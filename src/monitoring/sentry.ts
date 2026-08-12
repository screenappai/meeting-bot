import * as Sentry from '@sentry/node';
import { v5 as uuidv5 } from 'uuid';

const REDACTED = '[REDACTED]';
const MAX_FLUSH_TIMEOUT_MS = 2_000;
const GLOBAL_HANDLER_INTEGRATIONS = new Set([
  'Console',
  'OnUncaughtException',
  'OnUnhandledRejection',
]);

const SENSITIVE_KEYS = new Set([
  'authorization',
  'accountid',
  'bearer',
  'body',
  'clientsecret',
  'clientid',
  'cookie',
  'cookies',
  'documentbody',
  'documentbodytext',
  'dsn',
  'html',
  'idtoken',
  'oauth',
  'pagebody',
  'pagecontent',
  'pagetext',
  'password',
  'passwd',
  'pwd',
  'query',
  'querystring',
  'refreshtoken',
  'requestbody',
  'responsebody',
  'secret',
  'servicekey',
  'signature',
  'setcookie',
  'token',
  'accesstoken',
  'apikey',
  'participantuserid',
]);

type SentrySdk = Pick<
  typeof Sentry,
  'captureException' | 'captureMessage' | 'flush' | 'init' | 'withScope'
>;

export type MeetingProvider = 'google' | 'microsoft' | 'zoom';
export type RecordingTransport = 'browser' | 'rtms';
export type MeetingFailureKind =
  | 'automated_bot_blocked'
  | 'browser_failure'
  | 'host_rejected'
  | 'lobby_timeout'
  | 'meeting_ended'
  | 'recording_failure'
  | 'rtms_failure'
  | 'sign_in_required'
  | 'technical_failure'
  | 'unsupported_meeting'
  | 'upload_failed';

export interface MeetingSentryContext {
  provider: MeetingProvider;
  transport: RecordingTransport;
  phase: string;
  fallbackResult: string;
  teamId: string;
  eventId?: string;
  botId?: string;
  correlationId: string;
}

export interface MeetingIdentityContext {
  teamId: string;
  userId: string;
  url: string;
  eventId?: string;
  botId?: string;
}

export interface OperationalSentryContext {
  phase: string;
  provider?: MeetingProvider | 'system';
  transport?: RecordingTransport | 'none';
  teamId?: string;
  eventId?: string;
  botId?: string;
  correlationId?: string;
}

const normalizedKey = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, '');

const isSensitiveKey = (key: string, parentKey?: string): boolean => {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  if (
    normalized.endsWith('secret')
    || normalized.endsWith('token')
    || normalized.endsWith('apikey')
    || normalized.endsWith('authorization')
    || normalized.endsWith('cookie')
    || normalized.endsWith('password')
    || normalized.endsWith('signature')
  ) return true;
  return normalized === 'data' && normalizedKey(parentKey ?? '') === 'request';
};

