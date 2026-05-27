import { EventEmitter } from 'stream';
import { createClient } from 'redis';
import config from '../config';

/**
 * This class must not have any instance/local state, and should only be used as a singleton.
 * Uses FIFO queue (RPUSH + BLMOVE) with a processing list for active jobs.
 */
export class RedisMessageBroker extends EventEmitter {
  private meetbot: ReturnType<typeof createClient> | null = null;

  constructor() {
    super();

    if (config.isRedisEnabled) {
      this.meetbot = createClient({
        url: config.redisUri,
        name: 'backend-meetbot',
      });
      this.meetbot.on('error', (err) =>
        console.error('meetbot redis client error', err)
      );
      Promise.all([
        this.meetbot.connect(),
      ]).then(() => {
        console.log('Redis message broker connected.');
      });

      console.log('Redis message broker initialized:', config.redisUri);
    } else {
      console.log('Redis message broker disabled - Redis is disabled');
    }
  }

  /**
   * Return a job to the head of the meetbot Redis queue.
   * **Client needs to actively pull items.**
   *
   *  This function returns a message to the head of the meetbot Redis queue
   *  This is useful when a job is rejected by the JobStore, and needs to be retried.
   *
   * @param {message} message - The publish message.
   */
  async returnMeetingbotJobs(message: string) {
    // Set/update data, even if the item is already in the queue.
    return await this.meetbot?.lPush(
      config.redisQueueName,
      message
    );
  }

  /**
   * Return a job from the processing queue to the head of the pending queue.
   *
   * This is used if a job was atomically moved into processing but could not be
   * accepted by the local JobStore.
   *
   * @param {message} message - The original job message.
   */
  async returnProcessingMeetingbotJob(message: string) {
    return await this.meetbot?.sendCommand([
      'EVAL',
      'local removed = redis.call("LREM", KEYS[1], 1, ARGV[1]); if removed > 0 then return redis.call("LPUSH", KEYS[2], ARGV[1]); end; return 0;',
      '2',
      config.redisProcessingQueueName,
      config.redisQueueName,
      message,
    ]);
  }

  /**
   * Remove a finished or permanently failed job from the processing queue.
   *
   * @param {message} message - The original job message.
   */
  async acknowledgeProcessingMeetingbotJob(message: string): Promise<number> {
    const removed = await this.meetbot?.sendCommand([
      'LREM',
      config.redisProcessingQueueName,
      '1',
      message,
    ]);

    return Number(removed ?? 0);
  }

  /**
   * Move a job from the pending queue into the processing queue with a custom timeout.
   * **Client needs to actively acknowledge items after completion.**
   *
   * @param timeout - Timeout in seconds for blocking operation
   * @return The message acquired from meetbot Redis queue
   */
  async getMeetingbotJobsWithTimeout(timeout: number) {
    const message = await this.meetbot?.sendCommand([
      'BLMOVE',
      config.redisQueueName,
      config.redisProcessingQueueName,
      'LEFT',
      'RIGHT',
      String(timeout),
    ]);

    return typeof message === 'string'
      ? { key: config.redisQueueName, element: message }
      : null;
  }

  /**
   * Check if the Redis client is connected and ready
   * @return boolean indicating connection status
   */
  isConnected(): boolean {
    return this.meetbot?.isOpen ?? false;
  }

  /**
   * This function accompanies container shutdown and closes redis connection to free up server resources
   * @return void
   */
  async quitClientGracefully() {
    try {
      if (this.meetbot?.isOpen) {
        await this.meetbot?.quit();
      }
      console.log('Closed redis connection');      
    } catch(quitError) {
      console.error('Error while closing redis connection', quitError);
    }
  }
}
