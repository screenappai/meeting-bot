import assert from 'node:assert/strict';
import test from 'node:test';
import { ZoomBrowserJoinBlockedError } from '../error';
import { classifyZoomJoinState, shouldUseZoomRtmsFallback } from './zoomJoinState';

test('classifies explicit Zoom browser-security blocks as bot blocked', () => {
  assert.equal(
    classifyZoomJoinState('Automated bots aren\'t allowed to join this meeting. Sign in to join.'),
    'automated_bot_blocked'
  );
  assert.equal(
    classifyZoomJoinState('Zoom needs to review the security of your connection before proceeding.'),
    'automated_bot_blocked'
  );
  assert.equal(classifyZoomJoinState('Sign in to join this meeting'), 'sign_in_required');
});

test('allows RTMS fallback only for an explicit pre-join automated-bot block', () => {
  const blocked = new ZoomBrowserJoinBlockedError();

  assert.equal(shouldUseZoomRtmsFallback(blocked, true, 'prejoin'), true);
  assert.equal(shouldUseZoomRtmsFallback(blocked, false, 'prejoin'), false);
  assert.equal(shouldUseZoomRtmsFallback(blocked, true, 'joined'), false);
  assert.equal(shouldUseZoomRtmsFallback(new Error('automated bot blocked'), true, 'prejoin'), false);
});

test('classifies terminal Zoom join states', () => {
  assert.equal(classifyZoomJoinState('You have been removed'), 'host_rejected');
  assert.equal(classifyZoomJoinState('This meeting has been ended by host'), 'meeting_ended');
  assert.equal(
    classifyZoomJoinState('Please wait, the meeting host will let you in soon.'),
    'waiting_room'
  );
});
