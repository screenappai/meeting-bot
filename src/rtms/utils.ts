import crypto from 'crypto';

const ZOOM_HOST_SUFFIXES = ['.zoom.us', '.zoom.com', '.zoomgov.com'];

export const normalizeZoomMeetingId = (value: string | number): string => {
  const meetingId = String(value).replace(/\D/g, '');
  if (!meetingId) {
    throw new Error('Zoom meeting ID is missing or invalid');
  }
  return meetingId;
};

export const extractZoomMeetingId = (meetingUrl: string): string => {
  const url = new URL(meetingUrl);
  const hostname = url.hostname.toLowerCase();
  const isZoomHost = hostname === 'zoom.us'
    || hostname === 'zoom.com'
    || hostname === 'zoomgov.com'
    || ZOOM_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));

  if (!isZoomHost) {
    throw new Error('RTMS requires a Zoom meeting URL');
  }

  const pathMatch = url.pathname.match(/\/(?:j|wc\/join)\/(\d+)/i);
  const queryMeetingId = url.searchParams.get('confno');
  return normalizeZoomMeetingId(pathMatch?.[1] ?? queryMeetingId ?? '');
};

export const buildZoomWebhookSignature = (
  rawBody: Buffer | string,
  timestamp: string,
  secret: string
): string => {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const message = `v0:${timestamp}:${body}`;
  return `v0=${crypto.createHmac('sha256', secret).update(message).digest('hex')}`;
};

export const verifyZoomWebhookSignature = ({
  rawBody,
  timestamp,
  signature,
  secret,
  now = Date.now(),
  toleranceSeconds = 300,
}: {
  rawBody?: Buffer;
  timestamp?: string;
  signature?: string;
  secret?: string;
  now?: number;
  toleranceSeconds?: number;
}): boolean => {
  if (!rawBody || !timestamp || !signature || !secret) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;

  const ageSeconds = Math.abs(Math.floor(now / 1000) - timestampSeconds);
  if (ageSeconds > toleranceSeconds) return false;

  const expected = Buffer.from(buildZoomWebhookSignature(rawBody, timestamp, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

export const buildZoomUrlValidationResponse = (plainToken: string, secret: string) => ({
  plainToken,
  encryptedToken: crypto.createHmac('sha256', secret).update(plainToken).digest('hex'),
});
