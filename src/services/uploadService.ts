import axios from 'axios';
import moment from 'moment-timezone';
import { ContentType, FileType, IVFSResponse } from '../types';
import { createApiV2 } from '../util/auth';
import { Logger } from 'winston';

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
  let time;
  try {
    if (!moment.tz.zone(timezone))
      throw new Error(`Unsupported timezone: ${timezone}`);

    time = moment().tz(timezone).format('h:mma MMM DD YYYY');
  } catch (error) {
    logger.warn('Using UTC time, found an invalid timezone on team:', teamId, timezone, error);
    time = moment().format('h:mma MMM DD YYYY');
  }
  const response = await apiV2.put<IVFSResponse<FinalizeUploadResponseBody>>(
    `/files/upload/multipart/finalize/${teamId}/${folderId}/${fileId}/${uploadId}`,
    {
      file: {
        contentType,
        name: `${namePrefix} ${time}`,
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
