import { encrypt, decryptSecret } from '../governance/crypto';
import {
  pruneIntervalMs,
  webhookDeliveryMaxEntries,
  webhookDeliveryRetentionMs,
  type DeliveryQuery,
  type DeadLetterEntry,
  type WebhookDeliveryLog,
  type WebhookRegistration,
  type WebhookStore,
} from './webhook-store';

/** The subset of ioredis this store uses, so tests can supply a fake. */
export interface RedisLike {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, field: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  rpush(key: string, value: string): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

const REGISTRATIONS_KEY = 'webhooks:registrations';
const DEAD_LETTERS_KEY = 'webhooks:dead-letters';
const DELIVERIES_KEY = 'webhooks:deliveries';

function parseLines(lines: string[]): WebhookDeliveryLog[] {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as WebhookDeliveryLog];
    } catch {
      return [];
    }
  });
}

/**
 * Shared store backed by Redis. Every replica reads and writes the same keys,
 * so registrations, delivery history and dead letters converge across pods;
 * the propagation window is the service's mirror refresh interval.
 */
export class RedisWebhookStore implements WebhookStore {
  private lastPruneAt = 0;

  constructor(private readonly redis: RedisLike) {}

  async init(): Promise<void> {
    // ioredis connects lazily; nothing to allocate.
  }

  async saveRegistration(registration: WebhookRegistration): Promise<void> {
    const record: WebhookRegistration = { ...registration, secret: encrypt(registration.secret) };
    await this.redis.hset(REGISTRATIONS_KEY, registration.id, JSON.stringify(record));
  }

  async deleteRegistration(id: string): Promise<void> {
    await this.redis.hdel(REGISTRATIONS_KEY, id);
  }

  async listRegistrations(): Promise<WebhookRegistration[]> {
    const all = await this.redis.hgetall(REGISTRATIONS_KEY);
    return Object.values(all)
      .flatMap((raw) => {
        try {
          return [JSON.parse(raw) as WebhookRegistration];
        } catch {
          return [];
        }
      })
      .map((record) => ({ ...record, secret: decryptSecret(record.secret) }));
  }

  async appendDelivery(entry: WebhookDeliveryLog): Promise<void> {
    await this.redis.rpush(DELIVERIES_KEY, JSON.stringify(entry));
    const now = Date.now();
    if (now - this.lastPruneAt >= pruneIntervalMs()) {
      this.lastPruneAt = now;
      await this.pruneDeliveries();
    }
  }

  async listDeliveries(query: DeliveryQuery = {}): Promise<WebhookDeliveryLog[]> {
    let entries = parseLines(await this.redis.lrange(DELIVERIES_KEY, 0, -1));
    const webhookId = query.webhookId;
    if (webhookId !== undefined) entries = entries.filter((e) => e.webhookId === webhookId);
    const since = query.since;
    if (since !== undefined) entries = entries.filter((e) => e.timestamp >= since);
    entries.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const limit = query.limit;
    if (limit !== undefined && entries.length > limit) {
      entries = entries.slice(entries.length - limit);
    }
    return entries;
  }

  async appendDeadLetter(entry: DeadLetterEntry): Promise<void> {
    await this.redis.hset(DEAD_LETTERS_KEY, entry.id, JSON.stringify(entry));
  }

  async updateDeadLetter(entry: DeadLetterEntry): Promise<void> {
    await this.redis.hset(DEAD_LETTERS_KEY, entry.id, JSON.stringify(entry));
  }

  private async readDeadLetters(): Promise<DeadLetterEntry[]> {
    const all = await this.redis.hgetall(DEAD_LETTERS_KEY);
    return Object.values(all).flatMap((raw) => {
      try {
        return [JSON.parse(raw) as DeadLetterEntry];
      } catch {
        return [];
      }
    });
  }

  async listDeadLetters(apiKeyPrefix?: string): Promise<DeadLetterEntry[]> {
    const all = await this.readDeadLetters();
    const filtered = apiKeyPrefix ? all.filter((e) => e.apiKeyPrefix === apiKeyPrefix) : all;
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getDeadLetter(id: string): Promise<DeadLetterEntry | undefined> {
    const found = await this.redis.hget(DEAD_LETTERS_KEY, id);
    if (!found) return undefined;
    try {
      return JSON.parse(found) as DeadLetterEntry;
    } catch {
      return undefined;
    }
  }

  private async pruneDeliveries(): Promise<void> {
    const entries = parseLines(await this.redis.lrange(DELIVERIES_KEY, 0, -1));
    const cutoff = Date.now() - webhookDeliveryRetentionMs();
    let kept = entries.filter((e) => e.timestamp >= cutoff);
    const max = webhookDeliveryMaxEntries();
    if (kept.length > max) kept = kept.slice(kept.length - max);
    if (kept.length === entries.length) return;
    await this.redis.del(DELIVERIES_KEY);
    for (const entry of kept) {
      await this.redis.rpush(DELIVERIES_KEY, JSON.stringify(entry));
    }
  }

  async prune(): Promise<void> {
    this.lastPruneAt = Date.now();
    await this.pruneDeliveries();
    const cutoff = Date.now() - webhookDeliveryRetentionMs();
    const all = await this.readDeadLetters();
    for (const entry of all) {
      if (entry.createdAt < cutoff) await this.redis.hdel(DEAD_LETTERS_KEY, entry.id);
    }
  }

  async clear(): Promise<void> {
    await this.redis.del(REGISTRATIONS_KEY);
    await this.redis.del(DELIVERIES_KEY);
    await this.redis.del(DEAD_LETTERS_KEY);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
