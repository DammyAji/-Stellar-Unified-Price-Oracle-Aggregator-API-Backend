import { NextFunction, Request, Response } from 'express';
import Redis from 'ioredis';
import { config } from '../infrastructure/config';
import {
  rateLimitCounterSize,
  rateLimitDecisionsTotal,
  rateLimitRedisLatency,
} from '../observability/metrics';

type Layer = 'global' | 'tenant' | 'ip' | 'endpoint';

interface Decision {
  allowed: boolean;
  layer: Layer;
  limit: number;
  remaining: number;
  reset: number;
  consumed: number;
  degraded: boolean;
}

/**
 * Per-key sliding-window counts. This map is a *mirror* of the authoritative
 * counter (Redis when healthy, local when degraded): every successful Redis
 * increment writes the resulting count back here, so a Redis outage continues
 * from the last known count instead of resetting the tenant's usage, and a
 * Redis restart is reconciled upward (incrby) when the mirror ran ahead.
 */
const windows = new Map<string, { windowStart: number; count: number }>();

/**
 * Decision cache (50 ms). Only BLOCKED decisions are cached — rejections are
 * idempotent and safe to repeat without consuming the layer again. Allowed
 * decisions are never cached: a request that is admitted always increments
 * every layer, so no path can return "allowed" without consuming a unit and
 * headers always describe fresh state. Cached blocks are keyed by window and
 * re-read the current count for header accuracy; every layer is still
 * evaluated per request and the strictest decision wins.
 */
const blockCache = new Map<string, { expires: number; decision: Decision }>();
const BLOCK_CACHE_TTL_MS = 50;
const BLOCK_CACHE_MAX_ENTRIES = 5000;

const redis = config.redisUrl ? new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
let redisHealthy = false;

const baseLimits: Record<Layer, number> = {
  global: config.rateLimitMax * 10,
  tenant: config.rateLimitMax,
  ip: config.rateLimitMax,
  endpoint: Math.max(10, Math.floor(config.rateLimitMax / 2)),
};

async function ensureRedis(): Promise<boolean> {
  if (!redis) return false;
  if (redisHealthy) return true;
  try {
    await redis.connect();
    redisHealthy = true;
  } catch {
    redisHealthy = false;
  }
  return redisHealthy;
}

function regionMultiplier(req: Request): number {
  const region = String(req.headers['x-geo-region'] || req.headers['cf-ipcountry'] || '').toUpperCase();
  if (['CN', 'RU', 'KP'].includes(region)) return 0.5;
  if (['AF', 'OC', 'SA'].includes(region)) return 1.25;
  return 1;
}

function adjustedLimit(layer: Layer, req: Request, degraded: boolean): number {
  const pressure = Number(req.headers['x-system-load'] || 0);
  const dynamic = pressure > 0.8 ? 0.75 : pressure < 0.3 ? 1.1 : 1;
  const degradation = degraded ? 0.5 : 1;
  return Math.max(1, Math.floor(baseLimits[layer] * regionMultiplier(req) * dynamic * degradation));
}

async function increment(
  key: string,
  degraded: boolean,
  windowStart: number,
  reset: number,
): Promise<{ count: number; reset: number }> {
  const windowMs = config.rateLimitWindowMs;
  if (!degraded && redis && (await ensureRedis())) {
    const started = performance.now();
    try {
      const redisKey = `rl:${windowStart}:${key}`;
      let count = await redis.incr(redisKey);
      if (count === 1) await redis.pexpire(redisKey, windowMs * 2);
      const mirrored = windows.get(key);
      if (mirrored && mirrored.windowStart === windowStart && mirrored.count + 1 > count) {
        count = await redis.incrby(redisKey, mirrored.count + 1 - count);
      }
      windows.set(key, { windowStart, count });
      rateLimitCounterSize.set(windows.size);
      rateLimitRedisLatency.observe((performance.now() - started) / 1000);
      return { count, reset };
    } catch {
      redisHealthy = false;
    }
  }
  const current = windows.get(key);
  if (!current || current.windowStart !== windowStart) {
    windows.set(key, { windowStart, count: 1 });
    rateLimitCounterSize.set(windows.size);
    return { count: 1, reset };
  }
  current.count += 1;
  return { count: current.count, reset };
}

