import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Browser, BrowserContext, Page } from 'playwright';
import {
  closeBrowserSession,
  getValidatedProviderOrigin,
  normalizeBrowserSessionError,
  normalizeBrowserTimezone,
  raceBrowserSessionFailure,
  registerBrowserSession,
} from './browserSession';

class FakeBrowser extends EventEmitter {
  closeCalls = 0;
  connected = true;

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.connected = false;
    this.emit('disconnected');
  }
}

class FakeContext extends EventEmitter {
  closeCalls = 0;

  constructor(private readonly fakeBrowser: FakeBrowser) {
    super();
  }

  browser(): Browser {
    return this.fakeBrowser as unknown as Browser;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.emit('close');
  }
}

class FakePage extends EventEmitter {
  closeCalls = 0;
  closed = false;

  constructor(private readonly fakeContext: FakeContext) {
    super();
  }

  context(): BrowserContext {
    return this.fakeContext as unknown as BrowserContext;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
    this.emit('close');
  }
}

function createFakeBrowserPage() {
  const browser = new FakeBrowser();
  const context = new FakeContext(browser);
  const page = new FakePage(context);
  return { browser, context, page: page as unknown as Page, pageState: page };
}

test('validates provider-owned HTTPS origins', () => {
  assert.equal(getValidatedProviderOrigin('https://us05web.zoom.us/j/123?pwd=secret', 'zoom'), 'https://us05web.zoom.us');
  assert.equal(getValidatedProviderOrigin('https://meet.google.com/abc-defg-hij', 'google'), 'https://meet.google.com');
  assert.equal(getValidatedProviderOrigin('https://teams.microsoft.com/l/meetup-join/123', 'microsoft'), 'https://teams.microsoft.com');
  assert.throws(() => getValidatedProviderOrigin('https://evilzoom.us/j/123', 'zoom'));
  assert.throws(() => getValidatedProviderOrigin('http://meet.google.com/abc-defg-hij', 'google'));
});

test('uses UTC for missing or invalid timezones', () => {
  assert.equal(normalizeBrowserTimezone('Europe/Vienna'), 'Europe/Vienna');
  assert.equal(normalizeBrowserTimezone('Not/A_Timezone'), 'UTC');
  assert.equal(normalizeBrowserTimezone(), 'UTC');
});

test('closing an external CDP session never closes the shared browser', async () => {
  const { browser, context, page, pageState } = createFakeBrowserPage();
  registerBrowserSession(page, 'external-cdp', true, '[test]');

  await closeBrowserSession(page);
  await closeBrowserSession(page);

  assert.equal(pageState.closeCalls, 1);
  assert.equal(context.closeCalls, 1);
  assert.equal(browser.closeCalls, 0);
});

test('closing a page in the shared CDP context leaves that context running', async () => {
  const { browser, context, page, pageState } = createFakeBrowserPage();
  registerBrowserSession(page, 'external-cdp', false, '[test]');

  await closeBrowserSession(page);

  assert.equal(pageState.closeCalls, 1);
  assert.equal(context.closeCalls, 0);
  assert.equal(browser.closeCalls, 0);
});

test('closing a session with an owned browser closes the browser once', async () => {
  const { browser, page } = createFakeBrowserPage();
  registerBrowserSession(page, 'owned-browser', true, '[test]');

  await closeBrowserSession(page);
  await closeBrowserSession(page);

  assert.equal(browser.closeCalls, 1);
});

test('signals unexpected page crashes with a typed failure', async () => {
  const { page, pageState } = createFakeBrowserPage();
  const session = registerBrowserSession(page, 'external-cdp', false, '[test]');

  pageState.emit('crash');
  const failure = await session.failure;

  assert.equal(failure.name, 'BrowserSessionFailureError');
  assert.equal(failure.kind, 'page-crashed');
  assert.equal(normalizeBrowserSessionError(page, new Error('Target closed')), failure);
});

test('interrupts active meeting work immediately with the typed browser failure', async () => {
  const { page, pageState } = createFakeBrowserPage();
  registerBrowserSession(page, 'external-cdp', false, '[test]');
  let finishWork!: () => void;
  const work = new Promise<void>(resolve => {
    finishWork = resolve;
  });

  const activeMeeting = raceBrowserSessionFailure(page, work);
  pageState.emit('crash');

  await assert.rejects(
    activeMeeting,
    (error: unknown) => (error as { kind?: string }).kind === 'page-crashed'
  );
  finishWork();
});

test('normalizes disconnected and closed Playwright failures', () => {
  const disconnected = createFakeBrowserPage();
  disconnected.browser.connected = false;
  const disconnectedError = normalizeBrowserSessionError(
    disconnected.page,
    new Error('Target page, context or browser has been closed')
  );
  assert.equal((disconnectedError as { kind?: string }).kind, 'browser-disconnected');

  const closed = createFakeBrowserPage();
  closed.pageState.closed = true;
  const closedError = normalizeBrowserSessionError(closed.page, new Error('Page has been closed'));
  assert.equal((closedError as { kind?: string }).kind, 'page-closed');
});
