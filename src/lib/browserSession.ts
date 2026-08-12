import { Browser, BrowserContext, Page } from 'playwright';

export type BrowserProvider = 'microsoft' | 'google' | 'zoom';
export type BrowserOwnership = 'external-cdp' | 'owned-browser' | 'owned-persistent-context';
export type BrowserSessionFailureKind = 'browser-disconnected' | 'context-closed' | 'page-crashed' | 'page-closed';

export class BrowserSessionFailureError extends Error {
  constructor(public readonly kind: BrowserSessionFailureKind) {
    super(`Browser session failed: ${kind}`);
    this.name = 'BrowserSessionFailureError';
  }
}

const sessions = new WeakMap<Page, BrowserSession>();
const externalBrowserContexts = new WeakSet<BrowserContext>();

const PROVIDER_DOMAINS: Record<BrowserProvider, readonly string[]> = {
  google: ['meet.google.com'],
  microsoft: ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft', 'teams.microsoft.us'],
  zoom: ['zoom.us', 'zoom.com', 'zoomgov.com'],
};

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function getValidatedProviderOrigin(url: string, provider: BrowserProvider): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${provider} meeting URL`);
  }

  if (parsed.protocol !== 'https:' || !PROVIDER_DOMAINS[provider].some(domain => isDomainOrSubdomain(parsed.hostname, domain))) {
    throw new Error(`Unsupported ${provider} meeting URL`);
  }

  return parsed.origin;
}

export function normalizeBrowserTimezone(timezone?: string): string {
  if (!timezone?.trim()) return 'UTC';

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return 'UTC';
  }
}

export class BrowserSession {
  public readonly failure: Promise<BrowserSessionFailureError>;

  private readonly browser: Browser | null;
  private readonly context: BrowserContext;
  private resolveFailure!: (error: BrowserSessionFailureError) => void;
  private closePromise?: Promise<void>;
  private failureSignalled = false;
  private failureError?: BrowserSessionFailureError;
  private closing = false;
  private readonly onBrowserDisconnected = () => this.signalFailure('browser-disconnected');
  private readonly onContextClosed = () => this.signalFailure('context-closed');
  private readonly onPageCrashed = () => this.signalFailure('page-crashed');
  private readonly onPageClosed = () => this.signalFailure('page-closed');

  constructor(
    public readonly page: Page,
    public readonly ownership: BrowserOwnership,
    private readonly ownsContext: boolean,
    private readonly correlationLog: string,
  ) {
    this.context = page.context();
    this.browser = this.context.browser();
    this.failure = new Promise(resolve => {
      this.resolveFailure = resolve;
    });

    if (ownership === 'external-cdp') {
      externalBrowserContexts.add(this.context);
    }

    this.attachFailureHandlers();
    sessions.set(page, this);
  }

  private signalFailure(kind: BrowserSessionFailureKind): void {
    if (this.closing || this.failureSignalled) return;

    this.failureSignalled = true;
    const error = new BrowserSessionFailureError(kind);
    this.failureError = error;
    console.error(`${this.correlationLog} ${error.message}`);
    this.resolveFailure(error);
  }

  private attachFailureHandlers(): void {
    this.browser?.on('disconnected', this.onBrowserDisconnected);
    this.context.on('close', this.onContextClosed);
    this.page.on('crash', this.onPageCrashed);
    this.page.on('close', this.onPageClosed);
  }

  private detachFailureHandlers(): void {
    this.browser?.off('disconnected', this.onBrowserDisconnected);
    this.context.off('close', this.onContextClosed);
    this.page.off('crash', this.onPageCrashed);
    this.page.off('close', this.onPageClosed);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closing = true;
    this.closePromise = this.closeOwnedResources();
    return this.closePromise;
  }

  getFailureError(): BrowserSessionFailureError | undefined {
    return this.failureError;
  }

  private async closeOwnedResources(): Promise<void> {
    try {
      if (this.ownership === 'external-cdp') {
        if (!this.page.isClosed()) await this.page.close();
        if (this.ownsContext) await this.context.close().catch(() => undefined);
        return;
      }

      if (this.ownership === 'owned-persistent-context') {
        await this.context.close();
        return;
      }

      if (this.browser?.isConnected()) {
        await this.browser.close();
      } else if (!this.page.isClosed()) {
        await this.context.close();
      }
    } finally {
      this.detachFailureHandlers();
      sessions.delete(this.page);
    }
  }
}

export function registerBrowserSession(
  page: Page,
  ownership: BrowserOwnership,
  ownsContext: boolean,
  correlationLog: string,
): BrowserSession {
  return new BrowserSession(page, ownership, ownsContext, correlationLog);
}

export function getBrowserSession(page?: Page | null): BrowserSession | undefined {
  return page ? sessions.get(page) : undefined;
}

export async function closeBrowserSession(page?: Page | null): Promise<void> {
  if (!page) return;

  const session = getBrowserSession(page);
  if (session) {
    await session.close();
    return;
  }

  if (!page.isClosed()) await page.close();
}

export async function raceBrowserSessionFailure<T>(page: Page, work: Promise<T>): Promise<T> {
  const session = getBrowserSession(page);
  if (!session) return work;

  const outcome = await Promise.race([
    work.then(value => ({ type: 'completed' as const, value })),
    session.failure.then(error => ({ type: 'failed' as const, error })),
  ]);
  if (outcome.type === 'failed') throw outcome.error;
  return outcome.value;
}

export function normalizeBrowserSessionError(page: Page | undefined, error: unknown): unknown {
  if (error instanceof BrowserSessionFailureError || !page) return error;

  const sessionFailure = getBrowserSession(page)?.getFailureError();
  if (sessionFailure) return sessionFailure;

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const browser = page.context().browser();
  if (browser && !browser.isConnected()) {
    return new BrowserSessionFailureError('browser-disconnected');
  }
  if (page.isClosed() || message.includes('page has been closed')) {
    return new BrowserSessionFailureError('page-closed');
  }
  if (message.includes('context') && message.includes('closed')) {
    return new BrowserSessionFailureError('context-closed');
  }
  if (message.includes('target page, context or browser has been closed')) {
    return new BrowserSessionFailureError('page-closed');
  }
  return error;
}

export function isExternalBrowserContext(context?: BrowserContext | null): boolean {
  return Boolean(context && externalBrowserContexts.has(context));
}
