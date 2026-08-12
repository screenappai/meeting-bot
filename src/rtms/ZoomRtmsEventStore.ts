import crypto from 'crypto';
import { createClient } from 'redis';
import config from '../config';
import { normalizeZoomMeetingId } from './utils';
import { ZoomRtmsEventScope, ZoomRtmsWebhookEvent } from './types';

type RedisClient = ReturnType<typeof createClient>;
type LocalWaiter = (event: ZoomRtmsWebhookEvent | null) => void;

const PREFIX = 'meeting-bot:zoom:rtms';

export class ZoomRtmsEventStore {
  private commandClient?: RedisClient;
  private blockingClient?: RedisClient;
  private connectPromise?: Promise<void>;
  private readonly localQueues = new Map<string, ZoomRtmsWebhookEvent[]>();
  private readonly localWaiters = new Map<string, LocalWaiter[]>();
  private readonly localActiveStreams = new Map<string, string>();
  private readonly localDedupe = new Set<string>();
  private readonly localReservations = new Map<string, string>();
  private readonly localRoutes = new Map<string, Set<string>>();

  private digest(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private operatorId(scope: ZoomRtmsEventScope): string {
    return scope.operatorId || '*';
  }

  private appId(scope: ZoomRtmsEventScope): string {
    return scope.appId || 'global';
  }

  private appKeySegment(appId: string): string {
    return appId === 'global' ? '' : `:app:${this.digest(appId)}`;
  }

  private operatorRoutesKey(meetingId: string, appId: string, operatorId: string): string {
    return `${PREFIX}:meeting:${normalizeZoomMeetingId(meetingId)}${this.appKeySegment(appId)}:operator:${this.digest(operatorId)}:routes`;
  }

  private meetingQueue(
    meetingId: string,
    appId: string,
    operatorId: string,
    customerDigest: string
  ): string {
    return `${PREFIX}:meeting:${normalizeZoomMeetingId(meetingId)}${this.appKeySegment(appId)}:operator:${this.digest(operatorId)}:customer:${customerDigest}:events`;
  }

  private streamQueue(streamId: string, appId: string, customerDigest: string): string {
    return `${PREFIX}:stream:${streamId}${this.appKeySegment(appId)}:customer:${customerDigest}:events`;
  }

  private pendingStreamQueue(streamId: string, appId: string): string {
    return `${PREFIX}:stream:${streamId}${this.appKeySegment(appId)}:pending-events`;
  }

  private activeStreamKey(streamId: string, appId: string): string {
    return `${PREFIX}:stream:${streamId}${this.appKeySegment(appId)}:active`;
  }

  private reservationKey(meetingId: string, scope: ZoomRtmsEventScope): string {
    return `${PREFIX}:meeting:${normalizeZoomMeetingId(meetingId)}${this.appKeySegment(this.appId(scope))}:operator:${this.digest(this.operatorId(scope))}:owner`;
  }

  private dedupeKey(event: ZoomRtmsWebhookEvent, appId: string): string {
    const identity = [
      ...(appId === 'global' ? [] : [appId]),
      event.event,
      event.event_ts ?? '',
      event.payload.meeting_uuid,
      event.payload.rtms_stream_id,
      event.payload.server_urls ?? '',
      event.payload.stop_reason ?? '',
    ].join(':');
    const digest = crypto
      .createHash('sha256')
      .update(identity)
      .digest('hex');
    return `${PREFIX}:event:${digest}`;
  }

  private async connect(): Promise<void> {
    if (!config.isRedisEnabled) return;
    if (this.commandClient?.isReady && this.blockingClient?.isReady) return;

    if (!this.connectPromise) {
      this.commandClient = createClient({ url: config.redisUri, name: 'zoom-rtms-events' });
      this.blockingClient = createClient({ url: config.redisUri, name: 'zoom-rtms-blocking' });
      this.commandClient.on('error', (error) => console.error('Zoom RTMS Redis error', error));
      this.blockingClient.on('error', (error) => console.error('Zoom RTMS blocking Redis error', error));
      this.connectPromise = Promise.all([
        this.commandClient.connect(),
        this.blockingClient.connect(),
      ]).then(() => undefined).catch(async (error) => {
        const openClients = [this.commandClient, this.blockingClient]
          .filter((client): client is RedisClient => Boolean(client?.isOpen));
        await Promise.all(openClients.map((client) => client.disconnect()));
        this.commandClient = undefined;
        this.blockingClient = undefined;
        this.connectPromise = undefined;
        throw error;
      });
    }

    await this.connectPromise;
  }

  private getCommandClient(): RedisClient {
    if (!this.commandClient) throw new Error('Zoom RTMS Redis client is unavailable');
    return this.commandClient;
  }

  private getBlockingClient(): RedisClient {
    if (!this.blockingClient) throw new Error('Zoom RTMS blocking Redis client is unavailable');
    return this.blockingClient;
  }

  async publish(event: ZoomRtmsWebhookEvent, appId = 'global'): Promise<boolean> {
    const streamId = event.payload.rtms_stream_id;
    if (!streamId) throw new Error('RTMS webhook is missing rtms_stream_id');

    if (!config.isRedisEnabled) {
      return this.publishLocally(event, appId);
    }

    await this.connect();
    const client = this.getCommandClient();
    const ttl = config.zoomRtms.eventTtlSeconds;
    let queueKeys: string[];
    if (event.event === 'meeting.rtms_started') {
      const meetingId = normalizeZoomMeetingId(event.payload.meeting_id ?? '');
      const activeCustomer = await client.get(this.activeStreamKey(streamId, appId));
      queueKeys = activeCustomer
        ? [this.streamQueue(streamId, appId, activeCustomer)]
        : await this.meetingQueuesForStart(
          meetingId,
          String(event.payload.operator_id ?? ''),
          appId
        );
    } else {
      const activeCustomer = await client.get(this.activeStreamKey(streamId, appId));
      queueKeys = [activeCustomer
        ? this.streamQueue(streamId, appId, activeCustomer)
        : this.pendingStreamQueue(streamId, appId)];
    }

    if (queueKeys.length === 0) return true;

    const published = await client.sendCommand([
      'EVAL',
      'if redis.call("SET", KEYS[1], "1", "EX", ARGV[2], "NX") then for i = 2, #KEYS do redis.call("RPUSH", KEYS[i], ARGV[1]); redis.call("EXPIRE", KEYS[i], ARGV[2]); end; return 1; end; return 0;',
      String(queueKeys.length + 1),
      this.dedupeKey(event, appId),
      ...queueKeys,
      JSON.stringify(event),
      String(ttl),
    ]);
    return Number(published) === 1;
  }

  async waitForMeetingStart(
    meetingId: string,
    scope: ZoomRtmsEventScope,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    return this.waitFor(
      this.meetingQueue(
        meetingId,
        this.appId(scope),
        this.operatorId(scope),
        this.digest(scope.customerId)
      ),
      timeoutSeconds
    );
  }

  async waitForStreamEvent(
    streamId: string,
    scope: ZoomRtmsEventScope,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    return this.waitFor(
      this.streamQueue(streamId, this.appId(scope), this.digest(scope.customerId)),
      timeoutSeconds
    );
  }

  async markStreamActive(streamId: string, scope: ZoomRtmsEventScope): Promise<void> {
    const customerDigest = this.digest(scope.customerId);
    const appId = this.appId(scope);
    if (!config.isRedisEnabled) {
      const activeCustomer = this.localActiveStreams.get(this.activeStreamKey(streamId, appId));
      if (activeCustomer && activeCustomer !== customerDigest) {
        throw new Error('Zoom RTMS stream is already owned by another customer');
      }
      this.localActiveStreams.set(this.activeStreamKey(streamId, appId), customerDigest);
      const pendingQueue = this.pendingStreamQueue(streamId, appId);
      const targetQueue = this.streamQueue(streamId, appId, customerDigest);
      const pendingEvents = this.localQueues.get(pendingQueue) ?? [];
      this.localQueues.delete(pendingQueue);
      pendingEvents.forEach((event) => this.enqueueLocal(targetQueue, event));
      return;
    }

    await this.connect();
    const activeTtl = Math.max(
      config.zoomRtms.eventTtlSeconds,
      config.maxRecordingDuration * 60 + 600
    );
    const claimed = await this.getCommandClient().sendCommand([
      'EVAL',
      'local owner = redis.call("GET", KEYS[1]); if owner and owner ~= ARGV[1] then return -1; end; redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2]); local events = redis.call("LRANGE", KEYS[2], 0, -1); for _, event in ipairs(events) do redis.call("RPUSH", KEYS[3], event); end; if #events > 0 then redis.call("EXPIRE", KEYS[3], ARGV[3]); end; redis.call("DEL", KEYS[2]); return #events;',
      '3',
      this.activeStreamKey(streamId, appId),
      this.pendingStreamQueue(streamId, appId),
      this.streamQueue(streamId, appId, customerDigest),
      customerDigest,
      String(activeTtl),
      String(config.zoomRtms.eventTtlSeconds),
    ]);
    if (Number(claimed) === -1) {
      throw new Error('Zoom RTMS stream is already owned by another customer');
    }
  }

  async markStreamInactive(streamId: string, scope?: ZoomRtmsEventScope): Promise<void> {
    const expectedCustomer = scope ? this.digest(scope.customerId) : undefined;
    const appId = scope ? this.appId(scope) : 'global';
    if (!config.isRedisEnabled) {
      const activeStreamKey = this.activeStreamKey(streamId, appId);
      if (!expectedCustomer || this.localActiveStreams.get(activeStreamKey) === expectedCustomer) {
        this.localActiveStreams.delete(activeStreamKey);
      }
      return;
    }

    await this.connect();
    if (!expectedCustomer) {
      await this.getCommandClient().del(this.activeStreamKey(streamId, appId));
      return;
    }
    await this.getCommandClient().sendCommand([
      'EVAL',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]); end; return 0;',
      '1',
      this.activeStreamKey(streamId, appId),
      expectedCustomer,
    ]);
  }

  async reserveMeeting(
    meetingId: string,
    ownerId: string,
    ttlSeconds: number,
    scope: ZoomRtmsEventScope
  ): Promise<boolean> {
    const key = this.reservationKey(meetingId, scope);
    const routesKey = this.operatorRoutesKey(
      meetingId,
      this.appId(scope),
      this.operatorId(scope)
    );
    const customerDigest = this.digest(scope.customerId);
    if (!config.isRedisEnabled) {
      if (this.localReservations.has(key)) return false;
      this.localReservations.set(key, ownerId);
      const routes = this.localRoutes.get(routesKey) ?? new Set<string>();
      routes.add(customerDigest);
      this.localRoutes.set(routesKey, routes);
      return true;
    }

    await this.connect();
    const ttl = String(Math.max(1, Math.ceil(ttlSeconds)));
    const result = await this.getCommandClient().sendCommand([
      'EVAL',
      'if redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3], "NX") then redis.call("SADD", KEYS[2], ARGV[2]); redis.call("EXPIRE", KEYS[2], ARGV[3]); return 1; end; return 0;',
      '2',
      key,
      routesKey,
      ownerId,
      customerDigest,
      ttl,
    ]);
    return Number(result) === 1;
  }

  async releaseMeeting(
    meetingId: string,
    ownerId: string,
    scope: ZoomRtmsEventScope
  ): Promise<void> {
    const key = this.reservationKey(meetingId, scope);
    const routesKey = this.operatorRoutesKey(
      meetingId,
      this.appId(scope),
      this.operatorId(scope)
    );
    const customerDigest = this.digest(scope.customerId);
    if (!config.isRedisEnabled) {
      if (this.localReservations.get(key) === ownerId) {
        this.localReservations.delete(key);
        const routes = this.localRoutes.get(routesKey);
        routes?.delete(customerDigest);
        if (routes?.size === 0) this.localRoutes.delete(routesKey);
      }
      return;
    }

    await this.connect();
    await this.getCommandClient().sendCommand([
      'EVAL',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("DEL", KEYS[1]); redis.call("SREM", KEYS[2], ARGV[2]); if redis.call("SCARD", KEYS[2]) == 0 then redis.call("DEL", KEYS[2]); end; return 1; end; return 0;',
      '2',
      key,
      routesKey,
      ownerId,
      customerDigest,
    ]);
  }

  async close(): Promise<void> {
    const clients = [this.commandClient, this.blockingClient]
      .filter((client): client is RedisClient => Boolean(client?.isOpen));
    await Promise.all(clients.map((client) => client.quit()));
    this.commandClient = undefined;
    this.blockingClient = undefined;
    this.connectPromise = undefined;
  }

  private async waitFor(
    queueKey: string,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    if (!config.isRedisEnabled) {
      return this.waitForLocal(queueKey, timeoutSeconds);
    }

    await this.connect();
    const result = await this.getBlockingClient().blPop(
      queueKey,
      Math.max(1, Math.ceil(timeoutSeconds))
    );
    return result ? JSON.parse(result.element) as ZoomRtmsWebhookEvent : null;
  }

  private async meetingQueuesForStart(
    meetingId: string,
    operatorId: string,
    appId: string
  ): Promise<string[]> {
    const operatorIds = operatorId ? [operatorId, '*'] : ['*'];
    const customerRoutes = await Promise.all(operatorIds.map(async (routeOperatorId) => ({
      operatorId: routeOperatorId,
      customerDigests: await this.getCommandClient().sMembers(
        this.operatorRoutesKey(meetingId, appId, routeOperatorId)
      ),
    })));
    return customerRoutes.flatMap(({ operatorId: routeOperatorId, customerDigests }) =>
      customerDigests.map((customerDigest) =>
        this.meetingQueue(meetingId, appId, routeOperatorId, customerDigest)
      )
    );
  }

  private localMeetingQueuesForStart(
    meetingId: string,
    operatorId: string,
    appId: string
  ): string[] {
    const operatorIds = operatorId ? [operatorId, '*'] : ['*'];
    return operatorIds.flatMap((routeOperatorId) =>
      Array.from(
        this.localRoutes.get(this.operatorRoutesKey(meetingId, appId, routeOperatorId)) ?? []
      ).map((customerDigest) =>
        this.meetingQueue(meetingId, appId, routeOperatorId, customerDigest)
      )
    );
  }

  private publishLocally(event: ZoomRtmsWebhookEvent, appId = 'global'): boolean {
    const streamId = event.payload.rtms_stream_id;
    let queueKeys: string[];
    if (event.event === 'meeting.rtms_started') {
      const meetingId = normalizeZoomMeetingId(event.payload.meeting_id ?? '');
      const activeCustomer = this.localActiveStreams.get(this.activeStreamKey(streamId, appId));
      queueKeys = activeCustomer
        ? [this.streamQueue(streamId, appId, activeCustomer)]
        : this.localMeetingQueuesForStart(
          meetingId,
          String(event.payload.operator_id ?? ''),
          appId
        );
    } else {
      const activeCustomer = this.localActiveStreams.get(this.activeStreamKey(streamId, appId));
      queueKeys = [activeCustomer
        ? this.streamQueue(streamId, appId, activeCustomer)
        : this.pendingStreamQueue(streamId, appId)];
    }

    if (queueKeys.length === 0) return true;

    const dedupeKey = this.dedupeKey(event, appId);
    if (this.localDedupe.has(dedupeKey)) return false;
    this.localDedupe.add(dedupeKey);
    const timer = setTimeout(
      () => this.localDedupe.delete(dedupeKey),
      config.zoomRtms.eventTtlSeconds * 1000
    );
    timer.unref();

    queueKeys.forEach((queueKey) => this.enqueueLocal(queueKey, event));
    return true;
  }

  private enqueueLocal(queueKey: string, event: ZoomRtmsWebhookEvent): void {
    const waiter = this.localWaiters.get(queueKey)?.shift();
    if (waiter) {
      waiter(event);
    } else {
      const queue = this.localQueues.get(queueKey) ?? [];
      queue.push(event);
      this.localQueues.set(queueKey, queue);
    }
  }

  private waitForLocal(
    queueKey: string,
    timeoutSeconds: number
  ): Promise<ZoomRtmsWebhookEvent | null> {
    const queued = this.localQueues.get(queueKey)?.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve) => {
      const waiters = this.localWaiters.get(queueKey) ?? [];
      let settled = false;
      const finish = (event: ZoomRtmsWebhookEvent | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(event);
      };
      waiters.push(finish);
      this.localWaiters.set(queueKey, waiters);

      const timer = setTimeout(() => {
        const current = this.localWaiters.get(queueKey) ?? [];
        const index = current.indexOf(finish);
        if (index >= 0) current.splice(index, 1);
        finish(null);
      }, Math.max(1, timeoutSeconds) * 1000);
    });
  }
}

export const zoomRtmsEventStore = new ZoomRtmsEventStore();
