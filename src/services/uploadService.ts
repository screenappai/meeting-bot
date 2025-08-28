import axios from 'axios';
import { ContentType, FileType, IVFSResponse } from '../types';
import { createApiV2 } from '../util/auth';
import { Logger } from 'winston';
import { getTimeString } from '../lib/datetime';

export const fileNameTemplate = (namePrefix: string, time: string) => `${namePrefix} ${time}`;

interface InitializeMultipartUploadOptions {
  teamId: string;
  folderId: string;
  contentType: ContentType;
  token: string;
}
interface InitializeMultipartUploadResponse {
  fileId: string;
  uploadId: string;
}

export const initializeMultipartUpload = async ({
  teamId,
  folderId,
  contentType,
  token,
}: InitializeMultipartUploadOptions) => {
  const apiV2 = createApiV2(token);
  const response = await apiV2.put<
    IVFSResponse<InitializeMultipartUploadResponse>
  >(`/files/upload/multipart/init/${teamId}/${folderId}`, {
    contentType,
  });
  return response.data.data;
};

interface CreatePartUploadUrl {
  teamId: string;
  folderId: string;
  fileId: string;
  uploadId: string;
  partNumber: number;
  contentType: ContentType;
  token: string;
}

interface PartUploadUrlResponse {
  uploadUrl: string;
}

export const createPartUploadUrl = async ({
  teamId,
  folderId,
  fileId,
  uploadId,
  partNumber,
  contentType,
  token,
}: CreatePartUploadUrl) => {
  const apiV2 = createApiV2(token);
  const response = await apiV2.put<IVFSResponse<PartUploadUrlResponse>>(
    `/files/upload/multipart/url/${teamId}/${folderId}/${fileId}/${uploadId}/${partNumber}`,
    {
      contentType,
    }
  );
  return response.data.data.uploadUrl;
};

type FinalizeUploadOptions = {
  teamId: string;
  folderId: string;
  fileId: string;
  uploadId: string;
  contentType: ContentType;
  token: string;
  timezone: string;
  namePrefix: string;
  botId: string;
};
interface FinalizeUploadResponseBody {
  file: FileType;
}

export const finalizeUpload = async ({
  teamId,
  folderId,
  fileId,
  uploadId,
  contentType,
  token,
  timezone,
  namePrefix,
  botId,
}: FinalizeUploadOptions, logger: Logger) => {
  const apiV2 = createApiV2(token);
  const time = getTimeString(timezone, logger);
  
  const response = await apiV2.put<IVFSResponse<FinalizeUploadResponseBody>>(
    `/files/upload/multipart/finalize/${teamId}/${folderId}/${fileId}/${uploadId}`,
    {
      file: {
        contentType,
        name: fileNameTemplate(namePrefix, time),
        botId: botId,
      },
    }
  );
  return response.data.data.file;
};

export const uploadChunkToStorage = async ({
  uploadUrl,
  chunk,
}: {
  uploadUrl: string;
  chunk: Blob;
}, logger: Logger) => {
  if (!uploadUrl) {
    throw new Error('No upload URL provided');
  }
  try {
    const x = await axios.put(uploadUrl, chunk, {
      headers: {
        'Content-Type': chunk.type,
      },
    });
    return x;
  } catch (error) {
    logger.error('Error uploading chunk to bucket', error);
    throw error;
  }
};
