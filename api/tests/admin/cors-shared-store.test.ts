import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

const { persistPath, recordComplianceAuditSpy } = vi.hoisted(() => {
  process.env.CORS_PERSIST_PATH = `${process.env.TEMP || 'C:/Users/USER/AppData/Local/Temp'}/cors-shared-store-${process.pid}.json`;
  return {
    persistPath: process.env.CORS_PERSIST_PATH,
    recordComplianceAuditSpy: vi.fn(() => ({ hash: 'test' })),
  };
});

vi.mock('../../src/governance/compliance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/governance/compliance')>();
  return { ...actual, recordComplianceAudit: recordComplianceAuditSpy };
});

import adminRouter from '../../src/governance/admin';
import { corsManager, CorsManager, type CorsStore } from '../../src/governance/cors-manager';
import { apiKeyManager } from '../../src/governance/api-key-manager';
import { eventBus, type DomainEvent } from '../../src/domain-events';

describe('CORS allowlist shared store', () => {
  const events: DomainEvent[] = [];
  let adminKey: string;

  beforeAll(() => {
    adminKey = apiKeyManager.generateKey(1000, 'cors store admin', 'admin', 'admin').key;
    eventBus.subscribe('cors-allowlist-changed', (event) => {
      events.push(event);
    });
  });

  beforeEach(() => {
    events.length = 0;
    recordComplianceAuditSpy.mockClear();
    corsManager.setStore(null);
    corsManager.restore([]);
  });

  afterEach(() => {
    corsManager.setStore(null);
    corsManager.restore([]);
    if (fs.existsSync(persistPath)) {
      fs.unlinkSync(persistPath);
    }
    vi.unstubAllEnvs();
  });

  const auth = () => ({ Authorization: `Bearer ${adminKey}` });

  function buildApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/admin', adminRouter);
    return app;
  }

  function fakeStore(load: string[] = [], saveImpl?: () => Promise<void>) {
    return {
      load: vi.fn(async () => load),
      save: vi.fn(saveImpl ?? (async () => undefined)),
    } satisfies CorsStore & { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  }

  it('hydrates the union of environment origins and store origins, dropping invalid entries', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://env.example.com');
    const fresh = new CorsManager();
    const store = fakeStore(['https://stored.example.com', '*', 'javascript:alert(1)']);
    fresh.setStore(store);

    await fresh.hydrate();

    expect(store.load).toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(fresh.listOrigins()).toEqual(
      expect.arrayContaining(['https://env.example.com', 'https://stored.example.com']),
    );
    expect(fresh.listOrigins()).not.toContain('*');
    expect(fresh.listOrigins()).not.toContain('javascript:alert(1)');
    expect(fresh.isAllowed('https://evil.example.org')).toBe(false);
  });

  it('keeps the current allowlist when the store cannot be read', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://env.example.com');
    const fresh = new CorsManager();
    fresh.setStore({
      load: vi.fn(async () => {
        throw new Error('vault unreachable');
      }),
      save: vi.fn(async () => undefined),
    });

    await fresh.hydrate();

    expect(fresh.listOrigins()).toContain('https://env.example.com');
    expect(fresh.isAllowed('https://env.example.com')).toBe(true);
  });

  it('persists an added origin to the store with before/after state, emits an event, and audits it', async () => {
    const store = fakeStore();
    corsManager.setStore(store);
    corsManager.restore(['https://existing.example.com']);
    const app = buildApp();

    const res = await request(app)
      .post('/admin/cors/origins')
      .set(auth())
      .send({ origin: 'https://new.example.com' });

    expect(res.status).toBe(201);
    expect(res.body.data.added).toBe(true);
    expect(store.save).toHaveBeenCalledWith([
      'https://existing.example.com',
      'https://new.example.com',
    ]);
    expect(corsManager.listOrigins()).toContain('https://new.example.com');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'cors-allowlist-changed',
      payload: {
        origin: 'https://new.example.com',
        action: 'added',
        before: ['https://existing.example.com'],
        after: ['https://existing.example.com', 'https://new.example.com'],
      },
    });

    expect(recordComplianceAuditSpy).toHaveBeenCalledWith(
      'cors.allowlist.change',
      expect.anything(),
      'add_cors_origin',
      'success',
      expect.objectContaining({
        origin: 'https://new.example.com',
        before: ['https://existing.example.com'],
        after: ['https://existing.example.com', 'https://new.example.com'],
      }),
    );
  });

  it('persists a removed origin to the store and emits a removal event', async () => {
    const store = fakeStore();
    corsManager.setStore(store);
    corsManager.restore(['https://existing.example.com', 'https://gone.example.com']);
    const app = buildApp();

    const res = await request(app)
      .delete('/admin/cors/origins')
      .set(auth())
      .send({ origin: 'https://gone.example.com' });

    expect(res.status).toBe(200);
    expect(store.save).toHaveBeenCalledWith(['https://existing.example.com']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'cors-allowlist-changed',
      payload: { origin: 'https://gone.example.com', action: 'removed' },
    });
    expect(recordComplianceAuditSpy).toHaveBeenCalledWith(
      'cors.allowlist.change',
      expect.anything(),
      'remove_cors_origin',
      'success',
      expect.objectContaining({ origin: 'https://gone.example.com' }),
    );
  });

  it('rolls back the in-memory change and emits nothing when the store write fails', async () => {
    const store = fakeStore(undefined, async () => {
      throw new Error('vault write failed');
    });
    corsManager.setStore(store);
    corsManager.restore(['https://existing.example.com']);
    const app = buildApp();

    const add = await request(app)
      .post('/admin/cors/origins')
      .set(auth())
      .send({ origin: 'https://new.example.com' });

    expect(add.status).toBe(500);
    expect(add.body.error.code).toBe('STORE_WRITE_FAILED');
    expect(corsManager.listOrigins()).toEqual(['https://existing.example.com']);
    expect(events).toHaveLength(0);
    expect(recordComplianceAuditSpy).not.toHaveBeenCalled();

    const remove = await request(app)
      .delete('/admin/cors/origins')
      .set(auth())
      .send({ origin: 'https://existing.example.com' });

    expect(remove.status).toBe(500);
    expect(corsManager.listOrigins()).toEqual(['https://existing.example.com']);
    expect(events).toHaveLength(0);
  });

  it('rejects invalid origins before touching the store', async () => {
    const store = fakeStore();
    corsManager.setStore(store);
    const app = buildApp();

    const res = await request(app)
      .post('/admin/cors/origins')
      .set(auth())
      .send({ origin: 'javascript:alert(1)' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ORIGIN');
    expect(store.save).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});
