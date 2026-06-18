import { Page } from 'playwright';
import { Task } from '../lib/Task';
import config from '../config';
import { Logger } from 'winston';
import { getRecordingMimeTypesForExtension } from '../lib/recording';

export class RecordingTask extends Task<null, void> {
  private userId: string;
  private teamId: string;
  private page: Page;
  private duration: number;
  private inactivityLimit: number;
  private slightlySecretId: string;
  
  constructor(
    userId: string,
    teamId: string,
    page: Page,
    duration: number,
    slightlySecretId: string,
    logger: Logger
  ) {
    super(logger);
    this.userId = userId;
    this.teamId = teamId;
    this.duration = duration;
    this.inactivityLimit = config.inactivityLimit * 60 * 1000;
    this.page = page;
    this.slightlySecretId = slightlySecretId;
  }

  protected async execute(): Promise<void> {
    // Zoom records via real-time tab capture, often under software GL (swiftshader).
    // VP9 can't keep up there and drops frames -> laggy playback, so prefer VP8.
    const { mimeTypes } = getRecordingMimeTypesForExtension(config.uploaderFileExtension, true);
    const loneParticipantExitDelayMs = config.loneParticipantExitDelaySeconds * 1000;

    await this.page.evaluate(
      async ({ teamId, duration, inactivityLimit, loneParticipantExitDelayMs, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes, mimeTypes, videoBitsPerSecond }:
        { teamId: string, duration: number, inactivityLimit: number, loneParticipantExitDelayMs: number, userId: string, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number, mimeTypes: string[], videoBitsPerSecond: number }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivitySilenceDetectionTimeout: NodeJS.Timeout;

        /**
         * @summary A simple method to reliably send chunks over exposeFunction
         * @param chunk Array buffer to send
         * @returns void
         */
        const sendChunkToServer = async (chunk: ArrayBuffer) => {
          function arrayBufferToBase64(buffer: ArrayBuffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
          }
          const base64 = arrayBufferToBase64(chunk);
          await (window as any).screenAppSendData(slightlySecretId, base64);
        };

        async function startRecording() {
          console.log('Participant detection is active immediately; silence detection activates after', activateInactivityDetectionAfter);

          // Check for the availability of the mediaDevices API
          if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            console.error('MediaDevices or getDisplayMedia not supported in this browser.');
            return;
          }

          const stream: MediaStream = await (navigator.mediaDevices as any).getDisplayMedia({
            video: true,
            audio: {
              autoGainControl: false,
              channels: 2,
              channelCount: 2,
              echoCancellation: false,
              noiseSuppression: false,
            },
            preferCurrentTab: true,
          });

          const selectedMimeType = mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
          if (!selectedMimeType) {
            throw new Error(`MediaRecorder does not support requested codecs: ${mimeTypes.join(', ')}`);
          }

          console.log(`Media Recorder will use ${selectedMimeType} codecs...`);
          const mediaRecorder = new MediaRecorder(stream, { mimeType: selectedMimeType, videoBitsPerSecond });
          console.log(`Media Recorder actual mime type: ${mediaRecorder.mimeType}`);
          let chunkUploadChain: Promise<void> = Promise.resolve();
          let isStoppingRecording = false;

          mediaRecorder.ondataavailable = (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }

            const chunk = event.data;
            chunkUploadChain = chunkUploadChain.then(async () => {
              try {
                const arrayBuffer = await chunk.arrayBuffer();
                await sendChunkToServer(arrayBuffer);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('Error uploading chunk:', message, error);
              }
            });
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);
          const recordingStartedAt = Date.now();
          const initialAloneGraceMs = activateInactivityDetectionAfterMinutes * 60 * 1000;

          const stopTheRecording = async () => {
            if (isStoppingRecording) return;
            isStoppingRecording = true;
            console.log('-------- TRIGGER stop the recording');
            const recordedDurationSeconds = Math.max(1, Math.round((Date.now() - recordingStartedAt) / 1000));

            try {
              await new Promise<void>((resolve) => {
                if (mediaRecorder.state === 'inactive') {
                  resolve();
                  return;
                }
                mediaRecorder.addEventListener('stop', () => resolve(), { once: true });
                mediaRecorder.stop();
              });
              await chunkUploadChain;
            } catch (error) {
              console.error('Error stopping recorder or flushing final chunks:', error);
            } finally {
              stream.getTracks().forEach((track) => track.stop());

              // Cleanup recording timer
              clearTimeout(timeoutId);

              // Cancel the perpetural checks
              if (inactivitySilenceDetectionTimeout) {
                clearTimeout(inactivitySilenceDetectionTimeout);
              }

              // Begin browser cleanup
              (window as any).screenAppMeetEnd(slightlySecretId, recordedDurationSeconds);
            }
          };

          let loneTest: NodeJS.Timeout;
          let monitor = true;
          let hasSeenOtherParticipant = false;
          let aloneSince: number | null = null;

          const shouldStopForParticipantCount = (participants: number) => {
            const now = Date.now();
            if (participants > 1) {
              hasSeenOtherParticipant = true;
              aloneSince = null;
              return false;
            }

            if (hasSeenOtherParticipant) {
              if (aloneSince === null) {
                aloneSince = now;
                console.log('Bot is alone after previously seeing participants; waiting before ending recording.');
              }
              return now - aloneSince >= loneParticipantExitDelayMs;
            }

            return now - recordingStartedAt >= initialAloneGraceMs;
          };

          // TODO Create standard detection lib
          const detectLoneParticipant = () => {
            let dom: Document = document;
            const iframe: HTMLIFrameElement | null = document.querySelector('iframe#webclient');
            if (iframe && iframe.contentDocument) {
              console.log('Using iframe for participants detection...');
              dom = iframe.contentDocument;
            }

            loneTest = setInterval(() => {
              try {
                // Detect and click blocking "OK" buttons
                const okButton = Array.from(dom.querySelectorAll('button'))
                    .filter((el) => el?.innerText?.trim()?.match(/^OK/i));
                if (okButton && okButton[0]) {
                  console.log('It appears that meeting has been ended. Click "OK" and verify if meeting is still in progress...', { userId });
                  let shouldEndMeeting = false;
                  const meetingEndLabel = dom.querySelector('[aria-label="Meeting is end now"]');
                  if (meetingEndLabel) {
                    shouldEndMeeting = true;
                  }
                  else {
                    const endText = 'This meeting has been ended by host';
                    const divs = dom.querySelectorAll('div');
                    for (const modal of divs) {
                      if (modal.innerText.includes(endText)) {
                        shouldEndMeeting = true;
                        break;
                      }
                    }
                  }
                  okButton[0].click();
                  if (shouldEndMeeting) {
                    console.log('Detected Zoom meeting has been ended by host. End Recording...', { userId });
                    clearInterval(loneTest);
                    monitor = false;
                    stopTheRecording();
                  }
                }

                // Detect number of participants
                const participantsMatch = Array.from(dom.querySelectorAll('button'))
                    .filter((el) => el?.innerText?.trim()?.match(/^\d+/));
                const text = participantsMatch && participantsMatch.length > 0 ? participantsMatch[0].innerText.trim() : null;
                if (!text) {
                  console.error('Zoom presence detection is probably not working on user:', userId, teamId);
                  return;
                }

                const regex = new RegExp(/\d+/);
                const participants = text.match(regex);
                if (!participants || participants.length === 0) {
                  console.error('Zoom participants detection is probably not working on user:', { userId, teamId });
                  return;
                }
                const participantCount = Number(participants[0]);
                if (!shouldStopForParticipantCount(participantCount)) {
                  return;
                }

                console.log('Detected meeting bot is alone in meeting, ending recording on team:', { userId, teamId });
                clearInterval(loneTest);
                monitor = false;
                stopTheRecording();
              } catch (error) {
                console.error('Zoom Meeting presence detection failed on team:', { userId, teamId, message: error.message, error });
              }
            }, 2000); // Detect every 2 seconds
          };

          const detectIncrediblySilentMeeting = () => {
            const audioContext = new AudioContext();
            const mediaSource = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();

            /* Use a value suitable for the given use case of silence detection
               |
               |____ Relatively smaller FFT size for faster processing and less sampling
            */
            analyser.fftSize = 256;

            mediaSource.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            // Sliding silence period
            let silenceDuration = 0;

            // Audio gain/volume
            const silenceThreshold = 10;

            const monitorSilence = () => {
              analyser.getByteFrequencyData(dataArray);

              const audioActivity = dataArray.reduce((a, b) => a + b) / dataArray.length;

              if (audioActivity < silenceThreshold) {
                silenceDuration += 100; // Check every 100ms
                if (silenceDuration >= inactivityLimit) {
                  console.warn('Detected silence in Zoom Meeting and ending the recording on team:', userId, teamId);
                  monitor = false;
                  clearInterval(loneTest);
                  stopTheRecording();
                }
              } else {
                silenceDuration = 0;
              }

              if (monitor) {
                // Recursively queue the next check
                setTimeout(monitorSilence, 100);
              }
            };

            // Go silence monitor
            monitorSilence();
          };

          /**
           * Perpetual checks for inactivity detection
           */
          detectLoneParticipant();

          inactivitySilenceDetectionTimeout = setTimeout(() => {
            detectIncrediblySilentMeeting();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          // Cancel this timeout when stopping the recording
          // Stop recording after `duration` minutes upper limit
          timeoutId = setTimeout(async () => {
            stopTheRecording();
          }, duration);
        }

        // Start the recording
        await startRecording();
      },
{
        teamId: this.teamId,
        duration: this.duration,
        inactivityLimit: this.inactivityLimit,
        loneParticipantExitDelayMs,
        userId: this.userId,
        slightlySecretId: this.slightlySecretId,
        activateInactivityDetectionAfterMinutes: config.activateInactivityDetectionAfter,
        activateInactivityDetectionAfter: new Date(new Date().getTime() + config.activateInactivityDetectionAfter * 60 * 1000).toISOString(),
        mimeTypes,
        videoBitsPerSecond: config.recordingVideoBitsPerSecond,
      }
    );
  }
}
