export type ParticipantState = 'participants_present' | 'alone_confirmed' | 'removed_from_meeting' | 'page_state_changed' | 'unknown';

export type EndReason = 'alone_confirmed' | 'removed_from_meeting' | 'page_state_changed' | 'fallback_silence' | 'max_duration' | 'browser_signal' | 'manual';

export type SilenceEvent =
  | { type: 'below_threshold'; peakLevel: number; consecutiveSilentChecks: number; cumulativeSilenceMs: number }
  | { type: 'reset'; peakLevel: number; cumulativeSilenceMs: number }
  | { type: 'primary_threshold_reached'; cumulativeSilenceMs: number }
  | { type: 'fallback_threshold_reached'; cumulativeSilenceMs: number };

export type EndDecision =
  | { action: 'continue' }
  | { action: 'end'; reason: EndReason };

export interface SilenceMonitorConfig {
  checkIntervalMs: number;
  silenceThreshold: number;
  primaryThresholdMs: number;
  fallbackThresholdMs: number;
}

export interface MeetingEndConfig {
  primaryThresholdMs: number;
  fallbackThresholdMs: number;
  aloneConfirmationRequired: number;
  pageChangedConfirmationRequired: number;
  enableParticipantCountEnd: boolean;
}

