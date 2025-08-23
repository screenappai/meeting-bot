import { EventEmitter } from 'stream';
import { createClient } from 'redis';
import config from '../config';

/**
 * This class must not have any instance/local state, and should only be used as a singleton.
 * Uses FIFO queue (RPUSH + BLPOP)
 */
export class RedisMessageBroker extends EventEmitter {
  private meetbot: ReturnType<typeof createClient>;

  constructor() {
    super();

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
    return await this.meetbot.lPush(
      config.redisQueueName,
      message
    );
  }

  /**
   * Get a job from meetbot Redis queue with custom timeout.
   * **Client needs to actively pull items.**
   *
   * @param timeout - Timeout in seconds for blocking operation
   * @return The message acquired from meetbot Redis queue
   */
  async getMeetingbotJobsWithTimeout(timeout: number) {
    return await this.meetbot.blPop(
      config.redisQueueName,
      timeout
    );
  }

  /**
   * Check if the Redis client is connected and ready
   * @return boolean indicating connection status
   */
  isConnected(): boolean {
    return this.meetbot.isOpen;
  }



  /**
   * This function accompanies container shutdown and closes redis connection to free up server resources
   * @return void
   */
  async quitClientGracefully() {
    try {
      if (this.meetbot.isOpen) {
        await this.meetbot.quit();
      }
      console.log('Closed redis connection');      
    } catch(quitError) {
      console.error('Error while closing redis connection', quitError);
    }
  }
}
