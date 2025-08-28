import { JoinParams } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { UnsupportedMeetingError, WaitingAtLobbyRetryError } from '../error';
import { patchBotStatus } from '../services/botService';
import { handleUnsupportedMeetingError, handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback } from '../util/logger';
import { getWaitingPromise } from '../lib/promise';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { GOOGLE_LOBBY_MODE_HOST_TEXT, GOOGLE_REQUEST_DENIED, GOOGLE_REQUEST_TIMEOUT } from '../constants';
import { vp9MimeType, webmMimeType } from '../lib/recording';

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

    this.page = await createBrowserContext(url, this._correlationId);

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
                this._logger.info('Google Meet Bot is entering the meeting...', { userId, teamId });
                clearInterval(waitInterval);
                clearTimeout(waitTimeout);
                resolveWaiting(true);
                return;
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
      async ({ teamId, duration, inactivityLimit, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes, primaryMimeType, secondaryMimeType }: 
      { teamId:string, userId: string, duration: number, inactivityLimit: number, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number, primaryMimeType: string, secondaryMimeType: string }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityParticipantDetectionTimeout: NodeJS.Timeout;
        let inactivitySilenceDetectionTimeout: NodeJS.Timeout;
        let isOnValidGoogleMeetPageInterval: NodeJS.Timeout;

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

          // Check if we actually got audio tracks
          const audioTracks = stream.getAudioTracks();
          const hasAudioTracks = audioTracks.length > 0;
          
          if (!hasAudioTracks) {
            console.warn('No audio tracks available for silence detection. Will rely only on presence detection.');
          }

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
              sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error);
            }
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);

          let dismissModalsInterval: NodeJS.Timeout;
          let lastDimissError: Error | null = null;

          const stopTheRecording = async () => {
            mediaRecorder.stop();
            stream.getTracks().forEach((track) => track.stop());

            // Cleanup recording timer
            clearTimeout(timeoutId);

            // Cancel the perpetural checks
            if (inactivityParticipantDetectionTimeout) {
              clearTimeout(inactivityParticipantDetectionTimeout);
            }
            if (inactivitySilenceDetectionTimeout) {
              clearTimeout(inactivitySilenceDetectionTimeout);
            }

            if (loneTest) {
              clearTimeout(loneTest);
            }

            if (isOnValidGoogleMeetPageInterval) {
              clearInterval(isOnValidGoogleMeetPageInterval);
            }

            if (dismissModalsInterval) {
              clearInterval(dismissModalsInterval);
              if (lastDimissError && lastDimissError instanceof Error) {
                console.error('Error dismissing modals:', { lastDimissError, message: lastDimissError?.message });
              }
            }

            // Begin browser cleanup
            (window as any).screenAppMeetEnd(slightlySecretId);
          };

          let loneTest: NodeJS.Timeout;
          let detectionFailures = 0;
          let loneTestDetectionActive = true;
          const maxDetectionFailures = 10; // Track up to 10 consecutive failures

          function detectLoneParticipantResilient(): void {
            const re = /^[0-9]+$/;
          
            function getContributorsCount(): number | undefined {
              function findPeopleButton() {
                try {
                  // 1. Try to locate using attribute "starts with"
                  let btn: Element | null | undefined = document.querySelector('button[aria-label^="People -"]');
                  if (btn) return btn;
                
                  // 2. Try to locate using attribute "contains"
                  btn = document.querySelector('button[aria-label*="People"]');
                  if (btn) return btn;
                
                  // 3. Try via regex on aria-label (for more complex patterns)
                  const allBtns = Array.from(document.querySelectorAll('button[aria-label]'));
                  btn = allBtns.find(b => {
                    const label = b.getAttribute('aria-label');
                    return label && /^People - \d+ joined$/.test(label);
                  });
                  if (btn) return btn;
                
                  // 4. Fallback: Look for button with a child icon containing "people"
                  btn = allBtns.find(b =>
                    Array.from(b.querySelectorAll('i')).some(i =>
                      i.textContent && i.textContent.trim() === 'people'
                    )
                  );
                  if (btn) return btn;
                
                  // 5. Not found
                  return null;
                } catch (error) {
                  console.log('Error finding people button:', error);
                  return null;
                }
              }

              // 1. Try main DOM with aria-label first
              try {
                const peopleBtn = findPeopleButton();
                if (peopleBtn) {
                  const divs = Array.from((peopleBtn.parentNode as HTMLElement)?.parentNode?.querySelectorAll('div') ?? []);
                  for (const node of divs) {
                    if (typeof (node as HTMLElement).innerText === 'string' && re.test((node as HTMLElement).innerText.trim())) {
                      return Number((node as HTMLElement).innerText.trim());
                    }
                  }
                }
              } catch {
                console.log('1 Error getting contributors count:', { root: document.body.innerText });
              }
          
              return undefined;
            }
          
            function retryWithBackoff(): void {
              loneTest = setTimeout(function check() {
                if (!loneTestDetectionActive) {
                  if (loneTest) {
                    clearTimeout(loneTest);
                  }
                  return;
                }
                let contributors: number | undefined;
                try {
                  contributors = getContributorsCount();
                  if (typeof contributors === 'undefined') {
                    detectionFailures++;
                    console.warn('Meet participant detection failed, retrying. Failure count:', detectionFailures);
                    // Log for debugging
                    if (detectionFailures >= maxDetectionFailures) {
                      console.log('Persistent detection failures:', { bodyText: `${document.body.innerText?.toString()}` });
                      loneTestDetectionActive = false;
                    }
                    retryWithBackoff();
                    return;
                  }
                  detectionFailures = 0;
                  if (contributors < 2) {
                    console.log('Bot is alone, ending meeting.');
                    loneTestDetectionActive = false;
                    stopTheRecording();
                    return;
                  }
                } catch (err) {
                  detectionFailures++;
                  console.error('Detection error:', err, detectionFailures);
                  retryWithBackoff();
                  return;
                }
                retryWithBackoff();
              }, 5000);
            }
          
            retryWithBackoff();
          }

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
          inactivityParticipantDetectionTimeout = setTimeout(() => {
            detectLoneParticipantResilient();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          inactivitySilenceDetectionTimeout = setTimeout(() => {
            detectIncrediblySilentMeeting();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          const detectModalsAndDismiss = () => {
            let dismissModalErrorCount = 0;
            const maxDismissModalErrorCount = 10;
            dismissModalsInterval = setInterval(() => {
              try {
                const buttons = document.querySelectorAll('button');
                const dismissButtons = Array.from(buttons).filter((button) => button?.offsetParent !== null && button?.innerText?.includes('Got it'));
                if (dismissButtons.length > 0) {
                  console.log('Found "Got it" button, clicking it...', dismissButtons[0]);
                  dismissButtons[0].click();
                }
              } catch(error) {
                lastDimissError = error;
                dismissModalErrorCount += 1;
                if (dismissModalErrorCount > maxDismissModalErrorCount) {
                  console.error(`Failed to detect and dismiss "Got it" modals ${maxDismissModalErrorCount} times, will stop trying...`);
                  clearInterval(dismissModalsInterval);
                }
              }
            }, 2000);
          };

          const detectMeetingIsOnAValidPage = () => {
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
                  console.warn('Bot was removed from the meeting - ending recording on team:', userId, teamId);
                  return false;
                }

                if (currentBodyText.includes('No one responded to your request to join the call')) {
                  console.warn('Bot was not admitted to the meeting - ending recording on team:', userId, teamId);
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

            // check if we're still on a valid Google Meet page
            isOnValidGoogleMeetPageInterval = setInterval(() => {
              if (!isOnValidGoogleMeetPage()) {
                console.log('Google Meet page state changed - ending recording on team:', userId, teamId);
                clearInterval(isOnValidGoogleMeetPageInterval);
                stopTheRecording();
              }
            }, 10000);
          };

          detectModalsAndDismiss();

          detectMeetingIsOnAValidPage();
          
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

      this._logger.info('All done ✨', { eventId, botId, userId, teamId });
    });

    await waitingPromise.promise;
  }
}
