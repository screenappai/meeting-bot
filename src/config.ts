import dotenv from 'dotenv';
import path from 'node:path';
import { UploaderType } from './types';
dotenv.config();

const ENVIRONMENTS = [
  'production',
  'staging',
  'development',
  'cli',
  'test',
] as const;

export type Environment = (typeof ENVIRONMENTS)[number];
export const NODE_ENV: Environment = ENVIRONMENTS.includes(
  process.env.NODE_ENV as Environment
)
  ? (process.env.NODE_ENV as Environment)
  : 'staging';

console.log('NODE_ENV', process.env.NODE_ENV);

export interface ZoomRtmsCustomerCredentials {
  enabled: boolean;
  /** Server-to-Server OAuth account ID. */
  accountId: string;
  /** Server-to-Server OAuth client ID. */
  clientId: string;
  /** Server-to-Server OAuth client secret. */
  clientSecret: string;
  participantUserId: string;
  rtmsApp?: ZoomRtmsCustomerAppCredentials;
}

export type ZoomRtmsCustomerCredentialMode =
  | 'auto'
  | 'shared_customer'
  | 'dedicated_customer';

export interface ZoomRtmsCustomerAppCredentials {
  webhookId: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

export interface ZoomRtmsCustomerCredentialsParseResult {
  credentials: Record<string, ZoomRtmsCustomerCredentials>;
  entryErrors: Record<string, string>;
  error?: string;
}

export interface ZoomChromeCustomerStorageStatePathsParseResult {
  paths: Record<string, string>;
  entryErrors: Record<string, string>;
  error?: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value);

const isValidExactId = (value: string): boolean =>
  Boolean(value)
  && value.trim() === value
  && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);

const isValidWebhookId = (value: string): boolean =>
  /^[A-Za-z0-9_-]{1,128}$/.test(value)
  && value !== 'global';

export const parseZoomRtmsCustomerCredentials = (
  rawValue?: string,
  credentialMode: ZoomRtmsCustomerCredentialMode = 'auto'
): ZoomRtmsCustomerCredentialsParseResult => {
  const credentials: Record<string, ZoomRtmsCustomerCredentials> = Object.create(null);
  const entryErrors: Record<string, string> = Object.create(null);
  const teamByWebhookId = new Map<string, string>();
  if (!rawValue?.trim()) return { credentials, entryErrors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return {
      credentials,
      entryErrors,
      error: 'ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON must contain valid JSON',
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      credentials,
      entryErrors,
      error: 'ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON must be an object keyed by teamId',
    };
  }

  for (const [teamId, value] of Object.entries(parsed)) {
    if (!isValidExactId(teamId) || !isPlainObject(value)) {
      entryErrors[teamId] = 'customer credentials must be an object';
      continue;
    }

    const invalidFields: string[] = [];
    if (typeof value.enabled !== 'boolean') invalidFields.push('enabled');
    for (const field of ['accountId', 'clientId', 'clientSecret', 'participantUserId'] as const) {
      if (typeof value[field] !== 'string' || !value[field].trim()) {
        invalidFields.push(field);
      }
    }

    if (invalidFields.length > 0) {
      entryErrors[teamId] = `invalid or missing fields: ${invalidFields.join(', ')}`;
      continue;
    }

    let rtmsApp: ZoomRtmsCustomerAppCredentials | undefined;
    if (typeof value.rtmsApp !== 'undefined') {
      if (!isPlainObject(value.rtmsApp)) {
        entryErrors[teamId] = 'rtmsApp must be an object';
        continue;
      }

      const invalidAppFields: string[] = [];
      for (const field of ['webhookId', 'clientId', 'clientSecret', 'webhookSecret'] as const) {
        if (typeof value.rtmsApp[field] !== 'string' || !value.rtmsApp[field].trim()) {
          invalidAppFields.push(`rtmsApp.${field}`);
        }
      }
      if (
        typeof value.rtmsApp.webhookId === 'string'
        && value.rtmsApp.webhookId.trim()
        && !isValidWebhookId(value.rtmsApp.webhookId)
      ) {
        invalidAppFields.push('rtmsApp.webhookId');
      }
      if (invalidAppFields.length > 0) {
        entryErrors[teamId] = `invalid or missing fields: ${Array.from(new Set(invalidAppFields)).join(', ')}`;
        continue;
      }

      if (credentialMode === 'shared_customer') {
        entryErrors[teamId] = 'rtmsApp is not allowed in shared_customer mode';
        continue;
      }

      const webhookId = value.rtmsApp.webhookId as string;
      const existingTeamId = teamByWebhookId.get(webhookId);
      if (existingTeamId) {
        delete credentials[existingTeamId];
        entryErrors[existingTeamId] = 'rtmsApp.webhookId must be unique';
        entryErrors[teamId] = 'rtmsApp.webhookId must be unique';
        continue;
      }

      teamByWebhookId.set(webhookId, teamId);
      rtmsApp = {
        webhookId,
        clientId: (value.rtmsApp.clientId as string).trim(),
        clientSecret: (value.rtmsApp.clientSecret as string).trim(),
        webhookSecret: (value.rtmsApp.webhookSecret as string).trim(),
      };
    }

    if (credentialMode === 'dedicated_customer' && !rtmsApp) {
      entryErrors[teamId] = 'rtmsApp is required in dedicated_customer mode';
      continue;
    }

    credentials[teamId] = {
      enabled: value.enabled as boolean,
      accountId: (value.accountId as string).trim(),
      clientId: (value.clientId as string).trim(),
      clientSecret: (value.clientSecret as string).trim(),
      participantUserId: (value.participantUserId as string).trim(),
      ...(rtmsApp ? { rtmsApp } : {}),
    };
  }

  return { credentials, entryErrors };
};

