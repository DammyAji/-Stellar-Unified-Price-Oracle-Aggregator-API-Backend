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

/** Where the keys currently in the store came from. */
export type KeySource = 'env' | 'vault' | 'generated' | 'none';

/**
 * Durability of the configured key store. An ephemeral, in-process bootstrap
 * key does not make the store non-empty: `health` describes the configured
 * source, `report.ephemeral` says whether an unconfigured fallback key exists.
 */
export type KeyStoreHealth = 'empty' | 'env-seeded' | 'store-backed';

export interface KeyBootstrapReport {
  source: KeySource;
  count: number;
  health: KeyStoreHealth;
  ephemeral: boolean;
}

/** Thrown when a process that must not run without keys has no key source. */
export class MissingKeySourceError extends Error {
  readonly code = 'MISSING_KEY_SOURCE';

  constructor(message: string) {
    super(message);
    this.name = 'MissingKeySourceError';
  }
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Local development and test-only escape hatch; never set in production. */
export function allowEphemeralAdminKey(): boolean {
  return process.env.ALLOW_EPHEMERAL_ADMIN_KEY === 'true';
}

export function adminKeyPrefix(): string {
  return process.env.ADMIN_KEY_PREFIX || 'admin_';
}

export class ApiKeyManager {
  /** Keyed by SHA-256 hash of the API key — plaintext keys are never retained. */
  private keys: Map<string, ApiKeyMetadata> = new Map();
  private lastMinuteRequests: Map<string, number[]> = new Map();
  private envKeyCount = 0;
  private vaultKeyCount = 0;
  private generatedKeyCount = 0;
  private bootstrapKey: string | null = null;

  constructor() {
    this.loadKeysFromEnv();
  }

  /** One-shot retrieval of the ephemeral bootstrap key. Never logged. */
  takeBootstrapKey(): string | null {
    const key = this.bootstrapKey;
    this.bootstrapKey = null;
    return key;
  }

  getBootstrapReport(): KeyBootstrapReport {
    const source: KeySource = this.vaultKeyCount > 0
      ? 'vault'
      : this.envKeyCount > 0
        ? 'env'
        : this.generatedKeyCount > 0
          ? 'generated'
          : 'none';
    const health: KeyStoreHealth = this.vaultKeyCount > 0
      ? 'store-backed'
      : this.envKeyCount > 0
        ? 'env-seeded'
        : 'empty';
    return {
      source,
      count: this.keys.size,
      health,
      ephemeral: this.generatedKeyCount > 0,
    };
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

  /** Export all keys in Vault-compatible format for persistence.
   *  Note: plaintext keys are never stored after generation;
   *  keyPrefix is used for display/identification purposes. */
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

  /** Load keys from Vault into the in-memory store. */
  loadKeysFromVault(vaultKeys: Record<string, ApiKeyEntry>): void {
    for (const [, entry] of Object.entries(vaultKeys)) {
      const metadata: ApiKeyMetadata = {
        keyHash: entry.keyHash,
        keyPrefix: entry.keyPrefix || entry.key.substring(0, 12),
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
    }
    this.vaultKeyCount = Object.keys(vaultKeys).length;
    logger.info(`Loaded ${this.vaultKeyCount} API keys from Vault`);
  }

  hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private createKey(tier: KeyTier = 'free'): string {
    const prefix = tier === 'admin' ? adminKeyPrefix() : `sk_${tier}_`;
    return prefix + crypto.randomBytes(32).toString('hex');
  }

  private generateEphemeralAdminKey(): void {
    const adminKey = this.generateKey(TIER_RATE_LIMITS.admin, 'Ephemeral admin key (not persisted)', 'admin', 'admin');
    this.generatedKeyCount++;
    this.bootstrapKey = adminKey.key;
    logger.warn(
      `Generated an ephemeral admin key ${adminKey.keyPrefix}... (ALLOW_EPHEMERAL_ADMIN_KEY=true). ` +
      'Key material is not logged and is not persisted; retrieve it in-process with ' +
      'apiKeyManager.takeBootstrapKey(). Configure API_KEYS for a durable key — ' +
      'see docs/KEY_MANAGEMENT.md#api-key-bootstrap.',
    );
  }

  private loadKeysFromEnv(): void {
    const envKeys = process.env.API_KEYS ? decryptSecret(process.env.API_KEYS) : undefined;
    if (!envKeys || !envKeys.trim()) {
      if (this.keys.size === 0 && allowEphemeralAdminKey()) {
        this.generateEphemeralAdminKey();
      } else if (this.keys.size === 0) {
        logger.warn(
          'API_KEYS is not configured and ALLOW_EPHEMERAL_ADMIN_KEY is not set; ' +
          'the key store is empty. See docs/KEY_MANAGEMENT.md#api-key-bootstrap.',
        );
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
        }
      }

      this.envKeyCount = this.keys.size;
      logger.info(`Loaded ${this.envKeyCount} API keys from environment`);
    } catch (err) {
      logger.error('Failed to load API keys from environment', err);
    }
  }
}

export const apiKeyManager = new ApiKeyManager();

/**
 * Startup key-source check (issue #592). Reports how many keys were loaded
 * from where and refuses to start in production when no key source exists.
 * Call after the Vault load so store-backed keys are counted.
 */
export function bootstrapApiKeyStore(manager: ApiKeyManager = apiKeyManager): KeyBootstrapReport {
  const report = manager.getBootstrapReport();

  if (report.count === 0) {
    if (isProduction()) {
      throw new MissingKeySourceError(
        'No API key source configured: API_KEYS is unset or empty and the Vault key store did not ' +
        'supply any keys. Refusing to start in production. Set API_KEYS (format ' +
        '`key:rateLimit:description:tier:role`, see .env.example) or seed the Vault store. For local ' +
        'development and tests only, set ALLOW_EPHEMERAL_ADMIN_KEY=true. ' +
        'See docs/KEY_MANAGEMENT.md#api-key-bootstrap.',
      );
    }
    logger.warn(
      'API key bootstrap: source=none count=0 health=empty. No admin key exists; every admin route ' +
      'will reject requests. See docs/KEY_MANAGEMENT.md#api-key-bootstrap.',
    );
    return report;
  }

  logger.info(
    `API key bootstrap: source=${report.source} count=${report.count} health=${report.health}` +
    (report.ephemeral ? ' (ephemeral key present, not durable)' : ''),
  );
  return report;
}