export const redactSensitiveString = (value: string): string => value
  .replace(/\b(?:https?|wss?|zoommtg):\/\/[^\s"'<>]+/gi, (candidate) => {
    const queryIndex = candidate.search(/[?#]/);
    return queryIndex === -1 ? candidate : candidate.slice(0, queryIndex);
  })
  .replace(
    /(^|[\s("'`])((?:\/\/|\/)[^\s"'<>?]+)\?[^\s"'<>]*/g,
    '$1$2'
  )
  .replace(
    /\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>?]*)?)\?[^\s"'<>]*/gi,
    '$1'
  )
  .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
  .replace(
    /((?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|id[_-]?token|oauth|password|passwd|pwd|refresh[_-]?token|secret|token)\s*["']?\s*[:=]\s*["']?)[^&\s,"'`;}]*/gi,
    `$1${REDACTED}`
  );

const redactValue = (
  value: unknown,
  seen: WeakSet<object>,
  parentKey?: string
): unknown => {
  if (typeof value === 'string') return redactSensitiveString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, parentKey));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key, parentKey)
      ? REDACTED
      : redactValue(nestedValue, seen, key);
  }
  return redacted;
};

export const redactSentryEvent = <T>(event: T): T => {
  const redacted = redactValue(event, new WeakSet<object>()) as T;
  if (redacted && typeof redacted === 'object' && 'user' in redacted) {
    delete (redacted as Record<string, unknown>).user;
  }
  return redacted;
};

const errorType = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Unknown';
  return error.constructor.name || error.name || 'UnknownError';
};

const errorDescriptor = (error: unknown): string => [
  errorType(error),
  error instanceof Error ? error.message : '',
].join(' ').toLowerCase();

const readErrorTag = (error: unknown, key: string): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const FAILURE_KINDS = new Set<MeetingFailureKind>([
  'automated_bot_blocked',
  'browser_failure',
  'host_rejected',
  'lobby_timeout',
  'meeting_ended',
  'recording_failure',
  'rtms_failure',
  'sign_in_required',
  'technical_failure',
  'unsupported_meeting',
  'upload_failed',
]);

export const classifyMeetingFailureKind = (error: unknown): MeetingFailureKind => {
  const explicitKind = readErrorTag(error, 'failureKind')
    ?? readErrorTag(error, 'failure_kind');
  if (explicitKind && FAILURE_KINDS.has(explicitKind as MeetingFailureKind)) {
    return explicitKind as MeetingFailureKind;
  }

  const reason = readErrorTag(error, 'reason');
  if (reason && FAILURE_KINDS.has(reason as MeetingFailureKind)) {
    return reason as MeetingFailureKind;
  }
  const descriptor = errorDescriptor(error);
  if (reason === 'automated_bot_blocked' || descriptor.includes('automated bot')) {
    return 'automated_bot_blocked';
  }

  if (descriptor.includes('waitingatlobby') || descriptor.includes('waiting at lobby')) {
    const bodyText = readErrorTag(error, 'documentBodyText') ?? '';
    return /denied|removed|rejected/i.test(bodyText)
      ? 'host_rejected'
      : 'lobby_timeout';
  }

  if (/host.?rejected|denied access|request (?:was )?denied/.test(descriptor)) {
    return 'host_rejected';
  }
  if (descriptor.includes('lobby') && descriptor.includes('timeout')) return 'lobby_timeout';
  if (descriptor.includes('sign in') || descriptor.includes('signin')) return 'sign_in_required';
  if (descriptor.includes('upload')) return 'upload_failed';
  if (descriptor.includes('rtms')) return 'rtms_failure';
  if (
    descriptor.includes('browser')
    || descriptor.includes('context-closed')
    || descriptor.includes('page-crashed')
    || descriptor.includes('page-closed')
    || descriptor.includes('cdp')
  ) return 'browser_failure';
  if (descriptor.includes('meeting ended') || descriptor.includes('meeting_ended')) {
    return 'meeting_ended';
  }
  if (descriptor.includes('unsupported meeting') || descriptor.includes('unsupportedmeeting')) {
    return 'unsupported_meeting';
  }
  if (descriptor.includes('recording')) return 'recording_failure';
  return 'technical_failure';
};

const failureLevel = (failureKind: MeetingFailureKind): 'error' | 'warning' =>
  failureKind === 'host_rejected' || failureKind === 'lobby_timeout'
    ? 'warning'
    : 'error';

export const inferMeetingFailurePhase = (error: unknown): string => {
  const explicitPhase = readErrorTag(error, 'phase') ?? readErrorTag(error, 'stage');
  if (explicitPhase) return explicitPhase;

  const type = errorDescriptor(error);
  if (type.includes('upload')) return 'upload';
  if (type.includes('lobby') || type.includes('waitingroom')) return 'waiting_room';
  if (type.includes('signin') || type.includes('unsupported') || type.includes('join')) return 'prejoin';
  if (type.includes('browser') || type.includes('context') || type.includes('cdp')) return 'browser';
  if (type.includes('rtms')) return 'fallback';
  return 'recording';
};

export const inferMeetingFailureTransport = (error: unknown): RecordingTransport => {
  const transport = readErrorTag(error, 'transport');
  if (transport === 'rtms' || transport === 'browser') return transport;
  return errorDescriptor(error).includes('rtms') ? 'rtms' : 'browser';
};

export const inferFallbackResult = (error: unknown): string => {
  const fallbackResult = readErrorTag(error, 'fallbackResult')
    ?? readErrorTag(error, 'fallback_result');
  if (fallbackResult) return fallbackResult;
  return inferMeetingFailureTransport(error) === 'rtms' ? 'failed' : 'not_attempted';
};

export const createSentryCorrelationId = ({
  userId,
  eventId,
  botId,
  url,
}: MeetingIdentityContext): string => {
  const entityId = botId ?? eventId;
  return uuidv5(`${userId}:${entityId}:${url}`, uuidv5.DNS);
};

const normalizedException = (error: unknown): Error => {
  if (error instanceof Error) return error;
  return new Error(redactSensitiveString(String(error ?? 'Unknown error')));
};

export class SentryReporter {
  private enabled = false;
  private environment = 'unknown';
  private release = 'unknown';
  private readonly reportedObjectFailures = new WeakMap<object, Set<string>>();
  private readonly reportedPrimitiveFailures = new Set<string>();

  constructor(
    private readonly sdk: SentrySdk = Sentry,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  initialize(): boolean {
    const dsn = this.env.SENTRY_DSN?.trim();
    if (!dsn) return false;

    this.environment = this.env.SENTRY_ENVIRONMENT?.trim()
      || this.env.NODE_ENV?.trim()
      || 'unknown';
    this.release = this.env.SENTRY_RELEASE?.trim() || 'unknown';

    try {
      this.sdk.init({
        dsn,
        environment: this.environment,
        release: this.release === 'unknown' ? undefined : this.release,
        tracesSampleRate: 0,
        sendDefaultPii: false,
        integrations: (defaultIntegrations) => defaultIntegrations.filter(
          (integration) => !GLOBAL_HANDLER_INTEGRATIONS.has(integration.name)
        ),
        beforeSend: (event) => redactSentryEvent(event),
      });
      this.enabled = true;
      return true;
    } catch (error) {
      console.error(
        'Sentry initialization failed; monitoring is disabled.',
        redactSensitiveString(normalizedException(error).message)
      );
      return false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private tags(
    context: OperationalSentryContext & {
      errorType: string;
      failureKind: MeetingFailureKind;
      fallbackResult?: string;
    }
  ): Record<string, string> {
    return {
      provider: context.provider ?? 'system',
      transport: context.transport ?? 'none',
      error_type: context.errorType,
      failure_kind: context.failureKind,
      stage: context.phase,
      fallback_result: context.fallbackResult ?? 'not_applicable',
      environment: this.environment,
      release: this.release,
      team_id: context.teamId ?? 'none',
      event_id: context.eventId ?? 'none',
      bot_id: context.botId ?? 'none',
      correlation_id: context.correlationId ?? 'none',
    };
  }

  private capture(
    error: unknown,
    level: 'error' | 'warning',
    tags: Record<string, string>,
    message?: string
  ): void {
    if (!this.enabled) return;
    try {
      this.sdk.withScope((scope) => {
        scope.setLevel(level);
        for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
        scope.setFingerprint([tags.provider, tags.failure_kind]);
        if (message) {
          this.sdk.captureMessage(message, level);
        } else {
          this.sdk.captureException(normalizedException(error));
        }
      });
    } catch (captureError) {
      console.error(
        'Sentry capture failed.',
        redactSensitiveString(normalizedException(captureError).message)
      );
    }
  }

  private failureKey(error: unknown, context: MeetingSentryContext): string {
    return [
      context.correlationId,
      context.provider,
      context.transport,
      context.phase,
      context.fallbackResult,
      errorType(error),
    ].join(':');
  }

  private isDuplicatePermanentFailure(error: unknown, context: MeetingSentryContext): boolean {
    const key = this.failureKey(error, context);
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      const previousKeys = this.reportedObjectFailures.get(error as object);
      if (previousKeys?.has(key)) return true;
      if (previousKeys) {
        previousKeys.add(key);
      } else {
        this.reportedObjectFailures.set(error as object, new Set([key]));
      }
      return false;
    }

    if (this.reportedPrimitiveFailures.has(key)) return true;
    if (this.reportedPrimitiveFailures.size >= 1_000) {
      this.reportedPrimitiveFailures.clear();
    }
    this.reportedPrimitiveFailures.add(key);
    return false;
  }

  reportPermanentMeetingFailure(error: unknown, context: MeetingSentryContext): boolean {
    if (!this.enabled || this.isDuplicatePermanentFailure(error, context)) return false;
    const failureKind = classifyMeetingFailureKind(error);
    this.capture(error, failureLevel(failureKind), this.tags({
      ...context,
      errorType: errorType(error),
      failureKind,
    }));
    return true;
  }

  reportRecoveredZoomFallback(
    context: Omit<MeetingSentryContext, 'provider' | 'transport' | 'fallbackResult'>,
    browserError?: unknown
  ): boolean {
    if (!this.enabled) return false;
    this.capture(browserError, 'warning', this.tags({
      ...context,
      provider: 'zoom',
      transport: 'rtms',
      errorType: errorType(browserError) === 'Unknown'
        ? 'ZoomBrowserJoinBlockedError'
        : errorType(browserError),
      failureKind: 'automated_bot_blocked',
      fallbackResult: 'recovered',
    }), 'Zoom browser join was blocked; RTMS fallback recovered the recording.');
    return true;
  }

  captureOperationalError(error: unknown, context: OperationalSentryContext): boolean {
    if (!this.enabled) return false;
    this.capture(error, 'error', this.tags({
      ...context,
      errorType: errorType(error),
      failureKind: classifyMeetingFailureKind(error),
    }));
    return true;
  }

  async flush(timeoutMs = MAX_FLUSH_TIMEOUT_MS): Promise<boolean> {
    if (!this.enabled) return true;
    const boundedTimeout = Math.min(
      MAX_FLUSH_TIMEOUT_MS,
      Math.max(0, Math.floor(timeoutMs))
    );
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.sdk.flush(boundedTimeout),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), boundedTimeout);
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

const reporter = new SentryReporter();

export const initializeSentry = (): boolean => reporter.initialize();
export const isSentryEnabled = (): boolean => reporter.isEnabled();
export const reportPermanentMeetingFailure = (
  error: unknown,
  context: MeetingSentryContext
): boolean => reporter.reportPermanentMeetingFailure(error, context);
export const reportRecoveredZoomFallback = (
  context: Omit<MeetingSentryContext, 'provider' | 'transport' | 'fallbackResult'>,
  browserError?: unknown
): boolean => reporter.reportRecoveredZoomFallback(context, browserError);
export const captureOperationalError = (
  error: unknown,
  context: OperationalSentryContext
): boolean => reporter.captureOperationalError(error, context);
export const flushSentry = (timeoutMs = MAX_FLUSH_TIMEOUT_MS): Promise<boolean> =>
  reporter.flush(timeoutMs);
