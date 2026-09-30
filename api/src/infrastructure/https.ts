import { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { isTrustedProxy, trustedHeader } from '../platform/trusted-proxy';

/**
 * Trust assumptions (issue #603): the effective scheme is derived only from
 * the TLS socket (`req.secure`) or from `X-Forwarded-Proto` when the TCP peer
 * is a configured trusted proxy (`TRUSTED_PROXY_IPS`); a direct client cannot
 * influence it. Redirects always target the configured canonical origin
 * (`PUBLIC_BASE_URL`) — never the request's Host header — and plaintext
 * traffic is redirected or rejected, never served. An unexpected Host is
 * rejected, an undeterminable scheme fails closed, and HSTS is emitted only
 * on responses actually served over HTTPS.
 */

function canonicalOrigin(): string | undefined {
  const raw = config.publicBaseUrl.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.host) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function expectedHosts(): Set<string> {
  const hosts = new Set<string>();
  const origin = canonicalOrigin();
  if (origin) hosts.add(new URL(origin).host.toLowerCase());
  for (const entry of config.publicAllowedHosts) {
    if (entry) hosts.add(entry.toLowerCase());
  }
  return hosts;
}

function hostIsExpected(req: Request): boolean {
  const allowed = expectedHosts();
  if (allowed.size === 0) return true;
  return allowed.has(String(req.headers.host || '').toLowerCase());
}

function requestScheme(req: Request): 'http' | 'https' | undefined {
  if (isTrustedProxy(req)) {
    const forwarded = trustedHeader(req, 'x-forwarded-proto');
    if (forwarded) {
      const first = forwarded.split(',')[0].trim().toLowerCase();
      if (first === 'http' || first === 'https') return first;
    }
    return undefined;
  }
  return req.secure ? 'https' : 'http';
}

export function httpsRedirect(req: Request, res: Response, next: NextFunction): void {
  if (!hostIsExpected(req)) {
    res.status(421).json({
      success: false,
      error: { code: 'UNEXPECTED_HOST', message: 'Host header does not match a configured origin' },
    });
    return;
  }
  const scheme = requestScheme(req);
  if (scheme === undefined) {
    res.status(400).json({
      success: false,
      error: { code: 'SCHEME_UNDETERMINED', message: 'Request scheme could not be determined from a trusted source' },
    });
    return;
  }
  if (scheme === 'https') {
    next();
    return;
  }
  const origin = canonicalOrigin();
  if (!origin) {
    res.status(400).json({
      success: false,
      error: { code: 'HTTPS_REDIRECT_UNCONFIGURED', message: 'Cannot redirect plaintext: PUBLIC_BASE_URL is not configured' },
    });
    return;
  }
  res.redirect(301, `${origin}${req.originalUrl}`);
}

export function hstsHeaders(req: Request, res: Response, next: NextFunction): void {
  if (requestScheme(req) === 'https') {
    res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  next();
}
