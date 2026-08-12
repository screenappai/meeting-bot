import assert from 'node:assert/strict';
import test from 'node:test';
import { Logger } from 'winston';
import config from '../config';
import { boundMediaGapMilliseconds, RtmsMediaRecorder } from './RtmsMediaRecorder';

test('preserves media gaps longer than 60 seconds up to the recording limit', () => {
  const twoMinuteGap = 120_000;

  assert.equal(boundMediaGapMilliseconds(twoMinuteGap), twoMinuteGap);
  assert.equal(
    boundMediaGapMilliseconds(config.maxRecordingDuration * 60_000 + 1),
    config.maxRecordingDuration * 60_000
  );
});

test('keeps a media gap longer than 60 seconds in the recorded timeline', async () => {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
  const recorder = await RtmsMediaRecorder.create(logger);

  try {
    recorder.writeAudio(Buffer.alloc(3_200), 1_000_000);
    recorder.writeAudio(Buffer.alloc(3_200), 1_065_000);

    const recording = await recorder.finalize();
    assert.ok(recording.durationSeconds >= 65);
  } finally {
    await recorder.cleanup();
  }
});
