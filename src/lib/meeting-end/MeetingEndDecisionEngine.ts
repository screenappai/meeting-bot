import { Logger } from 'winston';
import { ParticipantState, SilenceEvent, EndDecision, EndReason, MeetingEndConfig } from './types';

export class MeetingEndDecisionEngine {
  private config: MeetingEndConfig;
  private logger: Logger;
  private ended = false;
  private endReason: EndReason | null = null;
  private participantCheckTriggered = false;
  private aloneStreak = 0;
  private pageChangedStreak = 0;

  constructor(config: MeetingEndConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  onSilenceEvent(event: SilenceEvent): EndDecision {
    if (this.ended) {
      return { action: 'continue' };
    }

    switch (event.type) {
      case 'below_threshold':
        if (event.cumulativeSilenceMs >= this.config.fallbackThresholdMs) {
          return this.endMeeting('fallback_silence');
        }
        if (event.cumulativeSilenceMs >= this.config.primaryThresholdMs && !this.participantCheckTriggered) {
          this.participantCheckTriggered = true;
          this.logger.info('silence_triggered_participant_check', {
            cumulativeSilenceMs: event.cumulativeSilenceMs,
          });
        }
        return { action: 'continue' };

      case 'primary_threshold_reached':
        if (!this.participantCheckTriggered) {
          this.participantCheckTriggered = true;
          this.logger.info('silence_triggered_participant_check', {
            cumulativeSilenceMs: event.cumulativeSilenceMs,
          });
        }
        return { action: 'continue' };

      case 'fallback_threshold_reached':
        return this.endMeeting('fallback_silence');

      case 'reset':
        this.resetStreaks();
        return { action: 'continue' };

      default:
        return { action: 'continue' };
    }
  }

  onParticipantState(state: ParticipantState): EndDecision {
    if (this.ended) {
      return { action: 'continue' };
    }

    if (!this.config.enableParticipantCountEnd) {
      return { action: 'continue' };
    }

    switch (state) {
      case 'removed_from_meeting':
        return this.endMeeting('removed_from_meeting');

      case 'alone_confirmed':
        this.aloneStreak++;
        this.pageChangedStreak = 0;
        if (this.aloneStreak >= this.config.aloneConfirmationRequired) {
          return this.endMeeting('alone_confirmed');
        }
        return { action: 'continue' };

      case 'page_state_changed':
        this.pageChangedStreak++;
        this.aloneStreak = 0;
        if (this.pageChangedStreak >= this.config.pageChangedConfirmationRequired) {
          return this.endMeeting('page_state_changed');
        }
        return { action: 'continue' };

      case 'participants_present':
        this.resetStreaks();
        return { action: 'continue' };

      case 'unknown':
        this.resetStreaks();
        return { action: 'continue' };

      default:
        return { action: 'continue' };
    }
  }

  onBrowserSignal(): EndDecision {
    if (this.ended) {
      return { action: 'continue' };
    }
    return this.endMeeting('browser_signal');
  }

  onMaxDuration(): EndDecision {
    if (this.ended) {
      return { action: 'continue' };
    }
    return this.endMeeting('max_duration');
  }

  shouldCheckParticipants(): boolean {
    return this.participantCheckTriggered && !this.ended;
  }

  isEnded(): boolean {
    return this.ended;
  }

  getEndReason(): EndReason | null {
    return this.endReason;
  }

  reset(): void {
    this.ended = false;
    this.endReason = null;
    this.participantCheckTriggered = false;
    this.aloneStreak = 0;
    this.pageChangedStreak = 0;
  }

  private resetStreaks(): void {
    this.aloneStreak = 0;
    this.pageChangedStreak = 0;
    this.participantCheckTriggered = false;
  }

  private endMeeting(reason: EndReason): EndDecision {
    this.ended = true;
    this.endReason = reason;
    this.logger.info('meeting_end_decision', { reason });
    return { action: 'end', reason };
  }
}
