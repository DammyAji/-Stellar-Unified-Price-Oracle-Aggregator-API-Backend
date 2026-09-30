import crypto from 'crypto';
import { logger } from '../observability/logger';
import { config } from '../infrastructure/config';
import type { Role } from './rbac';
import { decryptSecret } from './crypto';
import type { ApiKeyEntry } from '@stellar-oracle/vault-client';
import {
  ApiKeyStore,
  InMemoryApiKeyStore,
  RedisApiKeyStore,
} from './api-key-store';

export type KeyTier = 'free' | 'pro' | 'enterprise' | 'admin';

export const TIER_RATE_LIMITS: Record<KeyTier, number> = {
  free: 60,
  pro: 500,
  enterprise: 10000,
  admin: 100000,
};

export interface ApiKeyMetadata {
  keyHash: string;
  /** Non-secret leading segment of the key, kept for display in admin listings */
  keyPrefix: string;
  createdAt: number;
  lastUsed: number | null;
  requestCount: number;
  isActive: boolean;
  rateLimitPerMin: number;
  tier: KeyTier;
  role: Role;
  scopes?: string[];
  description?: string;
  /** If set, this key is in rotation grace period until this timestamp */
  rotationExpiresAt?: number;
}

/** Metadata plus the plaintext key, returned only when a key is created or rotated. */
export interface GeneratedApiKey extends ApiKeyMetadata {
  key: string;
}

export interface ApiKeyStoreMap {
  [keyHash: string]: ApiKeyMetadata;
}

export function createDefaultApiKeyStore(): ApiKeyStore {
  if (config.apiKeyStore.type === 'redis' && config.redisUrl) {
    return new RedisApiKeyStore(config.redisUrl);
  }
  return new InMemoryApiKeyStore();
}

export class ApiKeyManager {
  /** Local mirror of the shared store, keyed by SHA-256 hash — plaintext is never retained. */
  private keys: Map<string, ApiKeyMetadata> = new Map();
  private lastMinuteRequests: Map<string, number[]> = new Map();
  private readonly store: ApiKeyStore;
  private pendingWrites: Promise<void> = Promise.resolve();
  private refreshTimer: NodeJS.Timeout | null = null;
  private storeHealthy = true;
  private bootstrapped = false;

  constructor(store: ApiKeyStore = createDefaultApiKeyStore()) {
    this.store = store;
    this.loadKeysFromEnv();
  }

  /**
   * Bootstrap from the shared store. The store is authoritative: if it already
   * holds keys they replace whatever this replica loaded from the environment,
   * and the environment is used only to seed an empty store. A failed load marks
   * the store unhealthy, which fails every subsequent validation closed.
   */
  async initialize(): Promise<void> {
    if (this.bootstrapped) return;
    try {
      const snapshot = await this.store.load();
      if (snapshot.length > 0) {
        this.keys = this.toLocalMap(snapshot);
        logger.info(`Loaded ${this.keys.size} API keys from the ${this.store.kind} store`);
      } else if (this.keys.size > 0) {
        await this.persistAll(Array.from(this.keys.values()));
        logger.info(`Seeded ${this.keys.size} API keys into the ${this.store.kind} store`);
      }
      this.storeHealthy = true;
      this.bootstrapped = true;
    } catch (err) {
      this.storeHealthy = false;
      logger.error(`API key store unavailable at bootstrap (${this.store.kind})`, err);
    }
  }

  /** Reconcile the local mirror with the store. Called on a timer and after writes. */
  async refresh(): Promise<void> {
    if (!this.bootstrapped) return;
    try {
      const snapshot = await this.store.load();
      this.keys = this.toLocalMap(snapshot);
      this.storeHealthy = true;
    } catch (err) {
      this.storeHealthy = false;
      logger.error(`API key store refresh failed (${this.store.kind})`, err);
    }
  }

