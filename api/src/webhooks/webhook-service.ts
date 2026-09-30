import crypto, { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';
import { getVaultClient } from '@stellar-oracle/vault-client';
import { FileWebhookStore } from './file-webhook-store';
import { RedisWebhookStore } from './redis-webhook-store';
import {
  webhookPropagationMs,
  type DeadLetterEntry,
  type DeliveryQuery,
  type WebhookDeliveryLog,
  type WebhookRegistration,
  type WebhookStore,
  type WebhookTrigger,
} from './webhook-store';

export type {
  DeadLetterEntry,
  WebhookDeliveryLog,
  WebhookRegistration,
  WebhookTrigger,
  WebhookTriggerType,
} from './webhook-store';

export type ReplayStatus = 'replayed' | 'duplicate' | 'missing' | 'failed' | 'in-flight';

export interface ReplayResult {
  status: ReplayStatus;
  entry?: DeadLetterEntry;
  failure?: string;
}

function createWebhookStore(): WebhookStore {
  if (config.redisUrl) {
    return new RedisWebhookStore(
      new Redis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      }),
    );
  }
  return new FileWebhookStore();
}

function backoffDelayMs(attempt: number): number {
  const delay = config.webhooks.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(delay, config.webhooks.maxDelayMs);
}

export function signWebhookPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  if (!secret || !body || !signature) return false;

  const normalized = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const expected = signWebhookPayload(secret, body);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(normalized, 'hex');

  if (expectedBuf.length !== actualBuf.length) return false;

  try {
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/**
 * Deliveries are at-least-once and ordered per webhook: a payload is retried
 * with exponential backoff until it succeeds or the retry budget is spent,
 * and only then dead-lettered. Because a crash between a successful POST and
 * the acknowledgement can replay an attempt, consumers must deduplicate on
 * `webhookId` + payload `timestamp`. Retries are sequential per webhook, so
 * two triggers for the same webhook never deliver out of order; different
 * webhooks have no ordering guarantee between them.
 *
 * Registrations, delivery history and dead letters live in a shared
 * `WebhookStore` (Redis when `REDIS_URL` is set, otherwise files under
 * `WEBHOOK_DATA_DIR`). Each replica keeps a local mirror for synchronous
 * lookups and writes through to the store, so the propagation window for a
 * registration change seen by another replica is `WEBHOOK_PROPAGATION_MS`.
 */
class WebhookService {
  private webhooks = new Map<string, WebhookRegistration>();
  private deliveryRing: WebhookDeliveryLog[] = [];
  private readonly maxRingEntries = 2000;
  private pendingWrites: Promise<unknown>[] = [];
  private replaying = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private storeWarned = false;
  private store: WebhookStore;

  constructor(store: WebhookStore = createWebhookStore()) {
    this.store = store;
  }

  /**
   * Reads registrations from the shared store into the local mirror. Called at
   * startup and after a simulated restart; a failed read leaves the mirror
   * untouched rather than dropping registrations.
   */
  async load(): Promise<void> {
    await this.flush();
    try {
      await this.store.init();
      const records = await this.store.listRegistrations();
      this.mergeIntoMirror(records);
      await this.store.prune();
      this.storeWarned = false;
      logger.info(`Loaded ${records.length} webhook registrations from the shared store`);
    } catch (err) {
      logger.warn('Webhook store unavailable at startup; registrations start empty', err);
    }
  }

  /**
   * Re-reads registrations on an interval so registration and removal converge
   * across replicas. Runtime-only fields (trigger state, health) are kept from
   * the mirror so a refresh never resets delivery pacing.
   */
  startRefresh(): void {
    if (this.refreshTimer) return;
    const interval = webhookPropagationMs();
    this.refreshTimer = setInterval(() => {
      void this.refreshFromStore();
    }, interval);
    this.refreshTimer.unref?.();
  }

  stopRefresh(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async refreshFromStore(): Promise<void> {
    try {
      await this.flush();
      const records = await this.store.listRegistrations();
      this.mergeIntoMirror(records);
      this.storeWarned = false;
    } catch (err) {
      if (!this.storeWarned) {
        this.storeWarned = true;
        logger.warn('Webhook store unreachable; registrations are not converging across replicas', err);
      }
    }
  }

  private mergeIntoMirror(records: WebhookRegistration[]): void {
    const next = new Map<string, WebhookRegistration>();
    for (const record of records) {
      const existing = this.webhooks.get(record.id);
      next.set(
        record.id,
        existing
          ? {
              ...record,
              status: existing.status,
              failureCount: existing.failureCount,
              lastFailure: existing.lastFailure,
              lastPrice: existing.lastPrice,
              lastTriggeredAt: existing.lastTriggeredAt,
            }
          : record,
      );
    }
    this.webhooks = next;
  }

  /**
   * Awaits every registration write that is still in flight, so a subsequent
   * `load()` observes them. Exposed for tests and for graceful shutdown.
   */
  async flush(): Promise<void> {
    while (this.pendingWrites.length > 0) {
      const batch = this.pendingWrites;
      this.pendingWrites = [];
      await Promise.all(batch);
    }
  }

  private persist(registration: WebhookRegistration): void {
    const write = this.store.saveRegistration(registration).catch((err: unknown) => {
      logger.warn(`Failed to persist webhook ${registration.id} to the shared store`, err);
    });
    this.pendingWrites.push(write);
  }

  register(
    url: string,
    apiKeyPrefix: string,
    trigger: WebhookTrigger,
  ): WebhookRegistration {
    const secret = randomUUID();
    const verificationKey = crypto.createHash('sha256').update(secret).digest('hex');
    const webhook: WebhookRegistration = {
      id: randomUUID(),
      url,
      apiKeyPrefix,
      trigger,
      secret,
      verificationKey,
      active: true,
      status: 'healthy',
      createdAt: Date.now(),
      failureCount: 0,
    };
    this.webhooks.set(webhook.id, webhook);
    this.persist(webhook);

    // Persist webhook secret to Vault asynchronously
    this.persistWebhookToVault(webhook).catch((err) => {
      logger.warn(`Failed to persist webhook ${webhook.id} to Vault`, err);
    });

    return webhook;
  }

  private async persistWebhookToVault(webhook: WebhookRegistration): Promise<void> {
    try {
      const vault = getVaultClient();
      if (!vault.isInitialized()) return;
      await vault.saveWebhookSecret(webhook.apiKeyPrefix, {
        webhookId: webhook.id,
        secret: webhook.secret,
        verificationKey: webhook.verificationKey,
        apiKeyPrefix: webhook.apiKeyPrefix,
        createdAt: webhook.createdAt,
      });
    } catch {
      // Vault persistence is best-effort for webhooks
    }
  }

  list(apiKeyPrefix?: string): WebhookRegistration[] {
    const all = Array.from(this.webhooks.values());
    return apiKeyPrefix ? all.filter((w) => w.apiKeyPrefix === apiKeyPrefix) : all;
  }

  get(id: string): WebhookRegistration | undefined {
    return this.webhooks.get(id);
  }

  remove(id: string): boolean {
    const webhook = this.webhooks.get(id);
    const deleted = this.webhooks.delete(id);
    if (deleted && webhook) {
      const write = this.store.deleteRegistration(id).catch((err: unknown) => {
        logger.warn(`Failed to remove webhook ${id} from the shared store`, err);
      });
      this.pendingWrites.push(write);
      this.removeWebhookFromVault(webhook).catch((err) => {
        logger.warn(`Failed to remove webhook ${id} from Vault`, err);
      });
    }
    return deleted;
  }

  private async removeWebhookFromVault(webhook: WebhookRegistration): Promise<void> {
    try {
      const vault = getVaultClient();
      if (!vault.isInitialized()) return;
      await vault.deleteWebhookSecret(webhook.apiKeyPrefix, webhook.id);
    } catch {
      // Vault cleanup is best-effort
    }
  }

  /**
   * Durable, per-webhook delivery history. Reads go to the shared store so a
   * consumer sees the full retention window, not a process-local ring; the
   * ring is only a fallback when the store is unreachable.
   */
  async deliveries(webhookId?: string, query: Omit<DeliveryQuery, 'webhookId'> = {}): Promise<WebhookDeliveryLog[]> {
    try {
      return await this.store.listDeliveries({ ...query, webhookId });
    } catch (err) {
      logger.warn('Webhook delivery store unreachable; serving in-memory history', err);
      const ring = webhookId
        ? this.deliveryRing.filter((d) => d.webhookId === webhookId)
        : [...this.deliveryRing];
      const since = query.since;
      const filtered = since === undefined ? ring : ring.filter((d) => d.timestamp >= since);
      const limit = query.limit;
      if (limit !== undefined && filtered.length > limit) {
        return filtered.slice(filtered.length - limit);
      }
      return filtered;
    }
  }

  async listDeadLetters(apiKeyPrefix?: string): Promise<DeadLetterEntry[]> {
    try {
      return await this.store.listDeadLetters(apiKeyPrefix);
    } catch (err) {
      logger.warn('Webhook dead-letter store unreachable', err);
      return [];
    }
  }

  async getDeadLetter(id: string): Promise<DeadLetterEntry | undefined> {
    try {
      return await this.store.getDeadLetter(id);
    } catch (err) {
      logger.warn('Webhook dead-letter store unreachable', err);
      return undefined;
    }
  }

  /**
   * Replays a dead-lettered payload exactly once. A successful replay resolves
   * the entry, so any later replay of the same entry — with any idempotency
   * key — returns `duplicate` without delivering again.
   */
  async replay(deadLetterId: string, idempotencyKey: string): Promise<ReplayResult> {
    const entry = await this.getDeadLetter(deadLetterId);
    if (!entry) return { status: 'missing' };
    if (entry.resolvedAt) return { status: 'duplicate', entry };
    if (this.replaying.has(deadLetterId)) return { status: 'in-flight', entry };

    const webhook = this.webhooks.get(entry.webhookId);
    if (!webhook) {
      return { status: 'failed', failure: 'Webhook is no longer registered', entry };
    }

    this.replaying.add(deadLetterId);
    try {
      const outcome = await this.sendWithRetries(webhook, entry.payload);
      if (!outcome.ok) {
        return { status: 'failed', failure: webhook.lastFailure || 'Delivery failed', entry };
      }
      const resolved: DeadLetterEntry = {
        ...entry,
        resolvedAt: Date.now(),
        replayId: idempotencyKey,
      };
      await this.store.updateDeadLetter(resolved);
      return { status: 'replayed', entry: resolved };
    } catch (err) {
      return { status: 'failed', failure: err instanceof Error ? err.message : String(err), entry };
    } finally {
      this.replaying.delete(deadLetterId);
    }
  }

  private async logDelivery(entry: WebhookDeliveryLog): Promise<void> {
    this.deliveryRing.push(entry);
    if (this.deliveryRing.length > this.maxRingEntries) this.deliveryRing.shift();
    try {
      await this.store.appendDelivery(entry);
    } catch (err) {
      logger.warn(`Failed to persist delivery ${entry.id} to the shared store`, err);
    }
  }

  /**
   * Clears all registrations and durable webhook state. Used by tests for
   * isolation and available to operators who need to wipe webhook state.
   */
  async reset(): Promise<void> {
    await this.flush();
    this.webhooks.clear();
    this.deliveryRing = [];
    this.replaying.clear();
    try {
      await this.store.clear();
    } catch (err) {
      logger.warn('Failed to clear the webhook store', err);
    }
  }

  private async sendWithRetries(
    webhook: WebhookRegistration,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; attempt: number }> {
    const body = JSON.stringify({ webhookId: webhook.id, ...payload });
    const signature = signWebhookPayload(webhook.secret, body);
    let attempt = 0;

    while (attempt < config.webhooks.maxRetries) {
      attempt += 1;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.webhooks.timeoutMs);
        const res = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Id': webhook.id,
            'X-Webhook-Signature': `sha256=${signature}`,
            'X-Webhook-Timestamp': String(Math.floor(Date.now() / 1000)),
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        await this.logDelivery({
          id: randomUUID(),
          webhookId: webhook.id,
          url: webhook.url,
          attempt,
          success: res.ok,
          statusCode: res.status,
          timestamp: Date.now(),
        });

        if (res.ok) {
          webhook.status = 'healthy';
          webhook.failureCount = 0;
          webhook.lastFailure = undefined;
          return { ok: true, attempt };
        }

        webhook.lastFailure = `HTTP ${res.status}`;
        webhook.status = 'degraded';
        webhook.failureCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        webhook.lastFailure = message;
        webhook.status = 'degraded';
        webhook.failureCount += 1;
        await this.logDelivery({
          id: randomUUID(),
          webhookId: webhook.id,
          url: webhook.url,
          attempt,
          success: false,
          error: message,
          timestamp: Date.now(),
        });
      }

      if (attempt < config.webhooks.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
      }
    }

    return { ok: false, attempt };
  }

  /**
   * Delivers a payload with exponential backoff retry. Failures are dead-
   * lettered durably and never throw, since this runs from background
   * price-update fan-out.
   */
  async deliver(webhook: WebhookRegistration, payload: Record<string, unknown>): Promise<void> {
    const outcome = await this.sendWithRetries(webhook, payload);
    if (outcome.ok) return;

    const deadLetter: DeadLetterEntry = {
      id: randomUUID(),
      webhookId: webhook.id,
      apiKeyPrefix: webhook.apiKeyPrefix,
      url: webhook.url,
      trigger: webhook.trigger,
      payload,
      attempts: outcome.attempt,
      failure: webhook.lastFailure || 'Delivery failed',
      createdAt: Date.now(),
    };
    try {
      await this.store.appendDeadLetter(deadLetter);
    } catch (err) {
      logger.error(`Failed to persist dead letter for webhook ${webhook.id}`, err);
    }

    webhook.status = 'dead-letter';
    logger.warn(
      `Webhook ${webhook.id} failed after ${outcome.attempt} attempts and was dead-lettered ` +
      `as ${deadLetter.id}`,
    );
  }

  /**
   * Called on every price update; fires threshold-triggered webhooks whose
   * percent-change condition is met, and interval-triggered webhooks whose
   * minimum delivery interval has elapsed.
   */
  async handlePriceUpdate(asset: string, price: number): Promise<void> {
    const now = Date.now();
    for (const webhook of this.webhooks.values()) {
      if (!webhook.active || webhook.trigger.asset !== asset) continue;

      if (webhook.trigger.type === 'threshold') {
        const prev = webhook.lastPrice;
        webhook.lastPrice = price;
        if (prev === undefined) continue;
        const pctChange = Math.abs((price - prev) / prev) * 100;
        if (pctChange < webhook.trigger.value) continue;
      } else {
        const minInterval = Math.max(webhook.trigger.value, config.webhooks.minIntervalMs);
        if (webhook.lastTriggeredAt && now - webhook.lastTriggeredAt < minInterval) continue;
      }

      webhook.lastTriggeredAt = now;
      void this.deliver(webhook, { asset, price, timestamp: Math.floor(now / 1000) });
    }
  }
}

export { WebhookService };
export const webhookService = new WebhookService();
