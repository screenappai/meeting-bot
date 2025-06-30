// Express App
import express from 'express';
import { AxiosError } from 'axios';
import { GoogleMeetBot } from '../util/bots/GoogleMeetBot';
import messageBroker from '../util/messageBroker';
import { gracefulShutdownApp } from '../index';
import { KnownError } from '../error';
import { MicrosoftTeamsBot } from '../util/bots/MicrosoftTeamsBot';
import { BotLaunchParams } from '../util/bots/AbstractMeetBot';
import { createCorrelationId, loggerFactory, getErrorType } from '../util/logger';
import client from 'prom-client';
import { ZoomBot } from '../bots/ZoomBot';
import { NODE_ENV } from '../config';
import mainDebug from '../test/debug';
import { encodeFileNameSafebase64 } from '../util/strings';
import DiskUploader, { IUploader } from '../middleware/disk-uploader';
import { getRecordingNamePrefix } from '../util/bots/recordingName';
import { Logger } from 'winston';

const app = express();

app.use(express.json());

let isbusy = 0;
let gracefulShutdown = 0;

app.get('/isbusy', async (req, res) => {
  return res.status(200).json({ success: true, data: isbusy });
});

// Create a Gauge metric for busy status (0 or 1)
const busyStatus = new client.Gauge({
  name: 'isbusy',
  help: 'busy status of the pod (1 = busy, 0 = available)'
});

const isavailable = new client.Gauge({
  name: 'isavailable',
  help: 'available status of the pod (1 = available, 0 = busy)'
});

app.get('/metrics', async (req, res) => {
  busyStatus.set(isbusy);
  isavailable.set(1 - isbusy);
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/debug', async (req, res, next) => {
  if (NODE_ENV === 'development') {
    next();
  }
  else {
    res.status(500).send({});
  }
}, async (req, res) => {
  await mainDebug('baf14', 'https://www.github.com');
  res.status(200).send({});
});

const joinGoogleMeet = async (
  bearerToken: string,
  url: string,
  name: string,
  teamId: string,
  timezone: string,
  userId: string,
  eventId: string | undefined,
  botId: string | undefined,
  uploader: IUploader,
  logger: Logger
) => {
  isbusy = 1;
  try {
    const bot = new GoogleMeetBot(logger);
    await bot.join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader });
    logger.info('Joined Google Meet event successfully.', userId, teamId);
  } catch (error) {
    logger.error('Error joining Google Meet:', { userId, teamId, botId, eventId, error });
    if (error instanceof AxiosError) {
      logger.error('axios error', { userId, teamId, botId, data: error?.response?.data, config: error?.response?.config });
    }
    throw error;
  }
};

const joinMicrosoftTeams = async (
  bearerToken: string,
  url: string,
  name: string,
  teamId: string,
  timezone: string,
  userId: string,
  eventId: string | undefined,
  botId: string | undefined,
  uploader: IUploader,
  logger: Logger
) => {
  isbusy = 1;
  try {
    const bot = new MicrosoftTeamsBot(logger);
    await bot.join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader });
    logger.info('Joined Microsoft Teams meeting successfully.', userId);
  } catch (error) {
    logger.error('Error joining Microsoft Teams meeting:', { error, userId, teamId, botId, eventId });
    if (error instanceof AxiosError) {
      logger.error('axios error', error?.response?.data, error?.response?.config);
    }
    throw error;
  }
};

const joinZoom = async (
  bearerToken: string,
  url: string,
  name: string,
  teamId: string,
  timezone: string,
  userId: string,
  eventId: string | undefined,
  botId: string | undefined,
  uploader: IUploader,
  logger: Logger
) => {
  isbusy = 1;
  try {
    const bot = new ZoomBot(logger);
    await bot.join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader });
    logger.info('Joined Zoom meeting successfully.', userId);
  } catch (error) {
    logger.error('Error joining Zoom meeting:', { error, userId, teamId, botId, eventId });
    if (error instanceof AxiosError) {
      logger.error('axios error', error?.response?.data, error?.response?.config);
    }
    throw error;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export const setGracefulShutdown = (val: number) =>
  gracefulShutdown = val;

const main = async () => {
  console.log('Running main loop...');

  const joinMeetWithRetry = async (
    bearerToken: string, 
    url: string, 
    name: string, 
    teamId: string, 
    timezone: string, 
    userId: string,
    provider: 'google' | 'microsoft' | 'zoom',
    retryCount: number,
    eventId: undefined | string,
    botId: undefined | string,
    logger: Logger
  ) => {
    const entityId = botId ?? eventId;
    const tempId = `${userId}${entityId}${retryCount}`;
    const tempFileId = encodeFileNameSafebase64(tempId);

    const namePrefix = getRecordingNamePrefix(provider);
    
    const diskUploader = await DiskUploader.initialize(
      bearerToken,
      teamId,
      timezone,
      userId,
      botId ?? '',
      namePrefix,
      tempFileId,
      logger,
    );

    try {
      if (provider === 'google')
        await joinGoogleMeet(bearerToken, url, name, teamId, timezone, userId, eventId, botId, diskUploader, logger);
      if (provider === 'microsoft')
        await joinMicrosoftTeams(bearerToken, url, name, teamId, timezone, userId, eventId, botId, diskUploader, logger);
      if (provider === 'zoom')
        await joinZoom(bearerToken, url, name, teamId, timezone, userId, eventId, botId, diskUploader, logger);
    } catch (error) {
      if (error instanceof KnownError && !error.retryable) {
        logger.error('KnownError is not retryable:', error.name, error.message);
        throw error;
      }

      if (error instanceof KnownError && error.retryable && (retryCount + 1) >= error.maxRetries) {
        logger.error(`KnownError: ${error.maxRetries} tries consumed:`, error.name, error.message);
        throw error;
      }

      retryCount += 1;
      await sleep(retryCount * 30000);
      if (retryCount < 3) {
        if (retryCount) {
          logger.warn(`Retry count: ${retryCount}`);
        }
        await joinMeetWithRetry(bearerToken, url, name, teamId, timezone, userId, provider, retryCount, eventId, botId, logger);
      } else {
        throw error;
      }
    }
  };

  while (true) {
    isbusy = 0;
    const content = await messageBroker.getMeetingbotJobs();
    if (content && content.element) {
      const { bearerToken, url, name, teamId, timezone, userId, provider, eventId, botId } = JSON.parse(content.element) as BotLaunchParams;
      const correlationId = createCorrelationId({ teamId, userId, botId, eventId, url });
      const logger = loggerFactory(correlationId, provider);
      logger.info(content.element);
      
      try {
        logger.info('LogBasedMetric Bot has started recording meeting.');
        await joinMeetWithRetry(bearerToken, url, name, teamId, timezone, userId, provider, 0, eventId, botId, logger);
        logger.info('LogBasedMetric Bot has finished recording meeting successfully.');
      } catch (error) {
        const errorType = getErrorType(error);
        if (error instanceof KnownError) {
          logger.error('KnownError bot is permanently exiting:', { error, teamId, userId });
        } else {
          logger.error('Error joining meeting after multiple retries on team:', { error, teamId, userId });
        }
        logger.error(`LogBasedMetric Bot has permanently failed. [errorType: ${errorType}]`);
      }
    }
    if (gracefulShutdown) {
      console.log('Exiting from main loop...');
      gracefulShutdownApp(messageBroker);
      break;
    }
  }
};

// Start the loop
main();

export default app;
