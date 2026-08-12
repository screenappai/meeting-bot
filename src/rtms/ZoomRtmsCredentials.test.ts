import assert from 'node:assert/strict';
import test from 'node:test';
import config, {
  deriveZoomRtmsTransportStrategy,
  parseZoomRtmsCustomerCredentials,
  ZoomRtmsCustomerCredentials,
} from '../config';
import { ZoomRtmsCredentialsMissingError } from '../error';
import {
  resolveZoomRtmsCredentials,
  ZoomRtmsCredentialConfigurationError,
} from './ZoomRtmsCredentials';

const original = {
  transport: config.zoomRecordingTransport,
  rtmsClientId: config.zoomRtms.clientId,
  rtmsClientSecret: config.zoomRtms.clientSecret,
  rtmsWebhookSecret: config.zoomRtms.webhookSecret,
  oauthAccessToken: config.zoomRtms.oauthAccessToken,
  oauthAccountId: config.zoomRtms.oauthAccountId,
  oauthClientId: config.zoomRtms.oauthClientId,
  oauthClientSecret: config.zoomRtms.oauthClientSecret,
  participantUserId: config.zoomRtms.participantUserId,
  globalTeamId: config.zoomRtms.globalTeamId,
  customerCredentials: config.zoomRtms.customerCredentials,
  customerCredentialErrors: config.zoomRtms.customerCredentialErrors,
  customerCredentialsError: config.zoomRtms.customerCredentialsError,
};

const customer = (enabled = true): ZoomRtmsCustomerCredentials => ({
  enabled,
  accountId: 'account-a',
  clientId: 'oauth-client-a',
  clientSecret: 'oauth-secret-a',
  participantUserId: 'operator-a',
});

test.beforeEach(() => {
  config.zoomRecordingTransport = 'browser';
  config.zoomRtms.clientId = 'rtms-client';
  config.zoomRtms.clientSecret = 'rtms-secret';
  config.zoomRtms.webhookSecret = 'webhook-secret';
  config.zoomRtms.oauthAccessToken = undefined;
  config.zoomRtms.oauthAccountId = undefined;
  config.zoomRtms.oauthClientId = undefined;
  config.zoomRtms.oauthClientSecret = undefined;
  config.zoomRtms.participantUserId = undefined;
  config.zoomRtms.globalTeamId = undefined;
  config.zoomRtms.customerCredentials = Object.create(null);
  config.zoomRtms.customerCredentialErrors = Object.create(null);
  config.zoomRtms.customerCredentialsError = undefined;
});

test.after(() => {
  config.zoomRecordingTransport = original.transport;
  config.zoomRtms.clientId = original.rtmsClientId;
  config.zoomRtms.clientSecret = original.rtmsClientSecret;
  config.zoomRtms.webhookSecret = original.rtmsWebhookSecret;
  config.zoomRtms.oauthAccessToken = original.oauthAccessToken;
  config.zoomRtms.oauthAccountId = original.oauthAccountId;
  config.zoomRtms.oauthClientId = original.oauthClientId;
  config.zoomRtms.oauthClientSecret = original.oauthClientSecret;
  config.zoomRtms.participantUserId = original.participantUserId;
  config.zoomRtms.globalTeamId = original.globalTeamId;
  config.zoomRtms.customerCredentials = original.customerCredentials;
  config.zoomRtms.customerCredentialErrors = original.customerCredentialErrors;
  config.zoomRtms.customerCredentialsError = original.customerCredentialsError;
});

test('parses customer credential JSON without exposing secret values in errors', () => {
  const parsed = parseZoomRtmsCustomerCredentials(JSON.stringify({
    'team-a': customer(),
    'team-b': { enabled: true, clientSecret: 'must-not-appear' },
  }));

  assert.deepEqual({ ...parsed.credentials['team-a'] }, customer());
  assert.match(parsed.entryErrors['team-b'], /accountId/);
  assert.equal(parsed.entryErrors['team-b'].includes('must-not-appear'), false);

  const malformed = parseZoomRtmsCustomerCredentials('{secret-value');
  assert.match(malformed.error ?? '', /valid JSON/);
  assert.equal(malformed.error?.includes('secret-value'), false);
});

test('parses complete dedicated RTMS app credentials', () => {
  const dedicated = {
    ...customer(),
    rtmsApp: {
      webhookId: 'customer-app-a',
      clientId: 'dedicated-rtms-client',
      clientSecret: 'dedicated-rtms-secret',
      webhookSecret: 'dedicated-webhook-secret',
    },
  };
  const parsed = parseZoomRtmsCustomerCredentials(JSON.stringify({
    'team-a': dedicated,
  }));

  assert.deepEqual({ ...parsed.credentials['team-a'] }, dedicated);
  assert.deepEqual({ ...parsed.entryErrors }, {});
});

