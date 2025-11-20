import { spawn, ChildProcess } from 'child_process';
import { Logger } from 'winston';

export class FFmpegRecorder {
  private ffmpegProcess: ChildProcess | null = null;
  private outputPath: string;
  private logger: Logger;
  private exitCallback: ((code: number | null) => void) | null = null;

  constructor(outputPath: string, logger: Logger) {
    this.outputPath = outputPath;
    this.logger = logger;
  }

  /**
   * Register a callback to be notified when FFmpeg process exits
   */
  onProcessExit(callback: (code: number | null) => void): void {
    this.exitCallback = callback;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // FFmpeg command to capture X11 display and PulseAudio monitor
        const ffmpegArgs = [
          '-y', // Overwrite output file
          '-loglevel', 'info', // Verbose logging for debugging

          // Video input from X11 display (with Y offset to skip address bar)
          '-f', 'x11grab',
          '-video_size', '1280x720',
          '-framerate', '25',
          '-draw_mouse', '0',
          '-i', `${process.env.DISPLAY || ':99'}+0,80`,  // +0,80 = X offset 0, Y offset 80 (skip address bar)

          // Audio input from PulseAudio monitor
          '-f', 'pulse',
          '-ac', '2',
          '-ar', '44100',
          '-i', 'virtual_output.monitor',

          // Video encoding with better compatibility
          '-c:v', 'libx264',
          '-preset', 'faster',
          '-pix_fmt', 'yuv420p',
          '-crf', '23',
          '-g', '50', // Keyframe interval
          '-threads', '0',

          // Audio encoding
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2',
          '-strict', 'experimental',

          // Sync and timing
          '-vsync', 'cfr',
          '-async', '1',

          // MP4 optimization
          '-movflags', '+faststart',

          // Output
          this.outputPath
        ];

        this.logger.info('Starting ffmpeg with args:', { args: ffmpegArgs.join(' ') });

        // Ensure FFmpeg can connect to PulseAudio
        const ffmpegEnv = {
          ...process.env,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1001',
          DISPLAY: process.env.DISPLAY || ':99'
        };

        this.logger.info('FFmpeg environment:', {
          XDG_RUNTIME_DIR: ffmpegEnv.XDG_RUNTIME_DIR,
          DISPLAY: ffmpegEnv.DISPLAY,
          USER: process.env.USER,
          HOME: process.env.HOME
        });

        this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],  // Enable stdin to send 'q' quit signal
          env: ffmpegEnv
        });

        // Handle stdout
        this.ffmpegProcess.stdout?.on('data', (data) => {
          this.logger.debug('ffmpeg stdout:', data.toString());
        });

        // Buffer to accumulate stderr for better error reporting
        let stderrBuffer = '';
        const startTime = Date.now();

        // Handle stderr (ffmpeg outputs progress here)
        this.ffmpegProcess.stderr?.on('data', (data) => {
          const output = data.toString();
          stderrBuffer += output;

          const isStartupPhase = (Date.now() - startTime) < 5000; // First 5 seconds

          // Log errors and important messages
          if (output.includes('error') || output.includes('Error') || output.includes('Invalid') || output.includes('Failed')) {
            this.logger.error('ffmpeg error:', output);
          } else if (output.includes('Duration') || output.includes('Stream #') || output.includes('video:') || output.includes('audio:')) {
            this.logger.info('ffmpeg info:', output.trim());
          } else if (isStartupPhase) {
            // Log all stderr at info level during startup (first 5 seconds) to catch initialization errors
            this.logger.info('ffmpeg startup:', output.trim().substring(0, 200));
          } else {
            // After startup, only debug log progress updates
            this.logger.debug('ffmpeg progress:', output.substring(0, 150));
          }
        });

        // Track if we already resolved/rejected
        let settled = false;

        // Handle process exit
        this.ffmpegProcess.on('exit', (code, signal) => {
          this.logger.info('ffmpeg process exited', { code, signal });

          // Notify callback if registered
          if (this.exitCallback) {
            this.exitCallback(code);
          }

          // If exited with error, log the full stderr buffer
          if (code !== 0 && code !== null) {
            this.logger.error('FFmpeg failed with exit code', code);
            const trimmedBuffer = stderrBuffer.trim();
            if (trimmedBuffer) {
              this.logger.error('FFmpeg stderr output:', trimmedBuffer);
            } else {
              this.logger.error('FFmpeg stderr was empty - process may have crashed without error message');
              this.logger.error('Common causes: screen size mismatch (check Xvfb resolution vs capture area + offset), PulseAudio not running, X11 display not available');
            }

            // If we haven't settled yet (early failure during startup), reject
            if (!settled) {
              settled = true;
              reject(new Error(`FFmpeg exited with code ${code}: ${trimmedBuffer || 'no error details'}`));
            }
          }
        });

        // Handle errors
        this.ffmpegProcess.on('error', (error) => {
          this.logger.error('ffmpeg process error:', error);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });

        // Wait a bit to ensure ffmpeg starts successfully
        setTimeout(() => {
          if (settled) {
            // Already rejected due to early exit/error
            return;
          }

          if (this.ffmpegProcess && !this.ffmpegProcess.killed && this.ffmpegProcess.exitCode === null) {
            this.logger.info('ffmpeg recording started successfully');
            settled = true;
            resolve();
          } else {
            this.logger.error('ffmpeg failed to start or already exited');
            settled = true;
            reject(new Error('ffmpeg failed to start'));
          }
        }, 2000);

      } catch (error) {
        this.logger.error('Error starting ffmpeg:', error);
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ffmpegProcess) {
        this.logger.warn('No ffmpeg process to stop');
        resolve();
        return;
      }

      this.logger.info('Sending quit signal to ffmpeg...');

      // Flag to track if already resolved
      let resolved = false;

      // Send 'q' to ffmpeg stdin to gracefully stop
      try {
        if (this.ffmpegProcess.stdin) {
          this.ffmpegProcess.stdin.write('q\n');
          this.ffmpegProcess.stdin.end();
          this.logger.info('Quit signal sent successfully');
        }
      } catch (error) {
        this.logger.warn('Could not send quit signal to ffmpeg stdin:', error);
        // Fallback to SIGTERM
        this.ffmpegProcess.kill('SIGTERM');
      }

      // Wait longer for ffmpeg to finalize the file (15 seconds)
      const timeout = setTimeout(() => {
        if (this.ffmpegProcess && !this.ffmpegProcess.killed && !resolved) {
          this.logger.warn('ffmpeg did not exit after 15s, sending SIGTERM');
          this.ffmpegProcess.kill('SIGTERM');

          // Last resort SIGKILL after 5 more seconds
          setTimeout(() => {
            if (this.ffmpegProcess && !this.ffmpegProcess.killed && !resolved) {
              this.logger.error('ffmpeg still not exited, sending SIGKILL');
              this.ffmpegProcess.kill('SIGKILL');
            }
          }, 5000);
        }
      }, 15000);

      this.ffmpegProcess.on('exit', (code, signal) => {
        if (!resolved) {
          clearTimeout(timeout);
          this.logger.info('ffmpeg process exited gracefully', { code, signal });
          this.ffmpegProcess = null;
          resolved = true;
          resolve();
        }
      });

      // If already exited
      if (this.ffmpegProcess.killed || this.ffmpegProcess.exitCode !== null) {
        clearTimeout(timeout);
        this.ffmpegProcess = null;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
    });
  }
}
