import { Logger } from 'winston';
import {
  createPartUploadUrl,
  fileNameTemplate,
  finalizeUpload,
  initializeMultipartUpload,
  uploadChunkToStorage
} from '../services/uploadService';
import { ContentType, extensionToContentType, FileType } from '../types';
import fs, { createWriteStream } from 'fs';
import path from 'path';
import { LogAggregator } from '../util/logger';
import config from '../config';
import { uploadMultipartS3 } from '../uploader/s3-compatible-storage';
import { getTimeString } from '../lib/datetime';

console.log(' ----- PWD OR CWD ----- ', process.cwd());

const tempFolder = path.join(process.cwd(), 'dist', '_tempvideo');

function isNoSuchUploadError(err: any, userId: string, logger: Logger): boolean {
  /**
   * Error includes:
   * code: ERR_BAD_REQUEST
   * 
   * Error response includes:
   * status: 404
   * statusText: 'Not Found'
   * data: "<?xml version='1.0' encoding='UTF-8'?><Error><Code>NoSuchUpload</Code><Message>The requested upload was not found.</Message></Error>"
   */
  const xml = err?.response?.data || err?.data || '';

  const isNoSuchUpload = typeof xml === 'string' && xml?.includes('NoSuchUpload');

  if (isNoSuchUpload) {
    const code = err?.code;
    const status = err?.response?.status;
    logger.error('Critical: NoSuchUpload error on user', { userId, status, code });
  }

  return isNoSuchUpload;
}

export interface IUploader {
  uploadRecordingToRemoteStorage(options?: { forceUpload?: boolean }): Promise<boolean>;
  saveDataToTempFile(data: Buffer): Promise<boolean>;
}

// Save to disk and upload in one session
// TODO Add illustrative logs to track or replay the journey
class DiskUploader implements IUploader {
  private _token: string;
  private _teamId: string;
  private _timezone: string;
  private _userId: string;
  private _botId: string;
  private _namePrefix: string;
  private _tempFileId: string;
  private _logger: Logger;

  private readonly UPLOAD_CHUNK_SIZE = 50 * 1024 * 1024; // 50 MiB

  private readonly MAX_CHUNK_UPLOAD_RETRIES = 3;
  private readonly MAX_FILE_UPLOAD_RETRIES = 3;
  private readonly RETRY_UPLOAD_DELAY_BASE_MS = 500;
  private readonly MAX_GLOBAL_FAILURES = 5;

  private folderId = 'private'; // Assume meetings belong to an individual 
  private contentType: ContentType = extensionToContentType[config.uploaderFileExtension] ?? 'video/webm'; // Default video format
  private fileExtension: string = config.uploaderFileExtension;
  private fileId: string;
  private uploadId: string;

  private queue: Buffer[];
  private writing: boolean;
  private diskWriteSuccess: LogAggregator;

  private forceUpload: boolean;

  private constructor(
    token: string,
    teamId: string,
    timezone: string,
    userId: string,
    botId: string,
    namePrefix: string,
    tempFileId: string,
    logger: Logger
  ) {
    this._token = token;
    this._teamId = teamId;
    this._timezone = timezone;
    this._userId = userId;
    this._botId = botId;
    this._namePrefix = namePrefix;
    this._tempFileId = tempFileId;
    this._logger = logger;

    this.queue = [];
    this.writing = false;
    this.diskWriteSuccess = new LogAggregator(this._logger, `Success writing temp chunk to disk ${this._userId}`);
    this.forceUpload = false;
  }

  public static async initialize(
    token: string,
    teamId: string,
    timezone: string,
    userId: string,
    botId: string,
    namePrefix: string,
    tempFileId: string,
    logger: Logger
  ) {
    const folderPath = DiskUploader.getFolderPath(userId);

    await DiskUploader.setupDirectory(folderPath, userId, logger);

    const instance = new DiskUploader(
      token,
      teamId,
      timezone,
      userId,
      botId,
      namePrefix,
      tempFileId,
      logger
    );
    return instance;
  }

