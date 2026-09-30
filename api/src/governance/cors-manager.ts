import fs from 'fs';
import path from 'path';
import { logger } from '../observability/logger';

export interface CorsStore {
  load(): Promise<string[]>;
  save(origins: string[]): Promise<void>;
}

export interface OriginValidation {
  valid: boolean;
  reason?: string;
}

export function validateOriginPattern(pattern: string): OriginValidation {
  if (pattern === '*') {
    return {
      valid: false,
      reason: "'*' cannot be stored because it would be sent with credentials:true; set CORS_ALLOW_ANY=true (development only) to allow every origin",
    };
  }

  if (pattern === 'null') {
    return { valid: true };
  }

  if (pattern.startsWith('*.')) {
    const host = pattern.slice(2);
    if (!host) {
      return { valid: false, reason: 'wildcard pattern must look like *.example.com' };
    }
    try {
      const parsed = new URL(`https://${host}`);
      if (parsed.hostname !== host) {
        return { valid: false, reason: 'wildcard pattern must look like *.example.com' };
      }
    } catch {
      return { valid: false, reason: 'wildcard pattern must look like *.example.com' };
    }
    return { valid: true };
  }

  try {
    const parsed = new URL(pattern);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: 'origin must use the http or https scheme' };
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return { valid: false, reason: 'origin must not contain a path, query, or fragment' };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      reason: 'origin must be an absolute URL like https://example.com, a wildcard like *.example.com, or the literal null',
    };
  }
}

export class CorsManager {
  private origins: Set<string> = new Set();
  private envOrigins: Set<string> = new Set();
  private store: CorsStore | null = null;
  private readonly persistFile: string;

  constructor() {
    // Local cache only; the shared store (Vault) is the source of truth.
    this.persistFile = path.resolve(process.env.CORS_PERSIST_PATH || '/tmp/cors-origins.json');
    this.loadDefaults();
    this.loadFromDisk();
  }

  private allowAny(): boolean {
    return process.env.CORS_ALLOW_ANY === 'true';
  }

  private loadDefaults(): void {
    const envOrigins = process.env.CORS_ALLOWED_ORIGINS;
    if (envOrigins) {
      for (const o of envOrigins.split(',')) {
        const trimmed = o.trim();
        if (!trimmed) continue;
        if (!validateOriginPattern(trimmed).valid) {
          logger.warn(`Ignoring invalid origin in CORS_ALLOWED_ORIGINS: ${trimmed}`);
          continue;
        }
        this.envOrigins.add(trimmed);
        this.origins.add(trimmed);
      }
    }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.persistFile)) {
        const data = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
        if (Array.isArray(data)) {
          for (const o of data) {
            if (typeof o !== 'string') continue;
            if (!validateOriginPattern(o).valid) {
              logger.warn(`Ignoring invalid origin in CORS cache ${this.persistFile}: ${o}`);
              continue;
            }
            this.origins.add(o);
          }
        }
        logger.info(`Loaded ${this.origins.size} CORS origins from local cache`);
      }
    } catch (err) {
      logger.warn('Failed to load cached CORS origins', err);
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.persistFile, JSON.stringify(Array.from(this.origins), null, 2));
    } catch (err) {
      logger.warn('Failed to persist CORS origins cache', err);
    }
  }

  setStore(store: CorsStore | null): void {
    this.store = store;
  }

  async hydrate(): Promise<void> {
    if (!this.store) return;
    try {
      const stored = await this.store.load();
      const merged = new Set(this.envOrigins);
      for (const o of stored) {
        if (typeof o !== 'string') continue;
        if (!validateOriginPattern(o).valid) {
          logger.warn(`Ignoring invalid origin in shared CORS store: ${o}`);
          continue;
        }
        merged.add(o);
      }
      this.origins = merged;
      this.persist();
      logger.info(`Hydrated ${this.origins.size} CORS origins from shared store`);
    } catch (err) {
      logger.warn('Failed to hydrate CORS origins from shared store', err);
    }
  }

  async syncToStore(): Promise<void> {
    if (!this.store) return;
    await this.store.save(Array.from(this.origins));
  }

  restore(snapshot: string[]): void {
    this.origins = new Set(snapshot);
    this.persist();
  }

  isAllowed(origin: string): boolean {
    if (this.allowAny()) return true;
    if (this.origins.size === 0) return false;

    for (const pattern of this.origins) {
      if (this.matches(origin, pattern)) return true;
    }
    return false;
  }

  private matches(origin: string, pattern: string): boolean {
    if (pattern === origin) return true;

    // Wildcard subdomain: *.example.com also covers the apex (example.com).
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // .example.com
      let hostname = origin;
      try {
        hostname = new URL(origin).hostname;
      } catch {
        // Not a parseable URL; compare the raw string.
      }
      return hostname.endsWith(suffix) || hostname === suffix.slice(1);
    }
    return false;
  }

  validateOrigin(origin: string): OriginValidation {
    return validateOriginPattern(origin);
  }

  addOrigin(origin: string): boolean {
    const validation = validateOriginPattern(origin);
    if (!validation.valid) {
      logger.warn(`Rejected invalid CORS origin: ${origin} (${validation.reason})`);
      return false;
    }
    if (this.origins.has(origin)) return false;
    this.origins.add(origin);
    this.persist();
    logger.info(`Added CORS origin: ${origin}`);
    return true;
  }

  removeOrigin(origin: string): boolean {
    const removed = this.origins.delete(origin);
    if (removed) {
      this.persist();
      logger.info(`Removed CORS origin: ${origin}`);
    }
    return removed;
  }

  listOrigins(): string[] {
    return Array.from(this.origins);
  }

  getCorsOptions() {
    const allowAny = this.allowAny();
    return {
      origin: allowAny
        ? true
        : (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
            if (!origin) return cb(null, true);
            if (this.isAllowed(origin)) return cb(null, true);
            cb(new Error(`CORS origin not allowed: ${origin}`));
          },
      credentials: !allowAny,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-request-id', 'If-None-Match', 'If-Modified-Since'],
      exposedHeaders: [
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'Retry-After',
        'ETag',
        'Deprecation',
        'Sunset',
      ],
      // Cache preflight responses in the browser to avoid an OPTIONS
      // round-trip on every request (86400s is the Chromium max).
      maxAge: 86400,
      optionsSuccessStatus: 204,
    };
  }
}

export const corsManager = new CorsManager();
