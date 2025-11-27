import { StorageProvider, UploadOptions } from './storage-provider';
import config from '../../config';
import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'fs';

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;

  validateConfig(): void {
    const s3 = config.s3CompatibleStorage;
    const missing: string[] = [];
    if (!s3.region) missing.push('S3_REGION');
    if (!s3.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
    if (!s3.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
    if (!s3.bucket) missing.push('S3_BUCKET_NAME');
    if (missing.length) {
      throw new Error(`S3 compatible storage configuration is not set or incomplete. Missing: ${missing.join(', ')}`);
    }
  }

  async uploadFile(options: UploadOptions): Promise<boolean> {
    const s3Config = config.s3CompatibleStorage;

    // TypeScript knows these are defined because validateConfig() was called first
    if (!s3Config.region || !s3Config.accessKeyId || !s3Config.secretAccessKey || !s3Config.bucket) {
      throw new Error('S3 configuration validation failed - this should never happen after validateConfig()');
    }

    const clientConfig: S3ClientConfig = {
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: !!s3Config.forcePathStyle,
    };

    if (s3Config.endpoint) {
      clientConfig.endpoint = s3Config.endpoint;
    }

    const s3Client = new S3Client(clientConfig);

    try {
      options.logger.info(`Starting upload of ${options.key}`);
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: s3Config.bucket,
          Key: options.key,
          Body: createReadStream(options.filePath),
          ContentType: options.contentType,
        },
        queueSize: options.concurrency || 4,
        partSize: options.partSize || 50 * 1024 * 1024,
      });

      upload.on('httpUploadProgress', (progress) => {
        options.logger.info(`Uploaded ${options.key} ${progress.loaded} of ${progress.total || 0} bytes`);
      });

      await upload.done();
      options.logger.info(`Upload of ${options.key} complete.`);
      return true;
    } catch (err) {
      options.logger.error(`Upload for ${options.key} failed.`, err);
      return false;
    }
  }
}