test('enforces the configured customer credential mode', () => {
  const dedicated = {
    ...customer(),
    rtmsApp: {
      webhookId: 'customer-app-a',
      clientId: 'dedicated-rtms-client',
      clientSecret: 'dedicated-rtms-secret',
      webhookSecret: 'dedicated-webhook-secret',
    },
  };

  const dedicatedOnly = parseZoomRtmsCustomerCredentials(JSON.stringify({
    shared: customer(),
    dedicated,
  }), 'dedicated_customer');
  assert.equal(dedicatedOnly.credentials.shared, undefined);
  assert.deepEqual({ ...dedicatedOnly.credentials.dedicated }, dedicated);
  assert.match(dedicatedOnly.entryErrors.shared, /rtmsApp is required/);

  const sharedOnly = parseZoomRtmsCustomerCredentials(JSON.stringify({
    shared: customer(),
    dedicated,
  }), 'shared_customer');
  assert.deepEqual({ ...sharedOnly.credentials.shared }, customer());
  assert.equal(sharedOnly.credentials.dedicated, undefined);
  assert.match(sharedOnly.entryErrors.dedicated, /rtmsApp is not allowed/);
});

test('rejects partial, unsafe, and duplicate dedicated app settings without leaking secrets', () => {
  const secret = 'must-never-appear';
  const parsed = parseZoomRtmsCustomerCredentials(JSON.stringify({
    partial: {
      ...customer(),
      rtmsApp: {
        webhookId: 'partial-app',
        clientId: 'dedicated-client',
        clientSecret: secret,
      },
    },
    unsafe: {
      ...customer(),
      rtmsApp: {
        webhookId: '../unsafe',
        clientId: 'dedicated-client',
        clientSecret: secret,
        webhookSecret: secret,
      },
    },
    duplicateA: {
      ...customer(),
      rtmsApp: {
        webhookId: 'duplicate-app',
        clientId: 'dedicated-client-a',
        clientSecret: secret,
        webhookSecret: secret,
      },
    },
    duplicateB: {
      ...customer(),
      rtmsApp: {
        webhookId: 'duplicate-app',
        clientId: 'dedicated-client-b',
        clientSecret: secret,
        webhookSecret: secret,
      },
    },
  }));

  assert.equal(parsed.credentials.partial, undefined);
  assert.equal(parsed.credentials.unsafe, undefined);
  assert.equal(parsed.credentials.duplicateA, undefined);
  assert.equal(parsed.credentials.duplicateB, undefined);
  assert.match(parsed.entryErrors.partial, /rtmsApp\.webhookSecret/);
  assert.match(parsed.entryErrors.unsafe, /rtmsApp\.webhookId/);
  assert.match(parsed.entryErrors.duplicateA, /unique/);
  assert.match(parsed.entryErrors.duplicateB, /unique/);
  assert.equal(JSON.stringify(parsed.entryErrors).includes(secret), false);
});

test('derives browser-only, fallback, and forced RTMS strategies', () => {
  assert.equal(deriveZoomRtmsTransportStrategy('browser', false), 'browser_only');
  assert.equal(deriveZoomRtmsTransportStrategy('browser', true), 'browser_then_rtms');
  assert.equal(deriveZoomRtmsTransportStrategy('rtms', false), 'rtms_only');
  assert.equal(deriveZoomRtmsTransportStrategy('rtms', true), 'rtms_only');
});

test('selects enabled team credentials for browser fallback', () => {
  config.zoomRtms.customerCredentials['team-a'] = customer();

  const selected = resolveZoomRtmsCredentials('team-a');
  assert.equal(selected.api.source, 'customer');
  assert.equal(selected.api.oauthAccountId, 'account-a');
  assert.equal(selected.api.oauthClientId, 'oauth-client-a');
  assert.equal(selected.credentialMode, 'shared_customer');
  assert.equal(selected.app.appId, 'global');
  assert.equal(selected.app.clientId, 'rtms-client');
  assert.equal(selected.eventScope.customerId, 'team-a');
  assert.equal(selected.eventScope.appId, 'global');
  assert.equal(selected.eventScope.operatorId, 'operator-a');
});

test('selects dedicated RTMS app and customer OAuth credentials together', () => {
  config.zoomRtms.customerCredentials['team-a'] = {
    ...customer(),
    rtmsApp: {
      webhookId: 'customer-app-a',
      clientId: 'dedicated-rtms-client',
      clientSecret: 'dedicated-rtms-secret',
      webhookSecret: 'dedicated-webhook-secret',
    },
  };

  const selected = resolveZoomRtmsCredentials('team-a');
  assert.equal(selected.credentialMode, 'dedicated_customer');
  assert.equal(selected.app.appId, 'customer-app-a');
  assert.equal(selected.app.clientId, 'dedicated-rtms-client');
  assert.equal(selected.app.clientSecret, 'dedicated-rtms-secret');
  assert.equal(selected.app.webhookSecret, 'dedicated-webhook-secret');
  assert.equal(selected.api.rtmsClientId, 'dedicated-rtms-client');
  assert.equal(selected.api.oauthClientId, 'oauth-client-a');
  assert.equal(selected.eventScope.appId, 'customer-app-a');
});

