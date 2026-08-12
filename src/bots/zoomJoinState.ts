export type ZoomJoinState =
  | 'prejoin'
  | 'waiting_room'
  | 'joined'
  | 'host_rejected'
  | 'sign_in_required'
  | 'meeting_ended'
  | 'automated_bot_blocked'
  | 'unknown';

const normalize = (value?: string | null): string =>
  (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export const classifyZoomJoinState = (bodyText?: string | null): ZoomJoinState => {
  const text = normalize(bodyText);
  if (!text) return 'unknown';

  if (
    /automated bots? (?:are not|aren't) allowed to join/.test(text)
    || /this meeting (?:does not|doesn't) allow automated bots?/.test(text)
    || text.includes('zoom needs to review the security of your connection before proceeding')
  ) {
    return 'automated_bot_blocked';
  }

  if (text.includes('you have been removed')) return 'host_rejected';
  if (
    text.includes('this meeting has been ended by host')
    || text.includes('this meeting has ended')
    || text.includes('meeting has been ended')
  ) {
    return 'meeting_ended';
  }
  if (
    text.includes('sign in to join')
    || text.includes('you need to sign in to join this meeting')
  ) {
    return 'sign_in_required';
  }
  if (
    text.includes('please wait, the meeting host will let you in soon')
    || text.includes('the host will let you in soon')
  ) {
    return 'waiting_room';
  }

  return 'unknown';
};

export const shouldUseZoomRtmsFallback = (
  error: unknown,
  fallbackEnabled: boolean,
  joinState: ZoomJoinState
): error is ZoomBrowserJoinBlockedError =>
  fallbackEnabled
  && joinState !== 'joined'
  && error instanceof ZoomBrowserJoinBlockedError
  && error.reason === 'automated_bot_blocked';
import { ZoomBrowserJoinBlockedError } from '../error';
