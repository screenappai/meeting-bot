import { Logger } from 'winston';
import { randomUUID } from 'crypto';
import { JoinParams } from '../bots/AbstractMeetBot';
import config, { NODE_ENV } from '../config';
import { KnownError } from '../error';
import { BotStatus } from '../types';
import { RtmsMediaRecorder } from './RtmsMediaRecorder';
import { ZoomRtmsApi } from './ZoomRtmsApi';
import { resolveZoomRtmsCredentials } from './ZoomRtmsCredentials';
import { zoomRtmsEventStore } from './ZoomRtmsEventStore';
import {
  assertZoomRtmsSdkAvailable,
  ZoomRtmsSdkClient,
  ZoomRtmsSdkConnectionIssue,
} from './ZoomRtmsSdkClient';
import {
  ZoomRtmsEventScope,
  ZoomRtmsPayload,
  ZoomRtmsStopReason,
  ZoomRtmsWebhookEvent,
} from './types';
import { extractZoomMeetingId } from './utils';

const START_EVENT_CLOCK_SKEW_MS = 5_000;
const SIGNAL_RECONNECT_WINDOW_MS = 60_000;
const MEDIA_RECONNECT_WINDOW_MS = 30_000;
const STREAM_EVENT_POLL_SECONDS = 1;
const RECONNECT_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000];
const MAX_STREAM_RESTARTS = RECONNECT_DELAYS_MS.length;
const FIRST_KNOWN_STOP_REASON = 1;
const LAST_KNOWN_STOP_REASON = 26;

export const isTransientStopReason = (reason?: number): reason is number =>
  typeof reason === 'number' && ((reason >= 10 && reason <= 19) || reason === 24);

export const isTerminalSdkLeaveReason = (reason: number): boolean =>
  reason >= FIRST_KNOWN_STOP_REASON
  && reason <= LAST_KNOWN_STOP_REASON
  && !isTransientStopReason(reason);

