import { JoinParams } from './AbstractMeetBot';
import { BotStatus } from '../types';
import config from '../config';
import { UnsupportedMeetingError, WaitingAtLobbyRetryError } from '../error';
import { patchBotStatus } from '../services/botService';
import { handleUnsupportedMeetingError, handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback } from '../util/logger';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { GOOGLE_LOBBY_MODE_HOST_TEXT, GOOGLE_REQUEST_DENIED, GOOGLE_REQUEST_TIMEOUT } from '../constants';
import { FFmpegRecorder } from '../lib/ffmpegRecorder';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class GoogleMeetBot extends MeetBotBase {
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
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader, pushState });

      // Finish the upload from the temp video
      const uploadResult = await handleUpload();

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
      }

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
    } catch(error) {
      if (!_state.includes('finished')) 
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      if (error instanceof UnsupportedMeetingError) {
        await handleUnsupportedMeetingError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      throw error;
    }
  }

  private async joinMeeting({ url, name, teamId, userId, eventId, botId, pushState, uploader }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this._logger.info('Launching browser...');

    this.page = await createBrowserContext(url, this._correlationId, 'google');

    this._logger.info('Navigating to Google Meet URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    const dismissDeviceCheck = async () => {
      try {
        this._logger.info('Clicking Continue without microphone and camera button...');
        await retryActionWithWait(
          'Clicking the "Continue without microphone and camera" button',
          async () => {
            await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).waitFor({ timeout: 30000 });
            await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).click();
          },
          this._logger,
          1,
          15000,
        );
      } catch (dismissError) {
        this._logger.info('Continue without microphone and camera button is probably missing!...');
      }
    };

    await dismissDeviceCheck();

    const verifyItIsOnGoogleMeetPage = async (): Promise<'SIGN_IN_PAGE' | 'GOOGLE_MEET_PAGE' | 'UNSUPPORTED_PAGE' | null> => {
      try {
        const detectSignInPage = async () => {
          let result = false;
          const url = await this.page.url();
          if (url.startsWith('https://accounts.google.com/')) {
            this._logger.info('Google Meet bot is on the sign in page...', { userId, teamId });
            result = true;
          }
          const signInPage = await this.page.locator('h1', { hasText: 'Sign in' });
          if (await signInPage.count() > 0 && await signInPage.isVisible()) {
            this._logger.info('Google Meet bot is on the page with "Sign in" heading...', { userId, teamId });
            result = result && true;
          }
          return result;
        };
        const pageUrl = await this.page.url();
        if (!pageUrl.includes('meet.google.com')) {
          const signInPage = await detectSignInPage();
          return signInPage ? 'SIGN_IN_PAGE' : 'UNSUPPORTED_PAGE';
        }
        return 'GOOGLE_MEET_PAGE';
      } catch(e) {
        this._logger.error('Error verifying if Google Meet bot is on the Google Meet page...', { error: e, message: e?.message });
        return null;
      }
    };

    const googleMeetPageStatus = await verifyItIsOnGoogleMeetPage();
    if (googleMeetPageStatus === 'SIGN_IN_PAGE') {
      this._logger.info('Exiting now as meeting requires sign in...', { googleMeetPageStatus, userId, teamId });
      throw new UnsupportedMeetingError('Meeting requires sign in', googleMeetPageStatus);
    }

    if (googleMeetPageStatus === 'UNSUPPORTED_PAGE') {
      this._logger.info('Google Meet bot is on the unsupported page...', { googleMeetPageStatus, userId, teamId });
    }

    this._logger.info('Waiting for the input field to be visible...');
    await retryActionWithWait(
      'Waiting for the input field',
      async () => await this.page.waitForSelector('input[type="text"][aria-label="Your name"]', { timeout: 10000 }),
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'text-input-field-wait', userId, this._logger, botId);
      }
    );
    
    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    this._logger.info('Filling the input field with the name...');
    await this.page.fill('input[type="text"][aria-label="Your name"]', name ? name : 'ScreenApp Notetaker');

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);
    
    await retryActionWithWait(
      'Clicking the "Ask to join" button',
      async () => {
        // Using the Order of most probable detection
        const possibleTexts = [
          'Ask to join',
          'Join now',
          'Join anyway',
        ];

        let buttonClicked = false;

        for (const text of possibleTexts) {
          try {
            const button = await this.page.locator('button', { hasText: new RegExp(text.toLocaleLowerCase(), 'i') }).first();
            if (await button.count() > 0) {
              await button.click({ timeout: 5000 });
              buttonClicked = true;
              this._logger.info(`Success clicked using "${text}" action...`);
              break;
            }
          } catch(err) {
            this._logger.warn(`Unable to click using "${text}" action...`);
          }
        }

        // Throws to initiate retries
        if (!buttonClicked) {
          throw new Error('Unable to complete the join action...');
        }
      },
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'ask-to-join-button-click', userId, this._logger, botId);
      }
    );

    // Do this to ensure meeting bot has joined the meeting

    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to admit the bot

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;

      const waitAtLobbyPromise = new Promise<boolean>((resolveWaiting) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveWaiting(false);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const detectLobbyModeHostWaitingText = async (): Promise<'WAITING_FOR_HOST_TO_ADMIT_BOT' | 'WAITING_REQUEST_TIMEOUT' | 'LOBBY_MODE_NOT_ACTIVE' | 'UNABLE_TO_DETECT_LOBBY_MODE'> => {
              try {
                const lobbyModeHostWaitingText = await this.page.getByText(GOOGLE_LOBBY_MODE_HOST_TEXT);
                if (await lobbyModeHostWaitingText.count() > 0 && await lobbyModeHostWaitingText.isVisible()) {
                  return 'WAITING_FOR_HOST_TO_ADMIT_BOT';
                }

                const lobbyModeRequestTimeoutText = await this.page.getByText(GOOGLE_REQUEST_TIMEOUT);
                if (await lobbyModeRequestTimeoutText.count() > 0 && await lobbyModeRequestTimeoutText.isVisible()) {
                  return 'WAITING_REQUEST_TIMEOUT';
                }

                return 'LOBBY_MODE_NOT_ACTIVE';
              }
              catch (e) {
                this._logger.error('Error detecting lobby mode host waiting text...', { error: e, message: e?.message });
                return 'UNABLE_TO_DETECT_LOBBY_MODE';
              }
            };

            let peopleElement;
            let callButtonElement;
            let botWasDeniedAccess = false;

            try {
              peopleElement = await this.page.waitForSelector('button[aria-label="People"]', { timeout: 5000 });
            } catch(e) {
              this._logger.error(
                'wait error', { error: e }
              );
              //do nothing
            }

            try {
              callButtonElement = await this.page.waitForSelector('button[aria-label="Leave call"]', { timeout: 5000 });
            } catch(e) {
              this._logger.error(
                'wait error', { error: e }
              );
              //do nothing
            }

            if (peopleElement || callButtonElement) {
              // Here check the "lobby mode" that waits for the Host to join the meeting or for the Host to admit the bot
              const lobbyModeHostWaitingText = await detectLobbyModeHostWaitingText();
              if (lobbyModeHostWaitingText === 'WAITING_FOR_HOST_TO_ADMIT_BOT') {
                this._logger.info('Lobbdy Mode: Google Meet Bot is waiting for the host to admit it...', { userId, teamId });
              } else if (lobbyModeHostWaitingText === 'WAITING_REQUEST_TIMEOUT') {
                this._logger.info('Lobby Mode: Google Meet Bot join request timed out...', { userId, teamId });
                clearInterval(waitInterval);
                clearTimeout(waitTimeout);
                resolveWaiting(false);
                return;
              } else {
                // Additional check: Verify we can actually see participants (not just UI buttons)
                // The "Leave call" button can exist even in lobby waiting state
                try {
                  const participantCountDetected = await this.page.evaluate(() => {
                    try {
                      // Look for People button with participant count
                      const peopleButton = document.querySelector('button[aria-label^="People"]');
                      if (peopleButton) {
                        const ariaLabel = peopleButton.getAttribute('aria-label');
                        // Check if we can see participant count (e.g., "People - 2 joined")
                        const match = ariaLabel?.match(/People.*?(\d+)/);
                        if (match && parseInt(match[1]) >= 1) {
                          return true;
                        }
                      }

                      // Alternative: Check if participant count is visible in the DOM
                      const allButtons = Array.from(document.querySelectorAll('button'));
                      for (const btn of allButtons) {
                        const label = btn.getAttribute('aria-label');
                        if (label && /People.*?\d+/.test(label)) {
                          return true;
                        }
                      }

                      // Fallback: Check for text that indicates we're in the call
                      const bodyText = document.body.innerText;
                      if (bodyText.includes('You have joined the call') ||
                          bodyText.includes('other person in the call') ||
                          bodyText.includes('people in the call')) {
                        return true;
                      }

                      // Fallback: Check for Leave call button which indicates we're in a call
                      const leaveCallButton = document.querySelector('button[aria-label="Leave call"]');
                      if (leaveCallButton) {
                        // If we have Leave call button AND no lobby mode text, we're likely in the call
                        const hasLobbyText = bodyText.includes('Asking to join') ||
                                            bodyText.includes('You\'re the only one here');
                        if (!hasLobbyText) {
                          return true;
                        }
                      }

                      return false;
                    } catch (e) {
                      return false;
                    }
                  });

                  if (participantCountDetected) {
                    this._logger.info('Google Meet Bot is entering the meeting...', { userId, teamId });
                    clearInterval(waitInterval);
                    clearTimeout(waitTimeout);
                    resolveWaiting(true);
                    return;
                  } else {
                    this._logger.info('People button found but participant count not visible yet - continuing to wait...', { userId, teamId });
                    return;
                  }
                } catch (e) {
                  this._logger.error('Error checking participant visibility', { error: e });
                  return;
                }
              }              
            }

            try {
              const deniedText = await this.page.getByText(GOOGLE_REQUEST_DENIED);
              if (await deniedText.count() > 0 && await deniedText.isVisible()) {
                botWasDeniedAccess = true;
              }
            }
            catch(e) {
              //do nothing
            }
            if (botWasDeniedAccess) {
              this._logger.info('Google Meet Bot is denied access to the meeting...', { userId, teamId });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(false);
            }
          } catch(e) {
            this._logger.error(
              'wait error', { error: e }
            );
            // Do nothing
          }
        }, 20000);
      });

      const waitingAtLobbySuccess = await waitAtLobbyPromise;
      if (!waitingAtLobbySuccess) {
        const bodyText = await this.page.evaluate(() => document.body.innerText);

        const userDenied = (bodyText || '')?.includes(GOOGLE_REQUEST_DENIED);

        this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess, bodyText });

        // Don't retry lobby errors - if user doesn't admit bot, retrying won't help
        throw new WaitingAtLobbyRetryError('Google Meet bot could not enter the meeting...', bodyText ?? '', false, 0);
      }
    } catch(lobbyError) {
      this._logger.info('Closing the browser on error...', lobbyError);
      await this.page.context().browser()?.close();

      throw lobbyError;
    }

    pushState('joined');

    try {
      this._logger.info('Waiting for the "Got it" button...');
      await this.page.waitForSelector('button:has-text("Got it")', { timeout: 15000 });

      this._logger.info('Going to click all visible "Got it" buttons...');

      let gotItButtonsClicked = 0;
      let previousButtonCount = -1;
      let consecutiveNoChangeCount = 0;
      const maxConsecutiveNoChange = 2; // Stop if button count doesn't change for 2 consecutive iterations

      while (true) {
        const visibleButtons = await this.page.locator('button:visible', {
          hasText: 'Got it',
        }).all();
      
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
            gotItButtonsClicked++;
            this._logger.info(`Clicked a "Got it" button #${gotItButtonsClicked}`);
            
            await this.page.waitForTimeout(2000);
          } catch (err) {
            this._logger.warn('Click failed, possibly already dismissed', { error: err });
          }
        }
      
        await this.page.waitForTimeout(2000);
      }
    } catch (error) {
      // Log and ignore this error
      this._logger.info('"Got it" modals might be missing...', { error });
    }

    // Dismiss "Microphone not found" and "Camera not found" notifications if present
    try {
      this._logger.info('Checking for device notifications (microphone/camera)...');
      const hasDeviceNotification = await this.page.evaluate(() => {
        return document.body.innerText.includes('Microphone not found') ||
               document.body.innerText.includes('Make sure your microphone is plugged in') ||
               document.body.innerText.includes('Camera not found') ||
               document.body.innerText.includes('Make sure your camera is plugged in');
      });

      if (hasDeviceNotification) {
        this._logger.info('Found device notification (microphone/camera), attempting to dismiss...');
        // Try to find and click all close buttons
        const closeButtonsCount = await this.page.evaluate(() => {
          const allButtons = Array.from(document.querySelectorAll('button'));
          const closeButtons = allButtons.filter((btn) => {
            const ariaLabel = btn.getAttribute('aria-label');
            const hasCloseIcon = btn.querySelector('svg') !== null;
            return (ariaLabel?.toLowerCase().includes('close') ||
                    ariaLabel?.toLowerCase().includes('dismiss') ||
                    (hasCloseIcon && btn?.offsetParent !== null && btn.innerText === ''));
          });

          let clickedCount = 0;
          closeButtons.forEach((btn) => {
            if (btn?.offsetParent !== null) {
              btn.click();
              clickedCount++;
            }
          });
          return clickedCount;
        });

        if (closeButtonsCount > 0) {
          this._logger.info(`Successfully dismissed ${closeButtonsCount} device notification(s)`);
          await this.page.waitForTimeout(1000);
        } else {
          this._logger.warn('Could not find close button for device notifications');
        }
      }
    } catch (error) {
      this._logger.info('Error checking/dismissing device notifications...', { error });
    }

    this._logger.info('Begin recording with ffmpeg...');
    await this.recordMeetingPageWithFFmpeg({ teamId, eventId, userId, botId, uploader });

    pushState('finished');
  }

  private async recordMeetingPageWithFFmpeg(
    { teamId, userId, eventId, botId, uploader }:
    { teamId: string, userId: string, eventId?: string, botId?: string, uploader: IUploader }
  ): Promise<void> {
    const duration = config.maxRecordingDuration * 60 * 1000;
    this._logger.info(`Recording max duration set to ${duration / 60000} minutes (safety limit only)`);

    const tempFolder = path.join(process.cwd(), 'dist', '_tempvideo');
    const outputPath = path.join(tempFolder, `recording-${botId || Date.now()}.mp4`);

    this._logger.info('Starting ffmpeg recording...', { outputPath, duration });

    this._logger.info('Verifying PulseAudio status before starting FFmpeg...');
    try {
      try {
        const { stdout: psOutput } = await execAsync('ps aux | grep pulseaudio | grep -v grep');
        this._logger.info('PulseAudio process status:', psOutput.trim());
      } catch (err) {
        this._logger.error('PulseAudio process not found!', err);
      }

      this._logger.info('Environment check:', {
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        USER: process.env.USER,
        HOME: process.env.HOME
      });

      try {
        const socketPath = `${process.env.XDG_RUNTIME_DIR}/pulse/native`;
        const { stdout: socketCheck } = await execAsync(`ls -la ${socketPath}`);
        this._logger.info('PulseAudio socket exists:', socketCheck.trim());
      } catch (err) {
        this._logger.error('PulseAudio socket not found!', err);
      }

      const { stdout: paStatus } = await execAsync('pactl list sources short');
      this._logger.info('PulseAudio sources available:', paStatus.trim() || '(empty - no sources found)');

      if (!paStatus.includes('virtual_output.monitor')) {
        this._logger.error('WARNING: virtual_output.monitor not found in PulseAudio sources!');
        this._logger.info('Attempting to restart PulseAudio and recreate virtual audio device...');

        try {
          await execAsync('pulseaudio --kill || true');
          await execAsync('sleep 1');
          await execAsync('pulseaudio -D --exit-idle-time=-1 --log-level=info');
          await execAsync('sleep 2');
          this._logger.info('Restarted PulseAudio');

          await execAsync('pactl load-module module-null-sink sink_name=virtual_output sink_properties=device.description="Virtual_Output"');
          await execAsync('pactl set-default-sink virtual_output');
          this._logger.info('Recreated virtual_output sink and monitor');

          const { stdout: newStatus } = await execAsync('pactl list sources short');
          this._logger.info('PulseAudio sources after restart:', newStatus.trim());
        } catch (err) {
          this._logger.error('Failed to restart PulseAudio or recreate virtual audio device:', err);
        }
      }
    } catch (err) {
      this._logger.error('Error checking PulseAudio status:', err);
    }

    const recorder = new FFmpegRecorder(outputPath, this._logger);

    let ffmpegFailed = false;
    let ffmpegError: Error | null = null;

    try {
      await recorder.start();
      this._logger.info('FFmpeg recording started successfully');

      recorder.onProcessExit((code) => {
        if (code !== 0 && code !== null) {
          this._logger.error('FFmpeg died unexpectedly during recording', { exitCode: code });
          ffmpegFailed = true;
          ffmpegError = new Error(`FFmpeg exited with code ${code} during recording`);
        }
      });

      let meetingEnded = false;
      await this.page.exposeFunction('screenAppMeetEnd', () => {
        this._logger.info('Meeting ended signal received from browser');
        meetingEnded = true;
      });

      this.page.on('console', async msg => {
        try {
          await browserLogCaptureCallback(this._logger, msg);
        } catch(err) {
          this._logger.info('Playwright chrome logger: Failed to log browser messages...', err?.message);
        }
      });

      const inactivityLimitMs = config.inactivityLimit * 60 * 1000;

      const monitorAudioSilence = async () => {
        try {
          this._logger.info('Starting audio silence detection for Google Meet', {
            inactivityLimitMs,
            inactivityLimitMinutes: inactivityLimitMs / 60000
          });
          let consecutiveSilentChecks = 0;
          const checkIntervalSeconds = 5;
          const checksNeeded = Math.ceil(inactivityLimitMs / 1000 / checkIntervalSeconds);

          const checkInterval = setInterval(async () => {
            try {
              const { stdout } = await execAsync(
                'timeout 1 parec --device=virtual_output.monitor --format=s16le --rate=16000 --channels=1 2>/dev/null | ' +
                'od -An -td2 -v | awk \'BEGIN{max=0} {for(i=1;i<=NF;i++) {val=($i<0)?-$i:$i; if(val>max) max=val}} END{print max}\''
              );

              const peakLevel = parseInt(stdout.trim()) || 0;
              const silenceThreshold = 200;

              this._logger.debug('Audio level check', { peakLevel, threshold: silenceThreshold });

              if (peakLevel < silenceThreshold) {
                consecutiveSilentChecks++;
                this._logger.info(`Silence detected: ${consecutiveSilentChecks}/${checksNeeded} checks`, { peakLevel });

                if (consecutiveSilentChecks >= checksNeeded) {
                  this._logger.warn('Audio silence threshold reached, ending Google Meet meeting', {
                    userId,
                    teamId,
                    silenceDurationMs: inactivityLimitMs,
                    silenceDurationMinutes: inactivityLimitMs / 60000,
                    finalPeakLevel: peakLevel,
                    checksNeeded,
                    checksDetected: consecutiveSilentChecks
                  });
                  clearInterval(checkInterval);
                  meetingEnded = true;
                }
              } else {
                if (consecutiveSilentChecks > 0) {
                  this._logger.info('Audio detected, resetting silence counter', { peakLevel });
                }
                consecutiveSilentChecks = 0;
              }
            } catch (err) {
              this._logger.error('Error checking audio level:', err);
            }
          }, 5000);

        } catch (error) {
          this._logger.error('Failed to initialize audio silence detection:', error);
          this._logger.warn('Will rely on participant detection only');
        }
      };

      setTimeout(() => {
        monitorAudioSilence();
      }, config.activateInactivityDetectionAfter * 60 * 1000);

      await this.page.evaluate(
        ({ activateAfterMinutes, maxDuration }: { activateAfterMinutes: number, maxDuration: number }) => {
          setTimeout(() => {
            console.log(`Max recording duration (${maxDuration / 60000} minutes) reached, ending meeting`);
            (window as any).screenAppMeetEnd();
          }, maxDuration);
          console.log(`Max duration timeout set to ${maxDuration / 60000} minutes (safety limit)`);

          setTimeout(() => {
            console.log('Activating participant count detection...');

            const detectLoneParticipant = () => {
              const interval = setInterval(() => {
                try {
                  const peopleBtn = document.querySelector('button[aria-label*="People"]');
                  if (peopleBtn) {
                    const label = peopleBtn.getAttribute('aria-label') || '';
                    const match = label.match(/(\d+)/);
                    if (match) {
                      const count = parseInt(match[1]);
                      if (count >= 2) return;
                    }
                  }

                  const buttons = Array.from(document.querySelectorAll('button'));
                  for (const btn of buttons) {
                    const text = btn.textContent || '';
                    const label = btn.getAttribute('aria-label') || '';
                    const match = (text + ' ' + label).match(/(\d+)\s*(participant|people|joined)/i);
                    if (match && parseInt(match[1]) >= 2) return;
                  }

                  const leaveCallButton = document.querySelector('button[aria-label="Leave call"]');
                  if (!leaveCallButton) {
                    console.log('Google Meet page state changed - ending recording');
                    clearInterval(interval);
                    (window as any).screenAppMeetEnd();
                    return;
                  }

                  const bodyText = document.body.innerText;
                  if (bodyText.includes("You've been removed from the meeting") ||
                      bodyText.includes('No one responded to your request to join the call')) {
                    console.log('Bot removed or not admitted - ending recording');
                    clearInterval(interval);
                    (window as any).screenAppMeetEnd();
                    return;
                  }

                  console.log('Bot is alone, ending meeting');
                  clearInterval(interval);
                  (window as any).screenAppMeetEnd();
                } catch (error) {
                  console.error('Participant detection error:', error);
                }
              }, 5000);
            };

            detectLoneParticipant();
          }, activateAfterMinutes * 60 * 1000);

          const dismissModalsInterval = setInterval(() => {
            try {
              const buttons = document.querySelectorAll('button');
              const dismissButtons = Array.from(buttons).filter((button) => button?.offsetParent !== null && button?.innerText?.includes('Got it'));
              if (dismissButtons.length > 0) {
                console.log('Found "Got it" button, clicking it...', dismissButtons[0]);
                dismissButtons[0].click();
              }

              const bodyText = document.body.innerText;
              if (bodyText.includes('Microphone not found') ||
                  bodyText.includes('Make sure your microphone is plugged in') ||
                  bodyText.includes('Camera not found') ||
                  bodyText.includes('Make sure your camera is plugged in')) {
                console.log('Found device notification (microphone/camera), attempting to dismiss...');
                const allButtons = Array.from(document.querySelectorAll('button'));
                const closeButtons = allButtons.filter((btn) => {
                  const ariaLabel = btn.getAttribute('aria-label');
                  const hasCloseIcon = btn.querySelector('svg') !== null;
                  return (ariaLabel?.toLowerCase().includes('close') ||
                          ariaLabel?.toLowerCase().includes('dismiss') ||
                          (hasCloseIcon && btn?.offsetParent !== null && btn.innerText === ''));
                });
                closeButtons.forEach((btn) => {
                  if (btn?.offsetParent !== null) {
                    console.log('Clicking close button for device notification...');
                    btn.click();
                  }
                });
              }
            } catch(error) {
              console.error('Error dismissing modals:', error);
            }
          }, 2000);

          setTimeout(() => {
            clearInterval(dismissModalsInterval);
          }, maxDuration);
        },
        {
          activateAfterMinutes: config.activateInactivityDetectionAfter,
          maxDuration: duration,
        }
      );

      const startTime = Date.now();
      while (!meetingEnded && !ffmpegFailed && (Date.now() - startTime) < duration) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      this._logger.info('Recording period ended', {
        meetingEnded,
        ffmpegFailed,
        recordedDuration: Math.floor((Date.now() - startTime) / 1000) + 's'
      });

      if (ffmpegFailed && ffmpegError) {
        throw ffmpegError;
      }

    } catch (error) {
      this._logger.error('Error during recording:', error);
      ffmpegFailed = true;
      ffmpegError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      this._logger.info('Stopping ffmpeg recording...');
      await recorder.stop();

      this._logger.info('Uploading recorded file...', { outputPath });

      let uploadSuccess = false;
      if (fs.existsSync(outputPath)) {
        const fileBuffer = fs.readFileSync(outputPath);
        await uploader.saveDataToTempFile(fileBuffer);

        fs.unlinkSync(outputPath);
        this._logger.info('Recording uploaded and temporary file cleaned up');
        uploadSuccess = true;
      } else {
        this._logger.error('Recording file not found!', { outputPath });
      }

      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

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
