import { ContentType } from '../types';

export const mp4Codecs = {
  h264: 'avc1.42E01E',
  h264_high: 'avc1.640028',
  aac: 'mp4a.40.2'
};

export const mp4ContentType: ContentType = 'video/mp4';
export const mp4MimeType = `${mp4ContentType};codecs="${mp4Codecs.h264},${mp4Codecs.aac}"`;

export const webmContentType: ContentType = 'video/webm';
export const webmMimeType = `${webmContentType};codecs=vp9,opus`;

export const vp9ContentType: ContentType = 'video/webm';
export const vp9MimeType = `${vp9ContentType};codecs=vp09.00.10.08,opus`;

export const getRecordingMimeTypesForExtension = (extension: string) => {
  const webmVp9MimeTypes = [webmMimeType, vp9MimeType];

  if (extension === '.mp4') {
    return {
      mimeTypes: [mp4MimeType, ...webmVp9MimeTypes],
      primaryMimeType: mp4MimeType,
      secondaryMimeType: webmMimeType,
    };
  }

  return {
    mimeTypes: webmVp9MimeTypes,
    primaryMimeType: webmMimeType,
    secondaryMimeType: vp9MimeType,
  };
};
