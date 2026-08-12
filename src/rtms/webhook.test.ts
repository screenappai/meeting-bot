import assert from 'node:assert/strict';
import test from 'node:test';
import { Request, Response } from 'express';
import config from '../config';
import { zoomRtmsEventStore } from './ZoomRtmsEventStore';
import { buildZoomWebhookSignature, buildZoomUrlValidationResponse } from './utils';
import { handleZoomRtmsWebhook } from './webhook';

interface TestResponse {
  statusCode: number;
  body?: unknown;
  status(code: number): TestResponse;
  json(body: unknown): TestResponse;
  sendStatus(code: number): TestResponse;
}

const createResponse = (): TestResponse => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
  sendStatus(code) {
    this.statusCode = code;
    return this;
  },
});

const send = async ({
  body,
  timestamp,
  signature,
  webhookId,
}: {
  body: Record<string, unknown>;
  timestamp?: string;
  signature?: string;
  webhookId?: string;
}): Promise<TestResponse> => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const req = {
    body,
    rawBody,
    headers: {
      'x-zm-request-timestamp': timestamp,
      'x-zm-signature': signature,
    },
    params: webhookId ? { webhookId } : {},
  } as unknown as Request;
  const res = createResponse();
  await handleZoomRtmsWebhook(req, res as unknown as Response);
  return res;
};

test('validates Zoom challenges and signed RTMS events', async () => {
  const originalSecret = config.zoomRtms.webhookSecret;
  const originalCustomerCredentials = config.zoomRtms.customerCredentials;
  const originalRedisEnabled = config.isRedisEnabled;
  config.zoomRtms.webhookSecret = 'webhook-secret';
  config.zoomRtms.customerCredentials = {
    ...originalCustomerCredentials,
    'dedicated-team': {
      enabled: true,
      accountId: 'account-id',
      clientId: 'oauth-client-id',
      clientSecret: 'oauth-client-secret',
      participantUserId: 'operator-id',
      rtmsApp: {
        webhookId: 'dedicated-app-1234',
        clientId: 'rtms-client-id',
        clientSecret: 'rtms-client-secret',
        webhookSecret: 'dedicated-webhook-secret',
      },
    },
    'disabled-team': {
      enabled: false,
      accountId: 'disabled-account-id',
      clientId: 'disabled-oauth-client-id',
      clientSecret: 'disabled-oauth-client-secret',
      participantUserId: 'disabled-operator-id',
      rtmsApp: {
        webhookId: 'disabled-app-1234',
        clientId: 'disabled-rtms-client-id',
        clientSecret: 'disabled-rtms-client-secret',
        webhookSecret: 'disabled-webhook-secret',
      },
    },
  };
  config.isRedisEnabled = false;
  const eventScope = { appId: 'global', customerId: 'team-a', operatorId: 'operator-id' };
  const dedicatedScope = {
    appId: 'dedicated-app-1234',
    customerId: 'dedicated-team',
    operatorId: 'operator-id',
  };

  try {
    await zoomRtmsEventStore.reserveMeeting(
      '12345678901',
      'webhook-test-owner',
      60,
      eventScope
    );
    await zoomRtmsEventStore.reserveMeeting(
      '12345678901',
      'dedicated-webhook-test-owner',
      60,
      dedicatedScope
    );
    const challenge = await send({
      body: {
        event: 'endpoint.url_validation',
        payload: { plainToken: 'plain-token' },
      },
    });
    assert.equal(challenge.statusCode, 200);
    assert.deepEqual(
      challenge.body,
      buildZoomUrlValidationResponse('plain-token', 'webhook-secret')
    );

    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = {
      event: 'meeting.rtms_started',
      event_ts: Date.now(),
      payload: {
        meeting_uuid: 'meeting-uuid',
        meeting_id: '12345678901',
        operator_id: 'operator-id',
        rtms_stream_id: 'stream-id',
        server_urls: 'wss://rtms.zoom.us',
      },
    };
    const signed = await send({
      body,
      timestamp,
      signature: buildZoomWebhookSignature(
        JSON.stringify(body),
        timestamp,
        'webhook-secret'
      ),
    });
    assert.equal(signed.statusCode, 204);
    assert.equal(
      (
        await zoomRtmsEventStore.waitForMeetingStart(
          '12345678901',
          eventScope,
          1
        )
      )?.payload.rtms_stream_id,
      'stream-id'
    );

    const rejected = await send({
      body,
      timestamp,
      signature: 'v0=invalid',
    });
    assert.equal(rejected.statusCode, 401);

    const dedicatedChallenge = await send({
      webhookId: 'dedicated-app-1234',
      body: {
        event: 'endpoint.url_validation',
        payload: { plainToken: 'dedicated-plain-token' },
      },
    });
    assert.deepEqual(
      dedicatedChallenge.body,
      buildZoomUrlValidationResponse(
        'dedicated-plain-token',
        'dedicated-webhook-secret'
      )
    );

    const dedicatedBody = {
      ...body,
      event_ts: Date.now() + 1,
      payload: {
        ...body.payload,
        rtms_stream_id: 'dedicated-stream-id',
      },
    };
    const dedicatedSigned = await send({
      webhookId: 'dedicated-app-1234',
      body: dedicatedBody,
      timestamp,
      signature: buildZoomWebhookSignature(
        JSON.stringify(dedicatedBody),
        timestamp,
        'dedicated-webhook-secret'
      ),
    });
    assert.equal(dedicatedSigned.statusCode, 204);
    assert.equal(
      (
        await zoomRtmsEventStore.waitForMeetingStart(
          '12345678901',
          dedicatedScope,
          1
        )
      )?.payload.rtms_stream_id,
      'dedicated-stream-id'
    );

    const wrongAppSecret = await send({
      webhookId: 'dedicated-app-1234',
      body: dedicatedBody,
      timestamp,
      signature: buildZoomWebhookSignature(
        JSON.stringify(dedicatedBody),
        timestamp,
        'webhook-secret'
      ),
    });
    assert.equal(wrongAppSecret.statusCode, 401);

    const unknownApp = await send({
      webhookId: 'unknown-dedicated-app',
      body: dedicatedBody,
      timestamp,
      signature: buildZoomWebhookSignature(
        JSON.stringify(dedicatedBody),
        timestamp,
        'dedicated-webhook-secret'
      ),
    });
    assert.equal(unknownApp.statusCode, 404);

    const disabledApp = await send({
      webhookId: 'disabled-app-1234',
      body: dedicatedBody,
      timestamp,
      signature: buildZoomWebhookSignature(
        JSON.stringify(dedicatedBody),
        timestamp,
        'disabled-webhook-secret'
      ),
    });
    assert.equal(disabledApp.statusCode, 404);
  } finally {
    await zoomRtmsEventStore.releaseMeeting(
      '12345678901',
      'webhook-test-owner',
      eventScope
    );
    await zoomRtmsEventStore.releaseMeeting(
      '12345678901',
      'dedicated-webhook-test-owner',
      dedicatedScope
    );
    config.zoomRtms.webhookSecret = originalSecret;
    config.zoomRtms.customerCredentials = originalCustomerCredentials;
    config.isRedisEnabled = originalRedisEnabled;
  }
});