export const parseZoomChromeCustomerStorageStatePaths = (
  rawValue?: string
): ZoomChromeCustomerStorageStatePathsParseResult => {
  const paths: Record<string, string> = Object.create(null);
  const entryErrors: Record<string, string> = Object.create(null);
  const teamByPath = new Map<string, string>();
  if (!rawValue?.trim()) return { paths, entryErrors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return {
      paths,
      entryErrors,
      error: 'ZOOM_CHROME_CUSTOMER_STORAGE_STATE_PATHS_JSON must contain valid JSON',
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      paths,
      entryErrors,
      error: 'ZOOM_CHROME_CUSTOMER_STORAGE_STATE_PATHS_JSON must be an object keyed by teamId',
    };
  }

  for (const [teamId, value] of Object.entries(parsed)) {
    if (
      !teamId
      || teamId.trim() !== teamId
      || teamId.length > 256
      || /[\u0000-\u001f\u007f]/.test(teamId)
    ) {
      entryErrors[teamId] = 'teamId is invalid';
      continue;
    }

    if (
      typeof value !== 'string'
      || value.trim() !== value
      || value.includes('\0')
      || !path.isAbsolute(value)
    ) {
      entryErrors[teamId] = 'storage state path must be an absolute path';
      continue;
    }

    const existingTeamId = teamByPath.get(value);
    if (existingTeamId) {
      delete paths[existingTeamId];
      entryErrors[existingTeamId] = 'storage state path must be unique per teamId';
      entryErrors[teamId] = 'storage state path must be unique per teamId';
      continue;
    }

    teamByPath.set(value, teamId);
    paths[teamId] = value;
  }

  return { paths, entryErrors };
};

const requiredSettings = [
  'GCP_DEFAULT_REGION',
  'GCP_MISC_BUCKET',
];
const missingSettings = requiredSettings.filter((s) => !process.env[s]);
if (missingSettings.length > 0) {
  missingSettings.forEach((ms) =>
    console.error(`ENV settings ${ms} is missing.`)
  );
}

