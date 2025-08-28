import moment from 'moment-timezone';
import { Logger } from 'winston';

export const getTimeString = (timezone: string, logger: Logger) => {
  try {
    if (!moment.tz.zone(timezone)) {
      throw new Error(`Unsupported timezone: ${timezone}`);
    }

    return moment().tz(timezone).format('h:mma MMM DD YYYY');
  } catch (error) {
    logger.warn('Using UTC time, found an invalid timezone', timezone, error);
    return moment().format('h:mma MMM DD YYYY');
  }
};
