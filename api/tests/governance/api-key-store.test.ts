import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiKeyManager, TIER_RATE_LIMITS } from '../../src/governance/api-key-manager';
import {
  ApiKeyStore,
  InMemoryApiKeyStore,
  RedisApiKeyStore,
  RedisLikeClient,
} from '../../src/governance/api-key-store';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeRedis implements RedisLikeClient {
  readonly hashes = new Map<string, Map<string, string>>();
  failing = false;

  async hgetall(key: string): Promise<Record<string, string>> {
    if (this.failing) throw new Error('connection refused');
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    if (this.failing) throw new Error('connection refused');
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
    return 1;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    if (this.failing) throw new Error('connection refused');
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) removed += hash.delete(field) ? 1 : 0;
    return removed;
  }
}

function brokenStore(): ApiKeyStore {
  return {
    kind: 'memory',
    load: async () => {
      throw new Error('store unreachable');
    },
    put: async () => undefined,
    remove: async () => undefined,
  };
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.API_KEYS;
});

afterEach(() => {
  process.env = originalEnv;
});

// ---------------------------------------------------------------------------
// 1. Multi-replica propagation (issue #591, acceptance criteria)
// ---------------------------------------------------------------------------

describe('ApiKeyManager - shared store propagation', () => {
  it('a key created on one replica validates on another replica sharing the store', async () => {
    const store = new InMemoryApiKeyStore();
    const a = new ApiKeyManager(store);
    const b = new ApiKeyManager(store);
    await a.initialize();
    await b.initialize();
    await a.flush();

    const created = a.generateKey(100, 'created-on-a', 'pro', 'editor');
    await a.flush();
    await b.refresh();

    expect(b.validateKey(created.key).valid).toBe(true);
    expect(b.findByHash(created.keyHash)?.description).toBe('created-on-a');
    expect(b.findByHash(created.keyHash)?.rateLimitPerMin).toBe(100);
    expect(b.findByHash(created.keyHash)?.tier).toBe('pro');
    expect(b.findByHash(created.keyHash)?.role).toBe('editor');
  });

  it('a revocation on one replica is rejected on another within one refresh', async () => {
    const store = new InMemoryApiKeyStore();
    const a = new ApiKeyManager(store);
    const b = new ApiKeyManager(store);
    await a.initialize();
    await b.initialize();

    const { key, keyHash } = a.generateKey(100, 'to-revoke', 'free');
    await a.flush();
    await b.refresh();
    expect(b.validateKey(key).valid).toBe(true);

    a.revokeKey(keyHash);
    await a.flush();
    await b.refresh();

    expect(b.validateKey(key).valid).toBe(false);
    expect(b.validateKey(key).error).toBe('API key has been revoked');
  });

  it('reactivation, rotation and deletion all propagate to the other replica', async () => {
    const store = new InMemoryApiKeyStore();
    const a = new ApiKeyManager(store);
    const b = new ApiKeyManager(store);
    await a.initialize();
    await b.initialize();

    const { key, keyHash } = a.generateKey(100, 'lifecycle', 'enterprise', 'operator');
    await a.flush();
    await b.refresh();

    a.revokeKey(keyHash);
    await a.flush();
    await b.refresh();
    expect(b.validateKey(key).valid).toBe(false);

    a.reactivateKey(keyHash);
    await a.flush();
    await b.refresh();
    expect(b.validateKey(key).valid).toBe(true);

    const rotated = a.rotateKey(keyHash)!;
    await a.flush();
    await b.refresh();
    expect(b.validateKey(key).valid).toBe(false);
    expect(b.findByHash(keyHash)).toBeNull();
    expect(b.validateKey(rotated.key).valid).toBe(true);

    a.deleteKey(rotated.keyHash);
    await a.flush();
    await b.refresh();
    expect(b.validateKey(rotated.key).valid).toBe(false);
    expect(b.findByHash(rotated.keyHash)).toBeNull();
  });

  it('tier and rate-limit updates propagate', async () => {
    const store = new InMemoryApiKeyStore();
    const a = new ApiKeyManager(store);
    const b = new ApiKeyManager(store);
    await a.initialize();
    await b.initialize();

    const { keyHash } = a.generateKey(TIER_RATE_LIMITS.free, 'tiered', 'free');
    await a.flush();
    await b.refresh();

    a.updateTier(keyHash, 'enterprise');
    a.updateRateLimit(keyHash, 4242);
    await a.flush();
    await b.refresh();

    expect(b.findByHash(keyHash)?.tier).toBe('enterprise');
    expect(b.findByHash(keyHash)?.rateLimitPerMin).toBe(4242);
  });

  it('stays stale until refresh, then converges — the documented staleness window', async () => {
    const store = new InMemoryApiKeyStore();
    const a = new ApiKeyManager(store);
    const b = new ApiKeyManager(store);
    await a.initialize();
    await b.initialize();

    const { key, keyHash } = a.generateKey(100, 'stale-window', 'free');
    await a.flush();
    await b.refresh();

    a.revokeKey(keyHash);
    await a.flush();

    expect(b.validateKey(key).valid).toBe(true);
    await b.refresh();
    expect(b.validateKey(key).valid).toBe(false);
  });

  it('background refresh propagates without an explicit refresh() call', async () => {
    const store = new InMemoryApiKeyStore();
    const a = new ApiKeyManager(store);
    const b = new ApiKeyManager(store);
    await a.initialize();
    await b.initialize();

    const { key, keyHash } = a.generateKey(100, 'timer', 'free');
    await a.flush();
    await b.refresh();

    b.startRefresh(20);
    try {
      a.revokeKey(keyHash);
      await a.flush();
      expect(b.validateKey(key).valid).toBe(true);
      await sleep(150);
      expect(b.validateKey(key).valid).toBe(false);
    } finally {
      b.stopRefresh();
    }
  });

  it('two replicas over the same Redis hash propagate creates and revokes', async () => {
    const redis = new FakeRedis();
    const store = new RedisApiKeyStore(redis);
    const a = new ApiKeyManager(store);
    const b = new ApiKeyManager(new RedisApiKeyStore(redis));
    await a.initialize();
    await b.initialize();

    const { key, keyHash } = a.generateKey(100, 'on-redis', 'pro');
    await a.flush();
    await b.refresh();
    expect(b.validateKey(key).valid).toBe(true);

    a.revokeKey(keyHash);
    await a.flush();
    await b.refresh();
    expect(b.validateKey(key).valid).toBe(false);

    a.deleteKey(keyHash);
    await a.flush();
    await b.refresh();
    expect(b.findByHash(keyHash)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Bootstrap semantics
// ---------------------------------------------------------------------------

describe('ApiKeyManager - bootstrap', () => {
  it('seeds the store from the environment only when the store is empty', async () => {
    const store = new InMemoryApiKeyStore();
    process.env.API_KEYS = 'sk_free_first:100:first:free:viewer';
    const first = new ApiKeyManager(store);
    await first.initialize();
    await first.flush();
    expect(store.size).toBe(1);

    process.env.API_KEYS = 'sk_free_second:200:second:free:viewer';
    const second = new ApiKeyManager(store);
    await second.initialize();

    expect(second.validateKey('sk_free_first').valid).toBe(true);
    expect(second.validateKey('sk_free_second').valid).toBe(false);
    expect(second.getAllKeys().some((k) => k.description === 'second')).toBe(false);
    expect(second.getAllKeys().some((k) => k.description === 'first')).toBe(true);
  });

  it('writes env keys into an empty store so a fresh replica finds them', async () => {
    const store = new InMemoryApiKeyStore();
    process.env.API_KEYS = 'sk_free_seed:50:seeded:pro:editor';
    const first = new ApiKeyManager(store);
    await first.initialize();
    await first.flush();

    const second = new ApiKeyManager(store);
    await second.initialize();

    expect(second.validateKey('sk_free_seed').valid).toBe(true);
    expect(second.findByHash(first.hashKey('sk_free_seed'))?.description).toBe('seeded');
    expect(second.findByHash(first.hashKey('sk_free_seed'))?.rateLimitPerMin).toBe(50);
  });

  it('a replica loading a store that already has keys does not re-seed its own', async () => {
    const store = new InMemoryApiKeyStore();
    const seed = new ApiKeyManager(store);
    const created = seed.generateKey(100, 'authoritative', 'pro');
    await seed.flush();

    process.env.API_KEYS = 'sk_free_env:10:env:free:viewer';
    const replica = new ApiKeyManager(store);
    await replica.initialize();

    expect(replica.validateKey(created.key).valid).toBe(true);
    expect(replica.validateKey('sk_free_env').valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Store-unavailable behaviour is fail-closed
// ---------------------------------------------------------------------------

describe('ApiKeyManager - store-unavailable behaviour', () => {
  it('fails closed at bootstrap when the store cannot be reached', async () => {
    const mgr = new ApiKeyManager(brokenStore());
    await mgr.initialize();

    expect(mgr.isStoreHealthy).toBe(false);
    expect(mgr.validateKey('sk_free_anything')).toEqual({
      valid: false,
      error: 'API key store unavailable',
    });
    expect(mgr.isAdminKey('sk_admin_anything')).toBe(false);
    expect(mgr.checkRateLimit('sk_free_anything')).toEqual({
      allowed: false,
      remaining: 0,
      resetTime: 0,
    });
  });

  it('fails closed when a later refresh cannot reach the store', async () => {
    const store = new InMemoryApiKeyStore();
    const mgr = new ApiKeyManager(store);
    await mgr.initialize();
    const { key } = mgr.generateKey(100, 'graceful', 'pro');
    await mgr.flush();
    expect(mgr.validateKey(key).valid).toBe(true);

    store.load = async () => {
      throw new Error('redis down');
    };
    await mgr.refresh();

    expect(mgr.isStoreHealthy).toBe(false);
    expect(mgr.validateKey(key)).toEqual({
      valid: false,
      error: 'API key store unavailable',
    });
  });

  it('fails closed when a write cannot be persisted', async () => {
    const store = new InMemoryApiKeyStore();
    const mgr = new ApiKeyManager(store);
    await mgr.initialize();

    store.put = async () => {
      throw new Error('read-only replica');
    };
    mgr.generateKey(100, 'unwritable', 'free');
    await mgr.flush();

    expect(mgr.isStoreHealthy).toBe(false);
    expect(mgr.validateKey('sk_free_whatever').valid).toBe(false);
  });

  it('recovers as soon as the store answers again', async () => {
    const store = new InMemoryApiKeyStore();
    const mgr = new ApiKeyManager(store);
    await mgr.initialize();
    const generated = mgr.generateKey(100, 'recovery', 'pro');
    const { key: plaintext, ...meta } = generated;
    await mgr.flush();

    store.load = async () => {
      throw new Error('transient');
    };
    await mgr.refresh();
    expect(mgr.isStoreHealthy).toBe(false);

    store.load = async () => [{ ...meta }];
    await mgr.refresh();

    expect(mgr.isStoreHealthy).toBe(true);
    expect(mgr.validateKey(plaintext).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Export / import round trip (hash authoritative, plaintext never stored)
// ---------------------------------------------------------------------------

describe('ApiKeyManager - export/import round trip', () => {
  it('round-trips a usable key without persisting the plaintext', async () => {
    const source = new ApiKeyManager(new InMemoryApiKeyStore());
    const generated = source.generateKey(100, 'round-trip', 'enterprise', 'operator');
    const exported = source.exportKeysForVault();

    expect(exported[generated.keyHash].key).toBe('');
    expect(exported[generated.keyHash].keyHash).toBe(generated.keyHash);
    expect(exported[generated.keyHash].keyPrefix).toBe(generated.keyPrefix);

    const targetStore = new InMemoryApiKeyStore();
    const target = new ApiKeyManager(targetStore);
    target.loadKeysFromVault(exported);
    await target.flush();

    expect(target.validateKey(generated.key).valid).toBe(true);
    expect(target.findByHash(generated.keyHash)?.tier).toBe('enterprise');
    expect(target.findByHash(generated.keyHash)?.role).toBe('operator');
    expect(target.findByHash(generated.keyHash)?.rateLimitPerMin).toBe(100);
    expect(target.findByHash(generated.keyHash)?.description).toBe('round-trip');
    expect(target.findByHash(generated.keyHash)?.isActive).toBe(true);

    const stored = JSON.stringify(await targetStore.load());
    expect(stored).not.toContain(generated.key);
    expect(stored).toContain(generated.keyHash);
  });

  it('keeps revocation state across the round trip', async () => {
    const source = new ApiKeyManager(new InMemoryApiKeyStore());
    const generated = source.generateKey(100, 'revoked-round', 'free');
    source.revokeKey(generated.keyHash);

    const target = new ApiKeyManager(new InMemoryApiKeyStore());
    target.loadKeysFromVault(source.exportKeysForVault());
    await target.flush();

    expect(target.validateKey(generated.key).valid).toBe(false);
    expect(target.validateKey(generated.key).error).toBe('API key has been revoked');
  });

  it('derives a display prefix when an entry carries neither prefix nor key', () => {
    const mgr = new ApiKeyManager(new InMemoryApiKeyStore());
    const generated = mgr.generateKey(100, 'no-prefix', 'free');
    const exported = mgr.exportKeysForVault();
    exported[generated.keyHash].keyPrefix = '';
    exported[generated.keyHash].key = '';

    const target = new ApiKeyManager(new InMemoryApiKeyStore());
    target.loadKeysFromVault(exported);

    const restored = target.findByHash(generated.keyHash);
    expect(restored).not.toBeNull();
    expect(restored!.keyPrefix).toBe(generated.keyHash.substring(0, 12));
    expect(target.validateKey(generated.key).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Store implementations
// ---------------------------------------------------------------------------

describe('InMemoryApiKeyStore', () => {
  it('isolates entries between stores', async () => {
    const a = new InMemoryApiKeyStore();
    const b = new InMemoryApiKeyStore();
    const mgr = new ApiKeyManager(a);
    const { keyHash } = mgr.generateKey(100, 'isolated', 'free');
    await mgr.flush();

    expect(a.size).toBeGreaterThanOrEqual(1);
    expect((await b.load()).some((e) => e.keyHash === keyHash)).toBe(false);
  });

  it('removes entries', async () => {
    const store = new InMemoryApiKeyStore();
    await store.put({ keyHash: 'h1', keyPrefix: 'p', createdAt: 1, lastUsed: null, requestCount: 0, isActive: true, rateLimitPerMin: 60, tier: 'free', role: 'viewer' });
    expect(await store.load()).toHaveLength(1);
    await store.remove('h1');
    expect(await store.load()).toHaveLength(0);
  });
});

describe('RedisApiKeyStore', () => {
  it('stores everything under a single hash field per key', async () => {
    const redis = new FakeRedis();
    const store = new RedisApiKeyStore(redis);
    await store.put({ keyHash: 'abc', keyPrefix: 'sk_free_ab', createdAt: 7, lastUsed: null, requestCount: 0, isActive: true, rateLimitPerMin: 60, tier: 'free', role: 'viewer' });

    expect(redis.hashes.has('oracle:api-keys')).toBe(true);
    expect(redis.hashes.get('oracle:api-keys')!.has('abc')).toBe(true);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].keyHash).toBe('abc');
    expect(loaded[0].createdAt).toBe(7);

    await store.remove('abc');
    expect(await store.load()).toHaveLength(0);
  });

  it('ignores unparsable entries instead of failing the whole snapshot', async () => {
    const redis = new FakeRedis();
    const store = new RedisApiKeyStore(redis);
    redis.hashes.set('oracle:api-keys', new Map([
      ['good', JSON.stringify({ keyHash: 'good', keyPrefix: 'p', createdAt: 1, lastUsed: null, requestCount: 0, isActive: true, rateLimitPerMin: 60, tier: 'free', role: 'viewer' })],
      ['bad', 'not-json'],
      ['shapeless', JSON.stringify({ keyPrefix: 'p' })],
    ]));

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].keyHash).toBe('good');
  });

  it('surfaces connection failures so the manager can fail closed', async () => {
    const redis = new FakeRedis();
    const store = new RedisApiKeyStore(redis);
    redis.failing = true;
    await expect(store.load()).rejects.toThrow('connection refused');
    await expect(store.put({ keyHash: 'x', keyPrefix: 'p', createdAt: 1, lastUsed: null, requestCount: 0, isActive: true, rateLimitPerMin: 60, tier: 'free', role: 'viewer' })).rejects.toThrow('connection refused');
    await expect(store.remove('x')).rejects.toThrow('connection refused');
  });
});
