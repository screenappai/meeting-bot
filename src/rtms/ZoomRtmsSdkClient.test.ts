import assert from 'node:assert/strict';
import test from 'node:test';
import { buildZoomRtmsSdkJoinParams } from './ZoomRtmsSdkClient';
import { ZoomRtmsAppCredentials, ZoomRtmsPayload } from './types';

test('builds SDK join parameters from the resolved RTMS app', () => {
  const app: ZoomRtmsAppCredentials = {
    appId: 'customer-app',
    clientId: 'customer-client',
    clientSecret: 'customer-secret',
    webhookSecret: 'customer-webhook-secret',
  };
  const payload: ZoomRtmsPayload = {
    meeting_uuid: 'meeting-uuid',
    rtms_stream_id: 'stream-id',
    server_urls: 'wss://rtms.example.test',
  };

  assert.deepEqual(buildZoomRtmsSdkJoinParams(payload, app, 12_000), {
    meeting_uuid: 'meeting-uuid',
    rtms_stream_id: 'stream-id',
    server_urls: 'wss://rtms.example.test',
    client: 'customer-client',
    secret: 'customer-secret',
    timeout: 12_000,
    pollInterval: 10,
    is_verify_cert: 1,
  });
});
