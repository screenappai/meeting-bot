import { JoinParams } from './AbstractMeetBot';
import { BotStatus } from '../types';
import config from '../config';
import { WaitingAtLobbyRetryError } from '../error';
import { handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { browserLogCaptureCallback } from '../util/logger';
import { MICROSOFT_REQUEST_DENIED } from '../constants';
import { FFmpegRecorder } from '../lib/ffmpegRecorder';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

export class MicrosoftTeamsBot extends MeetBotBase {
  private _logger: Logger;
  private _correlationId: string;
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = v4();
    this._logger = logger;
    this._correlationId = correlationId;
  }
  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', { uploadResult, userId, teamId });
      return uploadResult;
    };

    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, pushState, uploader });

      // Finish the upload from the temp video
      const uploadResult = await handleUpload();

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
        this._logger.error('Recording completed but upload failed', { botId, userId, teamId });
        await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);
        throw new Error('Recording upload failed');
      } else if (uploadResult) {
        this._logger.info('Recording and upload completed successfully', { botId, userId, teamId });
      }

      await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);
    } catch(error) {
      // Log the actual error that occurred
      this._logger.error('Error in Microsoft Teams bot join process', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        botId,
        userId,
        teamId,
        currentState: _state
      });

      if (!_state.includes('finished'))
        _state.push('failed');

      // Try to update bot status (may fail if API is unreachable, but that's OK)
      await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);

      if (error instanceof WaitingAtLobbyRetryError)
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'microsoft', error }, this._logger);

      throw error;
    }
  }

  private async joinMeeting({ url, name, teamId, userId, eventId, botId, pushState, uploader }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    // First run: Navigate to pre-join screen to trigger Chrome dialogs, then close
    this._logger.info('Pre-warming: Opening browser to trigger first-run dialogs...');
    try {
      const warmupPage = await createBrowserContext(url, this._correlationId, 'microsoft');
      this._logger.info('Pre-warming: Navigating to Teams meeting...');
      await warmupPage.goto(url, { waitUntil: 'networkidle' });

      await warmupPage.waitForTimeout(2000);

      // Try to click "Join from browser" button
      this._logger.info('Pre-warming: Looking for Join from browser button...');
      const joinButtonSelectors = [
        'button[aria-label="Join meeting from this browser"]',
        'button[aria-label="Continue on this browser"]',
        'button[aria-label="Join on this browser"]',
        'button:has-text("Continue on this browser")',
        'button:has-text("Join from browser")',
      ];

      for (const selector of joinButtonSelectors) {
        try {
          await warmupPage.waitForSelector(selector, { timeout: 5000 });
          this._logger.info(`Pre-warming: Found button with selector: ${selector}`);
          await warmupPage.click(selector, { force: true });
          this._logger.info('Pre-warming: Clicked join from browser button');
          break;
        } catch (err) {
          continue;
        }
      }

      // Wait for pre-join screen to load
      this._logger.info('Pre-warming: Waiting for pre-join screen...');
      await warmupPage.waitForTimeout(5000);

      // Close the warmup browser
      this._logger.info('Pre-warming: Closing warmup browser...');
      await warmupPage.context().browser()?.close();
      this._logger.info('Pre-warming complete - dialogs triggered');

      // Wait 10 seconds for Chrome to fully close and save state before opening again
      this._logger.info('Waiting 10 seconds before opening browser for actual meeting...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    } catch (error) {
      this._logger.warn('Pre-warming failed (non-fatal):', error);
    }

    // Second run: Actual meeting join
    this._logger.info('Launching browser for actual meeting...');

    this.page = await createBrowserContext(url, this._correlationId, 'microsoft');

    await this.page.waitForTimeout(1000);

    this._logger.info('Navigating to Microsoft Teams Meeting URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    // Try to find and click "Join from browser" button
    this._logger.info('Waiting for Join meeting from browser button...');
    const joinButtonSelectors = [
      'button[aria-label="Join meeting from this browser"]',
      'button[aria-label="Continue on this browser"]',
      'button[aria-label="Join on this browser"]',
      'button:has-text("Continue on this browser")',
      'button:has-text("Join from browser")',
    ];

    let buttonClicked = false;
    for (const selector of joinButtonSelectors) {
      try {
        this._logger.info(`Trying selector: ${selector}`);
        await this.page.waitForSelector(selector, { timeout: 60000 });
        this._logger.info(`Found button, clicking: ${selector}`);
        await this.page.click(selector, { force: true });
        buttonClicked = true;
        this._logger.info('Successfully clicked join from browser button');
        break;
      } catch (err) {
        this._logger.info(`Selector not found: ${selector}`);
        continue;
      }
    }

    if (!buttonClicked) {
      this._logger.info('Join from browser button not found, proceeding anyway...');
    }

    this._logger.info('Waiting for pre-join screen to load...');

    // Try to fill name if input field exists (optional, won't fail if missing)
    try {
      this._logger.info('Looking for name input field...');

      // Use the specific Teams pre-join name input selector
      const nameInput = this.page.locator('input[data-tid="prejoin-display-name-input"]');

      // Wait for the field to be visible
      await nameInput.waitFor({ state: 'visible', timeout: 120000 });

      this._logger.info('Found name input field, filling with bot name...');
      await nameInput.fill(name ? name : 'ScreenApp Notetaker');
      await this.page.waitForTimeout(1000);
    } catch (err) {
      this._logger.info('Name input field not found after 120s, skipping...', err?.message);
    }

    // Toggle off camera and mute microphone before joining
    const toggleDevices = async () => {
      try {
        this._logger.info('Attempting to turn off camera and mute microphone...');
        await this.page.waitForTimeout(2000);

        // Turn off camera
        try {
          const cameraSelectors = [
            'input[data-tid="toggle-video"][checked]',
            'input[type="checkbox"][title*="Turn camera off" i]',
            'input[role="switch"][data-tid="toggle-video"]',
            'button[aria-label*="Turn camera off" i]',
            'button[aria-label*="Camera off" i]',
          ];

          for (const selector of cameraSelectors) {
            const cameraButton = this.page.locator(selector).first();
            const isVisible = await cameraButton.isVisible({ timeout: 2000 }).catch(() => false);
            if (isVisible) {
              const label = await cameraButton.getAttribute('aria-label');
              this._logger.info(`Clicking camera toggle: ${label}`);
              await cameraButton.click();
              await this.page.waitForTimeout(500);
              break;
            }
          }
        } catch (err) {
          this._logger.info('Could not toggle camera', err?.message);
        }

        // Mute microphone
        try {
          const micSelectors = [
            'input[data-tid="toggle-mute"]:not([checked])',
            'input[type="checkbox"][title*="Mute mic" i]',
            'input[role="switch"][data-tid="toggle-mute"]',
            'button[aria-label*="Mute microphone" i]',
            'button[aria-label*="Mute mic" i]',
          ];

          for (const selector of micSelectors) {
            const micButton = this.page.locator(selector).first();
            const isVisible = await micButton.isVisible({ timeout: 2000 }).catch(() => false);
            if (isVisible) {
              const label = await micButton.getAttribute('aria-label');
              this._logger.info(`Clicking microphone toggle: ${label}`);
              await micButton.click();
              await this.page.waitForTimeout(500);
              break;
            }
          }
        } catch (err) {
          this._logger.info('Could not toggle microphone', err?.message);
        }

        this._logger.info('Finished toggling camera and microphone');
      } catch (error) {
        this._logger.warn('Error toggling devices', error?.message);
      }
    };

    await toggleDevices();

    this._logger.info('Clicking the join button...');
    await retryActionWithWait(
      'Clicking the join button',
      async () => {
        // Try different possible button texts
        const possibleTexts = [
          'Join now',
          'Join',
          'Ask to join',
          'Join meeting',
        ];

        let buttonClicked = false;

        for (const text of possibleTexts) {
          try {
            const button = this.page.getByRole('button', { name: new RegExp(text, 'i') });
            if (await button.isVisible({ timeout: 3000 }).catch(() => false)) {
              await button.click();
              buttonClicked = true;
              this._logger.info(`Successfully clicked "${text}" button`);
              break;
            }
          } catch (err) {
            this._logger.info(`Unable to click "${text}" button, trying next...`);
          }
        }

        if (!buttonClicked) {
          throw new Error('Unable to find any join button variant');
        }
      },
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'join-button-click', userId, this._logger, botId);
      }
    );

    // Do this to ensure meeting bot has joined the meeting
    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to be let in
      const callButton = this.page.getByRole('button', { name: /Leave/i });
      await callButton.waitFor({ timeout: wanderingTime });
      this._logger.info('Bot is entering the meeting...');
    } catch (error) {
      const bodyText = await this.page.evaluate(() => document.body.innerText);

      const userDenied = (bodyText || '')?.includes(MICROSOFT_REQUEST_DENIED);

      this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess: false, bodyText });

      this._logger.error('Closing the browser on error...', error);
      await this.page.context().browser()?.close();
      
      throw new WaitingAtLobbyRetryError('Microsoft Teams Meeting bot could not enter the meeting...', bodyText ?? '', !userDenied, 2);
    }

    pushState('joined');

    const dismissDeviceChecksAndNotifications = async () => {
      const notificationCheck = async () => {
        try {
          this._logger.info('Waiting for the "Close" button...');
          await this.page.waitForSelector('button[aria-label=Close]', { timeout: 5000 });
          this._logger.info('Clicking the "Close" button...');
          await this.page.click('button[aria-label=Close]', { timeout: 2000 });
        } catch (error) {
          // Log and ignore this error
          this._logger.info('Turn On notification might be missing...', error);
        }
      };

      const deviceCheck = async () => {
        try {
          this._logger.info('Waiting for the "Close" button...');
          await this.page.waitForSelector('button[title="Close"]', { timeout: 5000 });
    
          this._logger.info('Going to click all visible "Close" buttons...');
    
          let closeButtonsClicked = 0;
          let previousButtonCount = -1;
          let consecutiveNoChangeCount = 0;
          const maxConsecutiveNoChange = 2; // Stop if button count doesn't change for 2 consecutive iterations
    
          while (true) {
            const visibleButtons = await this.page.locator('button[title="Close"]:visible').all();
          
            const currentButtonCount = visibleButtons.length;
            
            if (currentButtonCount === 0) {
              break;
            }
            
            // Check if button count hasn't changed (indicating we might be stuck)
            if (currentButtonCount === previousButtonCount) {
              consecutiveNoChangeCount++;
              if (consecutiveNoChangeCount >= maxConsecutiveNoChange) {
                this._logger.warn(`Button count hasn't changed for ${maxConsecutiveNoChange} iterations, stopping`);
                break;
              }
            } else {
              consecutiveNoChangeCount = 0;
            }
            
            previousButtonCount = currentButtonCount;
    
            for (const btn of visibleButtons) {
              try {
                await btn.click({ timeout: 5000 });
                closeButtonsClicked++;
                this._logger.info(`Clicked a "Close" button #${closeButtonsClicked}`);
                
                await this.page.waitForTimeout(2000);
              } catch (err) {
                this._logger.warn('Click failed, possibly already dismissed', { error: err });
              }
            }
          
            await this.page.waitForTimeout(2000);
          }
        } catch (error) {
          // Log and ignore this error
          this._logger.info('Device permissions modals might be missing...', { error });
        }
      };

      await notificationCheck();
      await deviceCheck();
      this._logger.info('Finished dismissing device checks and notifications...');
    };
    await dismissDeviceChecksAndNotifications();

    // Wait for mic to be fully muted and any initial beeps to stop
    this._logger.info('Waiting 5 seconds for audio to stabilize before recording...');
    await this.page.waitForTimeout(5000);

    // Recording the meeting page with ffmpeg
    this._logger.info('Begin recording with ffmpeg...');
    await this.recordMeetingPageWithFFmpeg({ teamId, userId, eventId, botId, uploader });

    pushState('finished');
  }

  private async recordMeetingPageWithFFmpeg(
    { teamId, userId, eventId, botId, uploader }:
    { teamId: string, userId: string, eventId?: string, botId?: string, uploader: IUploader }
  ): Promise<void> {
    // Use config max recording duration (3 hours default) - only for safety
    const duration = config.maxRecordingDuration * 60 * 1000;
    this._logger.info(`Recording max duration set to ${duration / 60000} minutes (safety limit only)`);

    // Use the same temp folder as Google Meet bot (has proper permissions)
    const tempFolder = path.join(process.cwd(), 'dist', '_tempvideo');
    const outputPath = path.join(tempFolder, `recording-${botId || Date.now()}.mp4`);

    this._logger.info('Starting ffmpeg recording...', { outputPath, duration });

    // Verify PulseAudio is ready before starting FFmpeg
    this._logger.info('Verifying PulseAudio status before starting FFmpeg...');
    try {
      const execAsync = promisify(exec);

      // Check if PulseAudio process is running
      try {
        const { stdout: psOutput } = await execAsync('ps aux | grep pulseaudio | grep -v grep');
        this._logger.info('PulseAudio process status:', psOutput.trim());
      } catch (err) {
        this._logger.error('PulseAudio process not found!', err);
      }

      // Check XDG_RUNTIME_DIR
      this._logger.info('Environment check:', {
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        USER: process.env.USER,
        HOME: process.env.HOME
      });

      // Check if PulseAudio socket exists
      try {
        const socketPath = `${process.env.XDG_RUNTIME_DIR}/pulse/native`;
        const { stdout: socketCheck } = await execAsync(`ls -la ${socketPath}`);
        this._logger.info('PulseAudio socket exists:', socketCheck.trim());
      } catch (err) {
        this._logger.error('PulseAudio socket not found!', err);
      }

      // Try to list sources
      const { stdout: paStatus } = await execAsync('pactl list sources short');
      this._logger.info('PulseAudio sources available:', paStatus.trim() || '(empty - no sources found)');

      if (!paStatus.includes('virtual_output.monitor')) {
        this._logger.error('WARNING: virtual_output.monitor not found in PulseAudio sources!');
        this._logger.info('Attempting to restart PulseAudio and recreate virtual audio device...');

        // Try to restart PulseAudio
        try {
          await execAsync('pulseaudio --kill || true');
          await execAsync('sleep 1');
          await execAsync('pulseaudio -D --exit-idle-time=-1 --log-level=info');
          await execAsync('sleep 2');
          this._logger.info('Restarted PulseAudio');

          // Recreate the null sink
          await execAsync('pactl load-module module-null-sink sink_name=virtual_output sink_properties=device.description="Virtual_Output"');
          await execAsync('pactl set-default-sink virtual_output');
          this._logger.info('Recreated virtual_output sink and monitor');

          // Verify it worked
          const { stdout: newStatus } = await execAsync('pactl list sources short');
          this._logger.info('PulseAudio sources after restart:', newStatus.trim());
        } catch (err) {
          this._logger.error('Failed to restart PulseAudio or recreate virtual audio device:', err);
        }
      }
    } catch (err) {
      this._logger.error('Error checking PulseAudio status:', err);
    }

    // Create and start ffmpeg recorder
    const recorder = new FFmpegRecorder(outputPath, this._logger);

    // Track FFmpeg status
    let ffmpegFailed = false;
    let ffmpegError: Error | null = null;

    try {
      await recorder.start();
      this._logger.info('FFmpeg recording started successfully');

      // Monitor FFmpeg process - if it dies, stop recording immediately
      recorder.onProcessExit((code) => {
        if (code !== 0 && code !== null) {
          this._logger.error('FFmpeg died unexpectedly during recording', { exitCode: code });
          ffmpegFailed = true;
          ffmpegError = new Error(`FFmpeg exited with code ${code} during recording`);
        }
      });

      // Set up browser-based inactivity detection
      let meetingEnded = false;
      await this.page.exposeFunction('screenAppMeetEnd', () => {
        this._logger.info('Meeting ended signal received from browser');
        meetingEnded = true;
      });

      // Capture and forward browser console logs to Node.js logger
      this.page.on('console', async msg => {
        try {
          await browserLogCaptureCallback(this._logger, msg);
        } catch(err) {
          this._logger.info('Playwright chrome logger: Failed to log browser messages...', err?.message);
        }
      });

      // Inject inactivity detection script
      await this.page.evaluate(
        ({ activateAfterMinutes, maxDuration }: { activateAfterMinutes: number, maxDuration: number }) => {
          // Max duration timeout - safety limit (3 hours default in production)
          setTimeout(() => {
            console.log(`Max recording duration (${maxDuration / 60000} minutes) reached, ending meeting`);
            (window as any).screenAppMeetEnd();
          }, maxDuration);
          console.log(`Max duration timeout set to ${maxDuration / 60000} minutes (safety limit)`);

          // Activate participant detection after delay
          setTimeout(() => {
            console.log('Activating participant count detection...');

            // Participant count detection
            const detectLoneParticipant = () => {
              const interval = setInterval(() => {
                try {
                  const regex = /\d+/;
                  const contributors = Array.from(document.querySelectorAll('button[aria-label=People]') ?? [])
                    .filter(x => regex.test(x?.textContent ?? ''))[0]?.textContent;
                  const match = (typeof contributors === 'undefined' || !contributors) ? null : contributors.match(regex);

                  if (match && Number(match[0]) >= 2) {
                    return; // Still has participants
                  }

                  console.log('Bot is alone, ending meeting');
                  clearInterval(interval);
                  (window as any).screenAppMeetEnd();
                } catch (error) {
                  console.error('Participant detection error:', error);
                }
              }, 5000);
            };

            // Start participant detection
            detectLoneParticipant();
          }, activateAfterMinutes * 60 * 1000);
        },
        {
          activateAfterMinutes: config.activateInactivityDetectionAfter,
          maxDuration: duration,
        }
      );

      // Wait for either timeout, meeting end, or FFmpeg failure
      const startTime = Date.now();
      while (!meetingEnded && !ffmpegFailed && (Date.now() - startTime) < duration) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      this._logger.info('Recording period ended', {
        meetingEnded,
        ffmpegFailed,
        recordedDuration: Math.floor((Date.now() - startTime) / 1000) + 's'
      });

      // If FFmpeg failed during recording, throw the error
      if (ffmpegFailed && ffmpegError) {
        throw ffmpegError;
      }

    } catch (error) {
      // If recorder.start() failed or any other error occurred, mark FFmpeg as failed
      this._logger.error('Error during recording:', error);
      ffmpegFailed = true;
      ffmpegError = error instanceof Error ? error : new Error(String(error));
      // Re-throw to be caught by outer try/catch in joinMeeting
      throw error;
    } finally {
      // Always stop ffmpeg
      this._logger.info('Stopping ffmpeg recording...');
      await recorder.stop();

      // Upload the recorded file
      this._logger.info('Uploading recorded file...', { outputPath });

      let uploadSuccess = false;
      if (fs.existsSync(outputPath)) {
        const fileBuffer = fs.readFileSync(outputPath);
        await uploader.saveDataToTempFile(fileBuffer);

        // Clean up the temporary file
        fs.unlinkSync(outputPath);
        this._logger.info('Recording uploaded and temporary file cleaned up');
        uploadSuccess = true;
      } else {
        this._logger.error('Recording file not found!', { outputPath });
      }

      // Close browser
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      // Log final status
      if (ffmpegFailed) {
        this._logger.error('Recording failed due to FFmpeg error', { botId, eventId, userId, teamId });
      } else if (!uploadSuccess) {
        this._logger.error('Recording completed but file upload failed', { botId, eventId, userId, teamId });
      } else {
        this._logger.info('Recording completed successfully ✨', { botId, eventId, userId, teamId });
      }
    }
  }
}
