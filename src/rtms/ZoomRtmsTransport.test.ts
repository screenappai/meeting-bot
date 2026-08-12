import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTerminalSdkLeaveReason,
  isTransientStopReason,
  shouldRestartStoppedStream,
} from './ZoomRtmsTransport';

test('treats non-retryable Zoom SDK stop reasons as terminal', () => {
  for (const reason of [1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22, 23, 25, 26]) {
    assert.equal(isTerminalSdkLeaveReason(reason), true, `reason ${reason}`);
  }
});

test('keeps transient and unknown Zoom SDK leave reasons reconnectable', () => {
  for (const reason of [0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24, 27, 960]) {
    assert.equal(isTerminalSdkLeaveReason(reason), false, `reason ${reason}`);
  }
});

test('restarts the complete RTMS stream for every retryable Zoom stop reason', () => {
  for (const reason of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24]) {
    assert.equal(isTransientStopReason(reason), true, `reason ${reason}`);
  }

  for (const reason of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22, 23, 25, 26, 27, 960]) {
    assert.equal(isTransientStopReason(reason), false, `reason ${reason}`);
  }
});

test('restarts stopped streams for transient and unknown reasons only', () => {
  for (const reason of [0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24, 27, 960]) {
    assert.equal(shouldRestartStoppedStream(reason), true, `reason ${reason}`);
  }

  for (const reason of [1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22, 23, 25, 26]) {
    assert.equal(shouldRestartStoppedStream(reason), false, `reason ${reason}`);
  }
  assert.equal(shouldRestartStoppedStream(undefined), false);
});