  /** Start the background refresh loop that bounds cross-replica staleness. */
  startRefresh(intervalMs: number = config.apiKeyStore.refreshIntervalMs): void {
    if (this.refreshTimer) return;
    if (intervalMs <= 0) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Await every queued store write. */
  async flush(): Promise<void> {
    await this.pendingWrites;
  }

  get isStoreHealthy(): boolean {
    return this.storeHealthy;
  }

  get storeKind(): ApiKeyStore['kind'] {
    return this.store.kind;
  }

  generateKey(rateLimitPerMin: number = TIER_RATE_LIMITS.free, description?: string, tier: KeyTier = 'free', role: Role = 'viewer', scopes?: string[]): GeneratedApiKey {
    const key = this.createKey(tier);
    const keyHash = this.hashKey(key);
    const metadata: ApiKeyMetadata = {
      keyHash,
      keyPrefix: key.substring(0, 12),
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      isActive: true,
      rateLimitPerMin,
      tier,
      role,
      scopes: scopes && scopes.length > 0 ? [...scopes] : undefined,
      description,
    };

    this.keys.set(keyHash, metadata);
    this.persist(metadata);
    logger.info(`Generated new API key: ${metadata.keyPrefix}... tier=${tier} role=${role} limit=${rateLimitPerMin}/min`);

    return { ...metadata, key };
  }

  validateKey(key: string): { valid: boolean; metadata?: ApiKeyMetadata; error?: string } {
    if (!this.storeHealthy) {
      return { valid: false, error: 'API key store unavailable' };
    }

    const metadata = this.keys.get(this.hashKey(key));

    if (!metadata) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (!metadata.isActive) {
      return { valid: false, error: 'API key has been revoked' };
    }

    return { valid: true, metadata };
  }

  isAdminKey(key: string): boolean {
    if (!this.storeHealthy) return false;
    const metadata = this.keys.get(this.hashKey(key));
    return !!metadata && metadata.role === 'admin';
  }

  checkRateLimit(key: string): { allowed: boolean; remaining: number; resetTime: number; retryAfter?: number } {
    if (!this.storeHealthy) {
      return { allowed: false, remaining: 0, resetTime: 0 };
    }

    const keyHash = this.hashKey(key);
    const metadata = this.keys.get(keyHash);
    if (!metadata) {
      return { allowed: false, remaining: 0, resetTime: 0 };
    }

    const now = Date.now();
    const windowMs = 60000;
    const oneMinuteAgo = now - windowMs;

    let requests = this.lastMinuteRequests.get(keyHash) || [];
    requests = requests.filter((ts) => ts > oneMinuteAgo);

    if (requests.length >= metadata.rateLimitPerMin) {
      const oldestRequest = Math.min(...requests);
      const resetTime = oldestRequest + windowMs;
      const retryAfter = Math.ceil((resetTime - now) / 1000);

      return { allowed: false, remaining: 0, resetTime, retryAfter };
    }

    requests.push(now);
    this.lastMinuteRequests.set(keyHash, requests);

    metadata.lastUsed = now;
    metadata.requestCount++;

    const remaining = metadata.rateLimitPerMin - requests.length;
    return { allowed: true, remaining, resetTime: now + windowMs };
  }

  rotateKey(oldKeyHash: string): GeneratedApiKey | null {
    const metadata = this.keys.get(oldKeyHash);
    if (!metadata) return null;

    const newKey = this.createKey(metadata.tier);
    const newHash = this.hashKey(newKey);
    const newMetadata: ApiKeyMetadata = {
      ...metadata,
      keyHash: newHash,
      keyPrefix: newKey.substring(0, 12),
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      scopes: metadata.scopes ? [...metadata.scopes] : undefined,
    };

    this.keys.delete(oldKeyHash);
    this.lastMinuteRequests.delete(oldKeyHash);
    this.keys.set(newHash, newMetadata);
    this.enqueue(async () => {
      await this.store.remove(oldKeyHash);
      await this.store.put(newMetadata);
    });
    logger.info(`Rotated API key: old=${metadata.keyPrefix}... new=${newMetadata.keyPrefix}...`);

    return { ...newMetadata, key: newKey };
  }

  revokeKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.isActive = false;
    this.persist(metadata);
    logger.info(`Revoked API key: ${metadata.keyPrefix}...`);
    return true;
  }

