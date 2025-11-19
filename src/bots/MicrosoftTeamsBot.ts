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
      }

      await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);
    } catch(error) {
      if (!_state.includes('finished')) 
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) 
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'microsoft', error }, this._logger);

      throw error;
    }
  }

  private async joinMeeting({ url, name, teamId, userId, eventId, botId, pushState, uploader }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this._logger.info('Launching browser...');

    this.page = await createBrowserContext(url, this._correlationId, 'microsoft');

    await this.page.waitForTimeout(1000);

    this._logger.info('Navigating to Microsoft Teams Meeting URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    let joinFromBrowserButtonFound = false;

    try {
      this._logger.info('Waiting for Join meeting from browser field to be visible...');
      await retryActionWithWait(
        'Waiting for Join meeting from browser field to be visible',
        async () => {
          await this.page.waitForSelector('button[aria-label="Join meeting from this browser"]', { timeout: 60000 });
          joinFromBrowserButtonFound = true;

          this._logger.info('Waiting for 10 seconds...');
          await this.page.waitForTimeout(10000);
        },
        this._logger,
        1,
        15000,
      );
    } catch (error) {
      this._logger.info('Join meeting from browser button is probably missing!...', { error });
    }

    if (joinFromBrowserButtonFound) {
      this._logger.info('Clicking Join meeting from this browser button...');
      await this.page.click('button[aria-label="Join meeting from this browser"]');
    }

    this._logger.info('Waiting for pre-join screen to load...');
    await this.page.waitForTimeout(5000);

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

    const outputPath = path.join(process.cwd(), `recording-${botId || Date.now()}.mp4`);

    this._logger.info('Starting ffmpeg recording...', { outputPath, duration });

    // Create and start ffmpeg recorder
    const recorder = new FFmpegRecorder(outputPath, this._logger);

    try {
      await recorder.start();
      this._logger.info('FFmpeg recording started successfully');

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

      // Wait for either timeout or meeting end
      const startTime = Date.now();
      while (!meetingEnded && (Date.now() - startTime) < duration) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      this._logger.info('Recording period ended', {
        meetingEnded,
        recordedDuration: Math.floor((Date.now() - startTime) / 1000) + 's'
      });

    } finally {
      // Always stop ffmpeg
      this._logger.info('Stopping ffmpeg recording...');
      await recorder.stop();

      // Upload the recorded file
      this._logger.info('Uploading recorded file...', { outputPath });

      if (fs.existsSync(outputPath)) {
        const fileBuffer = fs.readFileSync(outputPath);
        await uploader.saveDataToTempFile(fileBuffer);

        // Clean up the temporary file
        fs.unlinkSync(outputPath);
        this._logger.info('Recording uploaded and temporary file cleaned up');
      } else {
        this._logger.error('Recording file not found!', { outputPath });
      }

      // Close browser
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();
      this._logger.info('All done ✨', { botId, eventId, userId, teamId });
    }
  }
}
