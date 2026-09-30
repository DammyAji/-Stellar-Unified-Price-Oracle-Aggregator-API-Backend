import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = 'https://oracle.example';
  process.env.PUBLIC_BASE_ALLOWED_HOSTS = 'api.oracle.example';
  process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
});

import { httpsRedirect, hstsHeaders } from '../../src/infrastructure/https';
import { config } from '../../src/infrastructure/config';

interface MockRes {
  headers: Record<string, string>;
  statusCode: number;
  body?: unknown;
  redirectStatus?: number;
  location?: string;
  set(key: string, value: string): MockRes;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
  redirect(code: number, location: string): MockRes;
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
    redirect(code, location) {
      res.redirectStatus = code;
      res.location = location;
      res.statusCode = code;
      return res;
    },
  };
  return res;
}

interface ReqOptions {
  secure?: boolean;
  host?: string;
  ip?: string;
  xfp?: string;
  url?: string;
}

function makeReq(options: ReqOptions = {}): Request {
  const headers: Record<string, string> = {};
  if (options.host !== undefined) headers.host = options.host;
  if (options.xfp !== undefined) headers['x-forwarded-proto'] = options.xfp;
  return {
    secure: options.secure ?? false,
    headers,
    originalUrl: options.url ?? '/api/v1/prices',
    method: 'GET',
    path: '/api/v1/prices',
    socket: { remoteAddress: options.ip ?? '203.0.113.10' },
  } as unknown as Request;
}

const directIp = '203.0.113.10';
const trustedProxyIp = '10.0.0.5';

describe('httpsRedirect', () => {
  const originalBaseUrl = config.publicBaseUrl;
  const originalAllowedHosts = config.publicAllowedHosts;

  beforeEach(() => {
    config.publicBaseUrl = originalBaseUrl;
    config.publicAllowedHosts = [...originalAllowedHosts];
  });

  afterEach(() => {
    config.publicBaseUrl = originalBaseUrl;
    config.publicAllowedHosts = [...originalAllowedHosts];
  });

  it('redirects a direct plaintext connection to the canonical origin, preserving path and query', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    httpsRedirect(makeReq({ host: 'oracle.example', url: '/api/v1/prices?limit=10' }), res as unknown as Response, next);
    expect(res.redirectStatus).toBe(301);
    expect(res.location).toBe('https://oracle.example/api/v1/prices?limit=10');
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores a spoofed X-Forwarded-Proto: https from an untrusted peer (plaintext still redirects)', () => {
    const res = makeRes();
    httpsRedirect(makeReq({ ip: directIp, xfp: 'https', host: 'oracle.example' }), res as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(res.redirectStatus).toBe(301);
    expect(res.location).toBe('https://oracle.example/api/v1/prices');
  });

  it('ignores a spoofed X-Forwarded-Proto: http from an untrusted peer (TLS socket wins)', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    httpsRedirect(makeReq({ ip: directIp, xfp: 'http', secure: true, host: 'oracle.example' }), res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.redirectStatus).toBeUndefined();
  });

  it('rejects an unexpected Host header with 421 before anything else', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    httpsRedirect(makeReq({ host: 'evil.example' }), res as unknown as Response, next);
    expect(res.statusCode).toBe(421);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNEXPECTED_HOST');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unexpected Host over an otherwise-HTTPS connection', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    httpsRedirect(makeReq({ secure: true, host: 'evil.example' }), res as unknown as Response, next);
    expect(res.statusCode).toBe(421);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a request without a Host header when an allowlist is configured', () => {
    const res = makeRes();
    httpsRedirect(makeReq({}), res as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(421);
  });

  it('accepts an allowlisted alias host but still redirects to the canonical origin', () => {
    const res = makeRes();
    httpsRedirect(makeReq({ host: 'api.oracle.example' }), res as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(res.redirectStatus).toBe(301);
    expect(res.location).toBe('https://oracle.example/api/v1/prices');
  });

  it('honours X-Forwarded-Proto from a trusted proxy', () => {
    const httpsRes = makeRes();
    const httpsNext = vi.fn() as unknown as NextFunction;
    httpsRedirect(makeReq({ ip: trustedProxyIp, xfp: 'https', host: 'oracle.example' }), httpsRes as unknown as Response, httpsNext);
    expect(httpsNext).toHaveBeenCalled();
    expect(httpsRes.redirectStatus).toBeUndefined();

    const httpRes = makeRes();
    httpsRedirect(makeReq({ ip: trustedProxyIp, xfp: 'http', host: 'oracle.example' }), httpRes as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(httpRes.redirectStatus).toBe(301);
    expect(httpRes.location).toBe('https://oracle.example/api/v1/prices');
  });

  it('fails closed when a trusted proxy omits X-Forwarded-Proto', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    httpsRedirect(makeReq({ ip: trustedProxyIp, host: 'oracle.example' }), res as unknown as Response, next);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('SCHEME_UNDETERMINED');
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when a trusted proxy sends an unparseable X-Forwarded-Proto', () => {
    const res = makeRes();
    httpsRedirect(makeReq({ ip: trustedProxyIp, xfp: 'javascript', host: 'oracle.example' }), res as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('SCHEME_UNDETERMINED');
  });

  it('rejects plaintext with 400 instead of redirecting when PUBLIC_BASE_URL is not configured', () => {
    config.publicBaseUrl = '';
    config.publicAllowedHosts = [];
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    httpsRedirect(makeReq({ host: 'oracle.example' }), res as unknown as Response, next);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTPS_REDIRECT_UNCONFIGURED');
    expect(next).not.toHaveBeenCalled();
  });

  it('serves HTTPS without a configured canonical origin (no allowlist to enforce)', () => {
    config.publicBaseUrl = '';
    config.publicAllowedHosts = [];
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    httpsRedirect(makeReq({ secure: true, host: 'anything.example' }), res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

describe('hstsHeaders', () => {
  it('sets HSTS when the request is served over HTTPS', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    hstsHeaders(makeReq({ secure: true }), res as unknown as Response, next);
    expect(res.headers['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains; preload');
    expect(next).toHaveBeenCalled();
  });

  it('does not set HSTS on a plaintext request', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    hstsHeaders(makeReq({ secure: false }), res as unknown as Response, next);
    expect(res.headers['Strict-Transport-Security']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('does not set HSTS when a trusted proxy reports http', () => {
    const res = makeRes();
    hstsHeaders(makeReq({ ip: trustedProxyIp, xfp: 'http' }), res as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(res.headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('sets HSTS when a trusted proxy reports https', () => {
    const res = makeRes();
    hstsHeaders(makeReq({ ip: trustedProxyIp, xfp: 'https' }), res as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(res.headers['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains; preload');
  });

  it('does not set HSTS for an untrusted peer claiming https via header over plaintext', () => {
    const res = makeRes();
    hstsHeaders(makeReq({ ip: directIp, xfp: 'https', secure: false }), res as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(res.headers['Strict-Transport-Security']).toBeUndefined();
  });
});
