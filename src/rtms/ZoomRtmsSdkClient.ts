import { Logger } from 'winston';
import { createRequire } from 'module';
import { KnownError } from '../error';
import { ZoomRtmsAppCredentials, ZoomRtmsPayload } from './types';
import { RtmsMediaRecorder } from './RtmsMediaRecorder';

interface RtmsClient {
  setAudioParams(params: Record<string, number>): boolean;
  setVideoParams(params: Record<string, number>): boolean;
  onJoinConfirm(callback: (reason: number) => void): boolean;
  onLeave(callback: (reason: number) => void): boolean;
  onAudioData(callback: (buffer: Buffer, size: number, timestamp: number) => void): boolean;
  onVideoData(callback: (buffer: Buffer, size: number, timestamp: number) => void): boolean;
  onMediaConnectionInterrupted(callback: (timestamp: number) => void): boolean;
  join(params: Record<string, unknown>): boolean;
  leave(): boolean;
}

interface RtmsSdk {
  Client: new () => RtmsClient;
  AudioContentType: { RAW_AUDIO: number };
  AudioCodec: { L16: number };
  AudioSampleRate: { SR_16K: number };
  AudioChannel: { MONO: number };
  AudioDataOption: { AUDIO_MIXED_STREAM: number };
  VideoContentType: { RAW_VIDEO: number };
  VideoCodec: { H264: number };
  VideoResolution: { HD: number };
  VideoDataOption: { VIDEO_SINGLE_ACTIVE_STREAM: number };
}

export type ZoomRtmsSdkConnectionIssue =
  | { type: 'media_interrupted'; timestamp: number }
  | { type: 'left'; reason: number };

interface ActiveClient {
  client: RtmsClient;
  suppressIssues: boolean;
}

const isSupportedPlatform = (): boolean =>
  (process.platform === 'linux' && process.arch === 'x64')
  || (process.platform === 'darwin' && process.arch === 'arm64');

const requireModule = createRequire(__filename);

const loadSdk = (): RtmsSdk => {
  if (!isSupportedPlatform()) {
    throw new KnownError(
      `Zoom RTMS SDK is not supported on ${process.platform}-${process.arch}`,
      false,
      0
    );
  }

  try {
    const module = requireModule('@zoom/rtms');
    const sdk = module.default as RtmsSdk;
    if (!sdk || typeof sdk.Client !== 'function') throw new Error('Client export is missing');
    return sdk;
  } catch (error: unknown) {
    throw new KnownError(
      `Unable to load Zoom RTMS SDK: ${error instanceof Error ? error.message : String(error)}`,
      false,
      0
    );
  }
};

export const assertZoomRtmsSdkAvailable = (): void => {
  loadSdk();
};

export const buildZoomRtmsSdkJoinParams = (
  payload: ZoomRtmsPayload,
  app: ZoomRtmsAppCredentials,
  timeoutMs: number
): Record<string, unknown> => ({
  meeting_uuid: payload.meeting_uuid,
  rtms_stream_id: payload.rtms_stream_id,
  server_urls: payload.server_urls,
  client: app.clientId,
  secret: app.clientSecret,
  timeout: timeoutMs,
  pollInterval: 10,
  is_verify_cert: 1,
});

export class ZoomRtmsSdkClient {
  private activeClient?: ActiveClient;
  private connectionIssue?: ZoomRtmsSdkConnectionIssue;

  constructor(
    private readonly recorder: RtmsMediaRecorder,
    private readonly logger: Logger,
    private readonly app: ZoomRtmsAppCredentials
  ) {}

