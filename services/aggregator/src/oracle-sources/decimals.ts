import type { OracleSourceName } from '../infrastructure/types';

/**
 * Decimals contract shared by every oracle source.
 *
 * The numbers are the scale the aggregator's `normalize()` multiplies the raw
 * provider price by, and they must stay inside the range the Soroban contract
 * accepts (`OracleError::InvalidDecimals`, `contracts/price-oracle` — 0..=18),
 * otherwise a provider would be able to make the aggregator submit a value the
 * contract later rejects.
 *
 * Per-provider rationale and the source of truth for each default live in
 * `docs/ORACLE_SOURCE_DECIMALS.md`.
 */
export const MIN_DECIMALS = 0;
export const MAX_DECIMALS = 18;

export type DecimalsReason = 'decimals-missing' | 'decimals-malformed' | 'decimals-out-of-range';

/**
 * Raised when a provider payload cannot be trusted to describe its own scale.
 * `code` is the stable value callers and tests key off; `reason` says which of
 * the three provider-contract violations occurred.
 */
export class InvalidPayloadError extends Error {
  readonly code = 'invalid-payload';

  constructor(
    message: string,
    public readonly source: OracleSourceName,
    public readonly reason: DecimalsReason,
  ) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

export type DecimalsPolicy =
  /** The provider response carries `decimals`; a missing or invalid value fails the fetch. */
  | { kind: 'reported' }
  /** The provider response has no `decimals` field at all and its scale is fixed. */
  | { kind: 'fixed'; value: number };

/**
 * `chainlink` is the only fixed-scale provider: its payload is
 * `{ USD: { PRICE } }` with no scale field, so 8 dp is part of that endpoint's
 * contract rather than a fallback for a missing field. Every other provider
 * documents `decimals` in its response, so an absent value is a contract
 * change and must fail loudly instead of being papered over with a default.
 */
export const SOURCE_DECIMALS: Record<OracleSourceName, DecimalsPolicy> = {
  chainlink: { kind: 'fixed', value: 8 },
  redstone: { kind: 'reported' },
  band: { kind: 'reported' },
  reflector: { kind: 'reported' },
};

function assertInRange(decimals: number, source: OracleSourceName): number {
  if (!Number.isInteger(decimals)) {
    throw new InvalidPayloadError(
      `[${source}] reported non-integer decimals ${String(decimals)}`,
      source,
      'decimals-malformed',
    );
  }
  if (decimals < MIN_DECIMALS || decimals > MAX_DECIMALS) {
    throw new InvalidPayloadError(
      `[${source}] reported decimals ${decimals} outside contract range ${MIN_DECIMALS}..=${MAX_DECIMALS}`,
      source,
      'decimals-out-of-range',
    );
  }
  return decimals;
}

/**
 * Resolve the scale of a provider payload for `source`.
 *
 * `0` is a legitimate scale and is preserved — only `undefined`/`null` count as
 * "the field is absent". An absent field under the `reported` policy throws
 * {@link InvalidPayloadError} (`code: 'invalid-payload'`) so the failure is
 * attributed to the provider by `BaseSource.fetchWithBackoff` instead of
 * silently scaling the price by the wrong power of ten.
 */
export function resolveDecimals(source: OracleSourceName, reported: unknown): number {
  const policy = SOURCE_DECIMALS[source];

  if (policy.kind === 'fixed') {
    return assertInRange(policy.value, source);
  }

  if (reported === undefined || reported === null) {
    throw new InvalidPayloadError(
      `[${source}] payload has no "decimals" field`,
      source,
      'decimals-missing',
    );
  }

  if (typeof reported !== 'number') {
    throw new InvalidPayloadError(
      `[${source}] reported non-numeric decimals ${JSON.stringify(reported)}`,
      source,
      'decimals-malformed',
    );
  }

  return assertInRange(reported, source);
}
