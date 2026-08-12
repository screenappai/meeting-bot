import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const cdpUrl = process.env.CHROME_CDP_URL ?? 'http://127.0.0.1:9223';
const containerName = process.env.CHROME_CDP_CONTAINER;
const codec = 'video/webm;codecs=vp8,opus';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getCdpVersion(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/json/version', cdpUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(response.ok, true, `CDP returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw new Error(`CDP did not become ready: ${lastError instanceof Error ? lastError.message : lastError}`);
}

function assertXvfbSocket() {
  if (!containerName) return;

  execFileSync('docker', [
    'exec',
    containerName,
    'test',
    '-S',
    process.env.CHROME_XVFB_SOCKET ?? '/tmp/.X11-unix/X99',
  ], { stdio: 'inherit' });
}

async function recordCurrentTab(page) {
  await page.goto(new URL('/json/version', cdpUrl).toString(), { waitUntil: 'domcontentloaded' });
  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <style>
          body { background: #111; color: #fff; font: 32px sans-serif; }
          #pulse { animation: pulse 500ms infinite alternate; }
          @keyframes pulse { from { opacity: 0.25; } to { opacity: 1; } }
        </style>
      </head>
      <body>
        <button id="start" type="button">Start capture</button>
        <div id="pulse">Chrome CDP media smoke test</div>
        <script>
          const codec = ${JSON.stringify(codec)};

          async function runSmoke() {
            const codecSupported = MediaRecorder.isTypeSupported(codec);
            let capture;
            let audioContext;
            let oscillator;

            try {
              capture = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 5 },
                audio: false,
                preferCurrentTab: true,
                selfBrowserSurface: 'include',
                surfaceSwitching: 'exclude',
                systemAudio: 'exclude',
              });

              audioContext = new AudioContext();
              await audioContext.resume();
              const audioDestination = audioContext.createMediaStreamDestination();
              oscillator = audioContext.createOscillator();
              oscillator.frequency.value = 440;
              oscillator.connect(audioDestination);
              oscillator.start();

              const stream = new MediaStream([
                ...capture.getVideoTracks(),
                ...audioDestination.stream.getAudioTracks(),
              ]);
              const chunks = [];
              const recorder = new MediaRecorder(stream, { mimeType: codec });
              recorder.addEventListener('dataavailable', event => {
                if (event.data.size > 0) chunks.push(event.data);
              });
              const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));

              recorder.start(250);
              await new Promise(resolve => setTimeout(resolve, 5_000));

              const videoTrack = stream.getVideoTracks()[0];
              const audioTrack = stream.getAudioTracks()[0];
              const liveDuringRecording = recorder.state === 'recording'
                && videoTrack?.readyState === 'live'
                && audioTrack?.readyState === 'live';
              const displaySurface = videoTrack?.getSettings().displaySurface;

              recorder.stop();
              await stopped;
              const blob = new Blob(chunks, { type: codec });

              return {
                audioTrackCount: stream.getAudioTracks().length,
                blobSize: blob.size,
                chunkCount: chunks.length,
                codecSupported,
                displaySurface,
                liveDuringRecording,
                secureContext: window.isSecureContext,
                videoTrackCount: stream.getVideoTracks().length,
              };
            } catch (error) {
              return { error: error instanceof Error ? error.message : String(error) };
            } finally {
              capture?.getTracks().forEach(track => track.stop());
              oscillator?.stop();
              await audioContext?.close();
            }
          }

          document.querySelector('#start').addEventListener('click', () => {
            window.__chromeSmokeResult = Promise.race([
              runSmoke(),
              new Promise(resolve => setTimeout(() => resolve({ error: 'Media smoke test timed out' }), 20_000)),
            ]);
          });
        </script>
      </body>
    </html>
  `);

  await page.click('#start');
  return page.evaluate(() => window.__chromeSmokeResult);
}

async function main() {
  const initialVersion = await getCdpVersion();
  assert.match(initialVersion.Browser ?? '', /Chrome\//);
  assert.match(initialVersion.webSocketDebuggerUrl ?? '', /^ws:\/\//);
  assertXvfbSocket();

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    const result = await recordCurrentTab(page);
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.secureContext, true);
    assert.equal(result.codecSupported, true, `${codec} is not supported`);
    assert.equal(result.displaySurface, 'browser', 'Chrome did not capture the current tab');
    assert.equal(result.videoTrackCount, 1);
    assert.equal(result.audioTrackCount, 1);
    assert.equal(result.liveDuringRecording, true);
    assert.ok(result.chunkCount > 0, 'MediaRecorder produced no chunks');
    assert.ok(result.blobSize > 0, 'MediaRecorder produced an empty recording');
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }

  const finalVersion = await getCdpVersion(5_000);
  assert.equal(finalVersion.Browser, initialVersion.Browser, 'Chrome did not survive meeting-context cleanup');
  console.log(`Chrome CDP smoke test passed (${finalVersion.Browser}, ${codec})`);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
