import path from 'path';

export type WebhookTriggerType = 'threshold' | 'interval';

export interface WebhookTrigger {
  type: WebhookTriggerType;
  asset: string;
  // threshold: percent change that fires delivery; interval: ms between deliveries.
  value: number;
}

export interface WebhookRegistration {
  id: string;
  url: string;
  apiKeyPrefix: string;
  trigger: WebhookTrigger;
  secret: string;
  verificationKey: string;
  active: boolean;
  status: 'healthy' | 'degraded' | 'dead-letter';
  createdAt: number;
  lastTriggeredAt?: number;
  lastPrice?: number;
  lastFailure?: string;
  failureCount: number;
}

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  url: string;
  attempt: number;
  success: boolean;
  statusCode?: number;
  error?: string;
  timestamp: number;
}

/**
 * A delivery that exhausted its retries. `resolvedAt` is set once a replay has
 * succeeded; an entry can be replayed successfully at most once.
 */
export interface DeadLetterEntry {
  id: string;
  webhookId: string;
  apiKeyPrefix: string;
  url: string;
  trigger: WebhookTrigger;
  payload: Record<string, unknown>;
  attempts: number;
  failure: string;
  createdAt: number;
  resolvedAt?: number;
  replayId?: string;
}

export interface DeliveryQuery {
  webhookId?: string;
  limit?: number;
  since?: number;
}

/**
 * Durable backing store for registrations, delivery history and dead letters.
 * Reads and writes are whole-record so any implementation can be shared by
 * every replica; the service keeps a local mirror for synchronous lookups.
 */
export interface WebhookStore {
  init(): Promise<void>;
  saveRegistration(registration: WebhookRegistration): Promise<void>;
  deleteRegistration(id: string): Promise<void>;
  listRegistrations(): Promise<WebhookRegistration[]>;
  appendDelivery(entry: WebhookDeliveryLog): Promise<void>;
  listDeliveries(query?: DeliveryQuery): Promise<WebhookDeliveryLog[]>;
  appendDeadLetter(entry: DeadLetterEntry): Promise<void>;
  updateDeadLetter(entry: DeadLetterEntry): Promise<void>;
  listDeadLetters(apiKeyPrefix?: string): Promise<DeadLetterEntry[]>;
  getDeadLetter(id: string): Promise<DeadLetterEntry | undefined>;
  prune(): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export function webhookDataDir(): string {
  const configured = process.env.WEBHOOK_DATA_DIR;
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, '../../data/webhooks');
}

export function webhookDeliveryRetentionMs(): number {
  const days = parseInt(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS || '30', 10);
  return Math.max(days, 0) * 24 * 60 * 60 * 1000;
}

export function webhookDeliveryMaxEntries(): number {
  return Math.max(parseInt(process.env.WEBHOOK_DELIVERY_MAX_ENTRIES || '20000', 10), 1);
}

export function webhookPropagationMs(): number {
  return Math.max(parseInt(process.env.WEBHOOK_PROPAGATION_MS || '5000', 10), 100);
}

export function pruneIntervalMs(): number {
  return Math.max(parseInt(process.env.WEBHOOK_PRUNE_INTERVAL_MS || '60000', 10), 0);
}
