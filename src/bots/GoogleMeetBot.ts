import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { JoinParams } from './AbstractMeetBot';
import { BotStatus, ContentType, WaitPromise } from '../types';
import config from '../config';
import { WaitingAtLobbyRetryError } from '../error';
import { patchBotStatus } from '../services/botService';
import { handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback } from '../util/logger';
import { getWaitingPromise } from '../lib/promise';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

// Detect these dynamically and leave the meeting when necessary...
export const GOOGLE_REQUEST_DENIED = 'Someone in the call denied your request to join';
export const GOOGLE_REQUEST_TIMEOUT = 'No one responded to your request to join the call';

export class GoogleMeetBot extends MeetBotBase {
  private _logger: Logger;
  constructor(logger: Logger) {
    super();
    this.slightlySecretId = v4();
    this._logger = logger;
  }

  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', userId, teamId);
      const uploadResult = await uploader.uploadRecordingToServer();
      this._logger.info('Recording upload result', uploadResult, userId, teamId);
    };

    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader, pushState });
      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);

      // Finish the upload from the temp video
      await handleUpload();
    } catch(error) {
      if (!_state.includes('finished')) 
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      throw error;
    }
  }

  private async joinMeeting({ url, name, teamId, userId, eventId, botId, pushState, uploader }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this._logger.info('Launching browser...');

    const browserArgs: string[] = [
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--use-gl=egl',
      '--window-size=${width},${height}',
      '--auto-accept-this-tab-capture',
      '--enable-features=MediaRecorder',
    ];
    const size = { width: 1280, height: 720 };

    const browser = await chromium.launch({
      headless: false,
      args: browserArgs,
      ignoreDefaultArgs: ['--mute-audio'],
      executablePath: config.chromeExecutablePath,
    });

    const context = await browser.newContext({
      permissions: ['camera', 'microphone'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      viewport: size,
    });
    await context.grantPermissions(['microphone', 'camera'], { origin: url });

    this.page = await context.newPage();

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
            let peopleElement;
            let callButtonElement;

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
              this._logger.info('Google Meet Bot is entering the meeting...', { userId, teamId });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(true);
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

        throw new WaitingAtLobbyRetryError('Google Meet bot could not enter the meeting...', bodyText ?? '', !userDenied, 2);
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

      this._logger.info('Clicking the "Got it" button...');
      await this.page.click('button:has-text("Got it")');
    } catch (error) {
      // Log and ignore this error
      this._logger.info('Safety popup might be missing...', error);
    }

    // Recording the meeting page
    this._logger.info('Begin recording...');
    await this.recordMeetingPage({ teamId, eventId, userId, botId, uploader });

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
        this._logger.info('Playwright chrome logger: Failed to log browser messages...', err?.message);
      }
    });

    await this.page.exposeFunction('screenAppSendData', async (slightlySecretId: string, data: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;

      const buffer = Buffer.from(data, 'base64');
      await uploader.saveDataToTempFile(buffer);
    });

    await this.page.exposeFunction('screenAppMeetEnd', (slightlySecretId: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;
      try {
        this._logger.info('Attempt to end meeting early...');
        waitingPromise.resolveEarly();
      } catch (error) {
        console.error('Could not process meeting end event', error);
      }
    });

    // Inject the MediaRecorder code into the browser context using page.evaluate
    await this.page.evaluate(
      async ({ teamId, duration, inactivityLimit, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes }: 
      { teamId:string, userId: string, duration: number, inactivityLimit: number, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityDetectionTimeout: NodeJS.Timeout;

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

          const contentType: ContentType = 'video/webm';
          const mimeType = `${contentType}; codecs="h264"`;
          
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

          // Check if we actually got audio tracks
          const audioTracks = stream.getAudioTracks();
          const hasAudioTracks = audioTracks.length > 0;
          
          if (!hasAudioTracks) {
            console.warn('No audio tracks available for silence detection. Will rely only on presence detection.');
          }

          let options: MediaRecorderOptions = { mimeType: contentType };
          if (MediaRecorder.isTypeSupported(mimeType)) {
            console.log(`Media Recorder will use ${mimeType} codecs...`);
            options = { mimeType };
          }
          else {
            console.warn('Media Recorder did not find codecs, Using webm default');
          }

          const mediaRecorder = new MediaRecorder(stream, { ...options });

          mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }
            try {
              const arrayBuffer = await event.data.arrayBuffer();
              sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error);
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
          let detectionFailures = 0;
          const maxDetectionFailures = 10; // Track up to 10 consecutive failures
          
          // Simple check to verify we're still on a supported Google Meet page
          const isOnValidGoogleMeetPage = () => {
            try {
              // Check if we're still on a Google Meet URL
              const currentUrl = window.location.href;
              if (!currentUrl.includes('meet.google.com')) {
                console.warn('No longer on Google Meet page - URL changed to:', currentUrl);
                return false;
              }

              const currentBodyText = document.body.innerText;
              if (currentBodyText.includes('You\'ve been removed from the meeting')) {
                console.warn('User was removed from the meeting - ending recording on team:', userId, teamId);
                return false;
              }

              // Check for basic Google Meet UI elements
              const hasMeetElements = document.querySelector('button[aria-label="People"]') !== null ||
                                    document.querySelector('button[aria-label="Leave call"]') !== null;

              if (!hasMeetElements) {
                console.warn('Google Meet UI elements not found - page may have changed state');
                return false;
              }

              return true;
            } catch (error) {
              console.error('Error checking page validity:', error);
              return false;
            }
          };
          
          const detectLoneParticipant = () => {
            loneTest = setInterval(() => {
              try {
                // First check if we're still on a valid Google Meet page
                if (!isOnValidGoogleMeetPage()) {
                  console.log('Google Meet page state changed - ending recording on team:', userId, teamId);
                  clearInterval(loneTest);
                  stopTheRecording();
                  return;
                }

                const re = new RegExp(/^[0-9]$/g);
  
                const contributors = Array.from(document.querySelector('button[aria-label="People"]')?.parentNode?.parentNode?.querySelectorAll('div') ?? [])
                    .filter(x => (re.test(x.innerText)))[0]
                    ?.innerText;

                if (typeof contributors === 'undefined') {
                  detectionFailures++;
                  console.error('Possibly Google Meet presence detection did not work on team:', teamId, 'Failure count:', detectionFailures);
                  
                  if (detectionFailures >= maxDetectionFailures) {
                    console.error('Presence detection consistently failing - this may indicate a Google Meet UI change or technical issue. Meeting will continue until max duration.', { bodyText: document?.body?.innerText });
                    clearInterval(loneTest);
                  }
                  return;
                }

                // Reset failure count on success
                detectionFailures = 0;
                const isBotAlone = Number(contributors) < 2;
  
                if (isBotAlone) {
                  console.log('Detected meeting bot is alone in meeting, ending recording on team:', userId, teamId);
                  clearInterval(loneTest);
                  stopTheRecording();
                }
              } catch (error) {
                detectionFailures++;
                console.error('Google Meet presence detection failed on team:', userId, teamId, error, 'Failure count:', detectionFailures);
                
                if (detectionFailures >= maxDetectionFailures) {
                  console.error('Presence detection consistently failing - this may indicate a Google Meet UI change or technical issue. Meeting will continue until max duration.');
                  clearInterval(loneTest);
                }
              }
            }, 5000); // Detect every 5 seconds
          };

          const detectIncrediblySilentMeeting = () => {
            // Only run silence detection if we have audio tracks
            if (!hasAudioTracks) {
              console.warn('Skipping silence detection - no audio tracks available. This may be due to browser permissions or Google Meet audio sharing settings.');
              console.warn('Meeting will rely on presence detection and max duration timeout.');
              return;
            }

            try {
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
              let totalChecks = 0;
              let audioActivitySum = 0;

              // Audio gain/volume
              const silenceThreshold = 10;

              let monitor = true;

              const monitorSilence = () => {
                try {
                  analyser.getByteFrequencyData(dataArray);

                  const audioActivity = dataArray.reduce((a, b) => a + b) / dataArray.length;
                  audioActivitySum += audioActivity;
                  totalChecks++;

                  if (audioActivity < silenceThreshold) {
                    silenceDuration += 100; // Check every 100ms
                    if (silenceDuration >= inactivityLimit) {
                        console.warn('Detected silence in Google Meet and ending the recording on team:', userId, teamId);
                        console.log('Silence detection stats - Avg audio activity:', (audioActivitySum / totalChecks).toFixed(2), 'Checks performed:', totalChecks);
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
                } catch (error) {
                  console.error('Error in silence monitoring:', error);
                  console.warn('Silence detection failed - will rely on presence detection and max duration timeout.');
                  // Stop monitoring on error
                  monitor = false;
                }
              };

              // Go silence monitor
              monitorSilence();
            } catch (error) {
              console.error('Failed to initialize silence detection:', error);
              console.warn('Silence detection initialization failed - will rely on presence detection and max duration timeout.');
            }
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
        activateInactivityDetectionAfter: new Date(new Date().getTime() + config.activateInactivityDetectionAfter * 60 * 1000).toISOString()
      }
    );
  
    this._logger.info('Waiting for recording duration', config.maxRecordingDuration, 'minutes...');
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    waitingPromise.promise.then(async () => {
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      this._logger.info('All done ✨', { eventId, botId, userId, teamId });
    });

    await waitingPromise.promise;
  }
}
