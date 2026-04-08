import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SilenceMonitor } from '../../lib/meeting-end/SilenceMonitor';
import { SilenceMonitorConfig } from '../../lib/meeting-end/types';

function createConfig(overrides?: Partial<SilenceMonitorConfig>): SilenceMonitorConfig {
  return {
    checkIntervalMs: 1000,
    silenceThreshold: 500,
    primaryThresholdMs: 5000,
    fallbackThresholdMs: 10000,
    ...overrides,
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function createMockExecAsync(stdout: string) {
  return vi.fn().mockResolvedValue({ stdout, stderr: '' });
}

function createFailingExecAsync(error: Error) {
  return vi.fn().mockRejectedValue(error);
}

describe('SilenceMonitor', () => {
  let monitor: SilenceMonitor;
  let config: SilenceMonitorConfig;
  let logger: ReturnType<typeof createLogger>;
  let mockExecAsync: ReturnType<typeof createMockExecAsync>;

  beforeEach(() => {
    vi.useFakeTimers();
    config = createConfig();
    logger = createLogger();
    mockExecAsync = createMockExecAsync('0');
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start()', () => {
    it('should emit below_threshold when peakLevel is below silenceThreshold', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('200');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'below_threshold',
          peakLevel: 200,
          consecutiveSilentChecks: 1,
          cumulativeSilenceMs: config.checkIntervalMs,
        }),
      );
    });

    it('should emit reset when peakLevel meets or exceeds silenceThreshold', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('800');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
          peakLevel: 800,
          cumulativeSilenceMs: 0,
        }),
      );
    });

    it('should accumulate cumulative silence across consecutive silent checks', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);

      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'below_threshold',
          consecutiveSilentChecks: 1,
          cumulativeSilenceMs: 1000,
        }),
      );

      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'below_threshold',
          consecutiveSilentChecks: 2,
          cumulativeSilenceMs: 2000,
        }),
      );

      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'below_threshold',
          consecutiveSilentChecks: 3,
          cumulativeSilenceMs: 3000,
        }),
      );
    });

    it('should fire primary_threshold_reached when cumulative silence reaches primaryThresholdMs', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      }

      const primaryEvent = onEvent.mock.calls.find(
        (call: any[]) => call[0].type === 'primary_threshold_reached',
      );
      expect(primaryEvent).toBeDefined();
      expect(primaryEvent![0]).toEqual(
        expect.objectContaining({
          type: 'primary_threshold_reached',
          cumulativeSilenceMs: config.primaryThresholdMs,
        }),
      );
    });

    it('should fire fallback_threshold_reached when cumulative silence reaches fallbackThresholdMs', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      }

      const fallbackEvent = onEvent.mock.calls.find(
        (call: any[]) => call[0].type === 'fallback_threshold_reached',
      );
      expect(fallbackEvent).toBeDefined();
      expect(fallbackEvent![0]).toEqual(
        expect.objectContaining({
          type: 'fallback_threshold_reached',
          cumulativeSilenceMs: config.fallbackThresholdMs,
        }),
      );
    });

    it('should emit primary_threshold_reached exactly once at the threshold boundary', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);

      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      }

      const primaryEvents = onEvent.mock.calls.filter(
        (call: any[]) => call[0].type === 'primary_threshold_reached',
      );
      expect(primaryEvents).toHaveLength(1);
    });

    it('should reset cumulative silence and consecutive checks when audio is detected after silence', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);

      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'below_threshold', cumulativeSilenceMs: 1000 }),
      );

      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'below_threshold', cumulativeSilenceMs: 2000 }),
      );

      mockExecAsync.mockResolvedValueOnce({ stdout: '900', stderr: '' });
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'reset', peakLevel: 900, cumulativeSilenceMs: 0 }),
      );

      mockExecAsync.mockResolvedValueOnce({ stdout: '50', stderr: '' });
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'below_threshold', cumulativeSilenceMs: 1000, consecutiveSilentChecks: 1 }),
      );
    });
  });

  describe('stop()', () => {
    it('should stop emitting events after stop() is called', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenCalledTimes(1);

      monitor.stop();
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs * 5);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('should be safe to call stop() multiple times', () => {
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);
      const onEvent = vi.fn();
      monitor.start(onEvent);

      monitor.stop();
      monitor.stop();
      monitor.stop();

      expect(() => monitor.stop()).not.toThrow();
    });
  });

  describe('getCumulativeSilenceMs()', () => {
    it('should return 0 initially', () => {
      monitor = new SilenceMonitor(config, logger, mockExecAsync);
      expect(monitor.getCumulativeSilenceMs()).toBe(0);
    });

    it('should return accumulated silence after silent intervals', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);

      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(monitor.getCumulativeSilenceMs()).toBe(1000);

      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(monitor.getCumulativeSilenceMs()).toBe(2000);
    });

    it('should return 0 after audio resets the counter', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs * 3);
      expect(monitor.getCumulativeSilenceMs()).toBe(3000);

      mockExecAsync.mockResolvedValueOnce({ stdout: '800', stderr: '' });
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(monitor.getCumulativeSilenceMs()).toBe(0);
    });
  });

  describe('reset()', () => {
    it('should reset cumulative silence and consecutive checks', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('100');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs * 3);

      monitor.stop();
      monitor.reset();

      expect(monitor.getCumulativeSilenceMs()).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should log error and continue when exec fails', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createFailingExecAsync(new Error('parec: command not found'));
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);

      expect(logger.error).toHaveBeenCalledWith('Error checking audio level', { error: expect.any(Error) });
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('should recover after an exec error and resume normal operation', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createFailingExecAsync(new Error('temporary failure'));
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).not.toHaveBeenCalled();

      mockExecAsync.mockResolvedValueOnce({ stdout: '100', stderr: '' });
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'below_threshold', peakLevel: 100 }),
      );
    });
  });

  describe('threshold boundary conditions', () => {
    it('should not fire primary_threshold_reached when cumulative silence is just below threshold', async () => {
      const onEvent = vi.fn();
      const customConfig = createConfig({
        checkIntervalMs: 1000,
        primaryThresholdMs: 5000,
        fallbackThresholdMs: 10000,
      });
      mockExecAsync = createMockExecAsync('100');
      const customMonitor = new SilenceMonitor(customConfig, logger, mockExecAsync);

      customMonitor.start(onEvent);

      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      const primaryEvents = onEvent.mock.calls.filter(
        (call: any[]) => call[0].type === 'primary_threshold_reached',
      );
      expect(primaryEvents).toHaveLength(0);

      customMonitor.stop();
    });

    it('should treat peakLevel exactly at threshold as non-silent', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('500');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'reset', peakLevel: 500 }),
      );
    });

    it('should handle zero peakLevel as silence', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('0');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'below_threshold', peakLevel: 0 }),
      );
    });

    it('should handle malformed exec output gracefully', async () => {
      const onEvent = vi.fn();
      mockExecAsync = createMockExecAsync('not-a-number');
      monitor = new SilenceMonitor(config, logger, mockExecAsync);

      monitor.start(onEvent);
      await vi.advanceTimersByTimeAsync(config.checkIntervalMs);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'below_threshold', peakLevel: 0 }),
      );
    });
  });
});
