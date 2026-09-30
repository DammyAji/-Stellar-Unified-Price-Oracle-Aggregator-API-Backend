import { Agent } from 'undici';
import {
  createSecureLookup,
  isSsrfError,
  type SsrfError,
  type SsrfPolicy,
} from '@stellar-oracle/ssrf-guard';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';

/**
 * Egress policy for user-supplied webhook URLs (issue #600).
 *
 * Webhooks are the API's only destination chosen by a caller, so they get the
 * same guard the aggregator uses for oracle egress — protocol, allowlist,
 * private-range blocking, redirect refusal and connect-time pinning — built
 * from one shared implementation rather than a second copy of the range tables.
 *
 * The policy is built per call so a per-tenant allowlist applies to both
 * registration and delivery without threading state through the service.
 *
 * Tenant resolution: if `WEBHOOK_ALLOWED_HOSTS_BY_TENANT` has an entry for the
 * caller's API key prefix, that list is the allowlist for this webhook; if it
 * has no entry, the global `WEBHOOK_ALLOWED_HOSTS` applies. A tenant entry
 * therefore narrows, and cannot widen, the global policy.
 */
export function webhookSsrfPolicy(apiKeyPrefix?: string): SsrfPolicy {
  const webhooks = (config.webhooks ?? {}) as Partial<typeof config.webhooks>;
  const tenantHosts = apiKeyPrefix
    ? webhooks.allowedHostsByTenant?.[apiKeyPrefix.toLowerCase()]
    : undefined;
  // Anything that is not a non-empty list of hosts is ignored, so a malformed
  // value falls back to the global allowlist instead of widening it.
  const useTenantHosts = Array.isArray(tenantHosts) && tenantHosts.length > 0;
  const allowedHosts = useTenantHosts ? tenantHosts : webhooks.allowedHosts ?? [];

  return {
    // `!== false` so a partial config (tests stub the config module) still
    // resolves to the secure default rather than silently permitting http.
    requireHttps: webhooks.requireHttps !== false,
    allowedHosts,
    allowPrivateIps: isPrivateIpsAllowed(),
    // A private-only hostname is exactly what a private-IP deployment means,
    // so the two switches move together.
    allowLocalHostnames: isPrivateIpsAllowed(),
  };
}

export function isPrivateIpsAllowed(): boolean {
  return ((config.webhooks ?? {}) as Partial<typeof config.webhooks>).allowPrivateIps === true;
}

let dispatcher: Agent | null = null;

/**
 * The undici dispatcher used for every delivery. Its connect-time `lookup`
 * re-resolves the host for each attempt and refuses any answer in a private,
 * loopback, link-local or metadata range, handing the socket only a surviving
 * address — so the address the policy approved is the address the request
 * actually uses, and a DNS answer that flips between check and connect cannot
 * win.
 *
 * Tests that stub `globalThis.fetch` never reach this, so no test performs DNS.
 */
export function getWebhookDispatcher(): Agent {
  if (!dispatcher) {
    dispatcher = new Agent({
      connect: {
        lookup: createSecureLookup({
          getPolicy: () => ({ allowPrivateIps: isPrivateIpsAllowed() }),
          onBlocked: (info) => {
            logger.warn('[Webhook][SSRF] Blocked delivery — resolved addresses are private', {
              webhookHost: info.host,
            });
          },
        }),
      },
    });
  }
  return dispatcher;
}

/** Test hook: drop the cached dispatcher so config changes take effect. */
export function resetWebhookDispatcher(): void {
  dispatcher = null;
}

/**
 * Map a delivery failure to a small fixed vocabulary.
 *
 * The raw error is never surfaced: undici and Node messages embed resolved
 * addresses, ports, proxy settings and stack context, which together describe
 * this process's surroundings. What the owner needs is the category.
 */
export function classifyDeliveryError(err: unknown): string {
  if (isSsrfError(err)) {
    return err.reason === 'dns-rebinding' ? 'blocked-resolution' : 'blocked-url';
  }

  const candidate = err as { name?: string; code?: string; cause?: { name?: string; code?: string } } | undefined;
  const names = [candidate?.name, candidate?.cause?.name];
  const codes = [candidate?.code, candidate?.cause?.code];
  if (names.includes('AbortError') || names.includes('TimeoutError')) return 'timeout';
  if (codes.includes('UND_ERR_CONNECT_TIMEOUT') || codes.includes('UND_ERR_HEADERS_TIMEOUT')) {
    return 'timeout';
  }
  return 'network-error';
}

/**
 * Registration-time rejection text. Every reason it reports is a property of
 * the URL the caller just supplied, so none of it describes our topology.
 */
export function describeUrlRejection(err: SsrfError): string {
  switch (err.reason) {
    case 'malformed-url':
      return 'Webhook URL is not a valid URL';
    case 'protocol':
      return 'Webhook URL must use http or https';
    case 'https-required':
      return 'Webhook URL must use https';
    case 'allowlist':
      return 'Webhook host is not an allowed destination';
    case 'forbidden-host':
      return 'Webhook host is not an allowed destination';
    case 'private-ip':
    case 'dns-rebinding':
      return 'Webhook host resolves to a non-public address';
    default:
      return 'Webhook URL is not an allowed destination';
  }
}
