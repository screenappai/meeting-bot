import axios, { AxiosError } from 'axios';
import crypto from 'crypto';
import { KnownError } from '../error';
import { ZoomRtmsApiCredentials, ZoomRtmsStartResult } from './types';

type RtmsAction = 'start' | 'stop';

const REQUEST_TIMEOUT_MS = 15_000;
const START_RETRY_INITIAL_DELAY_MS = 1_000;
const START_RETRY_MAX_DELAY_MS = 10_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface ZoomApiErrorBody {
  code?: number;
  message?: string;
  reason?: string;
}

const asAxiosError = (error: unknown): AxiosError<ZoomApiErrorBody> | undefined =>
  axios.isAxiosError<ZoomApiErrorBody>(error) ? error : undefined;

export class ZoomRtmsApi {
  private static readonly tokenCache = new Map<string, CachedToken>();

  constructor(
    private readonly credentials: ZoomRtmsApiCredentials,
    private readonly wait: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = Date.now
  ) {}

  static clearTokenCache(): void {
    this.tokenCache.clear();
  }

  async start(meetingId: string, retryTimeoutMs = 0): Promise<ZoomRtmsStartResult> {
    const retryWindowMs = Number.isFinite(retryTimeoutMs)
      ? Math.max(0, retryTimeoutMs)
      : 0;
    const deadline = this.now() + retryWindowMs;
    let retryDelayMs = START_RETRY_INITIAL_DELAY_MS;

    while (true) {
      try {
        const remainingMs = deadline - this.now();
        const requestTimeoutMs = retryWindowMs > 0
          ? Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs))
          : REQUEST_TIMEOUT_MS;
        await this.sendStatusRequest(meetingId, 'start', requestTimeoutMs);
        return { status: 'requested' };
      } catch (error: unknown) {
        if (this.isAwaitingExternalAuthorization(error)) {
          return { status: 'awaiting_external_authorization', httpStatus: 403 };
        }
        const remainingMs = deadline - this.now();
        if (!this.isRetryableStartError(error) || remainingMs <= 0) {
          throw this.toKnownError(error, 'start');
        }

        await this.wait(Math.min(retryDelayMs, remainingMs));
        if (this.now() >= deadline) {
          throw this.toKnownError(error, 'start');
        }
        retryDelayMs = Math.min(retryDelayMs * 2, START_RETRY_MAX_DELAY_MS);
      }
    }
  }

  async stop(meetingId: string): Promise<void> {
    try {
      await this.sendStatusRequest(meetingId, 'stop', REQUEST_TIMEOUT_MS);
    } catch (error: unknown) {
      throw this.toKnownError(error, 'stop');
    }
  }

  private async sendStatusRequest(
    meetingId: string,
    action: RtmsAction,
    timeout: number
  ): Promise<void> {
    const clientId = this.credentials.rtmsClientId;
    if (!clientId) {
      throw new KnownError('ZOOM_RTMS_CLIENT_ID is required for RTMS', false, 0);
    }

    const accessToken = await this.getAccessToken();
    const settings: { client_id: string; participant_user_id?: string } = {
      client_id: clientId,
    };
    if (this.credentials.participantUserId) {
      settings.participant_user_id = this.credentials.participantUserId;
    }

    await axios.patch(
      `https://api.zoom.us/v2/live_meetings/${encodeURIComponent(meetingId)}/rtms_app/status`,
      { action, settings },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout,
      }
    );
  }

  private isRetryableStartError(error: unknown): boolean {
    const axiosError = asAxiosError(error);
    if (!axiosError) return false;
    const status = Number(axiosError.response?.status);
    const code = Number(axiosError.response?.data?.code);
    return !axiosError.response
      || code === 3000
      || status === 429
      || (status >= 500 && status < 600);
  }

  private isAwaitingExternalAuthorization(error: unknown): boolean {
    const axiosError = asAxiosError(error);
    const code = Number(axiosError?.response?.data?.code);
    return this.credentials.source === 'customer'
      && axiosError?.response?.status === 403
      && (code === 2308 || code === 2309);
  }

  private toKnownError(error: unknown, action: RtmsAction): KnownError {
    if (error instanceof KnownError) return error;

    const axiosError = asAxiosError(error);
    const status = axiosError?.response?.status;
    const message = axiosError?.response?.data?.message
      || (error instanceof Error ? error.message : undefined)
      || 'Unknown Zoom API error';
    return new KnownError(
      `Zoom RTMS ${action} failed${status ? ` (${status})` : ''}: ${message}`,
      false,
      0
    );
  }

  private async getAccessToken(): Promise<string> {
    if (this.credentials.oauthAccessToken) {
      return this.credentials.oauthAccessToken;
    }

    const cacheKey = this.tokenCacheKey();
    const cachedToken = ZoomRtmsApi.tokenCache.get(cacheKey);
    if (cachedToken && cachedToken.expiresAt > this.now()) {
      return cachedToken.value;
    }

    const { oauthAccountId, oauthClientId, oauthClientSecret } = this.credentials;
    if (!oauthAccountId || !oauthClientId || !oauthClientSecret) {
      throw new KnownError(
        'Configure ZOOM_RTMS_OAUTH_ACCESS_TOKEN or the ZOOM_RTMS_OAUTH_ACCOUNT_ID/CLIENT_ID/CLIENT_SECRET settings',
        false,
        0
      );
    }

    try {
      const response = await axios.post<{ access_token: string; expires_in?: number }>(
        'https://zoom.us/oauth/token',
        undefined,
        {
          auth: { username: oauthClientId, password: oauthClientSecret },
          params: {
            grant_type: 'account_credentials',
            account_id: oauthAccountId,
          },
          timeout: 15_000,
        }
      );
      const expiresIn = Math.max(60, response.data.expires_in ?? 3600);
      const cachedToken = {
        value: response.data.access_token,
        expiresAt: this.now() + (expiresIn - 30) * 1000,
      };
      ZoomRtmsApi.tokenCache.set(cacheKey, cachedToken);
      return cachedToken.value;
    } catch (error: unknown) {
      const axiosError = asAxiosError(error);
      const status = axiosError?.response?.status;
      const message = axiosError?.response?.data?.reason
        || (error instanceof Error ? error.message : undefined)
        || 'Unknown OAuth error';
      throw new KnownError(
        `Unable to obtain Zoom RTMS OAuth token${status ? ` (${status})` : ''}: ${message}`,
        false,
        0
      );
    }
  }

  private tokenCacheKey(): string {
    const identity = [
      this.credentials.oauthAccountId,
      this.credentials.oauthClientId,
      this.credentials.oauthClientSecret,
    ].join('\0');
    return crypto.createHash('sha256').update(identity).digest('hex');
  }
}