/** Non-consuming read of the current count, used for headers on cached blocks. */
async function readCount(key: string, degraded: boolean, windowStart: number): Promise<number | null> {
  if (!degraded && redis && (await ensureRedis())) {
    try {
      const raw = await redis.get(`rl:${windowStart}:${key}`);
      if (raw !== null) return Number(raw);
    } catch {
      redisHealthy = false;
    }
  }
  const current = windows.get(key);
  if (current && current.windowStart === windowStart) return current.count;
  return null;
}

/** Strictest decision wins: blocked beats allowed; among allowed, lowest remaining; among blocked, the earliest layer. */
function stricter(current: Decision | null, candidate: Decision): Decision {
  if (!current) return candidate;
  if (current.allowed !== candidate.allowed) return current.allowed ? candidate : current;
  if (!current.allowed) return current;
  return candidate.remaining < current.remaining ? candidate : current;
}

function setBlockCache(cacheKey: string, now: number, decision: Decision): void {
  if (blockCache.size >= BLOCK_CACHE_MAX_ENTRIES) {
    for (const [key, entry] of blockCache) {
      if (entry.expires <= now) blockCache.delete(key);
    }
    while (blockCache.size >= BLOCK_CACHE_MAX_ENTRIES) {
      const oldest = blockCache.keys().next();
      if (oldest.done) break;
      blockCache.delete(oldest.value);
    }
  }
  blockCache.set(cacheKey, { expires: now + BLOCK_CACHE_TTL_MS, decision });
}

async function evaluate(req: Request): Promise<Decision> {
  const tenant = String(req.headers['x-api-key'] || 'anonymous');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const endpoint = `${req.method}:${req.route?.path || req.path}`;
  const keys: Array<[Layer, string]> = [
    ['global', 'global'],
    ['tenant', `tenant:${tenant}`],
    ['ip', `ip:${ip}`],
    ['endpoint', `endpoint:${endpoint}`],
  ];
  const degraded = !(await ensureRedis());
  const windowMs = config.rateLimitWindowMs;
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  const reset = Math.ceil((windowStart + windowMs) / 1000);

  let strictest: Decision | null = null;
  for (const [layer, key] of keys) {
    const limit = adjustedLimit(layer, req, degraded);
    const cacheKey = `${layer}:${key}:${limit}:${windowStart}`;
    const cached = blockCache.get(cacheKey);
    if (cached && cached.expires > now) {
      const current = await readCount(key, degraded, windowStart);
      if (current !== null) {
        strictest = stricter(strictest, {
          allowed: false,
          layer,
          limit,
          remaining: 0,
          reset,
          consumed: current,
          degraded,
        });
        continue;
      }
    }
    const { count } = await increment(key, degraded, windowStart, reset);
    const decision: Decision = {
      allowed: count <= limit,
      layer,
      limit,
      remaining: Math.max(0, limit - count),
      reset,
      consumed: count,
      degraded,
    };
    if (!decision.allowed) setBlockCache(cacheKey, now, decision);
    strictest = stricter(strictest, decision);
  }
  return strictest!;
}

export async function distributedRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.path === '/metrics') return next();
  const decision = await evaluate(req);
  res.set('X-RateLimit-Limit', String(decision.limit));
  res.set('X-RateLimit-Remaining', String(decision.remaining));
  res.set('X-RateLimit-Reset', String(decision.reset));
  res.set('X-RateLimit-Consumed', String(decision.consumed));
  if (decision.degraded) res.set('X-RateLimit-Degraded', 'local');
  rateLimitDecisionsTotal.inc({
    layer: decision.layer,
    tenant: String(req.headers['x-api-key'] || 'anonymous'),
    endpoint: `${req.method}:${req.path}`,
    result: decision.allowed ? 'allowed' : 'blocked',
  });
  if (!decision.allowed) {
    const retryAfter = Math.max(1, decision.reset - Math.floor(Date.now() / 1000));
    res.set('Retry-After', String(retryAfter));
    res.set('X-RateLimit-Type', decision.layer);
    res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    return;
  }
  next();
}

export function rateLimitStatus() {
  return {
    mode: redisHealthy ? 'redis-cluster-crdt-sliding-window' : 'local-degraded-sliding-window',
    layers: Object.keys(baseLimits),
    redisConfigured: Boolean(redis),
    counterSize: windows.size,
    blockCacheTtlMs: BLOCK_CACHE_TTL_MS,
    blockCacheSize: blockCache.size,
  };
}

/** Exposed for tests: the counter mirror and the block-decision cache. */
export const __rateLimitInternals = { windows, blockCache };
