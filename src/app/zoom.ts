import express, { Request, Response } from 'express';
import { ZoomBot } from '../bots/ZoomBot';
import { IUploader } from '../middleware/disk-uploader';
import { AxiosError } from 'axios';
import { createCorrelationId, loggerFactory } from '../util/logger';
import DiskUploader from '../middleware/disk-uploader';
import { getRecordingNamePrefix } from '../util/recordingName';
import { encodeFileNameSafebase64 } from '../util/strings';
import { MeetingJoinParams } from './common';

const router = express.Router();

const joinZoom = async (req: Request, res: Response) => {
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

  // Create correlation ID and logger
  const correlationId = createCorrelationId({ teamId, userId, botId, eventId, url });
  const logger = loggerFactory(correlationId, 'zoom');

  try {
    // Initialize disk uploader
    const entityId = botId ?? eventId;
    const tempId = `${userId}${entityId}0`; // Using 0 as retry count
    const tempFileId = encodeFileNameSafebase64(tempId);
    const namePrefix = getRecordingNamePrefix('zoom');
    
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
    const bot = new ZoomBot(logger);
    await bot.join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader });
    
    logger.info('Joined Zoom meeting successfully.', userId, teamId);
    
    return res.status(200).json({
      success: true,
      message: 'Successfully joined Zoom meeting',
      data: { userId, teamId, eventId, botId }
    });

  } catch (error) {
    logger.error('Error joining Zoom meeting:', { userId, teamId, botId, eventId, error });
    
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

router.post('/join', joinZoom);

export default router;
