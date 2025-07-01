import { Logger } from 'winston';
import { KnownError } from '../error';
import { getErrorType } from '../util/logger';

export interface MeetingJoinParams {
  url: string;
  name: string;
  teamId: string;
  userId: string;
  bearerToken: string;
  timezone: string;
  botId?: string;
  eventId?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export const joinMeetWithRetry = async (
  processor: (params: MeetingJoinParams) => Promise<void>,
  bearerToken: string,
  url: string,
  name: string,
  teamId: string,
  timezone: string,
  userId: string,
  retryCount: number,
  eventId: undefined | string,
  botId: undefined | string,
  logger: Logger
) => {
  try {
    await processor({
      bearerToken,
      userId,
      eventId,
      botId,
      url,
      name,
      teamId,
      timezone,
    });
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
      await joinMeetWithRetry(processor, bearerToken, url, name, teamId, timezone, userId, retryCount, eventId, botId, logger);
    } else {
      throw error;
    }
  }
};

export const processMeetingJoin = async (
  processor: (params: MeetingJoinParams) => Promise<void>,
  bearerToken: string,
  url: string,
  name: string,
  teamId: string,
  timezone: string,
  userId: string,
  eventId: undefined | string,
  botId: undefined | string,
  logger: Logger
) => {
  try {
    logger.info('LogBasedMetric Bot has started recording meeting.');
    await joinMeetWithRetry(processor, bearerToken, url, name, teamId, timezone, userId, 0, eventId, botId, logger);
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
};
