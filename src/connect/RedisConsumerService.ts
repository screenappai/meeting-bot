import { globalJobStore } from '../lib/globalJobStore';
import { MeetingJoinRedisParams } from '../app/common';
import messageBroker from './messageBroker';
import { loggerFactory, createCorrelationId } from '../util/logger';
import { GoogleMeetBot } from '../bots/GoogleMeetBot';
import DiskUploader, { IUploader } from '../middleware/disk-uploader';
import { getRecordingNamePrefix } from '../util/recordingName';
import { encodeFileNameSafebase64 } from '../util/strings';
import { JoinParams } from '../bots/AbstractMeetBot';
import { MicrosoftTeamsBot } from '../bots/MicrosoftTeamsBot';
import { ZoomBot } from '../bots/ZoomBot';
import config from '../config';

export class RedisConsumerService {
  private _isRunning: boolean = false;
  private _isShutdownRequested: boolean = false;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  private readonly BLPOP_TIMEOUT = 10; // 10 seconds

  async start(): Promise<void> {
    if (this._isRunning) {
      console.warn('Redis consumer service is already running');
      return;
    }

    // Check if Redis is enabled
    if (!config.isRedisEnabled) {
      console.info('Redis consumer service not started - Redis is disabled');
      return;
    }

    try {
      // Check if messageBroker is connected
      if (!messageBroker.isConnected()) {
        console.warn('Message broker not connected, waiting for connection...');
        // Wait for connection or handle as needed
      }
      
      this._isRunning = true;
      this.setShutdownRequested(false);
      
      console.info('Redis consumer service started');
      this.startMessageLoop().catch((error) => {
        console.error('Failed to start message loop:', error);
        throw error;
      });
      
    } catch (error) {
      console.error('Failed to start Redis consumer service:', error);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    console.info('Initiating graceful shutdown of Redis consumer service...');
    this.setShutdownRequested(true);
    this._isRunning = false;

    // Clear any pending reconnect attempts
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    // Note: Redis connection is managed by messageBroker
    console.info('Redis consumer service shutdown initiated');
  }

  private async startMessageLoop(): Promise<void> {
    while (this._isRunning && !this.isShutdownRequested()) {
      try {
        // Check JobStore availability BEFORE attempting to get messages
        if (globalJobStore.isBusy()) {
          // JobStore is busy, wait a bit before checking again
          await new Promise(resolve => setTimeout(resolve, this.BLPOP_TIMEOUT)); // BLPOP_TIMEOUT second delay
          continue; // Skip to next iteration
        }

        // JobStore is available, now we can safely get a message
        const result = await messageBroker.getMeetingbotJobsWithTimeout(this.BLPOP_TIMEOUT);

        if (result && result.element) {
          await this.processMessage(result.element);
        }

      } catch (error) {
        if (this.isShutdownRequested()) {
          break;
        }

        console.error('Error in message loop:', error);
        
        // Attempt to reconnect if connection is lost
        if (!messageBroker.isConnected()) {
          await this.handleReconnection();
        }
      }
    }
  }

  private async processMessage(message: string): Promise<void> {
    const meetingParams: MeetingJoinRedisParams = JSON.parse(message);
    // Create correlation ID and logger
    const correlationId = createCorrelationId({
      teamId: meetingParams.teamId,
      userId: meetingParams.userId,
      botId: meetingParams.botId,
      eventId: meetingParams.eventId,
      url: meetingParams.url
    });
    const logger = loggerFactory(correlationId, meetingParams.provider);

    try {
      logger.info('Processing Redis message:', { 
        provider: meetingParams.provider, 
        teamId: meetingParams.teamId,
        userId: meetingParams.userId,
        url: meetingParams.url,
        name: meetingParams.name,
        eventId: meetingParams.eventId,
        botId: meetingParams.botId,
        timezone: meetingParams.timezone,
      });

      const jobAcceptedResult = await globalJobStore.addJob(async () => {
        // Initialize disk uploader
        const entityId = meetingParams.botId ?? meetingParams.eventId;
        const tempId = `${meetingParams.userId}${entityId}0`; // Using 0 as retry count
        const tempFileId = encodeFileNameSafebase64(tempId);
        const namePrefix = getRecordingNamePrefix(meetingParams.provider);
        
        const uploader: IUploader = await DiskUploader.initialize(
          meetingParams.bearerToken,
          meetingParams.teamId,
          meetingParams.timezone,
          meetingParams.userId,
          meetingParams.botId ?? '',
          namePrefix,
          tempFileId,
          logger,
        );

        // Create and join the meeting
        const joinParams: JoinParams = {
          url: meetingParams.url,
          name: meetingParams.name,
          bearerToken: meetingParams.bearerToken,
          teamId: meetingParams.teamId,
          timezone: meetingParams.timezone,
          userId: meetingParams.userId,
          eventId: meetingParams.eventId,
          botId: meetingParams.botId,
          uploader
        };
        
        switch (meetingParams.provider) {
          case 'google':
            const googleBot = new GoogleMeetBot(logger, correlationId);
            await googleBot.join(joinParams);
            logger.info('Joined Google Meet event successfully.', meetingParams.userId, meetingParams.teamId);
            break;
          case 'microsoft':
            const microsoftBot = new MicrosoftTeamsBot(logger, correlationId);
            await microsoftBot.join(joinParams);
            logger.info('Joined Microsoft Teams meeting successfully.', meetingParams.userId, meetingParams.teamId);
            break;
          case 'zoom':
            const zoomBot = new ZoomBot(logger, correlationId);
            await zoomBot.join(joinParams);
            logger.info('Joined Zoom meeting successfully.', meetingParams.userId, meetingParams.teamId);
            break;
          default:
            throw new Error(`Unsupported provider: ${meetingParams.provider}`);
        }
        
      }, logger);

      if (jobAcceptedResult.accepted) {
        logger.info('Message successfully added to JobStore');
      } else {
        logger.warn('Message rejected by JobStore - race condition detected, returning to queue');
        // Race condition: external API request got through, put message back at head of queue
        await messageBroker.returnMeetingbotJobs(message);
      }

    } catch (error) {
      logger.error('Error processing Redis message:', error);
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnectInterval) {
      return; // Already attempting to reconnect
    }

    console.info('Attempting to reconnect to Redis...');
    
    this.reconnectInterval = setTimeout(async () => {
      try {
        if (!messageBroker.isConnected()) {
          console.info('Waiting for messageBroker to reconnect...');
        }
      } catch (error) {
        console.error('Error checking Redis connection:', error);
        // Schedule another reconnection attempt
        this.handleReconnection();
      } finally {
        this.reconnectInterval = null;
      }
    }, this.RECONNECT_DELAY);
  }

  // Getter methods
  get isRunning(): boolean {
    return this._isRunning;
  }

  isShutdownRequested(): boolean {
    return this._isShutdownRequested;
  }

  // Setter methods for controlled state changes
  private setShutdownRequested(value: boolean): void {
    this._isShutdownRequested = value;
  }
}