const constructRedisUri = () => {
  const host = process.env.REDIS_HOST || 'redis';
  const port = process.env.REDIS_PORT || 6379;
  const username = process.env.REDIS_USERNAME;
  const password = process.env.REDIS_PASSWORD;

  if (username && password) {
    return `redis://${username}:${password}@${host}:${port}`;
  } else if (password) {
    return `redis://:${password}@${host}:${port}`;
  } else {
    return `redis://${host}:${port}`;
  }
};

const normalizeFileExtension = (extension?: string) => {
  if (!extension) return '.webm';
  return extension.startsWith('.') ? extension : `.${extension}`;
};

const parseOptionalNumber = (value?: string) => {
  if (typeof value === 'undefined' || value.trim() === '') return undefined;
  return Number(value);
};

const zoomRecordingTransport = process.env.ZOOM_RECORDING_TRANSPORT ?? 'browser';
if (!['browser', 'rtms'].includes(zoomRecordingTransport)) {
  throw new Error('ZOOM_RECORDING_TRANSPORT must be browser or rtms');
}

export type ZoomRtmsTransportStrategy =
  | 'browser_only'
  | 'browser_then_rtms'
  | 'rtms_only';

export const deriveZoomRtmsTransportStrategy = (
  transport: 'browser' | 'rtms',
  fallbackEnabled: boolean
): ZoomRtmsTransportStrategy => {
  if (transport === 'rtms') return 'rtms_only';
  return fallbackEnabled ? 'browser_then_rtms' : 'browser_only';
};

const zoomRtmsFallbackEnabled = process.env.ZOOM_RTMS_FALLBACK_ENABLED === 'true';
const zoomTransportStrategy = deriveZoomRtmsTransportStrategy(
  zoomRecordingTransport as 'browser' | 'rtms',
  zoomRtmsFallbackEnabled
);

const zoomRtmsEventTtlSeconds = process.env.ZOOM_RTMS_EVENT_TTL_SECONDS
  ? Number(process.env.ZOOM_RTMS_EVENT_TTL_SECONDS)
  : 3600;
if (!Number.isFinite(zoomRtmsEventTtlSeconds) || zoomRtmsEventTtlSeconds <= 0) {
  throw new Error('ZOOM_RTMS_EVENT_TTL_SECONDS must be a positive number');
}

const zoomRtmsCustomerCredentialMode =
  process.env.ZOOM_RTMS_CUSTOMER_CREDENTIAL_MODE ?? 'auto';
if (!['auto', 'shared_customer', 'dedicated_customer'].includes(zoomRtmsCustomerCredentialMode)) {
  throw new Error(
    'ZOOM_RTMS_CUSTOMER_CREDENTIAL_MODE must be auto, shared_customer or dedicated_customer'
  );
}

const zoomRtmsCustomerCredentials = parseZoomRtmsCustomerCredentials(
  process.env.ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON,
  zoomRtmsCustomerCredentialMode as ZoomRtmsCustomerCredentialMode
);
const zoomRtmsGlobalTeamId = process.env.ZOOM_RTMS_GLOBAL_TEAM_ID;
if (
  typeof zoomRtmsGlobalTeamId !== 'undefined'
  && (
    !zoomRtmsGlobalTeamId
    || zoomRtmsGlobalTeamId.trim() !== zoomRtmsGlobalTeamId
    || zoomRtmsGlobalTeamId.length > 256
    || /[\u0000-\u001f\u007f]/.test(zoomRtmsGlobalTeamId)
  )
) {
  throw new Error('ZOOM_RTMS_GLOBAL_TEAM_ID must contain one valid exact teamId');
}
const zoomChromeCustomerStorageStatePaths = parseZoomChromeCustomerStorageStatePaths(
  process.env.ZOOM_CHROME_CUSTOMER_STORAGE_STATE_PATHS_JSON
);

