import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'fs';
import { ContentType } from '../types';
import { Logger } from 'winston';

/**
 * The configuration for the upload.
 */
interface UploadConfig {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

/**
 * Uploads a file to an S3-compatible storage.
 * @param uploadConfig - The configuration for the upload.
 * @param filePath - The path to the file to upload.
 * @param key - The key to use for the upload.
 * @param logger - The logger to use for logging.
 */
export async function uploadMultipartS3(
  uploadConfig: UploadConfig,
  filePath: string,
  key: string,
  contentType: ContentType,
  logger: Logger,
  partSize: number = 50 * 1024 * 1024,
  queueSize: number = 4
): Promise<boolean> {
  const clientConfig: S3ClientConfig = {
    region: uploadConfig.region,
    credentials: {
      accessKeyId: uploadConfig.accessKeyId,
      secretAccessKey: uploadConfig.secretAccessKey,
    },
    forcePathStyle: uploadConfig.forcePathStyle,
  };
  if (uploadConfig.endpoint) {
    clientConfig.endpoint = uploadConfig.endpoint;
  }

  const s3 = new S3Client(clientConfig);

  try {
    logger.info(`Starting upload of ${key}`);
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: uploadConfig.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: contentType,
      },
      queueSize,
      partSize,
    });

    upload.on('httpUploadProgress', (progress) => {
      logger.info(`Uploaded ${key} ${progress.loaded} of ${progress.total || 0} bytes`);
    });

    await upload.done();
    logger.info(`Upload of ${key} complete.`);
    return true;
  } catch (err) {
    logger.error(`Upload for ${key} failed.`, err);
    return false;
  }
}
