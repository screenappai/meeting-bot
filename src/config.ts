import dotenv from 'dotenv';
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

export default {
  port: process.env.PORT || 3000,
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process,
  },
  authBaseUrlV2: process.env.SCREENAPP_AUTH_BASE_URL_V2 ?? 'http://localhost:8081/v2',
  // Unset MAX_RECORDING_DURATION_MINUTES to use default upper limit on duration
  maxRecordingDuration: process.env.MAX_RECORDING_DURATION_MINUTES ?
    Number(process.env.MAX_RECORDING_DURATION_MINUTES) :
    180, // There's an upper limit on meeting duration 3 hours 
  chromeExecutablePath: '/usr/bin/google-chrome', // We use Google Chrome with Playwright for recording
  inactivityLimit: process.env.MEETING_INACTIVITY_MINUTES ? Number(process.env.MEETING_INACTIVITY_MINUTES) : 1,
  activateInactivityDetectionAfter: process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES ? Number(process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES) :  1,
  serviceKey: process.env.SCREENAPP_BACKEND_SERVICE_API_KEY,
  joinWaitTime: 10,
  miscStorageBucket: process.env.GCP_MISC_BUCKET,
  miscStorageFolder: process.env.GCP_MISC_BUCKET_FOLDER ? process.env.GCP_MISC_BUCKET_FOLDER : 'meeting-bot',
  region: process.env.GCP_DEFAULT_REGION,
  accessKey: process.env.GCP_ACCESS_KEY_ID ?? '',
  accessSecret: process.env.GCP_SECRET_ACCESS_KEY ?? '',
  redisQueueName: process.env.REDIS_QUEUE_NAME ?? 'jobs:meetbot:list',
  redisUri: constructRedisUri(),
  uploaderFileExtension: process.env.UPLOADER_FILE_EXTENSION ? process.env.UPLOADER_FILE_EXTENSION : '.webm',
  isRedisEnabled: process.env.REDIS_CONSUMER_ENABLED === 'true',
  s3CompatibleStorage: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET_NAME,
    forcePathStyle: process.env.S3_USE_MINIO_COMPATIBILITY === 'true',
  },
  uploaderType: process.env.UPLOADER_TYPE ? (process.env.UPLOADER_TYPE as UploaderType) : 's3' as UploaderType,
};
