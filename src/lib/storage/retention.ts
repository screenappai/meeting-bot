import * as fs from 'fs';
import { Logger } from 'winston';
import { RetentionDecision } from './types';

export class RecordingRetentionPolicy {
  constructor(private logger: Logger) {}

  decide(
    uploadResult: { success: boolean; error?: Error | null; uploaderConfigured: boolean },
    filePath: string,
  ): RetentionDecision {
    if (uploadResult.success === true) {
      return { action: 'delete_temp', reason: 'temp_file_deleted_after_successful_upload' };
    }

    if (uploadResult.error) {
      return { action: 'retain_temp', reason: `upload_failed_temp_file_retained: ${uploadResult.error.message}` };
    }

    if (!uploadResult.uploaderConfigured) {
      return { action: 'retain_temp', reason: 'upload_failed_temp_file_retained: uploader not configured' };
    }

    return { action: 'retain_temp', reason: 'upload_failed_temp_file_retained: unknown reason' };
  }

  async execute(decision: RetentionDecision, filePath: string): Promise<void> {
    if (decision.action === 'delete_temp') {
      try {
        await fs.promises.unlink(filePath);
        this.logger.info(decision.reason, { filePath });
      } catch (error) {
        this.logger.warn('Failed to delete temp file', { filePath, error });
      }
      return;
    }

    if (decision.action === 'retain_temp') {
      this.logger.warn(decision.reason, { filePath });
    }
  }

  async decideAndExecute(
    uploadResult: { success: boolean; error?: Error | null; uploaderConfigured: boolean },
    filePath: string,
  ): Promise<RetentionDecision> {
    const decision = this.decide(uploadResult, filePath);
    await this.execute(decision, filePath);
    return decision;
  }
}
