import { Page } from 'playwright';
import { Task } from '../lib/Task';
import { JoinParams } from '../bots/AbstractMeetBot';
import { WaitPromise } from '../types';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback } from '../util/logger';

export class ContextBridgeTask extends Task<null, void> {
  private page: Page;
  private uploader: IUploader;
  private slightlySecretId: string;
  private waitingPromise: WaitPromise;

  constructor(
    page: Page,
    params: JoinParams & { botId: string },
    slightlySecretId: string,
    waitingPromise: WaitPromise,
    uploader: IUploader,
    logger: Logger
  ) {
    super(logger);
    this.page = page;
    this.slightlySecretId = slightlySecretId;
    this.waitingPromise = waitingPromise;
    this.uploader = uploader;
  }

  protected async execute(input: null): Promise<void> {
    // Capture and send the browser console logs to Node.js context
    this.page?.on('console', async msg => {
      try {
        await browserLogCaptureCallback(this._logger, msg);
      } catch(err) {
        this._logger.info('Failed to log browser messages...', err?.message);
      }
    });

    await this.page.exposeFunction('screenAppSendData', async (slightlySecretId: string, data: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;

      const buffer = Buffer.from(data, 'base64');
      await this.uploader.saveDataToTempFile(buffer);
    });

    await this.page.exposeFunction('screenAppMeetEnd', (slightlySecretId: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;
      try {
        this._logger.info('Early signal resolve recording');
        this.waitingPromise.resolveEarly();
      } catch (error) {
        this._logger.error('Could not process meeting end event', error);
      }
    });
  }
}
