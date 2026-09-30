import net from 'net';
import { URL } from 'url';
import { SsrfError } from './errors';
import { isPrivateIp } from './ranges';

export interface SsrfPolicy {
  /**
   * Require `https:`. Callers that legitimately speak cleartext (the aggregator
   * talking to local test doubles) leave this false; anything that accepts
   * user-supplied URLs should set it.
   */
  requireHttps?: boolean;
  /**
   * Exact lowercase hostnames that may be contacted. An empty set means "any
   * host the other checks accept".
   */
  allowedHosts?: Iterable<string>;
  /** Permit private / loopback / link-local / metadata addresses. Default false. */
  allowPrivateIps?: boolean;
  /**
   * Permit hostnames that cannot be a public endpoint (`localhost`,
   * `*.internal`, in-cluster DNS, ...). Defaults to the value of
   * `allowPrivateIps`, because those hostnames only ever resolve privately.
   */
  allowLocalHostnames?: boolean;
}

const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'ip6-localhost',
  'ip6-loopback',
  'host.docker.internal',
  'host.containers.internal',
]);

const FORBIDDEN_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  '.cluster.local',
  '.svc',
];

/**
 * Hostnames that can only ever name an internal service. Checked statically so
 * a URL is rejected at registration time without spending a DNS query on it —
 * resolution itself is enforced later, at connect time, where it cannot be
 * raced with the request.
 */
export function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (FORBIDDEN_HOSTNAMES.has(host)) return true;
  return FORBIDDEN_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function normalizeHosts(hosts?: Iterable<string>): Set<string> {
  const out = new Set<string>();
  if (hosts) {
    for (const host of hosts) out.add(String(host).toLowerCase().replace(/\.$/, ''));
  }
  return out;
}

/**
 * Validate a raw outbound URL against a policy: protocol, optional HTTPS, host
 * allowlist, statically-forbidden hostnames, and (for IP literals) private-range
 * blocking. Throws {@link SsrfError} when the URL is not allowed.
 *
 * This is the cheap, DNS-free half of the guard. The other half is
 * {@link createSecureLookup}, which applies the same private-range rule to the
 * addresses the hostname actually resolves to, at socket-connection time.
 */
export function validateOutboundUrl(rawUrl: string, policy: SsrfPolicy = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('Malformed outbound URL', rawUrl, 'malformed-url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`Blocked protocol "${parsed.protocol}"`, rawUrl, 'protocol');
  }

  if (policy.requireHttps && parsed.protocol !== 'https:') {
    throw new SsrfError('HTTPS is required for outbound URLs', rawUrl, 'https-required');
  }

  // `new URL` keeps IPv6 literals bracketed (`[::1]`), which `net.isIP` cannot
  // parse, and preserves a trailing root dot (`foo.internal.`).
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const ipLiteral = host.replace(/^\[(.*)\]$/, '$1');
  const allow = normalizeHosts(policy.allowedHosts);
  if (allow.size > 0 && !allow.has(host)) {
    throw new SsrfError(`Host "${host}" is not in the allowlist`, rawUrl, 'allowlist');
  }

  const allowLocalHostnames = policy.allowLocalHostnames ?? policy.allowPrivateIps ?? false;
  if (!allowLocalHostnames && isForbiddenHostname(host)) {
    throw new SsrfError(`Host "${host}" names an internal service`, rawUrl, 'forbidden-host');
  }

  if (net.isIP(ipLiteral) && !policy.allowPrivateIps && isPrivateIp(ipLiteral)) {
    throw new SsrfError(`Host "${host}" is in a private range`, rawUrl, 'private-ip');
  }

  return parsed;
}
