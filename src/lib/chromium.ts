import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import config from '../config';
import { getCorrelationIdLog } from '../util/logger';

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

export type BotType = 'microsoft' | 'google' | 'zoom';

const externalBrowserContexts = new WeakSet<BrowserContext>();

export function isExternalBrowserContext(context?: BrowserContext | null): boolean {
  return Boolean(context && externalBrowserContexts.has(context));
}

function attachBrowserErrorHandlers(browser: Browser | null, context: BrowserContext, page: Page, correlationId: string) {
  const log = getCorrelationIdLog(correlationId);

  browser?.on('disconnected', () => {
    console.log(`${log} Browser has disconnected!`);
  });

  context.on('close', () => {
    console.log(`${log} Browser has closed!`);
  });

  page.on('crash', (page) => {
    console.error(`${log} Page has crashed! ${page?.url()}`);
  });

  page.on('close', (page) => {
    console.log(`${log} Page has closed! ${page?.url()}`);
  });
}

async function launchBrowserWithTimeout(launchFn: () => Promise<Browser>, timeoutMs: number, correlationId: string): Promise<Browser> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Browser launch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    // Start launch
    launchFn()
      .then(result => {
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          console.log(`${getCorrelationIdLog(correlationId)} Browser launch function success!`);
          resolve(result);
        }
      })
      .catch(err => {
        console.error(`${getCorrelationIdLog(correlationId)} Error launching browser`, err);
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
  });
}

async function launchPersistentContextWithTimeout(launchFn: () => Promise<BrowserContext>, timeoutMs: number, correlationId: string): Promise<BrowserContext> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Persistent browser launch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    launchFn()
      .then(result => {
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          console.log(`${getCorrelationIdLog(correlationId)} Persistent browser launch function success!`);
          resolve(result);
        }
      })
      .catch(err => {
        console.error(`${getCorrelationIdLog(correlationId)} Error launching persistent browser`, err);
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
  });
}

async function createBrowserContext(url: string, correlationId: string, botType: BotType = 'google'): Promise<Page> {
  const size = { width: 1280, height: 720 };

  // Google Meet is sensitive to browser fingerprinting before admission. Keep
  // its launch close to normal Chrome and reserve recording-heavy flags for
  // platforms that need them.
  const googleBrowserArgs: string[] = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    `--window-size=${size.width},${size.height}`,
    '--auto-accept-this-tab-capture',
    '--autoplay-policy=no-user-gesture-required',
  ];

  const recordingBrowserArgs: string[] = [
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    `--window-size=${size.width},${size.height}`,
    '--auto-accept-this-tab-capture',
    '--enable-features=MediaRecorder',
    '--enable-audio-service-out-of-process',
    '--autoplay-policy=no-user-gesture-required',
  ];

  // Fake device args - only for Microsoft Teams
  // Teams needs fake devices to interact with pre-join screen toggles,
  // but actual recording is done via ffmpeg (X11 + PulseAudio)
  const fakeDeviceArgs: string[] = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ];

  // Google Meet and Zoom use browser-based recording (getDisplayMedia + MediaRecorder)
  // and don't need fake devices:
  // - Google Meet: clicks "Continue without microphone and camera"
  // - Zoom: expects "Cannot detect your camera/microphone" notifications
  const browserArgs = botType === 'google'
    ? googleBrowserArgs
    : botType === 'microsoft'
      ? [...recordingBrowserArgs, ...fakeDeviceArgs]
      : recordingBrowserArgs;
  const ignoreDefaultArgs = botType === 'google'
    ? ['--mute-audio', '--enable-automation']
    : ['--mute-audio'];

  // Teams-specific display args: kiosk mode prevents address bar from showing in ffmpeg recording
  // Google Meet and Zoom don't need this since they use tab capture (getDisplayMedia)
  const displayArgs = botType === 'microsoft'
    ? ['--kiosk', '--start-maximized']
    : [];

  console.log(`${getCorrelationIdLog(correlationId)} Launching browser for ${botType} bot (fake devices: ${botType === 'microsoft'})`);

  const contextOptions = {
    ...(botType !== 'google' ? {
      permissions: ['camera', 'microphone'],
    } : {}),
    viewport: size,
    ignoreHTTPSErrors: true,
    // Record video only in development for debugging. Keep Google Meet's
    // anonymous admission context close to a regular incognito tab.
    ...(process.env.NODE_ENV === 'development' && botType !== 'google' && {
      recordVideo: {
        dir: './debug-videos/',
        size: size,
      },
    }),
  };

  if (botType === 'google' && config.googleChromeCdpUrl) {
    console.log(`${getCorrelationIdLog(correlationId)} Connecting Google bot to external Chrome`, {
      cdpUrl: config.googleChromeCdpUrl,
    });

    const browser = await launchBrowserWithTimeout(
      async () => await chromium.connectOverCDP(config.googleChromeCdpUrl!),
      60000,
      correlationId
    );

    const context = browser.contexts()[0] ?? await browser.newContext({
      ...contextOptions,
      ...(config.googleChromeStorageStatePath ? {
        storageState: config.googleChromeStorageStatePath,
      } : {}),
    });
    externalBrowserContexts.add(context);

    const page = await context.newPage();
    await page.setViewportSize(size);
    attachBrowserErrorHandlers(browser, context, page, correlationId);

    console.log(`${getCorrelationIdLog(correlationId)} External Chrome connected successfully!`);

    return page;
  }

  if (botType === 'google' && config.googleChromeUserDataDir) {
    console.log(`${getCorrelationIdLog(correlationId)} Launching Google bot with persistent Chrome profile`, {
      userDataDir: config.googleChromeUserDataDir,
    });

    const context = await launchPersistentContextWithTimeout(
      async () => await chromium.launchPersistentContext(config.googleChromeUserDataDir!, {
        ...contextOptions,
        headless: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
          ...browserArgs,
          ...displayArgs,
        ],
        ignoreDefaultArgs,
        executablePath: config.chromeExecutablePath,
      }),
      60000,
      correlationId
    );

    const page = context.pages()[0] ?? await context.newPage();
    attachBrowserErrorHandlers(context.browser(), context, page, correlationId);

    console.log(`${getCorrelationIdLog(correlationId)} Persistent browser launched successfully!`);

    return page;
  }

  const browser = await launchBrowserWithTimeout(
    async () => await chromium.launch({
      headless: false,
      // Don't let Playwright install its own SIGTERM/SIGINT/SIGHUP handlers — they
      // close the browser immediately when the node process receives a signal, which
      // breaks our graceful shutdown (we want the in-flight recording to finish).
      // The app explicitly calls browser.close() when the recording is done.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        ...browserArgs,
        ...displayArgs,
      ],
      ignoreDefaultArgs,
      executablePath: config.chromeExecutablePath,
    }),
    60000,
    correlationId
  );

  const context = await browser.newContext({
    ...contextOptions,
    ...(config.googleChromeStorageStatePath && botType === 'google' ? {
      storageState: config.googleChromeStorageStatePath,
    } : {}),
  });

  // Grant permissions so Teams will play audio (Teams requires this unlike Google Meet)
  if (botType !== 'google') {
    await context.grantPermissions(['microphone', 'camera'], { origin: url });
  }

  const page = await context.newPage();

  // Attach common error handlers
  attachBrowserErrorHandlers(browser, context, page, correlationId);

  console.log(`${getCorrelationIdLog(correlationId)} Browser launched successfully!`);

  return page;
}

export default createBrowserContext;
