import { EventEmitter } from 'stream';
import { createClient } from 'redis';
import config from '../config';

/**
 * Returns the provided key as is. Avoids accidental wrong keys.
 *
 * @param key A string representing a job key in the format `'jobs:<QueueType>:<total|done|queue>:<Priorities>'` etc.
 * @return The provided key.
 */
function k(
  key:
    | 'jobs:meetbot:list'
) {
  return key;
}

/**
 *
 * This class must not have any instance/local state, and should only be used as a singleton.
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
   * Publish a job to a meetbot Redis queue.
   * **Client needs to actively pull items.**
   *
   *  This function publishes a message to meetbot Redis queue
   *
   * @param {message} message - The publish message.
   */
  async publishMeetingbotJobs(message: string) {
    // Set/update data, even if the item is already in the queue.
    return await this.meetbot.rPush(
      k('jobs:meetbot:list'),
      message
    );
  }

  /**
   * Get a job from meetbot Redis queue.
   * **Client needs to actively pull items.**
   *
   *  This function get a message from meetbot Redis queue
   *  @return The message acquired from meetbot Redis queue
   * 
   */
  async getMeetingbotJobs() {
    // Set/update data, even if the item is already in the queue.
    return await this.meetbot.blPop(
      k('jobs:meetbot:list'),
      10
    );
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
