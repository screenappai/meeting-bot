import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildZoomWebhookSignature,
  extractZoomMeetingId,
  verifyZoomWebhookSignature,
} from './utils';

test('extracts a meeting ID from Zoom join URLs', () => {
  assert.equal(
    extractZoomMeetingId('https://us05web.zoom.us/j/12345678901?pwd=secret'),
    '12345678901'
  );
  assert.equal(
    extractZoomMeetingId('https://zoom.us/wc/join/123456789'),
    '123456789'
  );
});

test('rejects non-Zoom meeting URLs', () => {
  assert.throws(() => extractZoomMeetingId('https://example.com/j/123456789'));
});

test('verifies signed Zoom webhooks within the timestamp tolerance', () => {
  const body = Buffer.from('{"event":"meeting.rtms_started"}');
  const timestamp = '1720000000';
  const secret = 'webhook-secret';
  const signature = buildZoomWebhookSignature(body, timestamp, secret);

  assert.equal(verifyZoomWebhookSignature({
    rawBody: body,
    timestamp,
    signature,
    secret,
    now: 1_720_000_100_000,
  }), true);
  assert.equal(verifyZoomWebhookSignature({
    rawBody: body,
    timestamp,
    signature,
    secret,
    now: 1_720_001_000_000,
  }), false);
});
