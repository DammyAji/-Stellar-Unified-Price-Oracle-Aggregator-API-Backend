import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookService } from '../src/webhooks/webhook-service';
import { FileWebhookStore } from '../src/webhooks/file-webhook-store';
import { RedisWebhookStore, type RedisLike } from '../src/webhooks/redis-webhook-store';
import type { WebhookStore, WebhookTrigger } from '../src/webhooks/webhook-store';

const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function failAll(): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection refused'))));
}

function succeedAll(): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(ok())));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('condition not met within timeout');
}

function createFakeRedis(): RedisLike & { data: Map<string, Map<string, string>>; lists: Map<string, string[]> } {
  const data = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const hash = (key: string): Map<string, string> => {
    let existing = data.get(key);
    if (!existing) {
      existing = new Map();
      data.set(key, existing);
    }
    return existing;
  };
  return {
    data,
    lists,
    async hset(key, field, value) {
      hash(key).set(field, value);
      return 1;
    },
    async hdel(key, field) {
      return hash(key).delete(field) ? 1 : 0;
    },
    async hget(key, field) {
      return hash(key).get(field) ?? null;
    },
    async hgetall(key) {
      return Object.fromEntries(hash(key));
    },
    async rpush(key, value) {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
      return list.length;
    },
    async lrange(key, start, stop) {
      const list = lists.get(key) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(Math.max(start, 0), end);
    },
    async del(key) {
      const removed = data.delete(key) || lists.delete(key);
      return removed ? 1 : 0;
    },
    async quit() {
      return 'OK';
    },
  };
}