  private async uploadChunk(data: Buffer, partNumber: number) {
    this._logger.info('Uploader sending part...', partNumber, this._userId, this._teamId);

    const blob = new Blob([new Uint8Array(data as Buffer)], { type: 'application/octet-stream' });

    // Upload chunks to the server
    const uploadUrl = await createPartUploadUrl({
      teamId: this._teamId,
      folderId: this.folderId,
      fileId: this.fileId,
      uploadId: this.uploadId,
      partNumber: partNumber,
      contentType: this.contentType,
      token: this._token,
    });

    await uploadChunkToStorage({
      uploadUrl,
      chunk: blob,
    }, this._logger);

    this._logger.info('Uploader completed part...', partNumber, this._userId, this._teamId);
  }

  private async connect() {
    this._logger.info('Uploader connecting...', this._userId, this._teamId);
    // Initialise the file upload
    const initResponse = await initializeMultipartUpload({
      teamId: this._teamId,
      folderId: this.folderId,
      contentType: this.contentType,
      token: this._token,
    });

    this.fileId = initResponse.fileId;
    this.uploadId = initResponse.uploadId;

    this._logger.info('Uploader connected...', this._userId, this._teamId);
  }

  private async finish() {
    this._logger.info('Client finishing upload ...', this._userId, this._teamId);
    
    // Finalise upload
    const file: FileType = await finalizeUpload({
      teamId: this._teamId,
      folderId: this.folderId,
      fileId: this.fileId,
      uploadId: this.uploadId,
      contentType: this.contentType,
      token: this._token,
      timezone: this._timezone,
      namePrefix: this._namePrefix,
      botId: this._botId,
    }, this._logger);
    this._logger.info('Finish recording upload...', file.name, this._userId, this._teamId);
  }

  private writeChunkToDisk(chunk: Buffer): Promise<void> {
    const filePath = DiskUploader.getFilePath(this._userId, this._tempFileId, this.fileExtension);

    return new Promise((resolve, reject) => {
      const stream = createWriteStream(filePath, {
        flags: 'a',
        highWaterMark: 2 * 1024 * 1024,
      });
      const canWrite = stream.write(chunk);
      if (!canWrite) {
        stream.once('drain', () => {
          stream.end(() => resolve());
        });
      } else {
        stream.end(() => resolve());
      }
      stream.on('error', reject);
    });
  }

  private consecutiveWriteFailures = 0;

  private async writeWithRetries() {
    if (this.writing) return;

    this.writing = true;

    while (this.queue.length > 0) {
      const chunk = this.queue.shift();
      let success = false;
      let attempt = 0;
      const maxRetries = 3;
      const delayMs = 250;

      if (chunk) {
        while (!success && attempt <= maxRetries) {
          try {
            await this.writeChunkToDisk(chunk);
            success = true;
            this.consecutiveWriteFailures = 0; // reset on success
          } catch (err) {
            attempt++;
            if (attempt > maxRetries) {
              this.consecutiveWriteFailures++;
              this.queue.unshift(chunk); // put chunk back at front

              if (this.consecutiveWriteFailures >= this.MAX_GLOBAL_FAILURES) {
                this._logger.error(`Abandoning write after ${this.consecutiveWriteFailures} global failures`, this._userId, err);
                this.writing = false;
                return; // give up entirely
              }
              this._logger.info('Temporarily exit disk writing on error', this._userId, err);
              break; // exit inner retry loop, but keep outer loop running
            }
            this._logger.error(`Attempt to re-write chunk at attempt ${attempt}:`, this._userId, err);
            await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
          }
        }
      }
    }

    this.writing = false;
  }

  private enqueue(chunk: Buffer) {
    this.queue.push(chunk);

    if (!this.writing) {
      // Non blocking queue
      this.writeWithRetries()
        .then(() => {
          this.diskWriteSuccess.log();
        })
        .catch((err) => {
          this._logger.info('Failure during queue processing to write to disk', this._userId);
          throw err;
        });
    }
  }

  public async saveDataToTempFile(data: Buffer) {
    try {
      if (this.forceUpload) {
        // Stop disk writes when the upload or data recovery has started!
        this._logger.info('Force upload is enabled. Stopping disk writes...', this._userId, this._teamId);
        return false;
      }
      this.enqueue(data);
      return true;
    } catch(err) {
      this._logger.info('Error: Unable to save the chunk to disk...', this._userId, this._teamId, err);
      return false;
    }
  }

  private static getFolderPath(userId: string) {
    const folderPath = path.join(tempFolder, userId);
    return folderPath;
  }

