import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ApiKeyEntry } from '@stellar-oracle/vault-client';
import {
  ApiKeyManager,
  MissingKeySourceError,
  allowEphemeralAdminKey,
  bootstrapApiKeyStore,
  isProduction,
} from '../../src/governance/api-key-manager';

const logs = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../../src/observability/logger', () => {
  const record = (...args: unknown[]): void => {
    logs.lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return {
    logger: {
      info: record,
      warn: record,
      error: record,
      debug: record,
      verbose: record,
      http: record,
    },
  };
});

const KEY_MATERIAL_PATTERN = /(?:admin|sk)_[a-z0-9]*_[0-9a-f]{64}|admin_[0-9a-f]{64}/g;

function loggedOutput(): string {
  return logs.lines.join('\n');
}

function fullKeysInLog(): string[] {
  return loggedOutput().match(KEY_MATERIAL_PATTERN) ?? [];
}

describe('API key bootstrap (issue #592)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    logs.lines.length = 0;
    delete process.env.API_KEYS;
    delete process.env.ALLOW_EPHEMERAL_ADMIN_KEY;
    delete process.env.ADMIN_KEY_PREFIX;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('fail closed in production', () => {
    it('refuses to start when no key source is configured', () => {
      process.env.NODE_ENV = 'production';

      const mgr = new ApiKeyManager();

      expect(mgr.getAllKeys()).toHaveLength(0);
      expect(isProduction()).toBe(true);
      expect(allowEphemeralAdminKey()).toBe(false);
      expect(() => bootstrapApiKeyStore(mgr)).toThrow(MissingKeySourceError);

      let thrown: unknown;
      try {
        bootstrapApiKeyStore(mgr);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MissingKeySourceError);
      expect((thrown as MissingKeySourceError).code).toBe('MISSING_KEY_SOURCE');
      expect((thrown as MissingKeySourceError).message).toContain('API_KEYS');
      expect((thrown as MissingKeySourceError).message).toContain('docs/KEY_MANAGEMENT.md');
    });

    it('refuses to start when API_KEYS parses to no keys', () => {
      process.env.NODE_ENV = 'production';
      process.env.API_KEYS = ',,,';

      const mgr = new ApiKeyManager();

      expect(mgr.getAllKeys()).toHaveLength(0);
      expect(() => bootstrapApiKeyStore(mgr)).toThrow(MissingKeySourceError);
    });

    it('starts when API_KEYS is configured', () => {
      process.env.NODE_ENV = 'production';
      process.env.API_KEYS = 'sk_prod_admin_1:100000:platform-admin:admin:admin';

      const mgr = new ApiKeyManager();
      const report = bootstrapApiKeyStore(mgr);

      expect(report).toMatchObject({
        source: 'env',
        count: 1,
        health: 'env-seeded',
        ephemeral: false,
      });
    });
  });

  describe('explicit opt-in for local development and tests', () => {
    it('generates a key without putting key material in any log output', () => {
      process.env.NODE_ENV = 'test';
      process.env.ALLOW_EPHEMERAL_ADMIN_KEY = 'true';

      const mgr = new ApiKeyManager();

      expect(mgr.getAllKeys()).toHaveLength(1);
      expect(fullKeysInLog()).toHaveLength(0);

      const report = bootstrapApiKeyStore(mgr);
      expect(report).toEqual({
        source: 'generated',
        count: 1,
        health: 'empty',
        ephemeral: true,
      });

      const key = mgr.takeBootstrapKey();
      expect(key).toMatch(/^admin_[0-9a-f]{64}$/);
      if (!key) throw new Error('expected an ephemeral bootstrap key');
      expect(mgr.validateKey(key).valid).toBe(true);
      expect(mgr.isAdminKey(key)).toBe(true);

      expect(loggedOutput()).toContain(key.substring(0, 12));
      expect(loggedOutput()).toContain('docs/KEY_MANAGEMENT.md');
      expect(fullKeysInLog()).toHaveLength(0);

      expect(mgr.takeBootstrapKey()).toBeNull();
    });

    it('honours ADMIN_KEY_PREFIX for the generated key', () => {
      process.env.NODE_ENV = 'test';
      process.env.ALLOW_EPHEMERAL_ADMIN_KEY = 'true';
      process.env.ADMIN_KEY_PREFIX = 'ops_admin_';

      const mgr = new ApiKeyManager();
      const key = mgr.takeBootstrapKey();

      expect(key).toMatch(/^ops_admin_[0-9a-f]{64}$/);
    });

    it('does not generate when a key source is configured', () => {
      process.env.NODE_ENV = 'test';
      process.env.ALLOW_EPHEMERAL_ADMIN_KEY = 'true';
      process.env.API_KEYS = 'sk_seed_admin_1:100:seeded:pro:editor';

      const mgr = new ApiKeyManager();

      expect(mgr.getAllKeys()).toHaveLength(1);
      expect(mgr.takeBootstrapKey()).toBeNull();
      expect(bootstrapApiKeyStore(mgr)).toMatchObject({
        source: 'env',
        count: 1,
        health: 'env-seeded',
        ephemeral: false,
      });
      expect(fullKeysInLog()).toHaveLength(0);
    });

    it('stays empty in a non-production run without opt-in', () => {
      process.env.NODE_ENV = 'test';

      const mgr = new ApiKeyManager();
      const report = bootstrapApiKeyStore(mgr);

      expect(report).toEqual({
        source: 'none',
        count: 0,
        health: 'empty',
        ephemeral: false,
      });
      expect(loggedOutput()).toContain('API key bootstrap: source=none count=0 health=empty');
      expect(fullKeysInLog()).toHaveLength(0);
    });
  });

  describe('startup report', () => {
    it('reports the key source and count without secrets', () => {
      process.env.API_KEYS = 'sk_report_aaa:100:first:free:viewer,sk_report_bbb:500:second:pro:editor';

      const mgr = new ApiKeyManager();
      logs.lines.length = 0;

      bootstrapApiKeyStore(mgr);

      expect(loggedOutput()).toContain('API key bootstrap: source=env count=2 health=env-seeded');
      expect(fullKeysInLog()).toHaveLength(0);
    });

    it('reports store-backed keys as durable', () => {
      process.env.API_KEYS = 'sk_report_env:100:env:free:viewer';

      const mgr = new ApiKeyManager();
      const entry: ApiKeyEntry = {
        keyHash: 'a'.repeat(64),
        keyPrefix: 'sk_vault_key',
        key: '',
        tier: 'admin',
        role: 'admin',
        rateLimitPerMin: 100000,
        description: 'vault seeded',
        createdAt: Date.now(),
        isActive: true,
      };
      mgr.loadKeysFromVault({ [entry.keyHash]: entry });

      expect(mgr.getBootstrapReport()).toMatchObject({
        source: 'vault',
        health: 'store-backed',
        ephemeral: false,
      });
      expect(bootstrapApiKeyStore(mgr)).toMatchObject({
        source: 'vault',
        count: 2,
        health: 'store-backed',
      });
      expect(fullKeysInLog()).toHaveLength(0);
    });
  });
});
