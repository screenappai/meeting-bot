import { ConsoleMessage } from 'playwright';
import { createLogger, format, transports, Logger } from 'winston';
import { v5 as uuidv5, v4 } from 'uuid';
import { redactSensitiveString } from '../monitoring/sentry';

const NAMESPACE = uuidv5.DNS; 

const SENSITIVE_KEY = /(accountid|authorization|bearer|clientid|cookie|oauth|participantuserid|password|secret|token|bodytext|documentbodytext|rawbody)/i;
const URL_KEY = /url/i;

export const sanitizeUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value.replace(/([?&](?:pwd|password|token|code|key|secret)=)[^&#\s]*/gi, '$1[REDACTED]');
  }
};

const sanitizeString = (value: string): string =>
  redactSensitiveString(value).replace(
    /\b(?:https?|wss?|zoommtg):\/\/[^\s"'<>]+/gi,
    (match) => sanitizeUrl(match)
  );

export const redactSensitive = (value: unknown, key = '', seen = new WeakSet<object>()): unknown => {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return URL_KEY.test(key) ? sanitizeUrl(value) : sanitizeString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeString(value.message) };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry, key, seen));
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSensitive(entryValue, entryKey, seen),
    ])
  );
};

export function loggerFactory(correlationId: string, botType?: string): Logger {
  return createLogger({
    format: format.combine(
      format.timestamp(),
      format((info) => {
        info.correlationId = correlationId;
        if (botType) {
          info.botType = botType;
        }
        return info;
      })(),
      format.printf(({ timestamp, level, message, correlationId, botType, ...meta }) => {
        const redactedMeta = redactSensitive(meta);
        const metaStr = Object.keys(meta).length ? JSON.stringify(redactedMeta) : '';
        const botTypeStr = botType ? ` [botType: ${botType}]` : '';
        return `[${timestamp}] [${level}] [correlationId: ${correlationId}]${botTypeStr} ${sanitizeString(String(message))} ${metaStr}`;
      }),
    ),
    transports: [new transports.Console()],
  });
}

export const browserLogCaptureCallback = async (logger: Logger, msg: ConsoleMessage) => {
  try {
    const metadata = {
      browserConsoleType: msg.type(),
      source: sanitizeUrl(msg.location().url || 'unknown'),
    };
    switch (msg?.type()) {
      case 'error':
        logger.error('[Playwright browser console error]', metadata);
        break;
      case 'warning':
        logger.warn('[Playwright browser console warning]', metadata);
        break;
      case 'info':
      case 'log':
        logger.info('[Playwright browser console message]', metadata);
        break;
      default:
        logger.info('[Playwright browser console event]', metadata);
        break;
    }
  } catch(err) {
    logger.info('Failed to log browser messages...', err?.message);
  }
};

export const createCorrelationId = ({
  userId,
  eventId,
  botId,
  url,
  teamId
}: {
  userId: string,
  eventId: string | undefined,
  botId: string | undefined,
  url: string,
  teamId: string
}): string => {
  try {
    const entityId = botId ?? eventId;
    const name = `${userId}:${entityId}:${url}`;
    const id = uuidv5(name, NAMESPACE);
    console.log('[correlationId:%s]', id, {
      correlationId: id,
      userId,
      eventId,
      botId,
      url: sanitizeUrl(url),
      teamId,
      method: 'v5'
    });
    return id;
  } catch(err) {
    console.error('Unable to create deterministic correlationId', { userId, teamId, err });
    const id = v4();
    console.log('[correlationId:%s]', id, {
      correlationId: id,
      userId,
      eventId,
      botId,
      url: sanitizeUrl(url),
      teamId,
      method: 'v4'
    });
    return id;
  }
};

export const getErrorType = (error: unknown): string => {
  if (!error) return 'Unknown';
  
  if (error instanceof Error) {
    // Handle KnownError and its subclasses
    if (error.constructor.name === 'WaitingAtLobbyError') {
      return 'WaitingAtLobbyError';
    }
    if (error.constructor.name === 'WaitingAtLobbyRetryError') {
      return 'WaitingAtLobbyRetryError';
    }
    if (error.constructor.name === 'UnsupportedMeetingError') {
      return 'UnsupportedMeetingError';
    }
    if (error.constructor.name === 'RecordingUploadFailedError') {
      return 'RecordingUploadFailedError';
    }
    if (error.constructor.name === 'KnownError') {
      return 'KnownError';
    }
    
    // Handle other common error types
    if (error.name === 'AxiosError' || error.constructor.name === 'AxiosError') {
      return 'AxiosError';
    }
    if (error.name === 'TimeoutError' || error.constructor.name === 'TimeoutError') {
      return 'TimeoutError';
    }
    
    // Return the constructor name for other Error instances
    return error.constructor.name || error.name || 'UnknownError';
  }
  
  return 'Unknown';
};

export class LogAggregator {
  private readonly threshold: number = 300; // 30 per minute

  private _counter: number;
  private _logger: Logger;
  private _message: string;

  constructor(logger: Logger, message: string) {
    this._counter = 0;
    this._logger = logger;
    this._message = message;
  }

  private print() {
    this._logger.info(`${this._counter} logs printed for: ${this._message}`);
  }

  public log() {
    this._counter += 1;
    if (this._counter >= this.threshold) {
      this.print();
      this._counter = 0;
    }
  }

  public flush() {
    if (this._counter > 0) {
      this.print();
      this._counter = 0;
    }
  }
}

export const getCorrelationIdLog = (correlationId: string) => {
  return `[correlationId: ${correlationId || 'None'}]`;
};
