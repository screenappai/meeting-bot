import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  promises: {
    unlink: vi.fn(),
  },
}));

import { RecordingRetentionPolicy } from '../../lib/storage/retention';
import * as fs from 'fs';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe('RecordingRetentionPolicy', () => {
  let policy: RecordingRetentionPolicy;

  beforeEach(() => {
    policy = new RecordingRetentionPolicy(mockLogger);
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    (fs.promises.unlink as any).mockReset();
  });

  describe('decide', () => {
    it('should delete temp file after successful upload', () => {
      const decision = policy.decide({
        success: true,
        error: null,
        uploaderConfigured: true,
      }, '/tmp/recording.mp4');

      expect(decision.action).toBe('delete_temp');
      expect(decision.reason).toBe('temp_file_deleted_after_successful_upload');
    });

    it('should retain temp file when upload fails with error', () => {
      const decision = policy.decide({
        success: false,
        error: new Error('network timeout'),
        uploaderConfigured: true,
      }, '/tmp/recording.mp4');

      expect(decision.action).toBe('retain_temp');
      expect(decision.reason).toContain('upload_failed_temp_file_retained');
      expect(decision.reason).toContain('network timeout');
    });

    it('should retain temp file when uploader is not configured', () => {
      const decision = policy.decide({
        success: false,
        error: null,
        uploaderConfigured: false,
      }, '/tmp/recording.mp4');

      expect(decision.action).toBe('retain_temp');
      expect(decision.reason).toContain('uploader not configured');
    });

    it('should retain temp file for unknown failure reason', () => {
      const decision = policy.decide({
        success: false,
        error: null,
        uploaderConfigured: true,
      }, '/tmp/recording.mp4');

      expect(decision.action).toBe('retain_temp');
      expect(decision.reason).toContain('unknown reason');
    });
  });

  describe('execute', () => {
    it('should delete file when decision is delete_temp', async () => {
      (fs.promises.unlink as any).mockResolvedValue(undefined);

      await policy.execute(
        { action: 'delete_temp', reason: 'temp_file_deleted_after_successful_upload' },
        '/tmp/recording.mp4',
      );

      expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/recording.mp4');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'temp_file_deleted_after_successful_upload',
        { filePath: '/tmp/recording.mp4' },
      );
    });

    it('should log warning when decision is retain_temp', async () => {
      await policy.execute(
        { action: 'retain_temp', reason: 'upload_failed_temp_file_retained: test error' },
        '/tmp/recording.mp4',
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'upload_failed_temp_file_retained: test error',
        { filePath: '/tmp/recording.mp4' },
      );
    });

    it('should handle file deletion failure gracefully', async () => {
      (fs.promises.unlink as any).mockRejectedValue(new Error('ENOENT'));

      await policy.execute(
        { action: 'delete_temp', reason: 'temp_file_deleted_after_successful_upload' },
        '/tmp/nonexistent.mp4',
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to delete temp file',
        expect.objectContaining({ filePath: '/tmp/nonexistent.mp4' }),
      );
    });
  });

  describe('decideAndExecute', () => {
    it('should decide and execute in one call', async () => {
      (fs.promises.unlink as any).mockResolvedValue(undefined);

      const decision = await policy.decideAndExecute(
        { success: true, error: null, uploaderConfigured: true },
        '/tmp/recording.mp4',
      );

      expect(decision.action).toBe('delete_temp');
      expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/recording.mp4');
    });

    it('should retain without attempting delete on upload failure', async () => {
      const decision = await policy.decideAndExecute(
        { success: false, error: new Error('fail'), uploaderConfigured: true },
        '/tmp/recording.mp4',
      );

      expect(decision.action).toBe('retain_temp');
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });
  });
});
