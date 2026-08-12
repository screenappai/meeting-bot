import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../config';
import { ZoomRtmsEventStore } from './ZoomRtmsEventStore';
import { ZoomRtmsEventScope, ZoomRtmsWebhookEvent } from './types';

const originalRedisEnabled = config.isRedisEnabled;

test.beforeEach(() => {
  config.isRedisEnabled = false;
});

test.afterEach(() => {
  config.isRedisEnabled = originalRedisEnabled;
});

const scope = (
  customerId: string,
  operatorId: string,
  appId = 'global'
): ZoomRtmsEventScope => ({
  appId,
  customerId,
  operatorId,
});

const startEvent = (
  eventTs: number,
  operatorId = 'operator-id',
  streamId = 'stream-id'
): ZoomRtmsWebhookEvent => ({
  event: 'meeting.rtms_started',
  event_ts: eventTs,
  payload: {
    meeting_uuid: 'meeting-uuid',
    meeting_id: '12345678901',
    operator_id: operatorId,
    rtms_stream_id: streamId,
    server_urls: 'wss://rtms.zoom.us',
  },
});

test('routes initial and recovery start events to their respective queues', async () => {
  const store = new ZoomRtmsEventStore();
  const eventScope = scope('team-a', 'operator-id');
  await store.reserveMeeting('12345678901', 'owner-a', 60, eventScope);
  const initial = startEvent(1);

  assert.equal(await store.publish(initial), true);
  assert.equal(await store.publish(initial), false);
  assert.deepEqual(
    await store.waitForMeetingStart('12345678901', eventScope, 1),
    initial
  );

  await store.markStreamActive('stream-id', eventScope);
  const recovery = startEvent(2);
  assert.equal(await store.publish(recovery), true);
  assert.deepEqual(
    await store.waitForStreamEvent('stream-id', eventScope, 1),
    recovery
  );
});

test('releases meeting reservations only for their owner', async () => {
  const store = new ZoomRtmsEventStore();
  const eventScope = scope('team-a', 'operator-id');

  assert.equal(await store.reserveMeeting('12345678901', 'owner-a', 60, eventScope), true);
  assert.equal(await store.reserveMeeting('12345678901', 'owner-b', 60, eventScope), false);

  await store.releaseMeeting('12345678901', 'owner-b', eventScope);
  assert.equal(await store.reserveMeeting('12345678901', 'owner-b', 60, eventScope), false);

  await store.releaseMeeting('12345678901', 'owner-a', eventScope);
  assert.equal(await store.reserveMeeting('12345678901', 'owner-b', 60, eventScope), true);
});

test('isolates initial events for parallel tenants by operator and customer', async () => {
  const store = new ZoomRtmsEventStore();
  const teamA = scope('team-a', 'operator-a');
  const teamB = scope('team-b', 'operator-b');
  await store.reserveMeeting('12345678901', 'owner-a', 60, teamA);
  await store.reserveMeeting('12345678901', 'owner-b', 60, teamB);

  const eventA = startEvent(10, 'operator-a', 'stream-a');
  const eventB = startEvent(11, 'operator-b', 'stream-b');
  await store.publish(eventA);
  await store.publish(eventB);

  assert.deepEqual(
    await store.waitForMeetingStart('12345678901', teamA, 1),
    eventA
  );
  assert.deepEqual(
    await store.waitForMeetingStart('12345678901', teamB, 1),
    eventB
  );
});

test('allows only one customer reservation for the same meeting and Zoom operator', async () => {
  const store = new ZoomRtmsEventStore();
  const teamA = scope('team-a', 'shared-operator');
  const teamB = scope('team-b', 'shared-operator');

  assert.equal(await store.reserveMeeting('12345678901', 'owner-a', 60, teamA), true);
  assert.equal(await store.reserveMeeting('12345678901', 'owner-b', 60, teamB), false);

  const event = startEvent(12, 'shared-operator', 'shared-stream');
  await store.publish(event);
  assert.deepEqual(await store.waitForMeetingStart('12345678901', teamA, 1), event);
});

test('isolates identical events and reservations across dedicated apps', async () => {
  const store = new ZoomRtmsEventStore();
  const teamA = scope('team-a', 'shared-operator', 'app-a');
  const teamB = scope('team-b', 'shared-operator', 'app-b');

  assert.equal(await store.reserveMeeting('12345678901', 'owner-a', 60, teamA), true);
  assert.equal(await store.reserveMeeting('12345678901', 'owner-b', 60, teamB), true);

  const event = startEvent(13, 'shared-operator', 'shared-stream');
  assert.equal(await store.publish(event, 'app-a'), true);
  assert.equal(await store.publish(event, 'app-b'), true);
  assert.deepEqual(await store.waitForMeetingStart('12345678901', teamA, 1), event);
  assert.deepEqual(await store.waitForMeetingStart('12345678901', teamB, 1), event);
});

test('moves early stream stop events into the owning customer queue', async () => {
  const store = new ZoomRtmsEventStore();
  const eventScope = scope('team-a', 'operator-id');
  const stopped: ZoomRtmsWebhookEvent = {
    event: 'meeting.rtms_stopped',
    event_ts: 12,
    payload: {
      meeting_uuid: 'meeting-uuid',
      rtms_stream_id: 'stream-id',
      stop_reason: 6,
    },
  };

  await store.publish(stopped);
  await store.markStreamActive('stream-id', eventScope);
  assert.deepEqual(
    await store.waitForStreamEvent('stream-id', eventScope, 1),
    stopped
  );
});

test('prevents another customer from taking ownership of an active stream', async () => {
  const store = new ZoomRtmsEventStore();
  await store.markStreamActive('stream-id', scope('team-a', 'operator-a'));

  await assert.rejects(
    store.markStreamActive('stream-id', scope('team-b', 'operator-b')),
    /already owned by another customer/
  );

  await store.markStreamActive('stream-id', scope('team-b', 'operator-b', 'dedicated-app'));
});

test('keeps pending stream events isolated by app', async () => {
  const store = new ZoomRtmsEventStore();
  const teamA = scope('team-a', 'operator-id', 'app-a');
  const teamB = scope('team-b', 'operator-id', 'app-b');
  const stopped: ZoomRtmsWebhookEvent = {
    event: 'meeting.rtms_stopped',
    event_ts: 14,
    payload: {
      meeting_uuid: 'meeting-uuid',
      rtms_stream_id: 'shared-stream-id',
      stop_reason: 6,
    },
  };

  await store.publish(stopped, 'app-a');
  await store.markStreamActive('shared-stream-id', teamB);
  await store.markStreamActive('shared-stream-id', teamA);
  assert.deepEqual(
    await store.waitForStreamEvent('shared-stream-id', teamA, 1),
    stopped
  );
});
