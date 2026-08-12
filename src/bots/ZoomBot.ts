import { Frame, Page } from 'playwright';
import { JoinParams, AbstractMeetBot } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import {
  RecordingUploadFailedError,
  WaitingAtLobbyRetryError,
  ZoomBrowserJoinBlockedError,
  ZoomMeetingJoinError,
} from '../error';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { RecordingTask } from '../tasks/RecordingTask';
import { ContextBridgeTask } from '../tasks/ContextBridgeTask';
import { getWaitingPromise } from '../lib/promise';
import createBrowserContext, { closeBrowserSession, getBrowserSession } from '../lib/chromium';
import { uploadDebugImage } from '../services/bugService';
import { Logger } from 'winston';
import { handleWaitingAtLobbyError } from './MeetBotBase';
import { ZoomRtmsTransport } from '../rtms/ZoomRtmsTransport';
import {
  classifyZoomJoinState,
  shouldUseZoomRtmsFallback,
  ZoomJoinState,
} from './zoomJoinState';
import { reportRecoveredZoomFallback } from '../monitoring/sentry';
import {
  clickZoomJoinWithOptionalMediaPromptRetry,
  dismissZoomOptionalMediaPrompt,
} from './zoomPrejoinModal';

class BotBase extends AbstractMeetBot {
  protected page: Page;
  protected slightlySecretId: symbol; // Use any hard-to-guess identifier
  protected _logger: Logger;
  protected _correlationId: string;
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = Symbol(v4());
    this._logger = logger;
    this._correlationId = correlationId;
  }
  join(params: JoinParams): Promise<void> {
    throw new Error('Function not implemented.');
  }
}

export class ZoomBot extends BotBase {
  private joinState: ZoomJoinState = 'prejoin';

  constructor(logger: Logger, correlationId: string) {
    super(logger, correlationId);
  }

