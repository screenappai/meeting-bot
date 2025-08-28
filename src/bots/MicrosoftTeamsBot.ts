import { JoinParams } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { WaitingAtLobbyRetryError } from '../error';
import { handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback } from '../util/logger';
import { getWaitingPromise } from '../lib/promise';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { MICROSOFT_REQUEST_DENIED } from '../constants';
import { vp9MimeType, webmMimeType } from '../lib/recording';

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
    };

    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, pushState, uploader });
      await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);

      // Finish the upload from the temp video
      await handleUpload();
    } catch(error) {
      if (!_state.includes('finished')) 
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) 
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'microsoft', error }, this._logger);

      throw error;
    }
  }

  private async joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, pushState, uploader }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this._logger.info('Launching browser...');

    this.page = await createBrowserContext(url, this._correlationId);

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

    const dismissDeviceCheck = async () => {
      try {
        this._logger.info('Clicking Continue without audio or video button...');
        await retryActionWithWait(
          'Clicking the "Continue without audio or video" button',
          async () => {
            await this.page.getByRole('button', { name: 'Continue without audio or video' }).waitFor({ timeout: 20000 });
            await this.page.getByRole('button', { name: 'Continue without audio or video' }).click();
          },
          this._logger,
          1,
          15000,
        );
      } catch (dismissError) {
        this._logger.info('Continue without audio or video button is probably missing!...');
      }
    };

    this._logger.info('Waiting for the input field to be visible...');
    await retryActionWithWait(
      'Waiting for the input field to be visible',
      async () => {
        await this.page.waitForSelector('input[type="text"]', { timeout: 20000 });
      },
      this._logger,
      2,
      15000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'input-field-visible', userId, this._logger, botId);
      }
    );
    
    await dismissDeviceCheck();

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    this._logger.info('Filling the input field with the name...');
    await this.page.fill('input[type="text"]', name ? name : 'ScreenApp Notetaker');

    this._logger.info('Waiting for 5 seconds...');
    await this.page.waitForTimeout(5000);

    this._logger.info('Clicking the "Join now" button...');
    await retryActionWithWait(
      'Clicking the "Join now" button',
      async () => {
        await this.page.getByRole('button', { name: 'Join now' }).waitFor({ state: 'visible', timeout: 15000 });
        await this.page.getByRole('button', { name: 'Join now' }).click();
      },
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'join-now-button-click', userId, this._logger, botId);
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

    // Recording the meeting page
    this._logger.info('Begin recording...');
    await this.recordMeetingPage({ teamId, userId, eventId, botId, uploader });
    
    pushState('finished');
  }

  private async recordMeetingPage(
    { teamId, userId, eventId, botId, uploader }: 
    { teamId: string, userId: string, eventId?: string, botId?: string, uploader: IUploader }
  ): Promise<void> {
    const duration = config.maxRecordingDuration * 60 * 1000;
    const inactivityLimit = config.inactivityLimit * 60 * 1000;

    // Capture and send the browser console logs to Node.js context
    this.page?.on('console', async msg => {
      try {
        await browserLogCaptureCallback(this._logger, msg);
      } catch(err) {
        this._logger.info('Failed to log browser messages...', err?.message);
      }
    });

    // These functions are exposed to browser while on trusted sites such as Microsoft Teams Web client - and within docker environment
    // A third-party script wouldn't have a unique accessId to call these functions
    await this.page.exposeFunction('screenAppSendData', async (slightlySecretId: string, data: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;

      const buffer = Buffer.from(data, 'base64');
      await uploader.saveDataToTempFile(buffer);
    });

    await this.page.exposeFunction('screenAppMeetEnd', (slightlySecretId: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;
      try {
        waitingPromise.resolveEarly();
      } catch (error) {
        this._logger.error('Could not process meeting end event', error);
      }
    });

    // Inject the MediaRecorder code into the browser context using page.evaluate
    await this.page.evaluate(
      async ({ teamId, duration, inactivityLimit, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes, primaryMimeType, secondaryMimeType }: 
      { teamId: string, duration: number, inactivityLimit: number, userId: string, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number, primaryMimeType: string, secondaryMimeType: string }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityDetectionTimeout: NodeJS.Timeout;

        /**
         * @summary A simple method to reliably send chunks over exposeFunction
         * @param chunk Array buffer to send
         * @returns void
         */
        const sendChunkToServer = async (chunk: ArrayBuffer) => {
          function arrayBufferToBase64(buffer: ArrayBuffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
          }
          const base64 = arrayBufferToBase64(chunk);
          await (window as any).screenAppSendData(slightlySecretId, base64);
        };

        async function startRecording() {
          console.log('Will activate the inactivity detection after', activateInactivityDetectionAfter);

          // Check for the availability of the mediaDevices API
          if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            console.error('MediaDevices or getDisplayMedia not supported in this browser.');
            return;
          }
          
          const stream: MediaStream = await (navigator.mediaDevices as any).getDisplayMedia({
            video: true,
            audio: {
              autoGainControl: false,
              channels: 2,
              channelCount: 2,
              echoCancellation: false,
              noiseSuppression: false,
            },
            preferCurrentTab: true,
          });

          let options: MediaRecorderOptions = {};
          if (MediaRecorder.isTypeSupported(primaryMimeType)) {
            console.log(`Media Recorder will use ${primaryMimeType} codecs...`);
            options = { mimeType: primaryMimeType };
          }
          else {
            console.warn(`Media Recorder did not find primary mime type codecs ${primaryMimeType}, Using fallback codecs ${secondaryMimeType}`);
            options = { mimeType: secondaryMimeType };
          }

          const mediaRecorder = new MediaRecorder(stream, { ...options });

          mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }
            try {
              const arrayBuffer = await event.data.arrayBuffer();
              await sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error.message, error);
            }
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);

          const stopTheRecording = async () => {
            mediaRecorder.stop();
            stream.getTracks().forEach((track) => track.stop());

            // Cleanup recording timer
            clearTimeout(timeoutId);

            // Cancel the perpetural checks
            if (inactivityDetectionTimeout) {
              clearTimeout(inactivityDetectionTimeout);
            }

            // Begin browser cleanup
            (window as any).screenAppMeetEnd(slightlySecretId);
          };

          let loneTest: NodeJS.Timeout;
          const detectLoneParticipant = () => {
            loneTest = setInterval(() => {
              try {
                const regex = new RegExp(/\d+/);
                const contributors = Array.from(document.querySelectorAll('button[aria-label=People]') ?? [])
                  .filter(x => (regex.test(x?.textContent ?? '')))[0]
                  ?.textContent;
                const match: null | RegExpMatchArray = (typeof contributors === 'undefined' || !contributors) ? null : contributors.match(regex);
                if (match && Number(match[0]) >= 2) {
                  return;
                }

                console.log('Detected meeting bot is alone in meeting, ending recording on team:', userId, teamId, userId);
                clearInterval(loneTest);
                stopTheRecording();
              } catch (error) {
                console.error('Microsoft Teams Meeting presence detection failed on team:', userId, teamId, error.message, error);
              }
            }, 5000); // Detect every 5 seconds
          };

          const detectIncrediblySilentMeeting = () => {
            const audioContext = new AudioContext();
            const mediaSource = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();

            /* Use a value suitable for the given use case of silence detection
               |
               |____ Relatively smaller FFT size for faster processing and less sampling
            */
            analyser.fftSize = 256;

            mediaSource.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            
            // Sliding silence period
            let silenceDuration = 0;

            // Audio gain/volume
            const silenceThreshold = 10;

            let monitor = true;

            const monitorSilence = () => {
              analyser.getByteFrequencyData(dataArray);

              const audioActivity = dataArray.reduce((a, b) => a + b) / dataArray.length;

              if (audioActivity < silenceThreshold) {
                silenceDuration += 100; // Check every 100ms
                if (silenceDuration >= inactivityLimit) {
                    console.warn('Detected silence in Microsoft Teams Meeting and ending the recording on team:', userId, teamId);
                    monitor = false;
                    stopTheRecording();
                }
              } else {
                silenceDuration = 0;
              }

              if (monitor) {
                // Recursively queue the next check
                setTimeout(monitorSilence, 100);
              }
            };

            // Go silence monitor
            monitorSilence();
          };

          /**
           * Perpetual checks for inactivity detection
           */
          inactivityDetectionTimeout = setTimeout(() => {
            detectLoneParticipant();
            detectIncrediblySilentMeeting();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          // Cancel this timeout when stopping the recording
          // Stop recording after `duration` minutes upper limit
          timeoutId = setTimeout(async () => {
            stopTheRecording();
          }, duration);
        }

        // Start the recording
        await startRecording();
      },
      { 
        teamId, 
        duration, 
        inactivityLimit, 
        userId, 
        slightlySecretId: this.slightlySecretId,
        activateInactivityDetectionAfterMinutes: config.activateInactivityDetectionAfter,
        activateInactivityDetectionAfter: new Date(new Date().getTime() + config.activateInactivityDetectionAfter * 60 * 1000).toISOString(),
        primaryMimeType: webmMimeType,
        secondaryMimeType: vp9MimeType
      }
    );
  
    this._logger.info('Waiting for recording duration', config.maxRecordingDuration, 'minutes...');
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    waitingPromise.promise.then(async () => {
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      this._logger.info('All done ✨', { botId, eventId, userId, teamId });
    });

    await waitingPromise.promise;
  }
}