  private static getFilePath(userId: string, tempFileId: string, fileExtension: string) {
    const fileName = `${tempFileId}${fileExtension}`;
    const folderPath = DiskUploader.getFolderPath(userId);
    const filePath = path.join(folderPath, fileName);
    return filePath;
  }

  private async processRecordingUpload() {
    const filePath = DiskUploader.getFilePath(this._userId, this._tempFileId, this.fileExtension);
    const chunkSize = this.UPLOAD_CHUNK_SIZE;

    await this.connect();

    const stats = await fs.promises.stat(filePath);
    const totalSize = stats.size;

    let offset = 0;
    let partNumber = 1;

    while (offset < totalSize) {
      const currentChunkSize = Math.min(chunkSize, totalSize - offset);
      const buffer = Buffer.alloc(currentChunkSize);

      const fd = await fs.promises.open(filePath, 'r');
      await fd.read(buffer, 0, currentChunkSize, offset);
      await fd.close();

      this._logger.info(`Uploading part ${partNumber} (bytes ${offset}-${offset + currentChunkSize - 1})`);

      // await this.uploadChunk(buffer, partNumber);

      await this.retryUploadWithResilience(
        () => this.uploadChunk(buffer, partNumber),
        partNumber
      );

      offset += currentChunkSize;
      partNumber++;
    }

    await this.finish();

    this._logger.info(`Finished uploading ${partNumber - 1} parts.`, this._userId, this._teamId);
  }

