import assert from 'node:assert/strict';
import test from 'node:test';

import { hasUsableLegacyCoreToken } from '../services/botService';

test('legacy Core callback skips missing and placeholder bearer tokens', () => {
  assert.equal(hasUsableLegacyCoreToken(''), false);
  assert.equal(hasUsableLegacyCoreToken('  your-auth-token  '), false);
  assert.equal(hasUsableLegacyCoreToken('PLACEHOLDER'), false);
  assert.equal(hasUsableLegacyCoreToken('unused'), false);
});

test('legacy Core callback accepts a real bearer token value', () => {
  assert.equal(hasUsableLegacyCoreToken('eyJhbGciOiJSUzI1NiJ9.payload.signature'), true);
});
