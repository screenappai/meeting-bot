export class KnownError extends Error {
  public retryable: boolean;
  public maxRetries: number;

  constructor(message: string, retryable?: boolean, maxRetries?: number) {
    super(message);
    this.retryable = typeof retryable !== 'undefined' ? retryable : false;
    this.maxRetries = typeof maxRetries !== 'undefined' ? maxRetries : 0;
  }
}

export class WaitingAtLobbyError extends KnownError {
  public documentBodyText: string | undefined | null;

  constructor(message: string, documentBodyText?: string) {
    super(message);
    this.documentBodyText = documentBodyText;
  }
}

export class WaitingAtLobbyRetryError extends KnownError {
  public documentBodyText: string | undefined | null;

  constructor(message: string, documentBodyText?: string, retryable?: boolean, maxRetries?: number) {
    super(message, retryable, maxRetries);
    this.documentBodyText = documentBodyText;
  }
}

export class MeetingTimeoutError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class RecordingUploadFailedError extends KnownError {
  constructor(message: string) {
    super(message, false, 0);
  }
}

export class ZoomBrowserJoinBlockedError extends KnownError {
  public readonly reason = 'automated_bot_blocked' as const;
  public readonly stage = 'prejoin' as const;

  constructor(message = 'Zoom blocked the browser as an automated meeting bot') {
    super(message, false, 0);
    this.name = 'ZoomBrowserJoinBlockedError';
  }
}

export class ZoomBrowserProfileConfigurationError extends KnownError {
  public readonly teamId: string;

  constructor(teamId: string) {
    super(`Zoom browser profile configuration is invalid for team ${teamId}`, false, 0);
    this.name = 'ZoomBrowserProfileConfigurationError';
    this.teamId = teamId;
  }
}

export type ZoomMeetingJoinFailureReason =
  | 'host_rejected'
  | 'sign_in_required'
  | 'meeting_ended';

export class ZoomMeetingJoinError extends KnownError {
  public readonly stage = 'prejoin' as const;

  constructor(public readonly reason: ZoomMeetingJoinFailureReason) {
    const messages: Record<ZoomMeetingJoinFailureReason, string> = {
      host_rejected: 'The Zoom host rejected or removed the recording participant',
      sign_in_required: 'Zoom requires the recording participant to sign in',
      meeting_ended: 'The Zoom meeting ended before the recording participant joined',
    };
    super(messages[reason], false, 0);
    this.name = 'ZoomMeetingJoinError';
  }
}

export class ZoomRtmsCredentialsMissingError extends KnownError {
  public readonly teamId: string;

  constructor(teamId: string) {
    super(`Zoom RTMS fallback is not configured for team ${teamId}`, false, 0);
    this.name = 'ZoomRtmsCredentialsMissingError';
    this.teamId = teamId;
  }
}

export class UnsupportedMeetingError extends KnownError {
  public googleMeetPageStatus: 'SIGN_IN_PAGE' | 'GOOGLE_MEET_PAGE' | 'UNSUPPORTED_PAGE' | null;

  constructor(message: string, googleMeetPageStatus: 'SIGN_IN_PAGE' | 'GOOGLE_MEET_PAGE' | 'UNSUPPORTED_PAGE' | null) {
    super(
      message,
      googleMeetPageStatus ? ['GOOGLE_MEET_PAGE', 'UNSUPPORTED_PAGE'].includes(googleMeetPageStatus) : false,
      2
    );
    this.googleMeetPageStatus = googleMeetPageStatus;
  }
}
