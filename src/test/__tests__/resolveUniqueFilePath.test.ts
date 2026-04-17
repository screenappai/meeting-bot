import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOpen, mockClose, mockMkdir } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockClose: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock('fs', () => {
  const mockFs = {
    promises: {
      mkdir: mockMkdir,
      open: mockOpen,
    },
    existsSync: vi.fn(),
    statSync: vi.fn(),
    createWriteStream: vi.fn(),
  };
  return { ...mockFs, default: mockFs };
});

vi.mock('../../config', () => ({
  default: {
    uploaderFileExtension: '.webm',
    uploaderType: 's3',
  },
}));

vi.mock('../../services/uploadService', () => ({
  createPartUploadUrl: vi.fn(),
  fileNameTemplate: vi.fn(),
  finalizeUpload: vi.fn(),
  initializeMultipartUpload: vi.fn(),
  uploadChunkToStorage: vi.fn(),
}));

vi.mock('../../uploader/providers/factory', () => ({
  getStorageProvider: vi.fn(),
}));

vi.mock('../../services/notificationService', () => ({
  notifyRecordingCompleted: vi.fn(),
}));

import DiskUploader from '../../middleware/disk-uploader';

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

describe('resolveUniqueFilePath (via DiskUploader.initialize)', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    mockOpen.mockReset();
  });

  it('should return base path when no file exists (no collision)', async () => {
    const mockFd = { close: mockClose };
    mockOpen.mockResolvedValue(mockFd);

    const uploader = await DiskUploader.initialize(
      'token', 'team1', 'UTC', 'user1', 'bot1', 'prefix', 'tempId123', logger
    );

    expect(mockOpen).toHaveBeenCalledWith(
      expect.stringContaining('tempId123.webm'),
      'wx'
    );
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('should return suffixed path when file already exists (one collision)', async () => {
    const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const mockFd = { close: mockClose };

    mockOpen
      .mockRejectedValueOnce(eexistError)
      .mockResolvedValueOnce(mockFd);

    await DiskUploader.initialize(
      'token', 'team1', 'UTC', 'user1', 'bot1', 'prefix', 'tempId123', logger
    );

    expect(mockOpen).toHaveBeenCalledTimes(2);
    expect(mockOpen).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('tempId123(1).webm'),
      'wx'
    );
  });

  it('should increment suffix on multiple collisions', async () => {
    const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const mockFd = { close: mockClose };

    mockOpen
      .mockRejectedValueOnce(eexistError)
      .mockRejectedValueOnce(eexistError)
      .mockRejectedValueOnce(eexistError)
      .mockResolvedValueOnce(mockFd);

    await DiskUploader.initialize(
      'token', 'team1', 'UTC', 'user1', 'bot1', 'prefix', 'tempId123', logger
    );

    expect(mockOpen).toHaveBeenCalledTimes(4);
    expect(mockOpen).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('tempId123(3).webm'),
      'wx'
    );
  });

  it('should propagate non-EEXIST errors', async () => {
    const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockOpen.mockRejectedValue(permError);

    await expect(
      DiskUploader.initialize(
        'token', 'team1', 'UTC', 'user1', 'bot1', 'prefix', 'tempId123', logger
      )
    ).rejects.toThrow('EACCES');
  });

  it('should use wx flag (atomic exclusive create)', async () => {
    const mockFd = { close: mockClose };
    mockOpen.mockResolvedValue(mockFd);

    await DiskUploader.initialize(
      'token', 'team1', 'UTC', 'user1', 'bot1', 'prefix', 'tempId123', logger
    );

    expect(mockOpen).toHaveBeenCalledWith(expect.any(String), 'wx');
  });
});
