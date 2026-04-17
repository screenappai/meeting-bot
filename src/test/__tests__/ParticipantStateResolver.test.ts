import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParticipantStateResolver } from '../../lib/meeting-end/ParticipantStateResolver';
import { ParticipantState } from '../../lib/meeting-end/types';

function createSequentialMockPage(returnValues: any[]) {
  let callIndex = 0;
  return {
    evaluate: vi.fn().mockImplementation(() => {
      const val = returnValues[callIndex];
      callIndex++;
      return Promise.resolve(val);
    }),
  } as any;
}

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe('ParticipantStateResolver', () => {
  beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  describe('peopleButtonCountStrategy', () => {
    it('should return participants_present when People button shows >= 2', async () => {
      const page = createSequentialMockPage([false, 5]);

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('participants_present');
    });

    it('should return alone_confirmed when People button shows 1', async () => {
      const page = createSequentialMockPage([false, 1]);

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('alone_confirmed');
    });

    it('should return unknown when no People button is found', async () => {
      const page = createSequentialMockPage([false, null, null, true]);

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('unknown');
    });
  });

  describe('removalDetectionStrategy', () => {
    it('should return removed_from_meeting when removal text is present', async () => {
      const page = createSequentialMockPage([true]);

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('removed_from_meeting');
    });

    it('should return unknown when removal text is absent and Leave button present', async () => {
      const page = createSequentialMockPage([false, null, null, true]);

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('unknown');
    });
  });

  describe('page_state_changed detection', () => {
    it('should return page_state_changed when Leave call button is absent', async () => {
      const page = createSequentialMockPage([false, null, null, false, true]);

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('page_state_changed');
    });
  });

  describe('strategy priority', () => {
    it('should return participants_present if first strategy resolves it (short-circuit)', async () => {
      const page = createSequentialMockPage([false, 3]);

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('participants_present');
      expect(page.evaluate).toHaveBeenCalledTimes(2);
    });
  });

  describe('custom strategies', () => {
    it('should support addStrategy for additional detection logic', async () => {
      const page = createSequentialMockPage([false, null, null, true]);

      const resolver = new ParticipantStateResolver(page, mockLogger);
      resolver.addStrategy(async () => 'participants_present' as ParticipantState);

      const result = await resolver.resolve();
      expect(result).toBe('participants_present');
    });
  });

  describe('error handling', () => {
    it('should continue to next strategy if one throws', async () => {
      const page = {
        evaluate: vi.fn()
          .mockRejectedValueOnce(new Error('DOM error'))
          .mockResolvedValueOnce(2),
      } as any;

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('participants_present');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'participant_strategy_error',
        expect.objectContaining({ strategyIndex: 0 }),
      );
    });

    it('should return unknown when all strategies fail', async () => {
      const page = {
        evaluate: vi.fn().mockRejectedValue(new Error('all fail')),
      } as any;

      const resolver = new ParticipantStateResolver(page, mockLogger);
      const result = await resolver.resolve();
      expect(result).toBe('unknown');
    });
  });
});
