import { Frame, Page } from 'playwright';
import { JoinParams, AbstractMeetBot } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { WaitingAtLobbyRetryError } from '../error';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { RecordingTask } from '../tasks/RecordingTask';
import { ContextBridgeTask } from '../tasks/ContextBridgeTask';
import { getWaitingPromise } from '../lib/promise';
import createBrowserContext from '../lib/chromium';
import { uploadDebugImage } from '../services/bugService';
import { Logger } from 'winston';
import { handleWaitingAtLobbyError } from './MeetBotBase';
import { ZOOM_REQUEST_DENIED } from '../constants';

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
  constructor(logger: Logger, correlationId: string) {
    super(logger, correlationId);
  }

  // TODO use base class for shared functions such as bot status and bot logging
  // TODO Lift the JoinParams to the constructor argument
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
      await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);

      // Finish the upload from the temp video
      await handleUpload();
    } catch(error) {
      if (!_state.includes('finished')) 
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'zoom', error }, this._logger);
      }

      throw error;
    }
  }

  private async joinMeeting({ pushState, ...params }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    const { url, name } = params;
    this._logger.info('Launching browser for Zoom...', { userId: params.userId });
    
    this.page = await createBrowserContext(url, this._correlationId);

    await this.page.route('**/*.exe', (route) => {
      this._logger.info(`Detected .exe download: ${route.request().url()?.split('download')[0]}`);
    });

    await this.page.waitForTimeout(1000);

    this._logger.info('Navigating to Zoom Meeting URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    // Accept cookies
    try {
      this._logger.info('Waiting for the "Accept Cookies" button...');
      await this.page.waitForTimeout(3000);
      const acceptCookies = await this.page.locator('button', { hasText: 'Accept Cookies' });
      await acceptCookies.waitFor({ timeout: 5000 });

      this._logger.info('Clicking the "Accept Cookies" button...', await acceptCookies.count());
      await acceptCookies.click({ force: true });
      
    } catch (error) {
      await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'accept-cookie', params.userId, this._logger, params.botId);
      this._logger.info('Unable to accept cookies...', error);
    }

    const hasFocus = await this.page.evaluate(() => document.hasFocus());
    this._logger.info(`Page focus status: ${hasFocus}`);

    const attempts = 3;
    let usingDirectWebClient = false;
    const findAndEnableJoinFromBrowserButton = async (retry: number): Promise<boolean> => {
      try {
        if (retry >= attempts) {
          return false;
        }

        this._logger.info('Waiting for 5 seconds...');
        await this.page.waitForTimeout(5000);

        const launchMeetingGetByRole = this.page.getByRole('button', { name: /Launch Meeting/i }).first();
        this._logger.info('Does Launch Meeting exist', await launchMeetingGetByRole.isVisible());

        const launchDownloadGetByRole = this.page.getByRole('button', { name: /Download Now/i }).first();
        this._logger.info('Does Download Now exist', await launchDownloadGetByRole.isVisible());

        this._logger.info('Click on Download Now...');
        await launchDownloadGetByRole.click({ force: true });

        const joinFromBrowser = await this.page.locator('a', { hasText: 'Join from your browser' }).first();
        await joinFromBrowser.waitFor({ timeout: 5000 });

        if ((await joinFromBrowser.count()) > 0) {
          await joinFromBrowser.click({ force: true });
          return true;
        }
        else {
          this._logger.info('Try to find the Join from your browser button again...', retry + 1);
          return await findAndEnableJoinFromBrowserButton(retry + 1);
        }
      } catch(error) {
        this._logger.info('Error on try find the web client', error);
        if (retry >= attempts) {
          return false;
        }
        return await findAndEnableJoinFromBrowserButton(retry + 1);
      }
    };

    const visitWebClientByUrl = async (): Promise<boolean> => {
      usingDirectWebClient = true;
      try {
        const wcUrl = new URL(url);
        wcUrl.pathname = wcUrl.pathname.replace('/j/', '/wc/join/');
        this._logger.info('Navigating to Zoom Web Client URL...', { wcUrl: wcUrl.toString(), botId: params.botId, userId: params.userId });
        await this.page.goto(wcUrl.toString(), { waitUntil: 'networkidle' });
        return true;
      } catch(err) {
        this._logger.info('Failed to access ZOOM web client by URL', { botId: params.botId, userId: params.userId });
        return false;
      }
    };

    const waitForJoinFromBrowserNav = async (): Promise<boolean> => {
      try {
        const maxAttempts = 3;
        let attempt = 0;

        const navPromise = new Promise<boolean>((foundResolver) => {
          const interv = setInterval(async () => {
            if (attempt >= maxAttempts) {
              clearInterval(interv);
              foundResolver(false);
              return;
            }

            try {
              const joinFromBrowser = await this.page.locator('a', { hasText: 'Join from your browser' }).first();
              await joinFromBrowser.waitFor({ timeout: 4000 }).catch();
              if (await joinFromBrowser.count() > 0) {
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
          }, 6000);
        });
        const success = await navPromise;
        return success;
      } catch(err) {
        this._logger.info('Zoom error: Unable to move forward from Join from your browser', params.userId);
        return false;
      }
    };

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
      await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'enable-join-from-browser', params.userId, this._logger, params.botId);
      this._logger.info('Failed to enable Join from your browser button...', params.userId);
      this._logger.info('Zoom Bot will now attempt to access the Web Client by URL...', params.userId);
      const canAccess = await visitWebClientByUrl();
      if (!canAccess) {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'direct-access-webclient', params.userId, this._logger, params.botId);
        throw new Error('Unable to join meeting after trying to access the web client by /wc/join/');
      }
    }

    this._logger.info('Heading to the web client...', { usingDirectWebClient });

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

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
          const join = await this.page.locator('button', { hasText: /Join/i });
          join.waitFor({ timeout: 15000 });
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
        this._logger.info('Cannot detect the App container for Zoom Web Client', startWith, err);
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'detect-app-container', params.userId, this._logger, params.botId);
        return await detectAppContainer(startWith === 'app' ? 'iframe' : 'app');
      }
    };

    const foundAppContainer = await detectAppContainer(usingDirectWebClient ? 'app' : 'iframe');

    if (!iframe || !foundAppContainer) {
      throw new Error(`Failed to get the Zoom PWA iframe on user ${params.userId}`);
    }

    this._logger.info('Waiting for the input field to be visible...');
    await iframe.waitForSelector('input[type="text"]', { timeout: 60000 });
    
    this._logger.info('Waiting for 5 seconds...');
    await this.page.waitForTimeout(5000);
    this._logger.info('Filling the input field with the name...');
    await iframe.fill('input[type="text"]', name ? name : 'ScreenApp Notetaker');

    await this.page.waitForTimeout(3000);

    this._logger.info('Clicking the "Join" button...');
    const joinButton = await iframe.locator('button', { hasText: 'Join' });
    await joinButton.click();

    // Wait in waiting room
    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to be let in
      
      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;
      const waitAtLobbyPromise = new Promise<boolean>((resolveMe) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveMe(false);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const footerInfo = await iframe.locator('#wc-footer');
            await footerInfo.waitFor({ state: 'attached' });
            const footerText = await footerInfo?.innerText();

            const tokens1 = footerText.split('\n');
            const tokens2 = footerText.split(' ');
            const tokens = tokens1.length > tokens2.length ? tokens1 : tokens2;
  
            const filtered: string[] = [];
            for (const tok of tokens) {
              if (!tok) continue;
              if (!Number.isNaN(Number(tok.trim())))
                filtered.push(tok);
              else if (tok.trim().toLowerCase() === 'participants') {
                filtered.push(tok.trim().toLowerCase());
                break;
              }
            }
            const joinedText = filtered.join('');

            if (joinedText === 'participants') 
              return;

            const isValid = joinedText.match(/\d+(.*)participants/i);
            if (!isValid) {
              return;
            }

            const num = joinedText.match(/\d+/);
            this._logger.info('Final Number of participants while waiting...', num);
            if (num && Number(num[0]) === 0)
              this._logger.info('Waiting on host...');
            else {
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveMe(true);
            }
          } catch(e) {
            // Do nothing
          }
        }, 2000);
      });

      const joined = await waitAtLobbyPromise;
      if (!joined) {
        const bodyText = await this.page.evaluate(() => document.body.innerText);

        const userDenied = (bodyText || '')?.includes(ZOOM_REQUEST_DENIED);

        this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess: joined, bodyText });

        throw new WaitingAtLobbyRetryError('Zoom bot could not enter the meeting...', bodyText ?? '', !userDenied, 2);
      }

      this._logger.info('Bot is entering the meeting after wait room...');
    } catch (error) {
      this._logger.info('Closing the browser on error...', error);
      await this.page.context().browser()?.close();

      throw error;
    }

    // Wait for device notifications and close the notifications
    let notifyInternval: NodeJS.Timeout;
    let notifyTimeout: NodeJS.Timeout;
    try {
      const cameraNotifications: ('found' | 'dismissed')[] = [];
      const micNotifications: ('found' | 'dismissed')[] = [];
      const stopWaiting = 30 * 1000;
      
      const notifyPromise = new Promise<boolean>((res) => {
        notifyTimeout = setTimeout(() => {
          clearInterval(notifyInternval);
          res(false);
        }, stopWaiting);
        notifyInternval = setInterval(async () => {
          try {
            const cameraDiv = await iframe.locator('div', { hasText: /^Cannot detect your camera/i }).first();
            const micDiv = await iframe.locator('div', { hasText: /^Cannot detect your microphone/i }).first();

            if (await cameraDiv.isVisible()) {
              if (!cameraNotifications.includes('found'))
                cameraNotifications.push('found');
            }
            else {
              if (cameraNotifications.includes('found'))
                cameraNotifications.push('dismissed');
            }

            if (await micDiv.isVisible()) {
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
                if (await close.isVisible()) {
                  await close.click({ timeout: 5000 });
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
        }, 2000);
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
      const okButton = await iframe.locator('button', { hasText: 'OK' }).first();
      if (await okButton.isVisible()) {
        await okButton.click({ timeout: 5000 });
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
    waitingPromise.promise.then(async () => {
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      this._logger.info('All done ✨', { botId, eventId, userId, teamId });
    });
    await waitingPromise.promise;
  }
}
