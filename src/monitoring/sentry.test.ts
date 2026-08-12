import assert from 'node:assert/strict';
import test from 'node:test';
import { WaitingAtLobbyRetryError } from '../error';
import {
  SentryReporter,
  classifyMeetingFailureKind,
  inferFallbackResult,
  inferMeetingFailurePhase,
  inferMeetingFailureTransport,
  redactSentryEvent,
} from './sentry';

interface FakeScope {
  level?: string;
  tags: Record<string, string>;
  fingerprint?: string[];
  setLevel(level: string): void;
  setTag(key: string, value: string): void;
  setFingerprint(fingerprint: string[]): void;
}

interface FakeInitOptions {
  dsn?: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
  sendDefaultPii?: boolean;
  beforeSend?: (event: unknown) => unknown;
  integrations?: (
    integrations: Array<{ name: string }>
  ) => Array<{ name: string }>;
}

const createFakeSdk = () => {
  let activeScope: FakeScope | undefined;
  const state = {
    initCalls: [] as FakeInitOptions[],
    exceptions: [] as Array<{ error: unknown; level?: string; tags: Record<string, string>; fingerprint?: string[] }>,
    messages: [] as Array<{ message: string; level?: string; tags: Record<string, string>; fingerprint?: string[] }>,
    flushTimeouts: [] as number[],
  };

  const sdk = {
    init(options: FakeInitOptions) {
      state.initCalls.push(options);
    },
    withScope(callback: (scope: FakeScope) => void) {
      const scope: FakeScope = {
        tags: {},
        setLevel(level) {
          this.level = level;
        },
        setTag(key, value) {
          this.tags[key] = value;
        },
        setFingerprint(fingerprint) {
          this.fingerprint = fingerprint;
        },
      };
      activeScope = scope;
      callback(scope);
      activeScope = undefined;
    },
    captureException(error: unknown) {
      state.exceptions.push({
        error,
        level: activeScope?.level,
        tags: { ...activeScope?.tags },
        fingerprint: activeScope?.fingerprint,
      });
      return 'event-id';
    },
    captureMessage(message: string) {
      state.messages.push({
        message,
        level: activeScope?.level,
        tags: { ...activeScope?.tags },
        fingerprint: activeScope?.fingerprint,
      });
      return 'event-id';
    },
    async flush(timeout: number) {
      state.flushTimeouts.push(timeout);
      return true;
    },
  };

  return { sdk, state };
};

test('is a complete no-op when SENTRY_DSN is absent', async () => {
  const { sdk, state } = createFakeSdk();
  const reporter = new SentryReporter(sdk as never, {});

  assert.equal(reporter.initialize(), false);
  assert.equal(reporter.captureOperationalError(new Error('failure'), { phase: 'startup' }), false);
  assert.equal(await reporter.flush(), true);
  assert.equal(state.initCalls.length, 0);
  assert.equal(state.exceptions.length, 0);
  assert.equal(state.flushTimeouts.length, 0);
});

test('initializes Sentry with safe non-tracing defaults from the environment', () => {
  const { sdk, state } = createFakeSdk();
  const reporter = new SentryReporter(sdk as never, {
    SENTRY_DSN: 'https://public@example.invalid/1',
    SENTRY_ENVIRONMENT: 'production',
    SENTRY_RELEASE: 'meeting-bot@1.3.6',
  });

  assert.equal(reporter.initialize(), true);
  assert.equal(state.initCalls.length, 1);
  assert.equal(state.initCalls[0].dsn, 'https://public@example.invalid/1');
  assert.equal(state.initCalls[0].environment, 'production');
  assert.equal(state.initCalls[0].release, 'meeting-bot@1.3.6');
  assert.equal(state.initCalls[0].tracesSampleRate, 0);
  assert.equal(state.initCalls[0].sendDefaultPii, false);
  assert.equal(typeof state.initCalls[0].beforeSend, 'function');
  const integrations = state.initCalls[0].integrations?.([
    { name: 'Http' },
    { name: 'Console' },
    { name: 'OnUncaughtException' },
    { name: 'OnUnhandledRejection' },
  ]);
  assert.deepEqual(integrations?.map(({ name }) => name), ['Http']);
});

