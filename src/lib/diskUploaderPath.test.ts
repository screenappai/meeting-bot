import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  assertPathWithinTempFolder,
  assertSafeFileComponent,
} from '../middleware/disk-uploader';

test('accepts only allowlisted temporary file components', () => {
  assert.doesNotThrow(() => assertSafeFileComponent('recording_01-safe', 'test component'));
  assert.throws(() => assertSafeFileComponent('../recording', 'test component'), /Invalid test component/);
  assert.throws(() => assertSafeFileComponent('recording.mp4', 'test component'), /Invalid test component/);
});

test('keeps temporary recording paths inside the application media root', () => {
  const root = path.resolve(process.cwd(), 'dist', '_tempvideo');
  const nested = path.join(root, 'tenant', 'recording.mp4');

  assert.equal(assertPathWithinTempFolder(nested), nested);
  assert.throws(
    () => assertPathWithinTempFolder(path.resolve(root, '..', 'recording.mp4')),
    /escapes its isolated directory/,
  );
});
