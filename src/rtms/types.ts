export type ZoomRtmsEventName =
  | 'meeting.rtms_started'
  | 'meeting.rtms_stopped'
  | 'meeting.rtms_interrupted';

export enum ZoomRtmsStopReason {
  MeetingEnded = 6,
  StreamRevoked = 8,
}

export interface ZoomRtmsPayload {
  meeting_uuid: string;
  meeting_id?: string | number;
  operator_id?: string | number;
  rtms_stream_id: string;
  server_urls?: string;
  stop_reason?: number;
  [key: string]: unknown;
}

export interface ZoomRtmsWebhookEvent {
  event: ZoomRtmsEventName;
  event_ts: number;
  payload: ZoomRtmsPayload;
}

export interface ZoomWebhookBody {
  event?: string;
  event_ts?: number;
  payload?: Record<string, unknown>;
}

export type ZoomRtmsCredentialMode =
  | 'internal'
  | 'shared_customer'
  | 'dedicated_customer';

export interface ZoomRtmsAppCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

export interface ZoomRtmsApiCredentials {
  source: 'customer' | 'legacy';
  customerId: string;
  rtmsClientId: string;
  participantUserId?: string;
  oauthAccessToken?: string;
  oauthAccountId?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
}

export interface ZoomRtmsEventScope {
  appId: string;
  customerId: string;
  operatorId?: string;
}

export type ZoomRtmsStartResult =
  | { status: 'requested' }
  | { status: 'awaiting_external_authorization'; httpStatus: 403 };
