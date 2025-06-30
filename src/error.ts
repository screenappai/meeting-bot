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
