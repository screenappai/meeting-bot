import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from 'winston';
import { SilenceMonitorConfig, SilenceEvent } from './types';

const defaultExecAsync = promisify(exec);

const PAREC_COMMAND =
  'timeout 1 parec --device=virtual_output.monitor --format=s16le --rate=16000 --channels=1 2>/dev/null | ' +
  'od -An -td2 -v | awk \'BEGIN{max=0} {for(i=1;i<=NF;i++) {val=($i<0)?-$i:$i; if(val>max) max=val}} END{print max}\'';

export type ExecAsyncFn = (command: string) => Promise<{ stdout: string; stderr: string }>;

export class SilenceMonitor {
  private config: SilenceMonitorConfig;
  private logger: Logger;
  private execAsync: ExecAsyncFn;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private consecutiveSilentChecks = 0;
  private cumulativeSilenceMs = 0;
  private isInFlight = false;
  private isStopped = false;
  private primaryThresholdTriggered = false;
  private fallbackThresholdTriggered = false;

  constructor(config: SilenceMonitorConfig, logger: Logger, execAsync?: ExecAsyncFn) {
    this.config = config;
    this.logger = logger;
    this.execAsync = execAsync ?? defaultExecAsync;
  }

  start(onEvent: (event: SilenceEvent) => void): void {
    if (this.isStopped) return;
    this.isStopped = false;
    this.intervalId = setInterval(async () => {
      if (this.isStopped) return;
      if (this.isInFlight) return;
      this.isInFlight = true;
      try {
        const { stdout } = await this.execAsync(PAREC_COMMAND);
        if (this.isStopped) return;

        const peakLevel = parseInt(stdout.trim()) || 0;

        this.logger.debug('Audio level check', { peakLevel, threshold: this.config.silenceThreshold });

        if (peakLevel < this.config.silenceThreshold) {
          this.consecutiveSilentChecks++;
          this.cumulativeSilenceMs += this.config.checkIntervalMs;

          this.logger.debug('Silence detected', {
            consecutiveSilentChecks: this.consecutiveSilentChecks,
            cumulativeSilenceMs: this.cumulativeSilenceMs,
            peakLevel,
          });

          onEvent({
            type: 'below_threshold',
            peakLevel,
            consecutiveSilentChecks: this.consecutiveSilentChecks,
            cumulativeSilenceMs: this.cumulativeSilenceMs,
          });
          if (!this.primaryThresholdTriggered && this.cumulativeSilenceMs >= this.config.primaryThresholdMs) {
            this.primaryThresholdTriggered = true;
            onEvent({ type: 'primary_threshold_reached', cumulativeSilenceMs: this.cumulativeSilenceMs });
          }
          if (!this.fallbackThresholdTriggered && this.cumulativeSilenceMs >= this.config.fallbackThresholdMs) {
            this.fallbackThresholdTriggered = true;
            onEvent({ type: 'fallback_threshold_reached', cumulativeSilenceMs: this.cumulativeSilenceMs });
          }
        } else {
          this.consecutiveSilentChecks = 0;
          this.cumulativeSilenceMs = 0;
          this.primaryThresholdTriggered = false;
          this.fallbackThresholdTriggered = false;

          this.logger.debug('Audio detected, resetting silence counter', { peakLevel });
          onEvent({ type: 'reset', peakLevel, cumulativeSilenceMs: 0 });
        }
      } catch (error) {
        this.logger.error('Error checking audio level', { error });
      } finally {
        this.isInFlight = false;
      }
    }, this.config.checkIntervalMs);
  }

  stop(): void {
    this.isStopped = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getCumulativeSilenceMs(): number {
    return this.cumulativeSilenceMs;
  }

  reset(): void {
    this.consecutiveSilentChecks = 0;
    this.cumulativeSilenceMs = 0;
    this.primaryThresholdTriggered = false;
    this.fallbackThresholdTriggered = false;
  }
}
