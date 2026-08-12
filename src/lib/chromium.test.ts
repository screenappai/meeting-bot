import assert from 'node:assert/strict';
import test from 'node:test';
import { Browser, BrowserContext } from 'playwright';
import config, { parseZoomChromeCustomerStorageStatePaths } from '../config';
import { ZoomBrowserProfileConfigurationError } from '../error';
import {
  cleanupFailedBrowserSetup,
  getStorageStatePath,
  selectZoomChromeStorageStatePath,
} from './chromium';

test('parses customer-scoped Zoom storage state paths without exposing values in errors', () => {
  const parsed = parseZoomChromeCustomerStorageStatePaths(JSON.stringify({
    'team-a': '/var/run/secrets/meeting-bot/zoom-profiles/team-a.json',
    'team-b': 'relative/must-not-appear.json',
  }));

  assert.equal(
    parsed.paths['team-a'],
    '/var/run/secrets/meeting-bot/zoom-profiles/team-a.json',
  );
  assert.match(parsed.entryErrors['team-b'], /absolute path/);
  assert.equal(parsed.entryErrors['team-b'].includes('must-not-appear'), false);

  const malformed = parseZoomChromeCustomerStorageStatePaths('{secret-value');
  assert.match(malformed.error ?? '', /valid JSON/);
  assert.equal(malformed.error?.includes('secret-value'), false);

  const duplicate = parseZoomChromeCustomerStorageStatePaths(JSON.stringify({
    'team-a': '/profiles/shared.json',
    'team-b': '/profiles/shared.json',
  }));
  assert.equal(duplicate.paths['team-a'], undefined);
  assert.equal(duplicate.paths['team-b'], undefined);
  assert.match(duplicate.entryErrors['team-a'], /unique/);
  assert.match(duplicate.entryErrors['team-b'], /unique/);
});

test('selects Zoom storage state only for the exact teamId', () => {
  const paths = Object.assign(Object.create(null), {
    'team-a': '/profiles/team-a.json',
    'team-b': '/profiles/team-b.json',
  });

  assert.equal(selectZoomChromeStorageStatePath('team-a', paths), '/profiles/team-a.json');
  assert.equal(selectZoomChromeStorageStatePath('team-b', paths), '/profiles/team-b.json');
  assert.equal(selectZoomChromeStorageStatePath('TEAM-A', paths), undefined);
  assert.equal(selectZoomChromeStorageStatePath('team', paths), undefined);
  assert.equal(selectZoomChromeStorageStatePath('__proto__', paths), undefined);
  assert.equal(selectZoomChromeStorageStatePath(undefined, paths), undefined);
});

test('does not fall back to another Zoom customer profile', () => {
  const originalPaths = config.zoomChromeCustomerStorageStatePaths;
  const originalEntryErrors = config.zoomChromeCustomerStorageStatePathErrors;
  const originalError = config.zoomChromeCustomerStorageStatePathsError;

  try {
    config.zoomChromeCustomerStorageStatePaths = Object.assign(Object.create(null), {
      'team-a': '/profiles/team-a.json',
    });
    config.zoomChromeCustomerStorageStatePathErrors = Object.create(null);
    config.zoomChromeCustomerStorageStatePathsError = undefined;

    assert.equal(getStorageStatePath('zoom', 'team-a'), '/profiles/team-a.json');
    assert.equal(getStorageStatePath('zoom', 'team-b'), undefined);
    assert.equal(getStorageStatePath('zoom'), undefined);
  } finally {
    config.zoomChromeCustomerStorageStatePaths = originalPaths;
    config.zoomChromeCustomerStorageStatePathErrors = originalEntryErrors;
    config.zoomChromeCustomerStorageStatePathsError = originalError;
  }
});

test('fails safely for an invalid declared customer profile', () => {
  const originalPaths = config.zoomChromeCustomerStorageStatePaths;
  const originalEntryErrors = config.zoomChromeCustomerStorageStatePathErrors;
  const originalError = config.zoomChromeCustomerStorageStatePathsError;

  try {
    config.zoomChromeCustomerStorageStatePaths = Object.create(null);
    config.zoomChromeCustomerStorageStatePathErrors = Object.assign(Object.create(null), {
      'team-a': 'invalid path',
    });
    config.zoomChromeCustomerStorageStatePathsError = undefined;

    assert.throws(
      () => getStorageStatePath('zoom', 'team-a'),
      ZoomBrowserProfileConfigurationError,
    );
  } finally {
    config.zoomChromeCustomerStorageStatePaths = originalPaths;
    config.zoomChromeCustomerStorageStatePathErrors = originalEntryErrors;
    config.zoomChromeCustomerStorageStatePathsError = originalError;
  }
});

test('closes an owned browser when setup fails before creating a page', async () => {
  let closeCalls = 0;
  const browser = {
    isConnected: () => true,
    close: async () => {
      closeCalls += 1;
    },
  } as unknown as Browser;

  await cleanupFailedBrowserSetup({
    browser,
    closeBrowser: true,
    closeContext: true,
    correlationId: 'test',
  });

  assert.equal(closeCalls, 1);
});

test('closes an isolated external context without closing shared Chrome', async () => {
  let browserCloseCalls = 0;
  let contextCloseCalls = 0;
  const browser = {
    isConnected: () => true,
    close: async () => {
      browserCloseCalls += 1;
    },
  } as unknown as Browser;
  const context = {
    close: async () => {
      contextCloseCalls += 1;
    },
  } as unknown as BrowserContext;

  await cleanupFailedBrowserSetup({
    browser,
    context,
    closeBrowser: false,
    closeContext: true,
    correlationId: 'test',
  });

  assert.equal(contextCloseCalls, 1);
  assert.equal(browserCloseCalls, 0);
});
