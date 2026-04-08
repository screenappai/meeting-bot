import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeetingEndDecisionEngine } from '../../lib/meeting-end/MeetingEndDecisionEngine';
import { MeetingEndConfig, SilenceEvent, ParticipantState } from '../../lib/meeting-end/types';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

const baseConfig: MeetingEndConfig = {
  primaryThresholdMs: 10000,
  fallbackThresholdMs: 20000,
  aloneConfirmationRequired: 2,
  pageChangedConfirmationRequired: 3,
  enableParticipantCountEnd: true,
};

function belowThreshold(cumulativeMs: number): SilenceEvent {
  return {
    type: 'below_threshold',
    peakLevel: 100,
    consecutiveSilentChecks: Math.floor(cumulativeMs / 1000),
    cumulativeSilenceMs: cumulativeMs,
  };
}

describe('MeetingEndDecisionEngine', () => {
  let engine: MeetingEndDecisionEngine;

  beforeEach(() => {
    engine = new MeetingEndDecisionEngine(baseConfig, mockLogger);
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  describe('onSilenceEvent', () => {
    it('should continue for below_threshold events below primary threshold', () => {
      const decision = engine.onSilenceEvent(belowThreshold(5000));
      expect(decision.action).toBe('continue');
    });

    it('should trigger participant check at primary threshold but not end', () => {
      const decision = engine.onSilenceEvent(belowThreshold(10000));
      expect(decision.action).toBe('continue');
      expect(engine.shouldCheckParticipants()).toBe(true);
    });

    it('should end with fallback_silence at fallback threshold', () => {
      const decision = engine.onSilenceEvent(belowThreshold(20000));
      expect(decision).toEqual({ action: 'end', reason: 'fallback_silence' });
    });

    it('should not trigger fallback_silence before fallback threshold', () => {
      const decision = engine.onSilenceEvent(belowThreshold(19000));
      expect(decision.action).toBe('continue');
    });

    it('should end with fallback_silence on fallback_threshold_reached event', () => {
      const decision = engine.onSilenceEvent({
        type: 'fallback_threshold_reached',
        cumulativeSilenceMs: 20000,
      });
      expect(decision).toEqual({ action: 'end', reason: 'fallback_silence' });
    });

    it('should continue on primary_threshold_reached event', () => {
      const decision = engine.onSilenceEvent({
        type: 'primary_threshold_reached',
        cumulativeSilenceMs: 10000,
      });
      expect(decision.action).toBe('continue');
      expect(engine.shouldCheckParticipants()).toBe(true);
    });

    it('should reset all streaks on reset silence event', () => {
      engine.onSilenceEvent(belowThreshold(10000));
      expect(engine.shouldCheckParticipants()).toBe(true);

      const decision = engine.onSilenceEvent({ type: 'reset', peakLevel: 900, cumulativeSilenceMs: 0 });
      expect(decision.action).toBe('continue');
      expect(engine.shouldCheckParticipants()).toBe(false);
    });

    it('should ignore all events after meeting has ended', () => {
      engine.onSilenceEvent(belowThreshold(20000));
      expect(engine.isEnded()).toBe(true);

      const decision = engine.onSilenceEvent({ type: 'reset', peakLevel: 900, cumulativeSilenceMs: 0 });
      expect(decision.action).toBe('continue');
    });

    it('should not re-trigger participant check after already triggered', () => {
      engine.onSilenceEvent(belowThreshold(10000));
      engine.onSilenceEvent(belowThreshold(11000));

      expect(mockLogger.info.mock.calls.filter((c: any) => c[0] === 'silence_triggered_participant_check').length).toBe(1);
    });
  });

  describe('onParticipantState — alone_confirmed streak', () => {
    it('should NOT end on a single alone_confirmed (streak = 1, required = 2)', () => {
      const decision = engine.onParticipantState('alone_confirmed');
      expect(decision.action).toBe('continue');
      expect(engine.isEnded()).toBe(false);
    });

    it('should end after 2 consecutive alone_confirmed (streak reaches required)', () => {
      engine.onParticipantState('alone_confirmed');
      const decision = engine.onParticipantState('alone_confirmed');
      expect(decision).toEqual({ action: 'end', reason: 'alone_confirmed' });
    });

    it('should reset alone streak when participants_present arrives', () => {
      engine.onParticipantState('alone_confirmed');
      engine.onParticipantState('participants_present');
      const decision = engine.onParticipantState('alone_confirmed');
      expect(decision.action).toBe('continue');
    });

    it('should reset alone streak on silence reset event', () => {
      engine.onParticipantState('alone_confirmed');
      engine.onSilenceEvent({ type: 'reset', peakLevel: 900, cumulativeSilenceMs: 0 });
      const decision = engine.onParticipantState('alone_confirmed');
      expect(decision.action).toBe('continue');
    });
  });

  describe('onParticipantState — removed_from_meeting', () => {
    it('should end immediately on removed_from_meeting', () => {
      const decision = engine.onParticipantState('removed_from_meeting');
      expect(decision).toEqual({ action: 'end', reason: 'removed_from_meeting' });
    });

    it('should not require a streak for removed_from_meeting', () => {
      const decision = engine.onParticipantState('removed_from_meeting');
      expect(decision.action).toBe('end');
      expect(engine.isEnded()).toBe(true);
    });
  });

  describe('onParticipantState — unknown', () => {
    it('should NOT trigger false positives on unknown state', () => {
      const decision = engine.onParticipantState('unknown');
      expect(decision.action).toBe('continue');
      expect(engine.isEnded()).toBe(false);
    });

    it('should continue monitoring even after multiple unknown states', () => {
      engine.onParticipantState('unknown');
      engine.onParticipantState('unknown');
      engine.onParticipantState('unknown');
      expect(engine.isEnded()).toBe(false);
    });

    it('should not increment alone streak for unknown state', () => {
      engine.onParticipantState('alone_confirmed');
      engine.onParticipantState('unknown');
      engine.onParticipantState('alone_confirmed');
      const decision = engine.onParticipantState('alone_confirmed');
      expect(decision.action).toBe('end');
      expect(decision).toEqual({ action: 'end', reason: 'alone_confirmed' });
    });
  });

  describe('onParticipantState — page_state_changed streak', () => {
    it('should NOT end on a single page_state_changed (transient UI glitch)', () => {
      const decision = engine.onParticipantState('page_state_changed');
      expect(decision.action).toBe('continue');
      expect(engine.isEnded()).toBe(false);
    });

    it('should NOT end on 2 page_state_changed (required = 3)', () => {
      engine.onParticipantState('page_state_changed');
      const decision = engine.onParticipantState('page_state_changed');
      expect(decision.action).toBe('continue');
      expect(engine.isEnded()).toBe(false);
    });

    it('should end after 3 consecutive page_state_changed', () => {
      engine.onParticipantState('page_state_changed');
      engine.onParticipantState('page_state_changed');
      const decision = engine.onParticipantState('page_state_changed');
      expect(decision).toEqual({ action: 'end', reason: 'page_state_changed' });
    });
  });

  describe('onParticipantState — participants_present resets everything', () => {
    it('should reset page_state_changed streak when participants_present arrives', () => {
      engine.onParticipantState('page_state_changed');
      engine.onParticipantState('page_state_changed');
      engine.onParticipantState('participants_present');
      engine.onParticipantState('page_state_changed');
      engine.onParticipantState('page_state_changed');
      const decision = engine.onParticipantState('page_state_changed');
      expect(decision).toEqual({ action: 'end', reason: 'page_state_changed' });
    });
  });

  describe('enableParticipantCountEnd disabled', () => {
    it('should ignore participant states when enableParticipantCountEnd is false', () => {
      const disabledConfig = { ...baseConfig, enableParticipantCountEnd: false };
      const disabledEngine = new MeetingEndDecisionEngine(disabledConfig, mockLogger);

      const decision = disabledEngine.onParticipantState('alone_confirmed');
      expect(decision.action).toBe('continue');
      expect(disabledEngine.isEnded()).toBe(false);
    });

    it('should still end on removed_from_meeting when disabled... wait, it should NOT', () => {
      const disabledConfig = { ...baseConfig, enableParticipantCountEnd: false };
      const disabledEngine = new MeetingEndDecisionEngine(disabledConfig, mockLogger);

      const decision = disabledEngine.onParticipantState('removed_from_meeting');
      expect(decision.action).toBe('continue');
    });
  });

  describe('fallback_silence overrides participant decisions', () => {
    it('should end with fallback_silence even if participant checks are running', () => {
      engine.onParticipantState('unknown');
      engine.onSilenceEvent(belowThreshold(20000));

      expect(engine.getEndReason()).toBe('fallback_silence');
      expect(engine.isEnded()).toBe(true);
    });

    it('should not allow participant events after fallback_silence ends meeting', () => {
      engine.onSilenceEvent(belowThreshold(20000));
      const decision = engine.onParticipantState('alone_confirmed');
      expect(decision.action).toBe('continue');
      expect(engine.getEndReason()).toBe('fallback_silence');
    });
  });

  describe('onBrowserSignal', () => {
    it('should end with browser_signal', () => {
      const decision = engine.onBrowserSignal();
      expect(decision).toEqual({ action: 'end', reason: 'browser_signal' });
    });
  });

  describe('onMaxDuration', () => {
    it('should end with max_duration', () => {
      const decision = engine.onMaxDuration();
      expect(decision).toEqual({ action: 'end', reason: 'max_duration' });
    });
  });

  describe('reset', () => {
    it('should restore engine to initial state', () => {
      engine.onSilenceEvent(belowThreshold(20000));
      expect(engine.isEnded()).toBe(true);

      engine.reset();
      expect(engine.isEnded()).toBe(false);
      expect(engine.getEndReason()).toBeNull();
      expect(engine.shouldCheckParticipants()).toBe(false);
    });
  });

  describe('interaction: silence + participants', () => {
    it('fallback_silence should override unknown participant state', () => {
      engine.onParticipantState('unknown');
      engine.onParticipantState('unknown');
      engine.onParticipantState('unknown');

      const decision = engine.onSilenceEvent(belowThreshold(20000));
      expect(decision).toEqual({ action: 'end', reason: 'fallback_silence' });
    });

    it('unknown state should not prevent fallback_silence from firing', () => {
      engine.onParticipantState('unknown');
      engine.onParticipantState('unknown');

      const decision = engine.onSilenceEvent(belowThreshold(20000));
      expect(decision.action).toBe('end');
      expect(decision.action === 'end' && decision.reason).toBe('fallback_silence');
    });
  });
});
