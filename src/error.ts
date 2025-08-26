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
