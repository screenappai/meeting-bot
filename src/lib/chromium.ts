import { Browser, BrowserContext, BrowserContextOptions, Page, chromium } from 'playwright';
import config from '../config';
import { ZoomBrowserProfileConfigurationError } from '../error';
import { getCorrelationIdLog } from '../util/logger';
import {
  BrowserProvider,
  closeBrowserSession,
  getBrowserSession,
  getValidatedProviderOrigin,
  isExternalBrowserContext,
  normalizeBrowserSessionError,
  normalizeBrowserTimezone,
  raceBrowserSessionFailure,
  registerBrowserSession,
} from './browserSession';

export type BotType = BrowserProvider;

export {
  closeBrowserSession,
  getBrowserSession,
  getValidatedProviderOrigin,
  isExternalBrowserContext,
  normalizeBrowserSessionError,
  normalizeBrowserTimezone,
  raceBrowserSessionFailure,
};

const VIEWPORT_SIZE = { width: 1280, height: 720 };
const WINDOW_SIZE = { width: 1280, height: 800 };
const CDP_CONNECT_TIMEOUT_MS = 60_000;
const CDP_RETRY_INTERVAL_MS = 1_000;
const externalBrowserConnections = new Map<string, Promise<Browser>>();

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resizeBrowserWindow(page: Page, correlationId: string): Promise<void> {
  const log = getCorrelationIdLog(correlationId);

  try {
    const client = await page.context().newCDPSession(page);
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        windowState: 'normal',
        left: 0,
        top: 0,
        width: WINDOW_SIZE.width,
        height: WINDOW_SIZE.height,
      },
    });
  } catch (error) {
    console.warn('%s Unable to resize Chrome window through CDP', log, error instanceof Error ? error.message : error);
  }
}

async function applyPageEnvironment(page: Page, timezoneId: string, correlationId: string): Promise<void> {
  const log = getCorrelationIdLog(correlationId);

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setLocaleOverride', { locale: 'en-US' });
    await client.send('Emulation.setTimezoneOverride', { timezoneId });
  } catch (error) {
    console.warn('%s Unable to apply Chrome locale/timezone through CDP', log, error instanceof Error ? error.message : error);
  }
}

