import { MicrosoftTeamsBot } from '../bots/MicrosoftTeamsBot';
import { AxiosError } from 'axios';
import { IUploader } from '../middleware/disk-uploader';
import express, { Request, Response } from 'express';
import { createCorrelationId, loggerFactory } from '../util/logger';
import DiskUploader from '../middleware/disk-uploader';
import { getRecordingNamePrefix } from '../util/recordingName';
import { encodeFileNameSafebase64 } from '../util/strings';
import { MeetingJoinParams } from './common';
import { globalJobStore } from '../lib/globalJobStore';

const router = express.Router();

const joinMicrosoftTeams = async (req: Request, res: Response) => {
  const {
    bearerToken,
    url,
    name,
    teamId,
    timezone,
    userId,
    eventId,
    botId
  }: MeetingJoinParams = req.body;

  // Validate required fields
  if (!bearerToken || !url || !name || !teamId || !timezone || !userId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: bearerToken, url, name, teamId, timezone, userId'
    });
  }

  if (!botId && !eventId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: botId or eventId'
    });
  }

  // Create correlation ID and logger
  const correlationId = createCorrelationId({ teamId, userId, botId, eventId, url });
  const logger = loggerFactory(correlationId, 'microsoft');

  try {
    // Try to add the job to the store
    const jobResult = await globalJobStore.addJob(async () => {
      // Initialize disk uploader
      const entityId = botId ?? eventId;
      const tempId = `${userId}${entityId}0`; // Using 0 as retry count
      const tempFileId = encodeFileNameSafebase64(tempId);
      const namePrefix = getRecordingNamePrefix('microsoft');
      
      const uploader: IUploader = await DiskUploader.initialize(
        bearerToken,
        teamId,
        timezone,
        userId,
        botId ?? '',
        namePrefix,
        tempFileId,
        logger,
      );

      // Create and join the meeting
      const bot = new MicrosoftTeamsBot(logger, correlationId);
      await bot.join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader });
      
      logger.info('Joined Microsoft Teams meeting successfully.', userId, teamId);
    }, logger);

    if (!jobResult.accepted) {
      return res.status(409).json({
        success: false,
        error: 'Another meeting is currently being processed. Please try again later.',
        data: { userId, teamId, eventId, botId }
      });
    }

    // Job was accepted, return immediate response
    logger.info('Microsoft Teams job accepted and started processing', { userId, teamId });
    
    return res.status(202).json({
      success: true,
      message: 'Microsoft Teams join request accepted and processing started',
      data: { 
        userId, 
        teamId, 
        eventId, 
        botId,
        status: 'processing'
      }
    });

  } catch (error) {
    logger.error('Error setting up Microsoft Teams job:', { userId, teamId, botId, eventId, error });
    
    if (error instanceof AxiosError) {
      logger.error('axios error', { 
        userId, 
        teamId, 
        botId, 
        data: error?.response?.data, 
        config: error?.response?.config 
      });
    }

    // Return appropriate error response
    const statusCode = error instanceof AxiosError ? (error.response?.status || 500) : 500;
    
    return res.status(statusCode).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      data: { userId, teamId, eventId, botId }
    });
  }
};

router.post('/join', joinMicrosoftTeams);

export default router;