export const shouldRestartStoppedStream = (reason?: number): reason is number =>
  typeof reason === 'number'
  && reason !== ZoomRtmsStopReason.StreamRevoked
  && !isTerminalSdkLeaveReason(reason);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ZoomRtmsTransport {
  constructor(private readonly logger: Logger) {}

  async record(
    params: JoinParams,
    pushState: (state: BotStatus) => void
  ): Promise<void> {
    const meetingId = extractZoomMeetingId(params.url);
    const credentials = resolveZoomRtmsCredentials(params.teamId);
    const eventScope = credentials.eventScope;
    const api = new ZoomRtmsApi(credentials.api);
    let recorder: RtmsMediaRecorder | undefined;
    let client: ZoomRtmsSdkClient | undefined;
    let streamId: string | undefined;
    let lastStartPayload: ZoomRtmsPayload | undefined;
    let terminalStopReceived = false;
    let rtmsRequested = false;
    let streamRestartAttempts = 0;
    const reservationOwnerId = randomUUID();
    let meetingReserved = false;

    try {
      if (!config.isRedisEnabled && (NODE_ENV === 'production' || NODE_ENV === 'staging')) {
        throw new KnownError(
          'Zoom RTMS requires REDIS_CONSUMER_ENABLED=true in multi-replica environments',
          false,
          0
        );
      }
      assertZoomRtmsSdkAvailable();
      recorder = await RtmsMediaRecorder.create(this.logger);

      const reservationTtlSeconds =
        config.joinWaitTime * 60 + config.maxRecordingDuration * 60 + 600;
      meetingReserved = await zoomRtmsEventStore.reserveMeeting(
        meetingId,
        reservationOwnerId,
        reservationTtlSeconds,
        eventScope
      );
      if (!meetingReserved) {
        throw new KnownError(
          'A Zoom RTMS recording is already active for this meeting and operator',
          false,
          0
        );
      }

      this.logger.info('Requesting Zoom RTMS stream', {
        meetingId,
        credentialMode: credentials.credentialMode,
      });
      const startRequestedAt = Date.now();
      const initialJoinDeadline = startRequestedAt + config.joinWaitTime * 60 * 1000;
      const startResult = await api.start(
        meetingId,
        Math.max(0, initialJoinDeadline - Date.now())
      );
      rtmsRequested = startResult.status === 'requested';
      if (startResult.status === 'awaiting_external_authorization') {
        this.logger.info('Waiting for external Zoom RTMS authorization', { meetingId });
      }
      const initialEventWaitMs = initialJoinDeadline - Date.now();
      if (initialEventWaitMs <= 0) {
        throw new KnownError('Timed out requesting the Zoom RTMS stream', false, 0);
      }

      const startEvent = await this.waitForFreshStart(
        meetingId,
        startRequestedAt,
        eventScope,
        Math.ceil(initialEventWaitMs / 1000)
      );
      if (!startEvent) {
        throw new KnownError('Timed out waiting for a fresh Zoom RTMS start event', false, 0);
      }

      streamId = startEvent.payload.rtms_stream_id;
      lastStartPayload = startEvent.payload;
      rtmsRequested = true;
      await zoomRtmsEventStore.markStreamActive(streamId, eventScope);
      client = new ZoomRtmsSdkClient(recorder, this.logger, credentials.app);
      await this.connectWithBackoff(
        client,
        lastStartPayload,
        'initial RTMS connection',
        this.eventDeadline(startEvent, SIGNAL_RECONNECT_WINDOW_MS),
        true
      );

      pushState('joined');
      this.logger.info('Zoom RTMS recording started', { meetingId, streamId });

      const recordingDeadline = Date.now() + config.maxRecordingDuration * 60 * 1000;
      const activeClient = client;
      const restartTerminatedStream = async (stopReason: number): Promise<void> => {
        rtmsRequested = false;
        if (streamRestartAttempts >= MAX_STREAM_RESTARTS) {
          throw new Error(
            `Zoom RTMS stream restart limit reached after stop reason ${stopReason}`
          );
        }
        streamRestartAttempts += 1;

        const stoppedStreamId = streamId;
        if (!stoppedStreamId) throw new Error('Zoom RTMS stream ID is unavailable');
        this.logger.warn('Restarting terminated Zoom RTMS stream', {
          meetingId,
          streamId: stoppedStreamId,
          stopReason,
          attempt: streamRestartAttempts,
          maxAttempts: MAX_STREAM_RESTARTS,
        });
        await activeClient.close();
        await zoomRtmsEventStore.markStreamInactive(stoppedStreamId, eventScope);

        const restartRequestedAt = Date.now();
        const restartJoinDeadline = Math.min(
          recordingDeadline,
          restartRequestedAt + config.joinWaitTime * 60 * 1000
        );
        const restartResult = await api.start(
          meetingId,
          Math.max(0, restartJoinDeadline - Date.now())
        );
        rtmsRequested = restartResult.status === 'requested';
        if (restartResult.status === 'awaiting_external_authorization') {
          this.logger.info('Waiting for external Zoom RTMS restart authorization', {
            meetingId,
          });
        }
        const restartEventWaitMs = restartJoinDeadline - Date.now();
        if (restartEventWaitMs <= 0) {
          throw new Error('Timed out requesting the Zoom RTMS stream restart');
        }
        const restartedEvent = await this.waitForFreshStart(
          meetingId,
          restartRequestedAt,
          eventScope,
          Math.ceil(restartEventWaitMs / 1000)
        );
        if (!restartedEvent) {
          throw new Error('Timed out waiting for Zoom RTMS to restart');
        }

        streamId = restartedEvent.payload.rtms_stream_id;
        lastStartPayload = restartedEvent.payload;
        rtmsRequested = true;
        await zoomRtmsEventStore.markStreamActive(streamId, eventScope);
        await this.connectWithBackoff(
          activeClient,
          lastStartPayload,
          'restarted RTMS stream',
          Math.min(
            recordingDeadline,
            this.eventDeadline(restartedEvent, SIGNAL_RECONNECT_WINDOW_MS)
          ),
          true
        );
        this.logger.info('Zoom RTMS stream restarted', { meetingId, streamId });
      };

      while (!terminalStopReceived) {
        const remainingSeconds = Math.ceil((recordingDeadline - Date.now()) / 1000);
        if (remainingSeconds <= 0) break;

        const event = await zoomRtmsEventStore.waitForStreamEvent(
          streamId,
          eventScope,
          Math.min(STREAM_EVENT_POLL_SECONDS, remainingSeconds)
        );

        if (event?.event === 'meeting.rtms_stopped') {
          rtmsRequested = false;
          if (typeof event.payload.stop_reason !== 'number') {
            throw new KnownError('Zoom RTMS stop event is missing its reason', false, 0);
          }
          if (event.payload.stop_reason === ZoomRtmsStopReason.StreamRevoked) {
            throw new KnownError(
              'Zoom RTMS consent was revoked; the recording was discarded',
              false,
              0
            );
          }

          if (shouldRestartStoppedStream(event.payload.stop_reason)) {
            await restartTerminatedStream(event.payload.stop_reason);
            continue;
          }

          terminalStopReceived = true;
          continue;
        }

        if (event?.event === 'meeting.rtms_started') {
          lastStartPayload = event.payload;
          this.logger.warn('Zoom RTMS server changed; reconnecting immediately', {
            meetingId,
            streamId,
          });
          await this.connectWithBackoff(
            client,
            lastStartPayload,
            'RTMS server failover',
            Math.min(
              recordingDeadline,
              this.eventDeadline(event, SIGNAL_RECONNECT_WINDOW_MS)
            ),
            true
          );
          continue;
        }

        if (event?.event === 'meeting.rtms_interrupted') {
          const reconnectPayload = this.mergeInterruptedPayload(lastStartPayload, event);
          lastStartPayload = reconnectPayload;
          this.logger.warn('Zoom RTMS signaling interrupted; reconnecting', {
            meetingId,
            streamId,
          });
          await this.connectWithBackoff(
            client,
            reconnectPayload,
            'interrupted RTMS signaling connection',
            Math.min(
              recordingDeadline,
              this.eventDeadline(event, SIGNAL_RECONNECT_WINDOW_MS)
            ),
            false
          );
          continue;
        }

        const connectionIssue = client.takeConnectionIssue();
        if (connectionIssue) {
          if (
            connectionIssue.type === 'left'
            && connectionIssue.reason === ZoomRtmsStopReason.StreamRevoked
          ) {
            throw new KnownError(
              'Zoom RTMS consent was revoked; the recording was discarded',
              false,
              0
            );
          }

          if (
            connectionIssue.type === 'left'
            && isTerminalSdkLeaveReason(connectionIssue.reason)
          ) {
            terminalStopReceived = true;
            rtmsRequested = false;
            this.logger.info('Zoom RTMS stream ended; finalizing recording', {
              meetingId,
              streamId,
              stopReason: connectionIssue.reason,
            });
            continue;
          }

          if (
            connectionIssue.type === 'left'
            && isTransientStopReason(connectionIssue.reason)
          ) {
            await restartTerminatedStream(connectionIssue.reason);
            continue;
          }

          if (!lastStartPayload) throw new Error('Zoom RTMS reconnect details are unavailable');
          const reconnectWindow = connectionIssue.type === 'media_interrupted'
            ? MEDIA_RECONNECT_WINDOW_MS
            : SIGNAL_RECONNECT_WINDOW_MS;
          this.logger.warn('Zoom RTMS SDK connection lost; reconnecting the full stream', {
            meetingId,
            streamId,
            issue: connectionIssue,
          });
          await this.reconnectAfterSdkIssue(
            client,
            lastStartPayload,
            connectionIssue,
            Math.min(recordingDeadline, Date.now() + reconnectWindow)
          );
        }
      }

      if (!terminalStopReceived) {
        this.logger.info('Maximum Zoom RTMS recording duration reached; stopping stream', {
          meetingId,
          streamId,
        });
        await api.stop(meetingId);
        rtmsRequested = false;
      }

      await client.close();
      const recording = await recorder.finalize();
      params.uploader.setRecordingDuration(recording.durationSeconds);
      await params.uploader.useExternalFile(recording.filePath, '.mp4');
      pushState('finished');
      this.logger.info('Zoom RTMS recording finalized', {
        meetingId,
        streamId,
        durationSeconds: recording.durationSeconds,
      });
    } catch (error: unknown) {
      if (error instanceof KnownError) throw error;
      throw new KnownError(
        `Zoom RTMS recording failed: ${errorMessage(error)}`,
        false,
        0
      );
    } finally {
      await client?.close();
      if (streamId) {
        await zoomRtmsEventStore.markStreamInactive(streamId, eventScope).catch((error) => {
          this.logger.warn('Unable to release Zoom RTMS stream ownership', { error, streamId });
        });
      }
      if (rtmsRequested && !terminalStopReceived) {
        await api.stop(meetingId).catch((error) => {
          this.logger.warn('Unable to stop Zoom RTMS during cleanup', { error, meetingId });
        });
      }
      await recorder?.cleanup().catch((error) => {
        this.logger.warn('Unable to remove Zoom RTMS temporary files', { error });
      });
      if (meetingReserved) {
        await zoomRtmsEventStore.releaseMeeting(
          meetingId,
          reservationOwnerId,
          eventScope
        ).catch((error) => {
          this.logger.warn('Unable to release Zoom RTMS meeting reservation', {
            error,
            meetingId,
          });
        });
      }
    }
  }

  private async waitForFreshStart(
    meetingId: string,
    requestedAt: number,
    eventScope: ZoomRtmsEventScope,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;

    while (Date.now() < deadline) {
      const event = await zoomRtmsEventStore.waitForMeetingStart(
        meetingId,
        eventScope,
        Math.max(1, Math.ceil((deadline - Date.now()) / 1000))
      );
      if (!event) return null;

      const eventTimestamp = event.event_ts;
      if (
        event.event !== 'meeting.rtms_started'
        || typeof eventTimestamp !== 'number'
        || eventTimestamp < requestedAt - START_EVENT_CLOCK_SKEW_MS
      ) {
        this.logger.warn('Ignoring stale Zoom RTMS start event', {
          meetingId,
          requestedAt,
          eventTimestamp,
        });
        continue;
      }

      const expectedOperatorId = eventScope.operatorId;
      if (
        expectedOperatorId
        && String(event.payload.operator_id ?? '') !== expectedOperatorId
      ) {
        this.logger.warn('Ignoring Zoom RTMS start event for another operator', {
          meetingId,
          expectedOperatorId,
          operatorId: event.payload.operator_id,
        });
        continue;
      }

      return event;
    }

    return null;
  }

  private mergeInterruptedPayload(
    lastStartPayload: ZoomRtmsPayload | undefined,
    event: ZoomRtmsWebhookEvent
  ): ZoomRtmsPayload {
    if (!lastStartPayload) throw new Error('Zoom RTMS reconnect details are unavailable');
    return {
      ...lastStartPayload,
      ...event.payload,
      server_urls: event.payload.server_urls ?? lastStartPayload.server_urls,
    };
  }

  private eventDeadline(event: ZoomRtmsWebhookEvent, windowMs: number): number {
    const eventTimestamp = typeof event.event_ts === 'number' ? event.event_ts : Date.now();
    return eventTimestamp + windowMs;
  }

  private async reconnectAfterSdkIssue(
    client: ZoomRtmsSdkClient,
    payload: ZoomRtmsPayload,
    issue: ZoomRtmsSdkConnectionIssue,
    deadline: number
  ): Promise<void> {
    const description = issue.type === 'media_interrupted'
      ? 'interrupted RTMS media connection'
      : `RTMS SDK leave (${issue.reason})`;
    await this.connectWithBackoff(client, payload, description, deadline, false);
  }

  private async connectWithBackoff(
    client: ZoomRtmsSdkClient,
    payload: ZoomRtmsPayload,
    description: string,
    deadline: number,
    immediate: boolean
  ): Promise<void> {
    let lastError: unknown;
    let attempt = 0;

    if (immediate) {
      attempt += 1;
      try {
        await this.connectBeforeDeadline(client, payload, deadline);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(`Zoom ${description} attempt failed`, {
          attempt,
          error: errorMessage(error),
        });
      }
    }

    for (const delayMs of RECONNECT_DELAYS_MS) {
      if (Date.now() + delayMs >= deadline) break;
      await sleep(delayMs);
      attempt += 1;
      try {
        await this.connectBeforeDeadline(client, payload, deadline);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(`Zoom ${description} attempt failed`, {
          attempt,
          delayMs,
          error: errorMessage(error),
        });
      }
    }

    throw new Error(
      `Unable to restore ${description} within Zoom's reconnect window after ${attempt} attempts${
        lastError ? `: ${errorMessage(lastError)}` : ''
      }`
    );
  }

  private async connectBeforeDeadline(
    client: ZoomRtmsSdkClient,
    payload: ZoomRtmsPayload,
    deadline: number
  ): Promise<void> {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1_000) throw new Error('Zoom RTMS reconnect window expired');
    await client.connect(payload, Math.min(30_000, remainingMs));
  }
}
