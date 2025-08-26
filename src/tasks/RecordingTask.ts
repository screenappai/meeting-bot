import { Page } from 'playwright';
import { Task } from '../lib/Task';
import config from '../config';
import { Logger } from 'winston';
import { vp9MimeType, webmMimeType } from '../lib/recording';

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
    await this.page.evaluate(
      async ({ teamId, duration, inactivityLimit, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes, primaryMimeType, secondaryMimeType }:
        { teamId: string, duration: number, inactivityLimit: number, userId: string, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number, primaryMimeType: string, secondaryMimeType: string }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityDetectionTimeout: NodeJS.Timeout;

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
          console.log('Will activate the inactivity detection after', activateInactivityDetectionAfter);

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

          let options: MediaRecorderOptions = {};
          if (MediaRecorder.isTypeSupported(primaryMimeType)) {
            console.log(`Media Recorder will use ${primaryMimeType} codecs...`);
            options = { mimeType: primaryMimeType };
          }
          else {
            console.warn(`Media Recorder did not find primary mime type codecs ${primaryMimeType}, Using fallback codecs ${secondaryMimeType}`);
            options = { mimeType: secondaryMimeType };
          }

          const mediaRecorder = new MediaRecorder(stream, { ...options });

          mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }
            try {
              const arrayBuffer = await event.data.arrayBuffer();
              await sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error.message, error);
            }
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);

          const stopTheRecording = async () => {
            console.log('-------- TRIGGER stop the recording');
            mediaRecorder.stop();
            stream.getTracks().forEach((track) => track.stop());

            // Cleanup recording timer
            clearTimeout(timeoutId);

            // Cancel the perpetural checks
            if (inactivityDetectionTimeout) {
              clearTimeout(inactivityDetectionTimeout);
            }

            // Begin browser cleanup
            (window as any).screenAppMeetEnd(slightlySecretId);
          };

          let loneTest: NodeJS.Timeout;
          let monitor = true;

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
                if (Number(participants[0]) > 1) {
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
          inactivityDetectionTimeout = setTimeout(() => {
            detectLoneParticipant();
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
        userId: this.userId, 
        slightlySecretId: this.slightlySecretId,
        activateInactivityDetectionAfterMinutes: config.activateInactivityDetectionAfter,
        activateInactivityDetectionAfter: new Date(new Date().getTime() + config.activateInactivityDetectionAfter * 60 * 1000).toISOString(),
        primaryMimeType: webmMimeType,
        secondaryMimeType: vp9MimeType
      }
    );
  }
}