test('redacts URL queries, credentials, request and page bodies before sending', () => {
  const event = {
    message: 'Failed https://zoom.us/j/123?pwd=zoom-password&token=url-token and /wc/join/123?foo=private-query token=inline-token',
    user: { email: 'person@example.com' },
    request: {
      url: 'https://zoom.us/j/123?pwd=zoom-password',
      query_string: 'pwd=zoom-password',
      data: '<html>private page</html>',
      headers: {
        authorization: 'Bearer private-bearer',
        'x-api-key': 'private-api-key',
      },
    },
    extra: {
      documentBodyText: 'private page text',
      clientSecret: 'private-client-secret',
      nested: { password: 'private-password' },
    },
  };

  const redacted = redactSentryEvent(event);
  const serialized = JSON.stringify(redacted);

  assert.equal(redacted.request.url, 'https://zoom.us/j/123');
  assert.equal('user' in redacted, false);
  assert.equal(redacted.request.query_string, '[REDACTED]');
  assert.equal(redacted.request.data, '[REDACTED]');
  assert.equal(redacted.request.headers.authorization, '[REDACTED]');
  assert.equal(redacted.request.headers['x-api-key'], '[REDACTED]');
  for (const secret of [
    'zoom-password',
    'url-token',
    'inline-token',
    'private-query',
    'private page',
    'private-bearer',
    'private-api-key',
    'private-client-secret',
    'private-password',
  ]) {
    assert.equal(serialized.includes(secret), false, `found leaked value: ${secret}`);
  }
});

test('redacts non-HTTP meeting URLs and inline OAuth credentials', () => {
  const event = {
    message: 'wss://rtms.zoom.us/connect?signature=private zoommtg://zoom.us/join?pwd=private clientSecret=private oauth_token=private',
  };
  const serialized = JSON.stringify(redactSentryEvent(event));

  assert.equal(serialized.includes('signature=private'), false);
  assert.equal(serialized.includes('pwd=private'), false);
  assert.equal(serialized.includes('clientSecret=private'), false);
  assert.equal(serialized.includes('oauth_token=private'), false);
});

test('captures one tagged permanent meeting failure for the same final error', () => {
  const { sdk, state } = createFakeSdk();
  const reporter = new SentryReporter(sdk as never, {
    SENTRY_DSN: 'https://public@example.invalid/1',
    SENTRY_ENVIRONMENT: 'production',
    SENTRY_RELEASE: 'meeting-bot@1.3.6',
  });
  reporter.initialize();

  const error = new Error('recording failed');
  const context = {
    provider: 'microsoft' as const,
    transport: 'browser' as const,
    phase: 'recording',
    fallbackResult: 'not_attempted',
    teamId: 'team-id',
    eventId: 'event-id',
    botId: 'bot-id',
    correlationId: 'correlation-id',
  };

  assert.equal(reporter.reportPermanentMeetingFailure(error, context), true);
  assert.equal(reporter.reportPermanentMeetingFailure(error, context), false);
  assert.equal(state.exceptions.length, 1);
  assert.equal(state.exceptions[0].level, 'error');
  assert.deepEqual(state.exceptions[0].fingerprint, ['microsoft', 'recording_failure']);
  assert.deepEqual(state.exceptions[0].tags, {
    provider: 'microsoft',
    transport: 'browser',
    error_type: 'Error',
    failure_kind: 'recording_failure',
    stage: 'recording',
    fallback_result: 'not_attempted',
    environment: 'production',
    release: 'meeting-bot@1.3.6',
    team_id: 'team-id',
    event_id: 'event-id',
    bot_id: 'bot-id',
    correlation_id: 'correlation-id',
  });
});