  deactivateKey(keyHash: string): boolean {
    return this.revokeKey(keyHash);
  }

  reactivateKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.isActive = true;
    this.persist(metadata);
    logger.info(`Reactivated API key: ${metadata.keyPrefix}...`);
    return true;
  }

  getKeyMetadata(keyHash: string): ApiKeyMetadata | null {
    return this.keys.get(keyHash) || null;
  }

  getAllKeys(): Array<{ keyPrefix: string; keyHash: string; createdAt: number; lastUsed: number | null; requestCount: number; isActive: boolean; rateLimitPerMin: number; tier: KeyTier; role: Role; scopes?: string[]; description?: string }> {
    // The non-secret display prefix is returned as-is (no ellipsis suffix) so
    // consumers can match keys by prefix without string munging.
    return Array.from(this.keys.values()).map((m) => ({
      keyPrefix: m.keyPrefix,
      keyHash: m.keyHash,
      createdAt: m.createdAt,
      lastUsed: m.lastUsed,
      requestCount: m.requestCount,
      isActive: m.isActive,
      rateLimitPerMin: m.rateLimitPerMin,
      tier: m.tier,
      role: m.role,
      scopes: m.scopes,
      description: m.description,
    }));
  }

  findByHash(hash: string): ApiKeyMetadata | null {
    return this.keys.get(hash) || null;
  }

  updateRateLimit(keyHash: string, newLimit: number): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.rateLimitPerMin = newLimit;
    this.persist(metadata);
    logger.info(`Updated rate limit for ${metadata.keyPrefix}... to ${newLimit}/min`);
    return true;
  }

  updateTier(keyHash: string, tier: KeyTier): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.tier = tier;
    metadata.rateLimitPerMin = TIER_RATE_LIMITS[tier];
    this.persist(metadata);
    logger.info(`Updated tier for ${metadata.keyPrefix}... to ${tier} (${TIER_RATE_LIMITS[tier]}/min)`);
    return true;
  }

  deleteKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    const result = this.keys.delete(keyHash);
    if (result) {
      this.lastMinuteRequests.delete(keyHash);
      this.enqueue(() => this.store.remove(keyHash));
      logger.info(`Deleted API key: ${metadata!.keyPrefix}...`);
    }
    return result;
  }

  /** Export all keys in Vault-compatible format for persistence.
   *
   *  The plaintext key is never retained, so `key` is always `''`. Validation
   *  hashes the presented key and looks it up by `keyHash`, which is the
   *  authoritative field — a round trip through export -> import restores a
   *  fully validatable key without ever persisting the secret. */
  exportKeysForVault(): Record<string, ApiKeyEntry> {
    const result: Record<string, ApiKeyEntry> = {};
    for (const [hash, meta] of this.keys) {
      result[hash] = {
        keyHash: meta.keyHash,
        keyPrefix: meta.keyPrefix,
        key: '',
        tier: meta.tier,
        role: meta.role,
        scopes: meta.scopes,
        rateLimitPerMin: meta.rateLimitPerMin,
        description: meta.description,
        createdAt: meta.createdAt,
        isActive: meta.isActive,
      };
    }
    return result;
  }

  /** Load keys from Vault into the local mirror and write them through to the store. */
  loadKeysFromVault(vaultKeys: Record<string, ApiKeyEntry>): void {
    const imported: ApiKeyMetadata[] = [];
    for (const [, entry] of Object.entries(vaultKeys)) {
      const metadata: ApiKeyMetadata = {
        keyHash: entry.keyHash,
        keyPrefix: entry.keyPrefix || (entry.key ? entry.key.substring(0, 12) : entry.keyHash.substring(0, 12)),
        createdAt: entry.createdAt,
        lastUsed: null,
        requestCount: 0,
        isActive: entry.isActive,
        rateLimitPerMin: entry.rateLimitPerMin,
        tier: entry.tier as KeyTier,
        role: entry.role as Role,
        scopes: Array.isArray(entry.scopes) ? [...entry.scopes] : undefined,
        description: entry.description,
      };
      this.keys.set(entry.keyHash, metadata);
      imported.push(metadata);
    }
    this.persistAll(imported);
    logger.info(`Loaded ${Object.keys(vaultKeys).length} API keys from Vault`);
  }

  hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private createKey(tier: KeyTier = 'free'): string {
    const prefix = tier === 'admin' ? 'sk_admin_' : `sk_${tier}_`;
    return prefix + crypto.randomBytes(32).toString('hex');
  }

  private toLocalMap(snapshot: ApiKeyMetadata[]): Map<string, ApiKeyMetadata> {
    const next = new Map<string, ApiKeyMetadata>();
    for (const entry of snapshot) {
      const local = this.keys.get(entry.keyHash);
      // lastUsed/requestCount are per-replica activity counters, not shared
      // state: the locally observed value is the more accurate one.
      const counters = local
        ? { lastUsed: local.lastUsed, requestCount: local.requestCount }
        : { lastUsed: entry.lastUsed, requestCount: entry.requestCount };
      next.set(entry.keyHash, { ...entry, ...counters });
    }
    return next;
  }

  private persist(entry: ApiKeyMetadata): void {
    this.enqueue(() => this.store.put(entry));
  }

  private persistAll(entries: ApiKeyMetadata[]): void {
    if (entries.length === 0) return;
    this.enqueue(async () => {
      for (const entry of entries) {
        await this.store.put(entry);
      }
    });
  }

  private enqueue(write: () => Promise<void>): void {
    this.pendingWrites = this.pendingWrites.then(write).catch((err) => {
      this.storeHealthy = false;
      logger.error(`API key store write failed (${this.store.kind})`, err);
    });
  }

  private loadKeysFromEnv(): void {
    const envKeys = process.env.API_KEYS ? decryptSecret(process.env.API_KEYS) : undefined;
    if (!envKeys) {
      if (this.keys.size === 0) {
        const adminKey = this.generateKey(TIER_RATE_LIMITS.admin, 'Default admin key', 'admin', 'admin');
        logger.info(`Generated default admin key: ${adminKey.key}`);
        logger.info('Store this key securely. It will not be shown again.');
      }
      return;
    }

    try {
      // Format: key1:limit1:desc1:tier1:role1,key2:...
      for (const spec of envKeys.split(',')) {
        const parts = spec.trim().split(':');
        if (parts.length >= 1 && parts[0]) {
          const key = parts[0];
          const limit = parseInt(parts[1], 10);
          const description = parts[2] || undefined;
          const tier = (parts[3] as KeyTier) || 'free';
          const role = (parts[4] as Role) || 'viewer';

          const keyHash = this.hashKey(key);
          const metadata: ApiKeyMetadata = {
            keyHash,
            keyPrefix: key.substring(0, 12),
            createdAt: Date.now(),
            lastUsed: null,
            requestCount: 0,
            isActive: true,
            rateLimitPerMin: isNaN(limit) ? TIER_RATE_LIMITS[tier] : limit,
            tier,
            role,
            description,
          };

          this.keys.set(keyHash, metadata);
        }
      }

      logger.info(`Loaded ${this.keys.size} API keys from environment`);
    } catch (err) {
      logger.error('Failed to load API keys from environment', err);
    }
  }
}

export const apiKeyManager = new ApiKeyManager();
