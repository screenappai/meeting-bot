import axios from 'axios';
import crypto from 'crypto';
import { Logger } from 'winston';
import config from '../config';
import { createClient, RedisClientType } from 'redis';

export interface RecordingCompletedPayload {
  recordingId: string;
  meetingLink?: string;
  status: 'completed' | string;
  blobUrl?: string; // generic storage url (S3, Azure blob, etc.)
  timestamp: string; // ISO string
  metadata?: Record<string, any>;
}

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

async function rpushToRedisList(payload: RecordingCompletedPayload, logger: Logger) {
  if (!config.notifyRedisEnabled) return;

  const uri = config.notifyRedisUri || config.redisUri;
  let db = config.notifyRedisDb;
  const list = config.notifyRedisList;

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
    logger.info(`Recording completed payload pushed to Redis list ${list} on DB ${db}.`);
  } catch (err) {
    logger.error('Failed to push recording notification to Redis', err as any);
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
    rpushToRedisList(payload, logger),
  ]);
}
