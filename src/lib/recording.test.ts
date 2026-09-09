import assert from 'node:assert/strict';
import test from 'node:test';
import { getRecordingMimeTypesForExtension, mp4MimeType, vp8MimeType, vp9MimeType, webmMimeType } from './recording';

test('real-time WebM capture prefers VP8 with VP9 compatibility fallbacks', () => {
  const { mimeTypes } = getRecordingMimeTypesForExtension('.webm', true);
  assert.equal(mimeTypes.find(() => true), vp8MimeType);
  assert.equal(mimeTypes.find((mimeType) => mimeType !== vp8MimeType), webmMimeType);
  assert.equal(mimeTypes.find((mimeType) => mimeType === vp9MimeType), vp9MimeType);
});

test('real-time MP4 capture retains H.264 preference before WebM fallback', () => {
  const { mimeTypes } = getRecordingMimeTypesForExtension('.mp4', true);
  assert.equal(mimeTypes[0], mp4MimeType);
  assert.equal(mimeTypes.find((mimeType) => mimeType !== mp4MimeType), vp8MimeType);
});
