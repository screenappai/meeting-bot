import { StorageProvider, UploadOptions } from './storage-provider';
import config from '../../config';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  ContainerClient,
  BlockBlobClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

export class AzureBlobStorageProvider implements StorageProvider {
  readonly name = 'azure' as const;

  private getContainerClient(): ContainerClient {
    const cfg = config.azureBlobStorage;

    let serviceClient: BlobServiceClient;

    if (cfg.connectionString) {
      serviceClient = BlobServiceClient.fromConnectionString(cfg.connectionString);
    } else if (cfg.accountName && cfg.sasToken) {
      // SAS token must start with ?; if not, add it
      const sas = cfg.sasToken.startsWith('?') ? cfg.sasToken : `?${cfg.sasToken}`;
      const url = `https://${cfg.accountName}.blob.core.windows.net${sas}`;
      serviceClient = new BlobServiceClient(url);
    } else if (cfg.accountName && cfg.accountKey) {
      const cred = new StorageSharedKeyCredential(cfg.accountName, cfg.accountKey);
      serviceClient = new BlobServiceClient(`https://${cfg.accountName}.blob.core.windows.net`, cred);
    } else if (cfg.accountName && cfg.useManagedIdentity) {
      const cred = new DefaultAzureCredential();
      serviceClient = new BlobServiceClient(`https://${cfg.accountName}.blob.core.windows.net`, cred);
    } else {
      throw new Error('Azure Blob Storage configuration incomplete. Provide connection string OR (account+sas/account+key/managed identity).');
    }

    if (!cfg.container) {
      throw new Error('AZURE_STORAGE_CONTAINER is required.');
    }

    return serviceClient.getContainerClient(cfg.container);
  }

  validateConfig(): void {
    // Will throw if invalid
    this.getContainerClient();
  }

  async uploadFile(options: UploadOptions): Promise<boolean> {
    const container = this.getContainerClient();
    const blobName = options.key; // key is full path decided by caller to preserve layout parity
    const blob: BlockBlobClient = container.getBlockBlobClient(blobName);

    try {
      options.logger.info(`Starting Azure Blob upload for ${blobName}`);
      await blob.uploadFile(options.filePath, {
        blobHTTPHeaders: { blobContentType: options.contentType },
        concurrency: options.concurrency ?? config.azureBlobStorage.uploadConcurrency ?? 4,
        onProgress: (p: { loadedBytes?: number }) => {
          if (p.loadedBytes) {
            options.logger.info(`Azure upload progress ${blobName}: ${p.loadedBytes} bytes`);
          }
        },
      });
      options.logger.info(`Azure upload complete for ${blobName}`);
      return true;
    } catch (err) {
      options.logger.error(`Azure upload failed for ${blobName}`, err as any);
      return false;
    }
  }

  async getSignedUrl(key: string, options?: { expiresInSeconds?: number; contentType?: string }): Promise<string> {
    const container = this.getContainerClient();
    const blobName = key; // use key as-is
    const expiresIn = options?.expiresInSeconds ?? config.azureBlobStorage.signedUrlTtlSeconds ?? 3600;

    // Determine credential type for SAS
    const cfg = config.azureBlobStorage;
    const baseUrl = container.getBlockBlobClient(blobName).url.split('?')[0];

    if (cfg.accountName && cfg.accountKey) {
      const cred = new StorageSharedKeyCredential(cfg.accountName, cfg.accountKey);
      const sas = generateBlobSASQueryParameters({
        containerName: container.containerName,
        blobName,
        permissions: BlobSASPermissions.parse('r'),
        expiresOn: new Date(Date.now() + expiresIn * 1000),
        protocol: SASProtocol.Https,
      }, cred).toString();
      return `${baseUrl}?${sas}`;
    }

    // If we have connection string with key, it is handled above; with SAS, URL already has SAS for container but not blob-specific; we can return blob URL with container SAS
    if (cfg.connectionString || (cfg.accountName && cfg.sasToken)) {
      // Container SAS should suffice to access blobs inside; ensure token is appended
      const sas = cfg.connectionString ? '' : (cfg.sasToken || '');
      const token = sas.startsWith('?') ? sas.substring(1) : sas; // strip leading ? if present
      const sep = baseUrl.includes('?') ? '&' : '?';
      return token ? `${baseUrl}${sep}${token}` : baseUrl;
    }

    // Managed identity / AAD: create User Delegation SAS
    if (cfg.accountName && cfg.useManagedIdentity) {
      const cred = new DefaultAzureCredential();
      const service = new BlobServiceClient(`https://${cfg.accountName}.blob.core.windows.net`, cred);
      const key = await service.getUserDelegationKey(new Date(), new Date(Date.now() + expiresIn * 1000));
      const sas = generateBlobSASQueryParameters({
        containerName: container.containerName,
        blobName,
        permissions: BlobSASPermissions.parse('r'),
        expiresOn: new Date(Date.now() + expiresIn * 1000),
        protocol: SASProtocol.Https,
      }, key, cfg.accountName).toString();
      return `${baseUrl}?${sas}`;
    }

    throw new Error('Unable to generate SAS URL: no suitable credentials available. Provide account key or enable managed identity, or provide a SAS token.');
  }

  async exists(key: string): Promise<boolean> {
    const container = this.getContainerClient();
    return container.getBlockBlobClient(key).exists();
  }

  async delete(key: string): Promise<void> {
    const container = this.getContainerClient();
    await container.deleteBlob(key, { deleteSnapshots: 'include' });
  }

  async list(prefix: string): Promise<string[]> {
    const container = this.getContainerClient();
    const names: string[] = [];
    for await (const blob of container.listBlobsFlat({ prefix })) {
      names.push(blob.name);
    }
    return names;
  }
}
