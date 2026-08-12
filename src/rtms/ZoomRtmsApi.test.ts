import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { KnownError } from '../error';
import { ZoomRtmsApi } from './ZoomRtmsApi';
import { ZoomRtmsApiCredentials } from './types';

const originalPatch = axios.patch;
const originalPost = axios.post;

const legacyCredentials = (): ZoomRtmsApiCredentials => ({
  source: 'legacy',
  customerId: 'legacy',
  rtmsClientId: 'rtms-client',
  oauthAccessToken: 'access-token',
});

const customerCredentials = (
  customerId: string,
  clientId = `${customerId}-client`
): ZoomRtmsApiCredentials => ({
  source: 'customer',
  customerId,
  rtmsClientId: 'rtms-client',
  participantUserId: `${customerId}-operator`,
  oauthAccountId: `${customerId}-account`,
  oauthClientId: clientId,
  oauthClientSecret: `${customerId}-secret`,
});

test.beforeEach(() => {
  ZoomRtmsApi.clearTokenCache();
});

test.afterEach(() => {
  axios.patch = originalPatch;
  axios.post = originalPost;
});

const zoomError = (status: number, code?: number) => ({
  isAxiosError: true,
  response: {
    status,
    data: { code, message: 'Zoom API error' },
  },
});

test('retries transient start failures with bounded exponential backoff', async () => {
  let now = 0;
  let attempts = 0;
  const waits: number[] = [];
  const requestTimeouts: number[] = [];
  const failures = [zoomError(400, 3000), zoomError(429), zoomError(503)];
  axios.patch = (async (_url, _body, requestConfig) => {
    requestTimeouts.push(requestConfig?.timeout ?? 0);
    const failure = failures[attempts++];
    if (failure) throw failure;
  }) as typeof axios.patch;

  const api = new ZoomRtmsApi(legacyCredentials(), async (milliseconds) => {
    waits.push(milliseconds);
    now += milliseconds;
  }, () => now);

  await api.start('123456789', 8_000);

  assert.equal(attempts, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
  assert.deepEqual(requestTimeouts, [8_000, 7_000, 5_000, 1_000]);
});

test('stops retrying when the caller timeout is reached', async () => {
  let now = 0;
  let attempts = 0;
  const waits: number[] = [];
  axios.patch = (async () => {
    attempts += 1;
    throw zoomError(500);
  }) as typeof axios.patch;

  const api = new ZoomRtmsApi(legacyCredentials(), async (milliseconds) => {
    waits.push(milliseconds);
    now += milliseconds;
  }, () => now);

  await assert.rejects(api.start('123456789', 2_500), KnownError);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1_000, 1_500]);
});

test('does not retry fatal start failures or stop failures', async () => {
  let attempts = 0;
  let waits = 0;
  axios.patch = (async () => {
    attempts += 1;
    throw zoomError(attempts === 1 ? 403 : 500);
  }) as typeof axios.patch;

  const api = new ZoomRtmsApi(legacyCredentials(), async () => {
    waits += 1;
  });

  await assert.rejects(api.start('123456789', 10_000), KnownError);
  await assert.rejects(api.stop('123456789'), KnownError);
  assert.equal(attempts, 2);
  assert.equal(waits, 0);
});

test('waits for external authorization after a customer-scoped 403', async () => {
  axios.patch = (async () => {
    throw zoomError(403, 2308);
  }) as typeof axios.patch;

  const result = await new ZoomRtmsApi({
    ...customerCredentials('team-a'),
    oauthAccessToken: 'customer-access-token',
  }).start(
    '123456789',
    10_000
  );
  assert.deepEqual(result, {
    status: 'awaiting_external_authorization',
    httpStatus: 403,
  });

  await assert.rejects(
    new ZoomRtmsApi(legacyCredentials()).start('123456789', 10_000),
    KnownError
  );
});

test('keeps unsupported or disabled RTMS 403 responses terminal', async () => {
  axios.patch = (async () => {
    throw zoomError(403, 13273);
  }) as typeof axios.patch;

  await assert.rejects(
    new ZoomRtmsApi({
      ...customerCredentials('team-a'),
      oauthAccessToken: 'customer-access-token',
    }).start('123456789', 10_000),
    KnownError
  );
});

test('caches S2S OAuth tokens independently by credential identity', async () => {
  const oauthClients: string[] = [];
  const authorizationHeaders: string[] = [];
  axios.post = (async (_url, _body, requestConfig) => {
    const clientId = requestConfig?.auth?.username ?? '';
    oauthClients.push(clientId);
    return { data: { access_token: `token-for-${clientId}`, expires_in: 3600 } };
  }) as typeof axios.post;
  axios.patch = (async (_url, _body, requestConfig) => {
    authorizationHeaders.push(String(requestConfig?.headers?.Authorization));
  }) as typeof axios.patch;

  const teamA = customerCredentials('team-a');
  await new ZoomRtmsApi(teamA).start('123456789');
  await new ZoomRtmsApi(teamA).start('123456789');
  await new ZoomRtmsApi(customerCredentials('team-b')).start('123456789');

  assert.deepEqual(oauthClients, ['team-a-client', 'team-b-client']);
  assert.deepEqual(authorizationHeaders, [
    'Bearer token-for-team-a-client',
    'Bearer token-for-team-a-client',
    'Bearer token-for-team-b-client',
  ]);
});
