import express, { Request, Response } from 'express';
import config from '../config';
import { zoomRtmsEventStore } from './ZoomRtmsEventStore';
import { ZoomRtmsEventName, ZoomRtmsWebhookEvent, ZoomWebhookBody } from './types';
import {
  buildZoomUrlValidationResponse,
  verifyZoomWebhookSignature,
} from './utils';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const RTMS_EVENTS = new Set<ZoomRtmsEventName>([
  'meeting.rtms_started',
  'meeting.rtms_stopped',
  'meeting.rtms_interrupted',
]);

export const captureRawBody = (req: Request, _res: unknown, buffer: Buffer): void => {
  (req as RawBodyRequest).rawBody = Buffer.from(buffer);
};

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const router = express.Router();

const resolveWebhook = (
  webhookId?: string
): { appId: string; secret?: string } | undefined => {
  if (typeof webhookId === 'undefined') {
    return { appId: 'global', secret: config.zoomRtms.webhookSecret };
  }

  const credentials = Object.values(config.zoomRtms.customerCredentials)
    .find((customer) =>
      customer.enabled
      && customer.rtmsApp?.webhookId === webhookId
    );
  return credentials?.rtmsApp
    ? { appId: webhookId, secret: credentials.rtmsApp.webhookSecret }
    : undefined;
};

export const handleZoomRtmsWebhook = async (req: RawBodyRequest, res: Response) => {
  const body = req.body as ZoomWebhookBody;
  const webhook = resolveWebhook(req.params?.webhookId);
  if (!webhook) {
    return res.status(404).json({ error: 'Zoom RTMS webhook is not configured' });
  }
  const { appId, secret } = webhook;

  if (body.event === 'endpoint.url_validation') {
    const plainToken = body.payload?.plainToken;
    if (typeof plainToken !== 'string' || !secret) {
      return res.status(503).json({ error: 'Zoom RTMS webhook is not configured' });
    }
    return res.json(buildZoomUrlValidationResponse(plainToken, secret));
  }

  const verified = verifyZoomWebhookSignature({
    rawBody: req.rawBody,
    timestamp: headerValue(req.headers['x-zm-request-timestamp']),
    signature: headerValue(req.headers['x-zm-signature']),
    secret,
  });
  if (!verified) {
    return res.status(401).json({ error: 'Invalid Zoom webhook signature' });
  }

  if (!body.event || !RTMS_EVENTS.has(body.event as ZoomRtmsEventName)) {
    return res.sendStatus(204);
  }

  const payload = body.payload;
  if (
    typeof body.event_ts !== 'number'
    || !Number.isFinite(body.event_ts)
    || !payload
    || typeof payload.meeting_uuid !== 'string'
    || typeof payload.rtms_stream_id !== 'string'
  ) {
    return res.status(400).json({ error: 'Invalid Zoom RTMS webhook payload' });
  }

  if (
    body.event === 'meeting.rtms_started'
    && (
      !['string', 'number'].includes(typeof payload.meeting_id)
      || typeof payload.operator_id !== 'string'
      || typeof payload.server_urls !== 'string'
    )
  ) {
    return res.status(400).json({ error: 'Invalid Zoom RTMS start event' });
  }

  if (
    body.event === 'meeting.rtms_stopped'
    && (typeof payload.stop_reason !== 'number' || !Number.isFinite(payload.stop_reason))
  ) {
    return res.status(400).json({ error: 'Invalid Zoom RTMS stop event' });
  }

  const event: ZoomRtmsWebhookEvent = {
    event: body.event as ZoomRtmsEventName,
    event_ts: body.event_ts,
    payload: payload as ZoomRtmsWebhookEvent['payload'],
  };

  try {
    await zoomRtmsEventStore.publish(event, appId);
    return res.sendStatus(204);
  } catch (error) {
    console.error('Unable to persist Zoom RTMS webhook event', error);
    return res.status(503).json({ error: 'Zoom RTMS event queue unavailable' });
  }
};

router.post('/', handleZoomRtmsWebhook);
router.post('/apps/:webhookId', handleZoomRtmsWebhook);

export default router;