  async connect(payload: ZoomRtmsPayload, timeoutMs = 30_000): Promise<void> {
    await this.close();
    this.connectionIssue = undefined;

    if (!this.app.clientId || !this.app.clientSecret) {
      throw new KnownError(
        'Zoom RTMS app client ID and client secret are required',
        false,
        0
      );
    }
    if (!payload.meeting_uuid || !payload.rtms_stream_id || !payload.server_urls) {
      throw new KnownError('Zoom RTMS start event is missing connection details', false, 0);
    }

    const sdk = loadSdk();
    const client = new sdk.Client();
    const activeClient: ActiveClient = { client, suppressIssues: false };
    this.activeClient = activeClient;
    const boundedTimeoutMs = Math.max(1_000, Math.min(30_000, timeoutMs));

    const audioConfigured = client.setAudioParams({
      contentType: sdk.AudioContentType.RAW_AUDIO,
      codec: sdk.AudioCodec.L16,
      sampleRate: sdk.AudioSampleRate.SR_16K,
      channel: sdk.AudioChannel.MONO,
      dataOpt: sdk.AudioDataOption.AUDIO_MIXED_STREAM,
      duration: 100,
      frameSize: 1600,
    });
    const videoConfigured = client.setVideoParams({
      contentType: sdk.VideoContentType.RAW_VIDEO,
      codec: sdk.VideoCodec.H264,
      resolution: sdk.VideoResolution.HD,
      dataOpt: sdk.VideoDataOption.VIDEO_SINGLE_ACTIVE_STREAM,
      fps: 25,
    });
    if (!audioConfigured || !videoConfigured) {
      await this.close();
      throw new KnownError('Unable to configure Zoom RTMS audio/video streams', false, 0);
    }

    const audioCallbackSet = client.onAudioData((buffer, size, timestamp) => {
      const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      this.recorder.writeAudio(data.subarray(0, size), timestamp);
    });
    const videoCallbackSet = client.onVideoData((buffer, size, timestamp) => {
      const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      this.recorder.writeVideo(data.subarray(0, size), timestamp);
    });
    if (!audioCallbackSet || !videoCallbackSet) {
      await this.close();
      throw new KnownError('Unable to register Zoom RTMS media callbacks', false, 0);
    }

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let joined = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          error ? reject(error) : resolve();
        };
        const timeout = setTimeout(
          () => finish(new Error('Timed out connecting to the Zoom RTMS stream')),
          boundedTimeoutMs
        );

        const joinCallbackSet = client.onJoinConfirm((reason) => {
          if (reason === 0) {
            joined = true;
            finish();
          } else {
            finish(new Error(`Zoom RTMS SDK rejected the stream connection (${reason})`));
          }
        });
        const leaveCallbackSet = client.onLeave((reason) => {
          this.logger.info('Zoom RTMS SDK left the stream', { reason });
          if (!joined) {
            finish(new Error(`Zoom RTMS SDK left before connecting (${reason})`));
          } else if (
            !activeClient.suppressIssues
            && this.activeClient === activeClient
            && !this.connectionIssue
          ) {
            this.connectionIssue = { type: 'left', reason };
          }
        });
        const interruptionCallbackSet = client.onMediaConnectionInterrupted((timestamp) => {
          this.logger.warn('Zoom RTMS media connection interrupted', { timestamp });
          if (!joined) {
            finish(new Error('Zoom RTMS media connection was interrupted while connecting'));
          } else if (
            !activeClient.suppressIssues
            && this.activeClient === activeClient
            && !this.connectionIssue
          ) {
            this.connectionIssue = { type: 'media_interrupted', timestamp };
          }
        });

        if (!joinCallbackSet || !leaveCallbackSet || !interruptionCallbackSet) {
          finish(new Error('Unable to register Zoom RTMS connection callbacks'));
          return;
        }

        const joining = client.join(
          buildZoomRtmsSdkJoinParams(payload, this.app, boundedTimeoutMs)
        );
        if (!joining) finish(new Error('Zoom RTMS SDK could not start the stream connection'));
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  takeConnectionIssue(): ZoomRtmsSdkConnectionIssue | undefined {
    const issue = this.connectionIssue;
    this.connectionIssue = undefined;
    return issue;
  }

  async close(): Promise<void> {
    const activeClient = this.activeClient;
    this.activeClient = undefined;
    this.connectionIssue = undefined;
    if (!activeClient) return;
    activeClient.suppressIssues = true;
    try {
      activeClient.client.leave();
    } catch (error) {
      this.logger.warn('Unable to close Zoom RTMS SDK client cleanly', { error });
    }
  }
}
