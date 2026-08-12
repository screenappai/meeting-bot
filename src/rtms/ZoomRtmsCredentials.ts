import config from '../config';
import { KnownError, ZoomRtmsCredentialsMissingError } from '../error';
import {
  ZoomRtmsApiCredentials,
  ZoomRtmsAppCredentials,
  ZoomRtmsCredentialMode,
  ZoomRtmsEventScope,
} from './types';

export type ZoomRtmsCredentialErrorReason =
  | 'disabled'
  | 'invalid_customer_configuration'
  | 'invalid_global_configuration';

export class ZoomRtmsCredentialConfigurationError extends KnownError {
  constructor(
    public readonly reason: ZoomRtmsCredentialErrorReason,
    public readonly teamId: string,
    message: string
  ) {
    super(message, false, 0);
    this.name = 'ZoomRtmsCredentialConfigurationError';
  }
}

export interface ResolvedZoomRtmsCredentials {
  credentialMode: ZoomRtmsCredentialMode;
  app: ZoomRtmsAppCredentials;
  api: ZoomRtmsApiCredentials;
  eventScope: ZoomRtmsEventScope;
}

const globalAppCredentials = (teamId: string): ZoomRtmsAppCredentials => {
  const clientId = config.zoomRtms.clientId;
  const clientSecret = config.zoomRtms.clientSecret;
  const webhookSecret = config.zoomRtms.webhookSecret;
  if (!clientId || !clientSecret || !webhookSecret) {
    throw new ZoomRtmsCredentialConfigurationError(
      'invalid_global_configuration',
      teamId,
      'ZOOM_RTMS_CLIENT_ID, ZOOM_RTMS_CLIENT_SECRET and ZOOM_RTMS_WEBHOOK_SECRET are required for the global RTMS app'
    );
  }

  return {
    appId: 'global',
    clientId,
    clientSecret,
    webhookSecret,
  };
};

const globalCredentials = (teamId: string): ResolvedZoomRtmsCredentials => {
  const app = globalAppCredentials(teamId);

  const hasAccessToken = Boolean(config.zoomRtms.oauthAccessToken);
  const hasServerCredentials = Boolean(
    config.zoomRtms.oauthAccountId
    && config.zoomRtms.oauthClientId
    && config.zoomRtms.oauthClientSecret
  );
  if (!hasAccessToken && !hasServerCredentials) {
    throw new ZoomRtmsCredentialConfigurationError(
      'invalid_global_configuration',
      teamId,
      'Configure ZOOM_RTMS_OAUTH_ACCESS_TOKEN or the global Zoom RTMS OAuth account credentials'
    );
  }

  return {
    credentialMode: 'internal',
    app,
    api: {
      source: 'legacy',
      customerId: teamId,
      rtmsClientId: app.clientId,
      participantUserId: config.zoomRtms.participantUserId,
      oauthAccessToken: config.zoomRtms.oauthAccessToken,
      oauthAccountId: config.zoomRtms.oauthAccountId,
      oauthClientId: config.zoomRtms.oauthClientId,
      oauthClientSecret: config.zoomRtms.oauthClientSecret,
    },
    eventScope: {
      appId: app.appId,
      customerId: teamId,
      operatorId: config.zoomRtms.participantUserId,
    },
  };
};

export const resolveZoomRtmsCredentials = (
  teamId: string
): ResolvedZoomRtmsCredentials => {
  const customer = config.zoomRtms.customerCredentials[teamId];
  if (customer?.enabled) {
    const app: ZoomRtmsAppCredentials = customer.rtmsApp
      ? {
        appId: customer.rtmsApp.webhookId,
        clientId: customer.rtmsApp.clientId,
        clientSecret: customer.rtmsApp.clientSecret,
        webhookSecret: customer.rtmsApp.webhookSecret,
      }
      : globalAppCredentials(teamId);

    return {
      credentialMode: customer.rtmsApp ? 'dedicated_customer' : 'shared_customer',
      app,
      api: {
        source: 'customer',
        customerId: teamId,
        rtmsClientId: app.clientId,
        participantUserId: customer.participantUserId,
        oauthAccountId: customer.accountId,
        oauthClientId: customer.clientId,
        oauthClientSecret: customer.clientSecret,
      },
      eventScope: {
        appId: app.appId,
        customerId: teamId,
        operatorId: customer.participantUserId,
      },
    };
  }

  if (config.zoomRtms.customerCredentialsError) {
    throw new ZoomRtmsCredentialConfigurationError(
      'invalid_customer_configuration',
      teamId,
      config.zoomRtms.customerCredentialsError
    );
  }

  const entryError = config.zoomRtms.customerCredentialErrors[teamId];
  if (entryError) {
    throw new ZoomRtmsCredentialConfigurationError(
      'invalid_customer_configuration',
      teamId,
      `Zoom RTMS credentials for team ${teamId} are invalid: ${entryError}`
    );
  }

  if (customer && !customer.enabled) {
    throw new ZoomRtmsCredentialConfigurationError(
      'disabled',
      teamId,
      `Zoom RTMS fallback is disabled for team ${teamId}`
    );
  }

  if (config.zoomRtms.globalTeamId === teamId) {
    return globalCredentials(teamId);
  }

  throw new ZoomRtmsCredentialsMissingError(teamId);
};