async function launchBrowserWithTimeout(
  launchFn: () => Promise<Browser>,
  timeoutMs: number,
  correlationId: string,
): Promise<Browser> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error(`Browser launch timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    launchFn()
      .then(async browser => {
        if (finished) {
          await browser.close().catch(() => undefined);
          return;
        }

        finished = true;
        clearTimeout(timeoutId);
        console.log(`${getCorrelationIdLog(correlationId)} Browser launch function success!`);
        resolve(browser);
      })
      .catch(error => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

async function launchPersistentContextWithTimeout(
  launchFn: () => Promise<BrowserContext>,
  timeoutMs: number,
  correlationId: string,
): Promise<BrowserContext> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error(`Persistent browser launch timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    launchFn()
      .then(async context => {
        if (finished) {
          await context.close().catch(() => undefined);
          return;
        }

        finished = true;
        clearTimeout(timeoutId);
        console.log(`${getCorrelationIdLog(correlationId)} Persistent browser launch function success!`);
        resolve(context);
      })
      .catch(error => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

async function connectToExternalChrome(cdpUrl: string, correlationId: string): Promise<Browser> {
  const existingConnection = externalBrowserConnections.get(cdpUrl);
  if (existingConnection) {
    const existingBrowser = await existingConnection.catch(() => undefined);
    if (existingBrowser?.isConnected()) return existingBrowser;
    externalBrowserConnections.delete(cdpUrl);
  }

  const connection = connectToExternalChromeWithRetry(cdpUrl, correlationId);
  externalBrowserConnections.set(cdpUrl, connection);

  try {
    const browser = await connection;
    browser.once('disconnected', () => {
      if (externalBrowserConnections.get(cdpUrl) === connection) {
        externalBrowserConnections.delete(cdpUrl);
      }
    });
    return browser;
  } catch (error) {
    if (externalBrowserConnections.get(cdpUrl) === connection) {
      externalBrowserConnections.delete(cdpUrl);
    }
    throw error;
  }
}

async function connectToExternalChromeWithRetry(cdpUrl: string, correlationId: string): Promise<Browser> {
  const startedAt = Date.now();
  let lastError: unknown;
  let attempt = 0;

  while ((Date.now() - startedAt) < CDP_CONNECT_TIMEOUT_MS) {
    attempt += 1;
    const remainingMs = CDP_CONNECT_TIMEOUT_MS - (Date.now() - startedAt);

    try {
      return await chromium.connectOverCDP(cdpUrl, {
        timeout: Math.max(1, Math.min(5_000, remainingMs)),
      });
    } catch (error) {
      lastError = error;
      console.warn('%s External Chrome is not ready; retrying', getCorrelationIdLog(correlationId), { attempt });
      const retryDelayMs = Math.min(CDP_RETRY_INTERVAL_MS, CDP_CONNECT_TIMEOUT_MS - (Date.now() - startedAt));
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
  throw new Error(`Unable to connect to external Chrome within ${CDP_CONNECT_TIMEOUT_MS}ms: ${detail}`);
}

export function selectZoomChromeStorageStatePath(
  teamId: string | undefined,
  customerPaths: Record<string, string>,
): string | undefined {
  if (!teamId || !Object.prototype.hasOwnProperty.call(customerPaths, teamId)) return undefined;
  return customerPaths[teamId];
}

export function getStorageStatePath(botType: BotType, teamId?: string): string | undefined {
  if (botType === 'google') return config.googleChromeStorageStatePath;
  if (botType === 'zoom') {
    if (!teamId) return undefined;
    if (
      config.zoomChromeCustomerStorageStatePathsError
      || config.zoomChromeCustomerStorageStatePathErrors[teamId]
    ) {
      throw new ZoomBrowserProfileConfigurationError(teamId);
    }
    return selectZoomChromeStorageStatePath(
      teamId,
      config.zoomChromeCustomerStorageStatePaths,
    );
  }
  return undefined;
}

function getBrowserArgs(botType: BotType): string[] {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-first-run-ui',
    '--disable-default-browser-promo',
    '--disable-default-apps',
    '--lang=en-US',
    `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
    '--auto-accept-this-tab-capture',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-blink-features=AutomationControlled',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];

  if (process.env.CHROME_NO_SANDBOX !== 'false') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  if (botType === 'microsoft') {
    args.push('--use-fake-device-for-media-stream');
  }

  if (botType !== 'google' && process.env.CHROME_SOFTWARE_GL !== 'false') {
    args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  }

  return args;
}

async function configurePage(
  page: Page,
  timezoneId: string,
  correlationId: string,
): Promise<void> {
  await resizeBrowserWindow(page, correlationId);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Automated Chrome returns 'denied' for Notification.permission, real
    // Chrome returns 'default' — match real browser behaviour.
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    }
    const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
    if (origQuery) {
      navigator.permissions.query = (parameters: PermissionDescriptor) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus)
          : origQuery(parameters);
    }
    // Ensure navigator.languages matches Accept-Language header.
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    // Ensure window.chrome.runtime exists (missing in some CDP setups).
    const w = window as any;
    if (typeof w.chrome === 'undefined') {
      w.chrome = {};
    }
    if (w.chrome && !w.chrome.runtime) {
      w.chrome.runtime = {};
    }
  });
  await page.setViewportSize(VIEWPORT_SIZE);
  await applyPageEnvironment(page, timezoneId, correlationId);
}

export async function cleanupFailedBrowserSetup({
  browser,
  context,
  page,
  closeBrowser,
  closeContext,
  correlationId,
}: {
  browser?: Browser | null;
  context?: BrowserContext;
  page?: Page;
  closeBrowser: boolean;
  closeContext: boolean;
  correlationId: string;
}): Promise<void> {
  try {
    const session = getBrowserSession(page);
    if (session) {
      await session.close();
    } else if (closeBrowser && browser?.isConnected()) {
      await browser.close();
    } else if (closeContext && context) {
      await context.close();
    } else if (page && !page.isClosed()) {
      await page.close();
    }
  } catch (cleanupError) {
    console.warn(
      '%s Failed to clean up partial browser setup',
      getCorrelationIdLog(correlationId),
      cleanupError instanceof Error ? cleanupError.message : cleanupError
    );
  }
}

async function createBrowserContext(
  url: string,
  correlationId: string,
  botType: BotType = 'google',
  timezone?: string,
  teamId?: string,
): Promise<Page> {
  const log = getCorrelationIdLog(correlationId);
  const trustedOrigin = getValidatedProviderOrigin(url, botType);
  const timezoneId = normalizeBrowserTimezone(timezone);
  const browserArgs = getBrowserArgs(botType);
  const storageStatePath = getStorageStatePath(botType, teamId);
  const contextOptions: BrowserContextOptions = {
    viewport: VIEWPORT_SIZE,
    locale: 'en-US',
    timezoneId,
    ...(process.env.NODE_ENV === 'development' && botType !== 'google' && {
      recordVideo: {
        dir: './debug-videos/',
        size: VIEWPORT_SIZE,
      },
    }),
  };

  if (timezone && timezoneId === 'UTC' && timezone !== 'UTC') {
    console.warn(`${log} Invalid browser timezone; using UTC`);
  }

  console.log(`${log} Launching browser for ${botType} bot`);

  const cdpUrl = botType === 'google'
    ? config.googleChromeCdpUrl
    : botType === 'zoom'
      ? config.zoomChromeCdpUrl
      : undefined;

  if (cdpUrl) {
    console.log(`${log} Connecting ${botType} bot to external Chrome`);
    const browser = await connectToExternalChrome(cdpUrl, correlationId);
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let ownsContext = false;

    try {
      const existingContext = botType === 'google' ? browser.contexts()[0] : undefined;
      context = existingContext ?? await browser.newContext({
        ...contextOptions,
        ...(storageStatePath
          ? { storageState: storageStatePath }
          : {}),
      });
      ownsContext = !existingContext;

      if (botType === 'microsoft') {
        await context.grantPermissions(['microphone', 'camera'], { origin: trustedOrigin });
      }

      page = await context.newPage();
      registerBrowserSession(page, 'external-cdp', ownsContext, log);
      await configurePage(page, timezoneId, correlationId);

      console.log(`${log} External Chrome connected successfully!`);
      return page;
    } catch (error) {
      const normalizedError = normalizeBrowserSessionError(page, error);
      await cleanupFailedBrowserSetup({
        browser,
        context,
        page,
        closeBrowser: false,
        closeContext: ownsContext,
        correlationId,
      });
      throw normalizedError;
    }
  }

  if (botType === 'google' && config.googleChromeUserDataDir) {
    console.log(`${log} Launching Google bot with persistent Chrome profile`);
    const context = await launchPersistentContextWithTimeout(
      () => chromium.launchPersistentContext(config.googleChromeUserDataDir!, {
        ...contextOptions,
        headless: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: browserArgs,
        ignoreDefaultArgs: ['--mute-audio', '--enable-automation'],
        executablePath: config.chromeExecutablePath,
      }),
      60_000,
      correlationId,
    );
    let page: Page | undefined;

    try {
      page = context.pages()[0] ?? await context.newPage();
      registerBrowserSession(page, 'owned-persistent-context', true, log);
      await configurePage(page, timezoneId, correlationId);

      console.log(`${log} Persistent browser launched successfully!`);
      return page;
    } catch (error) {
      const normalizedError = normalizeBrowserSessionError(page, error);
      await cleanupFailedBrowserSetup({
        browser: context.browser(),
        context,
        page,
        closeBrowser: false,
        closeContext: true,
        correlationId,
      });
      throw normalizedError;
    }
  }

  const browser = await launchBrowserWithTimeout(
    () => chromium.launch({
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: browserArgs,
      ignoreDefaultArgs: ['--mute-audio', '--enable-automation'],
      executablePath: config.chromeExecutablePath,
    }),
    60_000,
    correlationId,
  );

  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    context = await browser.newContext({
      ...contextOptions,
      ...(storageStatePath
        ? { storageState: storageStatePath }
        : {}),
    });

    if (botType === 'microsoft') {
      await context.grantPermissions(['microphone', 'camera'], { origin: trustedOrigin });
    }

    page = await context.newPage();
    registerBrowserSession(page, 'owned-browser', true, log);
    await configurePage(page, timezoneId, correlationId);

    console.log(`${log} Browser launched successfully!`);
    return page;
  } catch (error) {
    const normalizedError = normalizeBrowserSessionError(page, error);
    await cleanupFailedBrowserSetup({
      browser,
      context,
      page,
      closeBrowser: true,
      closeContext: true,
      correlationId,
    });
    throw normalizedError;
  }
}

export default createBrowserContext;