export default {
  port: process.env.PORT || 3000,
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process,
  },
  authBaseUrlV2: process.env.AUTH_BASE_URL_V2 ?? 'http://localhost:8081/v2',
  // Unset MAX_RECORDING_DURATION_MINUTES to use default upper limit on duration
  maxRecordingDuration: process.env.MAX_RECORDING_DURATION_MINUTES ?
    Number(process.env.MAX_RECORDING_DURATION_MINUTES) :
    180, // There's an upper limit on meeting duration 3 hours
  chromeExecutablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', // We use Google Chrome with Playwright for recording
  googleChromeCdpUrl: process.env.GOOGLE_CHROME_CDP_URL,
  googleChromeUserDataDir: process.env.GOOGLE_CHROME_USER_DATA_DIR,
  googleChromeStorageStatePath: process.env.GOOGLE_CHROME_STORAGE_STATE_PATH,
  zoomChromeCdpUrl: process.env.ZOOM_CHROME_CDP_URL,
  zoomChromeCustomerStorageStatePaths: zoomChromeCustomerStorageStatePaths.paths,
  zoomChromeCustomerStorageStatePathErrors: zoomChromeCustomerStorageStatePaths.entryErrors,
  zoomChromeCustomerStorageStatePathsError: zoomChromeCustomerStorageStatePaths.error,
  zoomRecordingTransport: zoomRecordingTransport as 'browser' | 'rtms',
  zoomRtmsFallbackEnabled,
  zoomTransportStrategy,
  zoomRtms: {
    clientId: process.env.ZOOM_RTMS_CLIENT_ID,
    clientSecret: process.env.ZOOM_RTMS_CLIENT_SECRET,
    webhookSecret: process.env.ZOOM_RTMS_WEBHOOK_SECRET,
    oauthAccessToken: process.env.ZOOM_RTMS_OAUTH_ACCESS_TOKEN,
    oauthAccountId: process.env.ZOOM_RTMS_OAUTH_ACCOUNT_ID,
    oauthClientId: process.env.ZOOM_RTMS_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.ZOOM_RTMS_OAUTH_CLIENT_SECRET,
    participantUserId: process.env.ZOOM_RTMS_PARTICIPANT_USER_ID,
    globalTeamId: zoomRtmsGlobalTeamId,
    eventTtlSeconds: zoomRtmsEventTtlSeconds,
    customerCredentialMode: zoomRtmsCustomerCredentialMode as ZoomRtmsCustomerCredentialMode,
    customerCredentials: zoomRtmsCustomerCredentials.credentials,
    customerCredentialErrors: zoomRtmsCustomerCredentials.entryErrors,
    customerCredentialsError: zoomRtmsCustomerCredentials.error,
  },
  googleAnonymousJoinRequestAttempts: process.env.GOOGLE_ANONYMOUS_JOIN_REQUEST_ATTEMPTS ?
    Number(process.env.GOOGLE_ANONYMOUS_JOIN_REQUEST_ATTEMPTS) :
    10,
  inactivityLimit: process.env.MEETING_INACTIVITY_MINUTES ? Number(process.env.MEETING_INACTIVITY_MINUTES) : 1,
  activateInactivityDetectionAfter: process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES ? Number(process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES) :  1,
  loneParticipantExitDelaySeconds: process.env.LONE_PARTICIPANT_EXIT_DELAY_SECONDS ? Number(process.env.LONE_PARTICIPANT_EXIT_DELAY_SECONDS) : 10,
  // Target video bitrate for MediaRecorder (bits/sec). The VP9 default produced
  // ~187 kbps because the encoder was starved; a sane target avoids blocky/stuttery output.
  recordingVideoBitsPerSecond: process.env.RECORDING_VIDEO_BITS_PER_SECOND
    ? Number(process.env.RECORDING_VIDEO_BITS_PER_SECOND)
    : 4_000_000,
  serviceKey: process.env.SCREENAPP_BACKEND_SERVICE_API_KEY,
  joinWaitTime: process.env.JOIN_WAIT_TIME_MINUTES ? Number(process.env.JOIN_WAIT_TIME_MINUTES) : 10,
  // Number of retries for transient errors (not applied to WaitingAtLobbyRetryError)
  retryCount: process.env.RETRY_COUNT ? Number(process.env.RETRY_COUNT) : 2,
  teamsPrewarmEnabled: process.env.TEAMS_PREWARM_ENABLED === 'true',
  teamsAudioStabilizationMs: process.env.TEAMS_AUDIO_STABILIZATION_MS ? Number(process.env.TEAMS_AUDIO_STABILIZATION_MS) : 1000,
  miscStorageBucket: process.env.GCP_MISC_BUCKET,
  miscStorageFolder: process.env.GCP_MISC_BUCKET_FOLDER ? process.env.GCP_MISC_BUCKET_FOLDER : 'meeting-bot',
  region: process.env.GCP_DEFAULT_REGION,
  accessKey: process.env.GCP_ACCESS_KEY_ID ?? '',
  accessSecret: process.env.GCP_SECRET_ACCESS_KEY ?? '',
  redisQueueName: process.env.REDIS_QUEUE_NAME ?? 'jobs:meetbot:list',
  redisProcessingQueueName: process.env.REDIS_PROCESSING_QUEUE_NAME ?? 'jobs:meetbot:processing',
  redisUri: constructRedisUri(),
  // Notification: Webhook (disabled by default)
  notifyWebhookEnabled: process.env.NOTIFY_WEBHOOK_ENABLED === 'true',
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL,
  // Optional secret to sign payloads (HMAC-SHA256). If set, signature will be sent in X-Webhook-Signature header
  notifyWebhookSecret: process.env.NOTIFY_WEBHOOK_SECRET,
  // Notification: Redis. Explicitly enabled via NOTIFY_REDIS_ENABLED, and enabled
  // automatically for Redis-worker mode so completed jobs are written to result list.
  notifyRedisEnabled: process.env.NOTIFY_REDIS_ENABLED === 'true' || process.env.REDIS_CONSUMER_ENABLED === 'true',
  // If not provided, uses redisUri with specified database selection
  notifyRedisUri: process.env.NOTIFY_REDIS_URI, // optional override
  notifyRedisDb: parseOptionalNumber(process.env.NOTIFY_REDIS_DB),
  notifyRedisList: process.env.NOTIFY_REDIS_LIST ?? 'jobs:meetbot:recordings',
  notifyRedisFailureList: process.env.NOTIFY_REDIS_FAILURE_LIST ?? 'jobs:meetbot:failures',
  uploaderFileExtension: normalizeFileExtension(process.env.UPLOADER_FILE_EXTENSION),
  isRedisEnabled: process.env.REDIS_CONSUMER_ENABLED === 'true',
  s3CompatibleStorage: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET_NAME,
    forcePathStyle: process.env.S3_USE_MINIO_COMPATIBILITY === 'true',
  },
  // Object storage provider selection: 's3' (default) or 'azure'
  storageProvider: (process.env.STORAGE_PROVIDER === 'azure' ? 'azure' : 's3') as 's3' | 'azure',
  azureBlobStorage: {
    // Either provide full connection string OR account + key/SAS OR managed identity
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    accountName: process.env.AZURE_STORAGE_ACCOUNT,
    accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY, // optional when using connection string
    sasToken: process.env.AZURE_STORAGE_SAS_TOKEN, // starts with ?sv=...
    useManagedIdentity: process.env.AZURE_USE_MANAGED_IDENTITY === 'true',
    container: process.env.AZURE_STORAGE_CONTAINER,
    blobPrefix: process.env.AZURE_BLOB_PREFIX || '',
    signedUrlTtlSeconds: process.env.AZURE_SIGNED_URL_TTL_SECONDS ? Number(process.env.AZURE_SIGNED_URL_TTL_SECONDS) : 3600,
    uploadConcurrency: process.env.AZURE_UPLOAD_CONCURRENCY ? Number(process.env.AZURE_UPLOAD_CONCURRENCY) : 4,
  },
  uploaderType: process.env.UPLOADER_TYPE ? (process.env.UPLOADER_TYPE as UploaderType) : 's3' as UploaderType,
};