test('reports host rejection and lobby timeout as classified warnings', () => {
  const { sdk, state } = createFakeSdk();
  const reporter = new SentryReporter(sdk as never, {
    SENTRY_DSN: 'https://public@example.invalid/1',
  });
  reporter.initialize();

  const context = {
    provider: 'google' as const,
    transport: 'browser' as const,
    phase: 'waiting_room',
    fallbackResult: 'not_attempted',
    teamId: 'team-id',
    eventId: 'event-id',
    correlationId: 'correlation-id',
  };
  const rejected = new WaitingAtLobbyRetryError(
    'Google Meet bot could not enter the meeting',
    'Someone in the call denied your request to join'
  );
  const timedOut = new WaitingAtLobbyRetryError(
    'Google Meet bot could not enter the meeting',
    'No one responded to your request to join the call'
  );

  assert.equal(classifyMeetingFailureKind(rejected), 'host_rejected');
  assert.equal(classifyMeetingFailureKind(timedOut), 'lobby_timeout');
  reporter.reportPermanentMeetingFailure(rejected, context);
  reporter.reportPermanentMeetingFailure(timedOut, {
    ...context,
    correlationId: 'second-correlation-id',
  });

  assert.deepEqual(state.exceptions.map(({ level, tags }) => ({
    level,
    failureKind: tags.failure_kind,
    stage: tags.stage,
  })), [
    { level: 'warning', failureKind: 'host_rejected', stage: 'waiting_room' },
    { level: 'warning', failureKind: 'lobby_timeout', stage: 'waiting_room' },
  ]);
});

test('keeps technical permanent failures at error level', () => {
  const { sdk, state } = createFakeSdk();
  const reporter = new SentryReporter(sdk as never, {
    SENTRY_DSN: 'https://public@example.invalid/1',
  });
  reporter.initialize();

  const technicalError = new Error('CDP browser disconnected');
  reporter.reportPermanentMeetingFailure(technicalError, {
    provider: 'zoom',
    transport: 'browser',
    phase: 'recording',
    fallbackResult: 'not_attempted',
    teamId: 'team-id',
    botId: 'bot-id',
    correlationId: 'correlation-id',
  });

  assert.equal(state.exceptions[0].level, 'error');
  assert.equal(state.exceptions[0].tags.failure_kind, 'browser_failure');
  assert.equal(state.exceptions[0].tags.team_id, 'team-id');
  assert.equal(state.exceptions[0].tags.bot_id, 'bot-id');
  assert.equal(state.exceptions[0].tags.event_id, 'none');
});

test('classifies an RTMS fallback failure from a wrapped error message', () => {
  const error = new Error('Zoom RTMS stream failed after recovery retries');
  assert.equal(inferMeetingFailureTransport(error), 'rtms');
  assert.equal(inferMeetingFailurePhase(error), 'fallback');
  assert.equal(inferFallbackResult(error), 'failed');
});

test('preserves explicit RTMS transport context for upload failures', () => {
  const error = Object.assign(new Error('Recording upload failed'), {
    transport: 'rtms',
    phase: 'upload',
    fallbackResult: 'recovered',
  });

  assert.equal(inferMeetingFailureTransport(error), 'rtms');
  assert.equal(inferMeetingFailurePhase(error), 'upload');
  assert.equal(inferFallbackResult(error), 'recovered');
});

test('reports a recovered Zoom RTMS fallback as a warning', () => {
  const { sdk, state } = createFakeSdk();
  const reporter = new SentryReporter(sdk as never, {
    SENTRY_DSN: 'https://public@example.invalid/1',
  });
  reporter.initialize();

  reporter.reportRecoveredZoomFallback({
    phase: 'fallback',
    teamId: 'team-id',
    eventId: 'event-id',
    correlationId: 'correlation-id',
  });

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].level, 'warning');
  assert.equal(state.messages[0].tags.provider, 'zoom');
  assert.equal(state.messages[0].tags.transport, 'rtms');
  assert.equal(state.messages[0].tags.failure_kind, 'automated_bot_blocked');
  assert.equal(state.messages[0].tags.stage, 'fallback');
  assert.equal(state.messages[0].tags.fallback_result, 'recovered');
});

test('caps Sentry flushing at two seconds', async () => {
  const { sdk, state } = createFakeSdk();
  const reporter = new SentryReporter(sdk as never, {
    SENTRY_DSN: 'https://public@example.invalid/1',
  });
  reporter.initialize();

  assert.equal(await reporter.flush(10_000), true);
  assert.deepEqual(state.flushTimeouts, [2_000]);
});
