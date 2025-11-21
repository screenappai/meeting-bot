import { Logger } from 'winston';
import { ContentType } from '../../types';

export interface UploadOptions {
  filePath: string;
  key: string;
  contentType: ContentType;
  logger: Logger;
  partSize?: number;
  concurrency?: number;
}

export interface StorageProvider {
  readonly name: 's3' | 'azure';
  validateConfig(): void;
  uploadFile(options: UploadOptions): Promise<boolean>;
  getSignedUrl?(key: string, options?: { expiresInSeconds?: number; contentType?: string }): Promise<string>;
  exists?(key: string): Promise<boolean>;
  delete?(key: string): Promise<void>;
  list?(prefix: string): Promise<string[]>;
}