  private delayPromise(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async retryUploadWithResilience(fn: () => Promise<void>, partNumber: number) {
    let attempt = 0;
    while (attempt < this.MAX_CHUNK_UPLOAD_RETRIES) {
      try {
        await fn();
        return;
      } catch (err) {
        attempt++;
        if (isNoSuchUploadError(err, this._userId, this._logger)) {
          // throw this in air to restart the upload from the start
          throw err;
        }
        if (attempt < this.MAX_CHUNK_UPLOAD_RETRIES) {
          const delay = this.RETRY_UPLOAD_DELAY_BASE_MS * Math.pow(2, attempt - 1);
          this._logger.info(`Retry part ${partNumber}, attempt ${attempt} after ${delay}ms`);
          await this.delayPromise(delay);
        } else {
          this._logger.info(`Failed to upload part ${partNumber} after ${this.MAX_CHUNK_UPLOAD_RETRIES} attempts.`);
          throw err;
        }
      }
    }
  }

  private static async setupDirectory(folderPath: string, userId: string, logger: Logger) {
    try {
      if (!fs.existsSync(folderPath)) {
        logger.info('Temp Directory does not exist. Creating...', userId);
        await fs.promises.mkdir(folderPath, { recursive: true });
        logger.info('Temp Directory does not exist. Creation success...', userId);
      }
      else {
        logger.info('Found the temp directory already...', userId);
      }
    } catch (error) {
      logger.error('Failed to create directory', userId, error);
      throw error;
    }
  }

  private async deleteTempFileAsync(): Promise<void> {
    try {
      const filePath = DiskUploader.getFilePath(this._userId, this._tempFileId, this.fileExtension);
      const absPath = path.resolve(filePath);
      await fs.promises.unlink(absPath);
      this._logger.info(`Temp File deleted from disk: ${absPath}`, this._userId);
    } catch (error) {
      this._logger.warn('Could not clean up temp file:', this._userId, error);
    }
  }

  private async tempFileExists(): Promise<boolean> {
    try {
      const filePath = DiskUploader.getFilePath(this._userId, this._tempFileId, this.fileExtension);
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForWritingFlag() {
    const userId = `${this._userId}`;

    const waitPromise = new Promise((resolve) => {
      const waitInterval = setInterval(() => {
        if (this.writing) {
          this._logger.info('Waiting on finish temp file write...', userId);
        } else {
          clearInterval(waitInterval);
          resolve(true);
        }
      }, 500);
    });

    await waitPromise;
    this._logger.info('Finish wait on temp file write...', userId);
  }

  private async finalizeDiskWriting() {
    try {
      await this.waitForWritingFlag();

      // Check if the queue is empty
      if (this.queue.length > 0) {
        // Final attempt to finish the disk write 
        await this.writeWithRetries();
      }

      return true;
    } catch(err) {
      this._logger.info('Critical: Failed to finalise temp file write...', this._userId, err);
      return false;
    }
  }

  private async uploadRecordingToScreenApp(): Promise<boolean> {
    this._logger.info('Uploading recording to screenapp...');
    let attempt = 0;
    let success = false;
    do {
      try {
        this.diskWriteSuccess.flush();

        await this.processRecordingUpload();
        success = true;
      } catch (err) {
        if (isNoSuchUploadError(err, this._userId, this._logger)) {
          attempt += 1;
          this._logger.info('Processing NoSuchUpload error...', this._userId);
          if (attempt >= this.MAX_FILE_UPLOAD_RETRIES) {
            throw err;
          }
          this._logger.info('NoSuchUpload detected, restarting upload session...', this._userId);
        } else {
          throw err;
        }
      }
    } while (!success);

    return success;
  }

  private async uploadRecordingToS3CompatibleStorage(): Promise<boolean> {
    this._logger.info('Uploading recording to S3 compatible storage...');
    const filePath = DiskUploader.getFilePath(this._userId, this._tempFileId, this.fileExtension);
    const chunkSize = this.UPLOAD_CHUNK_SIZE;

    if (!config.s3CompatibleStorage.region || !config.s3CompatibleStorage.accessKeyId || !config.s3CompatibleStorage.secretAccessKey || !config.s3CompatibleStorage.bucket) {
      throw new Error('S3 compatible storage configuration is not set. Will not upload to s3 compatible storage...');
    }

    const fileName = fileNameTemplate(this._namePrefix, getTimeString(this._timezone, this._logger));
    const key = `meeting-bot/${this._userId}/${fileName}${this.fileExtension}`;

    const uploadConfig = {
      endpoint: config.s3CompatibleStorage.endpoint,
      region: config.s3CompatibleStorage.region,
      accessKeyId: config.s3CompatibleStorage.accessKeyId,
      secretAccessKey: config.s3CompatibleStorage.secretAccessKey,
      bucket: config.s3CompatibleStorage.bucket,
      forcePathStyle: config.s3CompatibleStorage.forcePathStyle,
    };

    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this._logger.info(`S3 compatible storage upload attempt ${attempt} of ${maxAttempts}.`);
        const uploadSuccess = await uploadMultipartS3(uploadConfig, filePath, key, this.contentType, this._logger, chunkSize);

        if (!uploadSuccess) {
          throw new Error('Failed to upload recording to S3 compatible storage');
        }

        this._logger.info('S3 compatible storage upload success.');
        return true;
      } catch (err) {
        if (attempt >= maxAttempts) {
          this._logger.error(`Permanently failed to upload recording to S3 compatible storage after ${maxAttempts} attempts`, err);
          throw err;
        } else {
          this._logger.error(`Failed to upload recording to S3 compatible storage attempt ${attempt} of ${maxAttempts}`, err);
          const delay = this.RETRY_UPLOAD_DELAY_BASE_MS * Math.pow(2, attempt);
          await this.delayPromise(delay);
        }
      }
    }

    return false;
  }

  public async uploadRecordingToRemoteStorage(options?: { forceUpload?: boolean }) {
    try {
      if (typeof options?.forceUpload === 'boolean') {
        this.forceUpload = options.forceUpload;
      }

      if (!await this.tempFileExists()) {
        throw new Error(`Unable to access the temp recording file on disk: ${this._userId} ${this._botId}`);
      }

      const goodToGo = await this.finalizeDiskWriting();
      
      if (this.forceUpload) {
        this._logger.info('Force upload is enabled. Ignoring disk writing check results...', { goodToGo });
      } else if (!goodToGo) {
        throw new Error(`Unable to finalise the temp recording file: ${this._userId} ${this._botId}`);
      }

      let uploadResult = false;
      // Upload recording to configured storage
      if (config.uploaderType === 'screenapp') {
        uploadResult = await this.uploadRecordingToScreenApp();
      } else if (config.uploaderType === 's3') {
        uploadResult = await this.uploadRecordingToS3CompatibleStorage();
      } else {
        throw new Error(`Unsupported UPLOADER_TYPE configuration: ${config.uploaderType}`);
      }

      // Delete temp file after the upload is finished
      await this.deleteTempFileAsync();

      return uploadResult;
    } catch (err) {
      this._logger.info('Unable to upload recording to server...', { error: err, userId: this._userId, teamId: this._teamId });
      return false;
    }
  }
}

export default DiskUploader;
