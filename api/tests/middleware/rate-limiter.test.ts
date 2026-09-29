import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const h = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = '6';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.REDIS_URL = 'redis://localhost:6399';
  return {
    redis: { fail: false, store: new Map<string, number>(), connects: 0 },
  };
});

vi.mock('ioredis', () => {
  class FakeRedis {
    private store = h.redis.store;
    constructor(_url: string, _opts?: unknown) {}
    async connect(): Promise<void> {
      h.redis.connects += 1;
      if (h.redis.fail) throw new Error('redis down');
    }
    async incr(key: string): Promise<number> {
      if (h.redis.fail) throw new Error('redis down');
      const next = (this.store.get(key) ?? 0) + 1;
      this.store.set(key, next);
      return next;
    }
    async incrby(key: string, by: number): Promise<number> {
      if (h.redis.fail) throw new Error('redis down');
      const next = (this.store.get(key) ?? 0) + by;
      this.store.set(key, next);
      return next;
    }
    async get(key: string): Promise<string | null> {
      if (h.redis.fail) throw new Error('redis down');
      const value = this.store.get(key);
      return value === undefined ? null : String(value);
    }
    async pexpire(): Promise<number> {
      return 1;
    }
  }
  return { default: FakeRedis };
});

import {
  distributedRateLimiter,
  rateLimitStatus,
  __rateLimitInternals,
} from '../../src/platform/rate-limiter';

function makeReq(): Request {
  return {
    path: '/test',
    method: 'GET',
    headers: { 'x-api-key': 'tenant-a' },
    ip: '10.0.0.1',
    route: { path: '/test' },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as Request;
}

interface MockRes {
  headers: Record<string, string>;
  statusCode: number;
  body?: unknown;
  set(key: string, value: string): MockRes;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    headers: {},
    statusCode: 200,
    set(key, value) {
      res.headers[key] = String(value);
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

async function run(): Promise<{ res: MockRes; next: NextFunction }> {
  const req = makeReq();
  const res = makeRes();
  const next = vi.fn() as unknown as NextFunction;
  await distributedRateLimiter(req, res as unknown as Response, next);
  return { res, next };
}

const endpointCount = () => __rateLimitInternals.windows.get('endpoint:GET:/test')?.count ?? 0;
const tenantCount = () => __rateLimitInternals.windows.get('tenant:tenant-a')?.count ?? 0;

describe('Issue #593: rate limiter decision cache', () => {
  beforeEach(() => {
    h.redis.fail = false;
    h.redis.store.clear();
    __rateLimitInternals.windows.clear();
    __rateLimitInternals.blockCache.clear();
  });

  it('counts every request of a burst inside one 50 ms cache window', async () => {
    const consumed: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { res, next } = await run();
      expect(res.statusCode).toBe(200);
      expect(next).toHaveBeenCalled();
      consumed.push(Number(res.headers['X-RateLimit-Consumed']));
    }
    expect(consumed).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tenantCount()).toBe(6);
    expect(endpointCount()).toBe(6);
  });

  it('evaluates every layer even when an earlier layer blocks (strictest wins)', async () => {
    for (let i = 0; i < 6; i++) await run();

    const { res, next } = await run();
    expect(res.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
    expect(res.headers['X-RateLimit-Type']).toBe('tenant');
    expect(res.headers['X-RateLimit-Consumed']).toBe('7');
    expect(endpointCount()).toBe(7);
  });

  it('caches a blocked decision, repeats it without consuming, and keeps headers accurate', async () => {
    for (let i = 0; i < 7; i++) await run();

    const second = await run();
    expect(second.res.statusCode).toBe(429);
    expect(second.res.headers['X-RateLimit-Consumed']).toBe('7');
    expect(tenantCount()).toBe(7);

    const third = await run();
    expect(third.res.statusCode).toBe(429);
    expect(third.res.headers['X-RateLimit-Consumed']).toBe('7');
    expect(tenantCount()).toBe(7);
    expect(endpointCount()).toBe(9);
    expect(__rateLimitInternals.blockCache.size).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const afterExpiry = await run();
    expect(afterExpiry.res.statusCode).toBe(429);
    expect(afterExpiry.res.headers['X-RateLimit-Consumed']).toBe('8');
    expect(tenantCount()).toBe(8);
  });

  it('a cached block on one layer does not short-circuit the remaining layers', async () => {
    for (let i = 0; i < 7; i++) await run();
    expect(tenantCount()).toBe(7);

    await run();
    expect(tenantCount()).toBe(7);
    expect(endpointCount()).toBe(8);
    expect(__rateLimitInternals.windows.get('ip:10.0.0.1')?.count).toBe(7);
    expect(__rateLimitInternals.windows.get('global')?.count).toBe(8);
  });

  it('local mirror continues usage across a Redis outage instead of resetting', async () => {
    const first = await run();
    expect(first.res.headers['X-RateLimit-Consumed']).toBe('1');
    const second = await run();
    expect(second.res.headers['X-RateLimit-Consumed']).toBe('2');

    const redisKeys = [...h.redis.store.keys()].filter((k) => k.startsWith('rl:'));
    expect(redisKeys.length).toBeGreaterThan(0);
    const tenantRedisKey = redisKeys.find((k) => k.endsWith('tenant:tenant-a'))!;

    h.redis.fail = true;
    const during1 = await run();
    expect(during1.res.statusCode).toBe(200);
    expect(during1.res.headers['X-RateLimit-Consumed']).toBe('3');

    const during2 = await run();
    expect(during2.res.headers['X-RateLimit-Consumed']).toBe('4');

    h.redis.fail = false;
    const after = await run();
    expect(after.res.headers['X-RateLimit-Consumed']).toBe('5');
    expect(h.redis.store.get(tenantRedisKey)).toBe(5);
    expect(rateLimitStatus().redisConfigured).toBe(true);
  });

  it('reports block-cache telemetry in the status endpoint payload', () => {
    const status = rateLimitStatus() as Record<string, unknown>;
    expect(status.blockCacheTtlMs).toBe(50);
    expect(status.blockCacheSize).toBe(0);
    expect(status.layers).toEqual(['global', 'tenant', 'ip', 'endpoint']);
  });
});