  // TODO use base class for shared functions such as bot status and bot logging
  // TODO Lift the JoinParams to the constructor argument
  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];
    let recoveredBrowserError: ZoomBrowserJoinBlockedError | undefined;
    let recordingTransport: 'browser' | 'rtms' =
      config.zoomTransportStrategy === 'rtms_only' ? 'rtms' : 'browser';
    let fallbackResult = 'not_attempted';

    const annotateFailure = (error: unknown, phase: string) => {
      if (error && typeof error === 'object') {
        Object.assign(error, {
          transport: recordingTransport,
          fallbackResult,
          phase,
        });
      }
      return error;
    };

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', { uploadResult, userId, teamId });
      return uploadResult;
    };
    
    try {
      const pushState = (st: BotStatus) => _state.push(st);
      const joinParams = { url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader };
      if (config.zoomTransportStrategy === 'rtms_only') {
        try {
          await new ZoomRtmsTransport(this._logger).record(joinParams, pushState);
        } catch (rtmsError) {
          throw annotateFailure(rtmsError, 'recording');
        }
      } else {
        try {
          await this.joinMeeting({ ...joinParams, pushState });
        } catch (browserError) {
          if (!shouldUseZoomRtmsFallback(
            browserError,
            config.zoomTransportStrategy === 'browser_then_rtms',
            this.joinState
          )) {
            throw browserError;
          }

          this._logger.warn('Zoom browser join was blocked before admission; trying RTMS fallback', {
            teamId,
            eventId,
            botId,
          });
          await closeBrowserSession(this.page);

          recordingTransport = 'rtms';
          fallbackResult = 'failed';
          try {
            await new ZoomRtmsTransport(this._logger).record(joinParams, pushState);
          } catch (fallbackError) {
            throw annotateFailure(fallbackError, 'fallback');
          }

          fallbackResult = 'recovered';
          recoveredBrowserError = browserError;
        }
      }

      // Finish the upload from the temp video
      let uploadResult: boolean;
      try {
        uploadResult = await handleUpload();
      } catch (uploadError) {
        throw annotateFailure(uploadError, 'upload');
      }

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
        throw annotateFailure(
          new RecordingUploadFailedError('Zoom recording completed but upload failed'),
          'upload'
        );
      }

      await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);
      if (recoveredBrowserError) {
        reportRecoveredZoomFallback({
          phase: 'fallback',
          teamId,
          eventId,
          botId,
          correlationId: this._correlationId,
        }, recoveredBrowserError);
      }
    } catch(error) {
      if (!_state.includes('finished') && !_state.includes('failed'))
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);

      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'zoom', error }, this._logger);
      }

      throw error;
    } finally {
      try {
        await closeBrowserSession(this.page);
      } catch (cleanupErr) {
        this._logger.warn('Browser cleanup in join finally failed (non-fatal)', { error: cleanupErr });
      }
    }
  }

  private async joinMeeting({ pushState, ...params }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this.joinState = 'prejoin';
    this._logger.info('Launching browser for Zoom...', { userId: params.userId });
    this.page = await createBrowserContext(
      params.url,
      this._correlationId,
      'zoom',
      params.timezone,
      params.teamId,
    );
    const browserSession = getBrowserSession(this.page);
    const joinWork = this.joinMeetingInBrowser({ ...params, pushState });

    if (browserSession) {
      await Promise.race([
        joinWork,
        browserSession.failure.then(error => Promise.reject(error)),
      ]);
      return;
    }

    await joinWork;
  }

  private async joinMeetingInBrowser({ pushState, ...params }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    const { url, name } = params;

    await this.page.route('**/*.exe', async (route) => {
      this._logger.info(`Detected .exe download: ${route.request().url()?.split('download')[0]}`);
      await route.abort();
    });

    const readVisiblePageText = async (): Promise<string> => {
      const frameTexts = await Promise.all(
        this.page.frames().map(frame => frame.locator('body').innerText({ timeout: 2_000 }).catch(() => ''))
      );
      return frameTexts.join('\n');
    };

    const applyJoinState = (bodyText: string): ZoomJoinState => {
      const state = classifyZoomJoinState(bodyText);
      if (state !== 'unknown') this.joinState = state;
      if (state === 'automated_bot_blocked') {
        throw new ZoomBrowserJoinBlockedError();
      }
      if (state === 'host_rejected' || state === 'sign_in_required' || state === 'meeting_ended') {
        throw new ZoomMeetingJoinError(state);
      }
      return state;
    };

    const inspectJoinState = async (): Promise<ZoomJoinState> =>
      applyJoinState(await readVisiblePageText());

    let usingDirectWebClient = false;
    const visitWebClientByUrl = async (): Promise<boolean> => {
      usingDirectWebClient = true;
      try {
        const wcUrl = new URL(url);
        wcUrl.pathname = wcUrl.pathname.replace('/j/', '/wc/join/');
        this._logger.info('Navigating to the Zoom Web Client fallback...', {
          botId: params.botId,
          userId: params.userId,
        });
        await this.page.goto(wcUrl.toString(), { waitUntil: 'domcontentloaded' });
        await inspectJoinState();
        return true;
      } catch(err) {
        if (err instanceof ZoomBrowserJoinBlockedError || err instanceof ZoomMeetingJoinError) {
          throw err;
        }
        usingDirectWebClient = false;
        this._logger.info('Failed to access ZOOM web client by URL', { botId: params.botId, userId: params.userId });
        return false;
      }
    };

    this._logger.info('Navigating to the original Zoom meeting URL...');
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });

    // Accept cookies
    try {
      this._logger.info('Waiting for the "Accept Cookies" button...');
      const acceptCookies = this.page.locator('button', { hasText: 'Accept Cookies' }).first();
      await acceptCookies.waitFor({ timeout: 2500 });

      this._logger.info('Clicking the "Accept Cookies" button...', await acceptCookies.count());
      await acceptCookies.click();

    } catch (error) {
      this._logger.info('Unable to accept cookies...', error);
    }

    const hasFocus = await this.page.evaluate(() => document.hasFocus());
    this._logger.info(`Page focus status: ${hasFocus}`);

    const attempts = 3;
    const findAndEnableJoinFromBrowserButton = async (retry: number): Promise<boolean> => {
      try {
        if (retry >= attempts) {
          return false;
        }

        const launchMeetingGetByRole = this.page.getByRole('button', { name: /Launch Meeting/i }).first();
        this._logger.info('Does Launch Meeting exist', await launchMeetingGetByRole.isVisible({ timeout: 1000 }).catch(() => false));

        const joinFromBrowser = this.page.locator('a', { hasText: 'Join from your browser' }).first();
        await joinFromBrowser.waitFor({ timeout: 4000 });

        if (await joinFromBrowser.isVisible({ timeout: 500 }).catch(() => false)) {
          await joinFromBrowser.click();
          return true;
        }
        else {
          this._logger.info('Try to find the Join from your browser button again...', retry + 1);
          return await findAndEnableJoinFromBrowserButton(retry + 1);
        }
      } catch(error) {
        await inspectJoinState();
        this._logger.info('Error on try find the web client', error);
        if (retry >= attempts) {
          return false;
        }
        return await findAndEnableJoinFromBrowserButton(retry + 1);
      }
    };

    const waitForJoinFromBrowserNav = async (): Promise<boolean> => {
      try {
        const maxAttempts = 10;
        let attempt = 0;

        const navPromise = new Promise<boolean>((foundResolver) => {
          const interv = setInterval(async () => {
            if (attempt >= maxAttempts) {
              clearInterval(interv);
              foundResolver(false);
              return;
            }

            try {
              const joinFromBrowser = this.page.locator('a', { hasText: 'Join from your browser' }).first();
              if (await joinFromBrowser.isVisible({ timeout: 500 }).catch(() => false)) {
                this._logger.info('Waiting for zoom navigation to meeting page...', params.userId);
              }
              else {
                clearInterval(interv);
                foundResolver(true);
              }
            }
            catch(e) {
              if (e?.name === 'TimeoutError') {
                this._logger.info('Join from your browser is no longer present on page...', params.userId);
                clearInterval(interv);
                foundResolver(true);
                return;
              }
              this._logger.info('An error happened while waiting for zoom navigation to finish', e);
              if (attempt >= maxAttempts) {
                clearInterval(interv);
                foundResolver(false);
                return;
              }
            }
            attempt += 1;
          }, 1000);
        });
        const success = await navPromise;
        return success;
      } catch(err) {
        this._logger.info('Zoom error: Unable to move forward from Join from your browser', params.userId);
        return false;
      }
    };

    if (!usingDirectWebClient) {
      // Join from browser
      this._logger.info('Waiting for Join from your browser to be visible...');
      const foundAndClickedJoinFromBrowser = await findAndEnableJoinFromBrowserButton(0);

      let navSuccess = false;
      if (foundAndClickedJoinFromBrowser) {
        this._logger.info('Verify the meeting web client is visible...');
        // Ensure the page has navigated to the web client...
        navSuccess = await waitForJoinFromBrowserNav();
      }

      if (!foundAndClickedJoinFromBrowser || !navSuccess) {
        await inspectJoinState();
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'enable-join-from-browser', params.userId, this._logger, params.botId);
        this._logger.info('Failed to enable Join from your browser button...', params.userId);
        this._logger.info('Zoom Bot will now attempt to access the Web Client by URL...', params.userId);
        const canAccess = await visitWebClientByUrl();
        if (!canAccess) {
          await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'direct-access-webclient', params.userId, this._logger, params.botId);
          throw new Error('Unable to join meeting after trying to access the web client by /wc/join/');
        }
      }
    }

    this._logger.info('Heading to the web client...', { usingDirectWebClient });

    let iframe: Frame | Page = this.page;
    const apps: ('app' | 'iframe')[] = [];
    const detectAppContainer = async (startWith: 'app' | 'iframe'): Promise<boolean> => {
      try {
        if (apps.includes('app') && apps.includes('iframe')) {
          return false;
        }

        apps.push(startWith);
        if (startWith === 'app') {
          const input = await this.page.waitForSelector('input[type="text"]', { timeout: 30000 });
          const join = this.page.locator('button', { hasText: /Join/i }).first();
          await join.waitFor({ timeout: 15000 });
          this._logger.info('App container...', { input: input !== null, join: join !== null });
          if (input && join) {
            iframe = this.page;
          } else {
            return await detectAppContainer('iframe');
          }
        }

        if (startWith === 'iframe') {
          const iframeElementHandle = await this.page.waitForSelector('iframe#webclient', { timeout: 30000, state: 'attached' });
          this._logger.info('Iframe container...', await iframeElementHandle?.getAttribute('id'));
          const contentFrame = await iframeElementHandle.contentFrame();
          if (contentFrame) {
            iframe = contentFrame;
          } else {
            return await detectAppContainer('app');
          }
        }

        return true;
      } catch(err) {
        await inspectJoinState();
        this._logger.info('Cannot detect the App container for Zoom Web Client', startWith, err);
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'detect-app-container', params.userId, this._logger, params.botId);
        return await detectAppContainer(startWith === 'app' ? 'iframe' : 'app');
      }
    };

    const foundAppContainer = await detectAppContainer(usingDirectWebClient ? 'app' : 'iframe');

    if (!iframe || !foundAppContainer) {
      await inspectJoinState();
      throw new Error(`Failed to get the Zoom PWA iframe on user ${params.userId}`);
    }

    this._logger.info('Waiting for the input field to be visible...');
    await iframe.waitForSelector('input[type="text"]', { timeout: 60000 });

    if (await dismissZoomOptionalMediaPrompt(iframe)) {
      this._logger.info('Continuing Zoom pre-join without microphone and camera...');
    }

    this._logger.info('Filling the input field with the name...');
    await iframe.fill('input[type="text"]', name ? name : 'winkk AI Notetaker');

    this._logger.info('Clicking the "Join" button...');
    await dismissZoomOptionalMediaPrompt(iframe, 500);
    const joinButton = iframe.locator('button', { hasText: 'Join' }).first();
    await joinButton.waitFor({ timeout: 15000 });
    await clickZoomJoinWithOptionalMediaPromptRetry(
      iframe,
      () => joinButton.click({ timeout: 2_000 })
    );
    this.joinState = 'waiting_room';

    const lobbyDeadline = Date.now() + config.joinWaitTime * 60 * 1000;
    let joined = false;
    while (Date.now() < lobbyDeadline) {
      const state = await inspectJoinState();
      if (state === 'waiting_room') this.joinState = state;

      const footerText = await iframe.locator('#wc-footer')
        .innerText({ timeout: 1_500 })
        .catch(() => '');
      const participantCount = footerText.match(/(\d+)\s*participants?/i);
      if (participantCount && Number(participantCount[1]) > 0) {
        joined = true;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 2_000));
    }

    if (!joined) {
      await inspectJoinState();
      this._logger.warn('Zoom participant was not admitted before the lobby timeout', {
        botId: params.botId,
        userId: params.userId,
      });
      throw new WaitingAtLobbyRetryError(
        'Zoom recording participant was not admitted before the lobby timeout',
        '',
        false,
        0
      );
    }

    this.joinState = 'joined';
    this._logger.info('Bot is entering the meeting after wait room...');

    // Wait for device notifications and close the notifications
    let notifyInternval: NodeJS.Timeout;
    let notifyTimeout: NodeJS.Timeout;
    try {
      const cameraNotifications: ('found' | 'dismissed')[] = [];
      const micNotifications: ('found' | 'dismissed')[] = [];
      const stopWaiting = 6 * 1000;
      let sawNotification = false;
      
      const notifyPromise = new Promise<boolean>((res) => {
        notifyTimeout = setTimeout(() => {
          clearInterval(notifyInternval);
          res(false);
        }, stopWaiting);
        notifyInternval = setInterval(async () => {
          try {
            const cameraDiv = iframe.locator('div', { hasText: /^Cannot detect your camera/i }).first();
            const micDiv = iframe.locator('div', { hasText: /^Cannot detect your microphone/i }).first();
            const cameraVisible = await cameraDiv.isVisible({ timeout: 500 }).catch(() => false);
            const micVisible = await micDiv.isVisible({ timeout: 500 }).catch(() => false);

            if (!cameraVisible && !micVisible && !sawNotification) {
              clearInterval(notifyInternval);
              clearTimeout(notifyTimeout);
              res(false);
              return;
            }

            if (cameraVisible) {
              sawNotification = true;
              if (!cameraNotifications.includes('found'))
                cameraNotifications.push('found');
            }
            else {
              if (cameraNotifications.includes('found'))
                cameraNotifications.push('dismissed');
            }

            if (micVisible) {
              sawNotification = true;
              if (!micNotifications.includes('found'))
                micNotifications.push('found');
            }
            else {
              if (micNotifications.includes('found'))
                micNotifications.push('dismissed');
            }

            if (micNotifications.length >= 2 && cameraNotifications.length >= 2) {
              clearInterval(notifyInternval);
              clearTimeout(notifyTimeout);
              res(true);
              return;
            }

            const closeButtons = await iframe.getByLabel('close').all();
            this._logger.info('Clicking the "x" button...', closeButtons.length);
            
            let counter = 0;
            try {
              for await (const close of closeButtons) {
                if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
                  await close.click({ timeout: 1000 });
                  counter += 1;
                }
              }
            } catch (err) {
              this._logger.info('Unable to click the x notifications', counter, err);
            }
          } catch (error) {
            // Log and ignore this error
            this._logger.info('Unable to close x notifications...', error);
            clearInterval(notifyInternval);
            clearTimeout(notifyTimeout);
            res(false);
          }
        }, 1000);
      });

      await notifyPromise.catch(() => {
        clearInterval(notifyInternval);
        clearTimeout(notifyTimeout);
      });
    }
    catch(err) {
      this._logger.info('Caught notifications close error', err.message);
    }

    // Dismiss annoucements OK button if present
    try {
      const okButton = iframe.locator('button', { hasText: 'OK' }).first();
      if (await okButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await okButton.click({ timeout: 1000 });
        this._logger.info('Dismissed the OK button...');
      }
    } catch (error) {
      this._logger.info('OK button might be missing...', error);
    }

    pushState('joined');

    // Recording the meeting page
    this._logger.info('Begin recording...');
    await this.recordMeetingPage({ ...params });
    
    pushState('finished');
  }

  private async recordMeetingPage(params: JoinParams): Promise<void> {
    const { teamId, userId, eventId, botId, uploader } = params;
    const duration = config.maxRecordingDuration * 60 * 1000;

    this._logger.info('Setting up the duration');
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    this._logger.info('Setting up the recording connect functions');
    const chores = new ContextBridgeTask(
      this.page, 
      { ...params, botId: params.botId ?? '' },
      this.slightlySecretId.toString(),
      waitingPromise,
      uploader,
      this._logger
    );
    await chores.runAsync(null);

    this._logger.info('Setting up the recording Main Task');
    // Inject the MediaRecorder code into the browser context using page.evaluate
    const recordingTask = new RecordingTask(
      userId,
      teamId,
      this.page,
      duration,
      this.slightlySecretId.toString(),
      this._logger
    );
    await recordingTask.runAsync(null);
  
    this._logger.info('Waiting for recording duration:', config.maxRecordingDuration, 'minutes...');
    await waitingPromise.promise;

    this._logger.info('Recording stopped; closing the meeting browser context...', {
      botId,
      eventId,
      userId,
      teamId,
    });
    await closeBrowserSession(this.page);
  }
}
