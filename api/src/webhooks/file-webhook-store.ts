import fs from 'fs';
import path from 'path';
import { encrypt, decryptSecret } from '../governance/crypto';
import {
  pruneIntervalMs,
  webhookDataDir,
  webhookDeliveryMaxEntries,
  webhookDeliveryRetentionMs,
  type DeliveryQuery,
  type DeadLetterEntry,
  type WebhookDeliveryLog,
  type WebhookRegistration,
  type WebhookStore,
} from './webhook-store';

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readJsonLines<T>(file: string): T[] {
  try {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Durable store backed by files under `WEBHOOK_DATA_DIR` (default `api/data/webhooks`).
 * Registration records carry the signing secret, encrypted with the same
 * `enc:v1:` envelope used everywhere else when `ENCRYPTION_KEY` is set, and are
 * written mode 0600.
 *
 * Point every replica at the same directory (a shared volume) to converge, or
 * configure `REDIS_URL` to get `RedisWebhookStore` instead.
 */
export class FileWebhookStore implements WebhookStore {
  private lastPruneAt = 0;

  private dir(): string {
    return webhookDataDir();
  }

  private registrationsPath(): string {
    return path.join(this.dir(), 'registrations.json');
  }

  private deliveriesPath(): string {
    return path.join(this.dir(), 'deliveries.jsonl');
  }

  private deadLettersPath(): string {
    return path.join(this.dir(), 'dead-letters.json');
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
  }

  private writeFileAtomic(file: string, contents: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  async saveRegistration(registration: WebhookRegistration): Promise<void> {
    const file = this.registrationsPath();
    const all = readJson<WebhookRegistration[]>(file, []);
    const record: WebhookRegistration = {
      ...registration,
      secret: encrypt(registration.secret),
    };
    const next = all.filter((w) => w.id !== registration.id);
    next.push(record);
    this.writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  async deleteRegistration(id: string): Promise<void> {
    const file = this.registrationsPath();
    const all = readJson<WebhookRegistration[]>(file, []);
    const next = all.filter((w) => w.id !== id);
    if (next.length === all.length) return;
    this.writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  async listRegistrations(): Promise<WebhookRegistration[]> {
    return readJson<WebhookRegistration[]>(this.registrationsPath(), []).map((record) => ({
      ...record,
      secret: decryptSecret(record.secret),
    }));
  }

  async appendDelivery(entry: WebhookDeliveryLog): Promise<void> {
    fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.deliveriesPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const now = Date.now();
    if (now - this.lastPruneAt >= pruneIntervalMs()) {
      this.lastPruneAt = now;
      await this.pruneDeliveries();
    }
  }

  async listDeliveries(query: DeliveryQuery = {}): Promise<WebhookDeliveryLog[]> {
    let entries = readJsonLines<WebhookDeliveryLog>(this.deliveriesPath());
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
    const file = this.deadLettersPath();
    const all = readJson<DeadLetterEntry[]>(file, []);
    all.push(entry);
    this.writeFileAtomic(file, `${JSON.stringify(all, null, 2)}\n`);
  }

  async updateDeadLetter(entry: DeadLetterEntry): Promise<void> {
    const file = this.deadLettersPath();
    const all = readJson<DeadLetterEntry[]>(file, []);
    const next = all.map((e) => (e.id === entry.id ? entry : e));
    if (next.length === all.length && all.some((e) => e.id === entry.id)) {
      this.writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
      return;
    }
    next.push(entry);
    this.writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  async listDeadLetters(apiKeyPrefix?: string): Promise<DeadLetterEntry[]> {
    const all = readJson<DeadLetterEntry[]>(this.deadLettersPath(), []);
    const filtered = apiKeyPrefix ? all.filter((e) => e.apiKeyPrefix === apiKeyPrefix) : all;
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getDeadLetter(id: string): Promise<DeadLetterEntry | undefined> {
    return readJson<DeadLetterEntry[]>(this.deadLettersPath(), []).find((e) => e.id === id);
  }

  private async pruneDeliveries(): Promise<void> {
    const file = this.deliveriesPath();
    const entries = readJsonLines<WebhookDeliveryLog>(file);
    const cutoff = Date.now() - webhookDeliveryRetentionMs();
    let kept = entries.filter((e) => e.timestamp >= cutoff);
    const max = webhookDeliveryMaxEntries();
    if (kept.length > max) kept = kept.slice(kept.length - max);
    if (kept.length === entries.length) return;
    this.writeFileAtomic(file, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
  }

  async prune(): Promise<void> {
    this.lastPruneAt = Date.now();
    await this.pruneDeliveries();
    const file = this.deadLettersPath();
    const cutoff = Date.now() - webhookDeliveryRetentionMs();
    const all = readJson<DeadLetterEntry[]>(file, []);
    const kept = all.filter((e) => e.createdAt >= cutoff);
    if (kept.length === all.length) return;
    this.writeFileAtomic(file, `${JSON.stringify(kept, null, 2)}\n`);
  }

  async clear(): Promise<void> {
    for (const file of [
      this.registrationsPath(),
      this.deliveriesPath(),
      this.deadLettersPath(),
    ]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        // best effort: a missing file already satisfies clear()
      }
    }
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
