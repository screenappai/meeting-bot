import axios from 'axios';
import crypto from 'crypto';
import { Logger } from 'winston';
import config from '../config';
import { createClient, RedisClientType } from 'redis';
import { KnownError } from '../error';
import { getErrorType } from '../util/logger';

export interface RecordingCompletedPayload {
  recordingId: string;
  meetingLink?: string;
  status: 'completed' | string;
  blobUrl?: string; // generic storage url (S3, Azure blob, etc.)
  timestamp: string; // ISO string
  metadata?: Record<string, any>;
}

export interface MeetingFailedPayload {
  recordingId: string;
  meetingLink?: string;
  status: 'failed';
  timestamp: string;
  error: {
    type: string;
    message: string;
    name?: string;
    retryable?: boolean;
    maxRetries?: number;
  };
  metadata: {
    userId: string;
    teamId: string;
    botId?: string;
    eventId?: string;
    provider?: string;
    meetingName?: string;
    timezone?: string;
  };
}

export interface MeetingFailureContext {
  url: string;
  name?: string;
  teamId: string;
  timezone?: string;
  userId: string;
  botId?: string;
  eventId?: string;
  provider?: string;
}

type RedisNotificationPayload = RecordingCompletedPayload | MeetingFailedPayload;

function signPayload(body: string, secret?: string): string | undefined {
  if (!secret) return undefined;
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function sendWebhook(payload: RecordingCompletedPayload, logger: Logger) {
  if (!config.notifyWebhookEnabled) return;
  if (!config.notifyWebhookUrl) {
    logger.warn('Webhook enabled but NOTIFY_WEBHOOK_URL is not set. Skipping.');
    return;
  }

  const body = JSON.stringify(payload);
  const signature = signPayload(body, config.notifyWebhookSecret);

  try {
    await axios.post(config.notifyWebhookUrl, body, {
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Webhook-Signature': signature } : {}),
      },
      timeout: 10000,
    });
    logger.info('Recording completed webhook delivered.');
  } catch (err) {
    logger.error('Failed to deliver recording webhook', err as any);
  }
}

async function rpushToRedisList(
  payload: RedisNotificationPayload,
  logger: Logger,
  list: string,
  logLabel: string
) {
  if (!config.notifyRedisEnabled) return;

  const uri = config.notifyRedisUri || config.redisUri;
  let db = config.notifyRedisDb;

  if (!uri) {
    logger.warn('Redis notification enabled but no URI available. Skipping.');
    return;
  }
  if (typeof db !== 'number') {
    logger.warn('Redis notification DB is invalid. Skipping.');
    return;
  }
  // Enforce DB not 0: if 0 is set, switch to 1 and warn
  if (db === 0) {
    logger.warn('NOTIFY_REDIS_DB was set to 0. Switching to DB 1 as DB 0 is not allowed for notifications.');
    db = 1;
  }

  let client: RedisClientType | null = null;
  try {
    client = createClient({ url: uri, database: db, name: 'meetbot-notify' });
    client.on('error', (e) => logger.error('notify redis client error', e));
    await client.connect();
    const body = JSON.stringify(payload);
    await client.rPush(list, body);
    logger.info(`${logLabel} payload pushed to Redis list ${list} on DB ${db}.`);
  } catch (err) {
    logger.error(`Failed to push ${logLabel.toLowerCase()} notification to Redis`, err as any);
  } finally {
    try {
      if (client) await client.quit();
    } catch {}
  }
}

export async function notifyRecordingCompleted(payload: RecordingCompletedPayload, logger: Logger) {
  // both notification channels are optional; do both if enabled
  await Promise.allSettled([
    sendWebhook(payload, logger),
    rpushToRedisList(payload, logger, config.notifyRedisList, 'Recording completed'),
  ]);
}

export function createMeetingFailedPayload(context: MeetingFailureContext, error: unknown): MeetingFailedPayload {
  const entityId = context.botId ?? context.eventId ?? context.userId;
  const errorType = getErrorType(error);
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');

  return {
    recordingId: entityId,
    meetingLink: context.url,
    status: 'failed',
    timestamp: new Date().toISOString(),
    error: {
      type: errorType,
      message,
      ...(error instanceof Error ? { name: error.name } : {}),
      ...(error instanceof KnownError ? {
        retryable: error.retryable,
        maxRetries: error.maxRetries,
      } : {}),
    },
    metadata: {
      userId: context.userId,
      teamId: context.teamId,
      botId: context.botId,
      eventId: context.eventId,
      provider: context.provider,
      meetingName: context.name,
      timezone: context.timezone,
    },
  };
}

export async function notifyMeetingFailed(payload: MeetingFailedPayload, logger: Logger) {
  await rpushToRedisList(payload, logger, config.notifyRedisFailureList, 'Meeting failed');
}