describe('Webhook durability, dead letters and replay (issue #601)', () => {
  let dataDir: string;
  let originalEncryptionKey: string | undefined;
  let originalPruneInterval: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhooks-'));
    process.env.WEBHOOK_DATA_DIR = dataDir;
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    originalPruneInterval = process.env.WEBHOOK_PRUNE_INTERVAL_MS;
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.WEBHOOK_PRUNE_INTERVAL_MS = '100000000000';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(ok())));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    if (originalPruneInterval === undefined) delete process.env.WEBHOOK_PRUNE_INTERVAL_MS;
    else process.env.WEBHOOK_PRUNE_INTERVAL_MS = originalPruneInterval;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('registration survives a restart', () => {
    it('reloads registrations from the shared store in a fresh process', async () => {
      const before = new WebhookService(new FileWebhookStore());
      const registered = before.register('https://hooks.example.com/price', 'key-aaa', trigger);
      await before.flush();

      const after = new WebhookService(new FileWebhookStore());
      await after.load();

      const reloaded = after.get(registered.id);
      expect(reloaded).toBeDefined();
      expect(reloaded?.url).toBe('https://hooks.example.com/price');
      expect(reloaded?.apiKeyPrefix).toBe('key-aaa');
      expect(reloaded?.trigger).toEqual(trigger);
      expect(reloaded?.secret).toBe(registered.secret);
      expect(after.list('key-aaa')).toHaveLength(1);
    });

    it('converges registration and removal across replicas sharing the store', async () => {
      const replicaA = new WebhookService(new FileWebhookStore());
      const replicaB = new WebhookService(new FileWebhookStore());
      await replicaA.load();
      await replicaB.load();

      const created = replicaA.register('https://a.example.com/hook', 'key-aaa', trigger);
      await replicaA.flush();
      await replicaB.load();
      expect(replicaB.get(created.id)).toBeDefined();

      replicaA.remove(created.id);
      await replicaA.flush();
      await replicaB.load();
      expect(replicaB.get(created.id)).toBeUndefined();
    });

    it('scopes registrations to the owning key prefix', async () => {
      const service = new WebhookService(new FileWebhookStore());
      service.register('https://mine.example.com', 'owner-1', trigger);
      service.register('https://theirs.example.com', 'owner-2', trigger);
      await service.flush();

      expect(service.list('owner-1').map((w) => w.url)).toEqual(['https://mine.example.com']);
      expect(service.list('owner-2').map((w) => w.url)).toEqual(['https://theirs.example.com']);
    });

    it('converges on its own within the propagation window without losing runtime state', async () => {
      const replicaA = new WebhookService(new FileWebhookStore());
      const replicaB = new WebhookService(new FileWebhookStore());
      await replicaA.load();
      await replicaB.load();
      replicaB.startRefresh();

      try {
        const created = replicaA.register('https://live.example.com', 'key-live', trigger);
        await replicaA.flush();
        await waitFor(() => replicaB.get(created.id) !== undefined);

        const mirrored = replicaB.get(created.id)!;
        mirrored.lastPrice = 42;
        mirrored.lastTriggeredAt = 999;
        mirrored.status = 'degraded';

        await delay(600);
        const after = replicaB.get(created.id)!;
        expect(after.lastPrice).toBe(42);
        expect(after.lastTriggeredAt).toBe(999);
        expect(after.status).toBe('degraded');

        replicaA.remove(created.id);
        await replicaA.flush();
        await waitFor(() => replicaB.get(created.id) === undefined);
      } finally {
        replicaB.stopRefresh();
      }
    });
  });

  describe('dead-letter store and replay', () => {
    it('persists a delivery that exhausts its retries and replays it exactly once', async () => {
      const service = new WebhookService(new FileWebhookStore());
      const webhook = service.register('https://hooks.example.com/failing', 'key-bbb', trigger);
      await service.flush();

      failAll();
      await service.deliver(webhook, { asset: 'XLM', price: '1000', timestamp: 1719000000 });

      const dead = await service.listDeadLetters('key-bbb');
      expect(dead).toHaveLength(1);
      expect(dead[0].webhookId).toBe(webhook.id);
      expect(dead[0].url).toBe('https://hooks.example.com/failing');
      expect(dead[0].payload).toEqual({ asset: 'XLM', price: '1000', timestamp: 1719000000 });
      expect(dead[0].attempts).toBeGreaterThanOrEqual(1);
      expect(dead[0].failure).toBeTruthy();
      expect(dead[0].resolvedAt).toBeUndefined();
      expect(webhook.status).toBe('dead-letter');

      const history = await service.deliveries(webhook.id);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history.every((d) => d.webhookId === webhook.id)).toBe(true);
      expect(history.some((d) => d.success)).toBe(false);

      const fetchMock = vi.fn(() => Promise.resolve(ok()));
      vi.stubGlobal('fetch', fetchMock);

      const first = await service.replay(dead[0].id, 'idem-1');
      expect(first.status).toBe('replayed');
      expect(first.entry?.resolvedAt).toBeGreaterThan(0);
      expect(first.entry?.replayId).toBe('idem-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const second = await service.replay(dead[0].id, 'idem-2');
      expect(second.status).toBe('duplicate');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const resolved = await service.getDeadLetter(dead[0].id);
      expect(resolved?.resolvedAt).toBeGreaterThan(0);
      expect(resolved?.replayId).toBe('idem-1');
    });

    it('leaves the entry unresolved when a replay also fails', async () => {
      const service = new WebhookService(new FileWebhookStore());
      const webhook = service.register('https://hooks.example.com/down', 'key-ccc', trigger);
      await service.flush();

      failAll();
      await service.deliver(webhook, { asset: 'XLM', price: '1' });
      const [entry] = await service.listDeadLetters('key-ccc');
      expect(entry).toBeDefined();

      const failed = await service.replay(entry.id, 'idem-retry');
      expect(failed.status).toBe('failed');
      expect(failed.failure).toBeTruthy();

      const stillOpen = await service.getDeadLetter(entry.id);
      expect(stillOpen?.resolvedAt).toBeUndefined();
    });

    it('reports missing entries and dead letters the caller does not own', async () => {
      const service = new WebhookService(new FileWebhookStore());
      expect(await service.replay('nope', 'idem')).toEqual({ status: 'missing' });

      const webhook = service.register('https://hooks.example.com/owned', 'owner-x', trigger);
      await service.flush();
      failAll();
      await service.deliver(webhook, { asset: 'XLM', price: '1' });
      const [entry] = await service.listDeadLetters('owner-x');

      expect(await service.listDeadLetters('someone-else')).toHaveLength(0);
      expect(await service.getDeadLetter(entry.id)).toBeDefined();
    });

    it('fails the replay when the webhook is no longer registered', async () => {
      const service = new WebhookService(new FileWebhookStore());
      const webhook = service.register('https://hooks.example.com/gone', 'key-ddd', trigger);
      await service.flush();
      failAll();
      await service.deliver(webhook, { asset: 'XLM', price: '1' });
      const [entry] = await service.listDeadLetters('key-ddd');

      service.remove(webhook.id);
      await service.flush();

      const result = await service.replay(entry.id, 'idem-gone');
      expect(result.status).toBe('failed');
      expect(result.failure).toContain('no longer registered');
    });
  });

  describe('durable, per-webhook delivery history', () => {
    it('keeps history partitioned per webhook', async () => {
      const service = new WebhookService(new FileWebhookStore());
      const one = service.register('https://one.example.com', 'key-1', trigger);
      const two = service.register('https://two.example.com', 'key-2', trigger);
      await service.flush();

      await service.deliver(one, { seq: 1 });
      await service.deliver(two, { seq: 2 });
      await service.deliver(one, { seq: 3 });

      const oneHistory = await service.deliveries(one.id);
      const twoHistory = await service.deliveries(two.id);
      expect(oneHistory.length).toBeGreaterThan(0);
      expect(twoHistory.length).toBeGreaterThan(0);
      expect(oneHistory.every((d) => d.webhookId === one.id)).toBe(true);
      expect(twoHistory.every((d) => d.webhookId === two.id)).toBe(true);
    });

    it('honours limit and since filters', async () => {
      const service = new WebhookService(new FileWebhookStore());
      const webhook = service.register('https://paged.example.com', 'key-page', trigger);
      await service.flush();

      await service.deliver(webhook, { seq: 1 });
      await service.deliver(webhook, { seq: 2 });
      await service.deliver(webhook, { seq: 3 });

      const limited = await service.deliveries(webhook.id, { limit: 2 });
      expect(limited).toHaveLength(2);

      const future = await service.deliveries(webhook.id, { since: Date.now() + 60_000 });
      expect(future).toHaveLength(0);
    });

    it('prunes history older than the retention window', async () => {
      const store = new FileWebhookStore();
      await store.init();
      const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
      await store.appendDelivery({
        id: 'old-entry',
        webhookId: 'w-1',
        url: 'https://old.example.com',
        attempt: 1,
        success: false,
        error: 'too old',
        timestamp: old,
      });
      await store.appendDelivery({
        id: 'new-entry',
        webhookId: 'w-1',
        url: 'https://new.example.com',
        attempt: 1,
        success: true,
        statusCode: 200,
        timestamp: Date.now(),
      });

      await store.prune();

      const remaining = await store.listDeliveries({ webhookId: 'w-1' });
      expect(remaining.map((d) => d.id)).toEqual(['new-entry']);
    });

    it('does not truncate the active history when the store is unreadable mid-write', async () => {
      const service = new WebhookService(new FileWebhookStore());
      const webhook = service.register('https://ok.example.com', 'key-ok', trigger);
      await service.flush();
      await service.deliver(webhook, { seq: 1 });

      const before = await service.deliveries(webhook.id);
      expect(before.length).toBeGreaterThan(0);

      await service.deliver(webhook, { seq: 2 });
      const after = await service.deliveries(webhook.id);
      expect(after.map((d) => d.id)).toEqual(expect.arrayContaining(before.map((d) => d.id)));
      expect(after.length).toBeGreaterThan(before.length);
    });
  });

  describe('redis-backed shared store', () => {
    it('shares registrations, history and dead letters across service instances', async () => {
      const fake = createFakeRedis();
      const storeA = new RedisWebhookStore(fake);
      const storeB = new RedisWebhookStore(fake);

      const replicaA = new WebhookService(storeA);
      const replicaB = new WebhookService(storeB);
      await replicaA.load();
      await replicaB.load();

      const webhook = replicaA.register('https://shared.example.com', 'key-redis', trigger);
      await replicaA.flush();
      await replicaB.load();
      expect(replicaB.get(webhook.id)).toBeDefined();

      failAll();
      await replicaA.deliver(webhook, { asset: 'XLM', price: '1' });
      const dead = await replicaB.listDeadLetters('key-redis');
      expect(dead).toHaveLength(1);

      succeedAll();
      const replayed = await replicaB.replay(dead[0].id, 'idem-redis');
      expect(replayed.status).toBe('replayed');
      expect(await replicaA.getDeadLetter(dead[0].id)).toMatchObject({ replayId: 'idem-redis' });

      replicaA.remove(webhook.id);
      await replicaA.flush();
      await replicaB.load();
      expect(replicaB.get(webhook.id)).toBeUndefined();
    });

    it('clears every keyspace on reset', async () => {
      const fake = createFakeRedis();
      const service = new WebhookService(new RedisWebhookStore(fake));
      const webhook = service.register('https://reset.example.com', 'key-reset', trigger);
      await service.flush();
      failAll();
      await service.deliver(webhook, { asset: 'XLM', price: '1' });
      expect(fake.data.size).toBeGreaterThan(0);

      await service.reset();

      expect(await service.list()).toEqual([]);
      expect(await service.listDeadLetters()).toEqual([]);
      expect(await service.deliveries()).toEqual([]);
    });
  });

  describe('store contract', () => {
    it('round-trips registration secrets without leaving them on disk in cleartext', async () => {
      const store: WebhookStore = new FileWebhookStore();
      await store.init();
      await store.saveRegistration({
        id: 'w-secret',
        url: 'https://secret.example.com',
        apiKeyPrefix: 'key-sec',
        trigger,
        secret: 'super-secret-value',
        verificationKey: 'verify',
        active: true,
        status: 'healthy',
        createdAt: Date.now(),
        failureCount: 0,
      });

      const raw = fs.readFileSync(path.join(dataDir, 'registrations.json'), 'utf8');
      expect(raw).not.toContain('super-secret-value');

      const [loaded] = await store.listRegistrations();
      expect(loaded.secret).toBe('super-secret-value');
    });
  });
});