test('dedicated customer apps do not depend on global RTMS app credentials', () => {
  config.zoomRtms.clientId = undefined;
  config.zoomRtms.clientSecret = undefined;
  config.zoomRtms.webhookSecret = undefined;
  config.zoomRtms.customerCredentials['dedicated-team'] = {
    ...customer(),
    rtmsApp: {
      webhookId: 'dedicated-app',
      clientId: 'dedicated-client',
      clientSecret: 'dedicated-secret',
      webhookSecret: 'dedicated-webhook-secret',
    },
  };
  config.zoomRtms.customerCredentials['shared-team'] = customer();

  assert.equal(
    resolveZoomRtmsCredentials('dedicated-team').credentialMode,
    'dedicated_customer'
  );
  assert.throws(
    () => resolveZoomRtmsCredentials('shared-team'),
    (error: unknown) => error instanceof ZoomRtmsCredentialConfigurationError
      && error.reason === 'invalid_global_configuration'
  );
});

test('fails typed for missing, disabled, and invalid fallback credentials', () => {
  assert.throws(
    () => resolveZoomRtmsCredentials('missing-team'),
    ZoomRtmsCredentialsMissingError
  );

  config.zoomRtms.customerCredentials['disabled-team'] = customer(false);
  assert.throws(
    () => resolveZoomRtmsCredentials('disabled-team'),
    (error: unknown) => error instanceof ZoomRtmsCredentialConfigurationError
      && error.reason === 'disabled'
  );

  config.zoomRtms.customerCredentialErrors['invalid-team'] = 'invalid fields';
  assert.throws(
    () => resolveZoomRtmsCredentials('invalid-team'),
    (error: unknown) => error instanceof ZoomRtmsCredentialConfigurationError
      && error.reason === 'invalid_customer_configuration'
  );
});

test('uses global OAuth only for the explicitly configured internal team', () => {
  config.zoomRtms.globalTeamId = 'internal-team';
  config.zoomRtms.oauthAccessToken = 'legacy-access-token';
  config.zoomRtms.participantUserId = 'legacy-operator';

  const selected = resolveZoomRtmsCredentials('internal-team');
  assert.equal(selected.api.source, 'legacy');
  assert.equal(selected.credentialMode, 'internal');
  assert.equal(selected.app.appId, 'global');
  assert.equal(selected.api.oauthAccessToken, 'legacy-access-token');
  assert.equal(selected.eventScope.appId, 'global');
  assert.equal(selected.eventScope.customerId, 'internal-team');
  assert.equal(selected.eventScope.operatorId, 'legacy-operator');

  assert.throws(
    () => resolveZoomRtmsCredentials('team-without-mapping'),
    ZoomRtmsCredentialsMissingError
  );
});

test('never falls back to global OAuth for disabled or invalid customer credentials', () => {
  config.zoomRtms.globalTeamId = 'internal-team';
  config.zoomRtms.oauthAccessToken = 'legacy-access-token';
  config.zoomRtms.customerCredentials['internal-team'] = customer(false);

  assert.throws(
    () => resolveZoomRtmsCredentials('internal-team'),
    (error: unknown) => error instanceof ZoomRtmsCredentialConfigurationError
      && error.reason === 'disabled'
  );

  delete config.zoomRtms.customerCredentials['internal-team'];
  config.zoomRtms.customerCredentialErrors['internal-team'] = 'invalid fields';
  assert.throws(
    () => resolveZoomRtmsCredentials('internal-team'),
    (error: unknown) => error instanceof ZoomRtmsCredentialConfigurationError
      && error.reason === 'invalid_customer_configuration'
  );

  config.zoomRtms.customerCredentialErrors = Object.create(null);
  config.zoomRtms.customerCredentialsError = 'invalid JSON';
  assert.throws(
    () => resolveZoomRtmsCredentials('internal-team'),
    (error: unknown) => error instanceof ZoomRtmsCredentialConfigurationError
      && error.reason === 'invalid_customer_configuration'
  );
});

test('supports internal and customer credentials in the same deployment', () => {
  config.zoomRtms.globalTeamId = 'internal-team';
  config.zoomRtms.oauthAccessToken = 'legacy-access-token';
  config.zoomRtms.customerCredentials['customer-team'] = customer();

  assert.equal(resolveZoomRtmsCredentials('internal-team').api.source, 'legacy');
  assert.equal(resolveZoomRtmsCredentials('customer-team').api.source, 'customer');
  assert.throws(
    () => resolveZoomRtmsCredentials('unknown-team'),
    ZoomRtmsCredentialsMissingError
  );
});

test('prefers an enabled exact customer mapping over global credentials', () => {
  config.zoomRtms.globalTeamId = 'shared-team';
  config.zoomRtms.oauthAccessToken = 'legacy-access-token';
  config.zoomRtms.customerCredentials['shared-team'] = customer();

  const selected = resolveZoomRtmsCredentials('shared-team');
  assert.equal(selected.api.source, 'customer');
  assert.equal(selected.api.oauthAccountId, 'account-a');
});
