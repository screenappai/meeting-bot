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

// VP8 encodes far faster than VP9 in real time. VP9 under software GL
// (swiftshader) starves the encoder -> dropped frames + a stuttery, very
// low-bitrate stream that looks laggy on playback. VP8 is the classic
// MediaRecorder screen-capture codec.
export const vp8MimeType = `${webmContentType};codecs=vp8,opus`;

export const getRecordingMimeTypesForExtension = (extension: string, preferVp8 = false) => {
  const webmMimeTypes = preferVp8
    ? [vp8MimeType, webmMimeType, vp9MimeType]
    : [webmMimeType, vp9MimeType];

  if (extension === '.mp4') {
    return {
      mimeTypes: [mp4MimeType, ...webmMimeTypes],
      primaryMimeType: mp4MimeType,
      secondaryMimeType: webmMimeType,
    };
  }

  return {
    mimeTypes: webmMimeTypes,
    primaryMimeType: webmMimeType,
    secondaryMimeType: vp9MimeType,
  };
};
