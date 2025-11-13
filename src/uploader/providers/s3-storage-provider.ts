import { StorageProvider, UploadOptions } from './storage-provider';
import { uploadMultipartS3 } from '../s3-compatible-storage';
import config from '../../config';

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
    const s3 = config.s3CompatibleStorage;
    return uploadMultipartS3(
      {
        endpoint: s3.endpoint,
        region: s3.region!,
        accessKeyId: s3.accessKeyId!,
        secretAccessKey: s3.secretAccessKey!,
        bucket: s3.bucket!,
        forcePathStyle: !!s3.forcePathStyle,
      },
      options.filePath,
      options.key,
      options.contentType,
      options.logger,
      options.partSize,
      options.concurrency
    );
  }
}
