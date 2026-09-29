import crypto from 'crypto';
import { logger } from '../observability/logger';
import type { Role } from './rbac';
import { decryptSecret } from './crypto';
import type { ApiKeyEntry } from '@stellar-oracle/vault-client';

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

export interface ApiKeyStore {
  [keyHash: string]: ApiKeyMetadata;
}

/** Durable backing store for API keys (Vault KV at `secret/data/api/keys` in production). */
export interface KeyStore {
  load(): Promise<Record<string, ApiKeyEntry> | null>;
  save(entries: Record<string, ApiKeyEntry>): Promise<void>;
}

/** Same display prefix present in both the environment seed and the key store, with different key hashes. */
export interface KeyConflict {
  keyPrefix: string;
  envHash: string;
  storeHash: string;
}

export interface KeyStoreBootReport {
  loaded: number;
  seeded: number;
  conflicts: KeyConflict[];
}

export type KeyStoreRefreshResult = 'refreshed' | 'empty' | 'failed';

/** A mutation was rolled back because the key store write failed (or was unavailable). */
export class KeyStoreWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeyStoreWriteError';
  }
}

function canonicalKeyJson(entries: Record<string, ApiKeyEntry>): string {
  return JSON.stringify(Object.keys(entries).sort().map((hash) => [hash, entries[hash]]));
}

export class ApiKeyManager {
  /** Keyed by SHA-256 hash of the API key — plaintext keys are never retained. */
  private keys: Map<string, ApiKeyMetadata> = new Map();
  private lastMinuteRequests: Map<string, number[]> = new Map();
  private store: KeyStore | null = null;
  private envKeyHashes = new Set<string>();
  private lastSyncedJson = '';

  constructor() {
    this.loadKeysFromEnv();
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
    logger.info(`Generated new API key: ${metadata.keyPrefix}... tier=${tier} role=${role} limit=${rateLimitPerMin}/min`);

    return { ...metadata, key };
  }

  validateKey(key: string): { valid: boolean; metadata?: ApiKeyMetadata; error?: string } {
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
    const metadata = this.keys.get(this.hashKey(key));
    return !!metadata && metadata.role === 'admin';
  }

  checkRateLimit(key: string): { allowed: boolean; remaining: number; resetTime: number; retryAfter?: number } {
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
    logger.info(`Rotated API key: old=${metadata.keyPrefix}... new=${newMetadata.keyPrefix}...`);

    return { ...newMetadata, key: newKey };
  }

  revokeKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.isActive = false;
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
    logger.info(`Updated rate limit for ${metadata.keyPrefix}... to ${newLimit}/min`);
    return true;
  }

  updateTier(keyHash: string, tier: KeyTier): boolean {
    const metadata = this.keys.get(keyHash);
    if (!metadata) return false;

    metadata.tier = tier;
    metadata.rateLimitPerMin = TIER_RATE_LIMITS[tier];
    logger.info(`Updated tier for ${metadata.keyPrefix}... to ${tier} (${TIER_RATE_LIMITS[tier]}/min)`);
    return true;
  }

  deleteKey(keyHash: string): boolean {
    const metadata = this.keys.get(keyHash);
    const result = this.keys.delete(keyHash);
    if (result) {
      this.lastMinuteRequests.delete(keyHash);
      logger.info(`Deleted API key: ${metadata!.keyPrefix}...`);
    }
    return result;
  }

  setStore(store: KeyStore | null): void {
    this.store = store;
  }

  hasStore(): boolean {
    return this.store !== null;
  }

  /** Deep copy of the in-memory key map, used to roll back failed transactions. */
  snapshot(): Record<string, ApiKeyMetadata> {
    return structuredClone(Object.fromEntries(this.keys));
  }

  restore(snapshot: Record<string, ApiKeyMetadata>): void {
    this.keys = new Map(Object.entries(snapshot));
  }

  /** Write memory to the store. No-op without a store; throws when the store rejects the write. */
  async syncToStore(): Promise<void> {
    if (!this.store) return;
    const entries = this.exportKeysForVault();
    const serialized = canonicalKeyJson(entries);
    if (serialized === this.lastSyncedJson) return;
    await this.store.save(entries);
    this.lastSyncedJson = serialized;
  }

  /**
   * Boot sequence: load the store, report environment-seed conflicts, merge,
   * drop runtime-only keys once the store is authoritative, and seed anything
   * the store is missing. Throws when the store cannot be read.
   */
  async hydrate(): Promise<KeyStoreBootReport> {
    if (!this.store) return { loaded: 0, seeded: 0, conflicts: [] };
    const storeKeys = (await this.store.load()) ?? {};
    const loaded = Object.keys(storeKeys).length;
    let conflicts: KeyConflict[] = [];
    if (loaded > 0) {
      conflicts = this.compareWithStore(storeKeys);
      for (const conflict of conflicts) {
        logger.warn(
          `API key store conflict for prefix ${conflict.keyPrefix}: environment seed ${conflict.envHash.substring(0, 12)} vs store ${conflict.storeHash.substring(0, 12)} — both retained, not silently preferring one`,
        );
      }
      this.loadKeysFromVault(storeKeys);
      for (const hash of [...this.keys.keys()]) {
        if (!storeKeys[hash] && !this.envKeyHashes.has(hash)) {
          const orphan = this.keys.get(hash)!;
          this.keys.delete(hash);
          logger.warn(
            `Dropped runtime-generated API key ${orphan.keyPrefix}... — it is not in the key store; seed keys via API_KEYS or create them through the admin API so they persist`,
          );
        }
      }
    }
    const missing =
      loaded > 0
        ? [...this.envKeyHashes].filter((hash) => !storeKeys[hash])
        : [...this.keys.keys()];
    if (missing.length > 0) {
      await this.syncToStore();
      logger.info(`Seeded ${missing.length} API key(s) into the key store`);
    }
    return { loaded, seeded: missing.length, conflicts };
  }

  /** Compare environment-seeded keys against the store: same prefix with a different hash is a conflict. */
  compareWithStore(storeKeys: Record<string, ApiKeyEntry>): KeyConflict[] {
    const conflicts: KeyConflict[] = [];
    for (const [hash, entry] of Object.entries(storeKeys)) {
      if (!entry || typeof entry.keyHash !== 'string' || this.envKeyHashes.has(hash)) continue;
      const envPeer = Array.from(this.envKeyHashes)
        .map((envHash) => this.keys.get(envHash))
        .find((meta) => meta !== undefined && meta.keyPrefix === entry.keyPrefix);
      if (envPeer && envPeer.keyHash !== entry.keyHash) {
        conflicts.push({ keyPrefix: entry.keyPrefix, envHash: envPeer.keyHash, storeHash: entry.keyHash });
      }
    }
    return conflicts;
  }

  /**
   * Replace in-memory state with the store's contents (replica refresh).
   * Never wipes memory on an empty store; in-flight usage counters survive.
   */
  async refreshFromStore(): Promise<KeyStoreRefreshResult> {
    if (!this.store) return 'empty';
    let storeKeys: Record<string, ApiKeyEntry> | null;
    try {
      storeKeys = await this.store.load();
    } catch (err) {
      logger.warn('API key store refresh failed; keeping in-memory keys', err);
      return 'failed';
    }
    if (!storeKeys || Object.keys(storeKeys).length === 0) return 'empty';
    const previous = this.keys;
    const next = new Map<string, ApiKeyMetadata>();
    for (const entry of Object.values(storeKeys)) {
      if (!entry || typeof entry.keyHash !== 'string' || entry.keyHash.length === 0) continue;
      const metadata = this.metadataFromEntry(entry);
      const prior = previous.get(entry.keyHash);
      if (prior) {
        metadata.lastUsed = prior.lastUsed;
        metadata.requestCount = prior.requestCount;
      }
      next.set(entry.keyHash, metadata);
    }
    if (next.size === 0) return 'empty';
    this.keys = next;
    this.lastSyncedJson = canonicalKeyJson(this.exportKeysForVault());
    return 'refreshed';
  }

  /**
   * Run a mutation against the authoritative store: refresh first, mutate,
   * then persist before returning. A failed refresh aborts the mutation; a
   * failed write rolls the mutation back and throws KeyStoreWriteError.
   */
  async transact<T>(mutate: () => T): Promise<T> {
    if (this.store) {
      const refreshed = await this.refreshFromStore();
      if (refreshed === 'failed') {
        throw new KeyStoreWriteError('API key store unavailable; mutation was not applied');
      }
    }
    const before = this.snapshot();
    const result = mutate();
    try {
      await this.syncToStore();
    } catch (err) {
      this.restore(before);
      throw new KeyStoreWriteError(
        `API key store write failed; mutation rolled back: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    return result;
  }

  /** Export all keys in Vault-compatible format for persistence.
   *  Contract: only the SHA-256 hash of the key material and its metadata are
   *  stored — the plaintext key is never written (`key` is blank). On restore,
   *  validation works by hashing the presented key and matching it against
   *  `keyHash`; the plaintext itself cannot be reconstructed from the store. */
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

  /** Load keys from Vault into the in-memory store. Returns how many entries were accepted. */
  loadKeysFromVault(vaultKeys: Record<string, ApiKeyEntry>): number {
    let loaded = 0;
    for (const entry of Object.values(vaultKeys)) {
      if (!entry || typeof entry.keyHash !== 'string' || entry.keyHash.length === 0) {
        logger.warn('Skipping malformed API key entry in store (missing keyHash)');
        continue;
      }
      this.keys.set(entry.keyHash, this.metadataFromEntry(entry));
      loaded += 1;
    }
    logger.info(`Loaded ${loaded} API keys from Vault`);
    return loaded;
  }

  private metadataFromEntry(entry: ApiKeyEntry): ApiKeyMetadata {
    const keyPrefix =
      entry.keyPrefix ||
      (entry.key && entry.key.length >= 12 ? entry.key.substring(0, 12) : entry.keyHash.substring(0, 12));
    return {
      keyHash: entry.keyHash,
      keyPrefix,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      lastUsed: null,
      requestCount: 0,
      isActive: entry.isActive !== false,
      rateLimitPerMin: typeof entry.rateLimitPerMin === 'number' ? entry.rateLimitPerMin : TIER_RATE_LIMITS.free,
      tier: (entry.tier as KeyTier) || 'free',
      role: (entry.role as Role) || 'viewer',
      scopes: Array.isArray(entry.scopes) ? [...entry.scopes] : undefined,
      description: entry.description,
    };
  }

  hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private createKey(tier: KeyTier = 'free'): string {
    const prefix = tier === 'admin' ? 'sk_admin_' : `sk_${tier}_`;
    return prefix + crypto.randomBytes(32).toString('hex');
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
      for (const config of envKeys.split(',')) {
        const parts = config.trim().split(':');
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
          this.envKeyHashes.add(keyHash);
        }
      }

      logger.info(`Loaded ${this.keys.size} API keys from environment`);
    } catch (err) {
      logger.error('Failed to load API keys from environment', err);
    }
  }
}

export const apiKeyManager = new ApiKeyManager();
