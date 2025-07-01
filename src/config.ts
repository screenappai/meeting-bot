import dotenv from 'dotenv';
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
  inactivityLimit: 0.5,
  activateInactivityDetectionAfter: 0.5,
  serviceKey: process.env.SCREENAPP_BACKEND_SERVICE_API_KEY,
  joinWaitTime: 10,
  miscStorageBucket: process.env.GCP_MISC_BUCKET,
  miscStorageFolder: process.env.GCP_MISC_BUCKET_FOLDER ? process.env.GCP_MISC_BUCKET_FOLDER : 'meeting-bot',
  region: process.env.GCP_DEFAULT_REGION,
  accessKey: process.env.GCP_ACCESS_KEY_ID ?? '',
  accessSecret: process.env.GCP_SECRET_ACCESS_KEY ?? '',
};
