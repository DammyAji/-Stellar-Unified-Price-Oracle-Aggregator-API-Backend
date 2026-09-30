# Oracle source decimals

Every price the aggregator publishes is a `bigint` scaled by `decimals`.
Sources do **not** agree on that scale, so the scale is part of the provider
contract, not a cosmetic detail: a wrong value shifts the price by
`10^(wrong - real)` before it is ever aggregated or submitted on-chain.

**Source of truth:** `services/aggregator/src/oracle-sources/decimals.ts`
(`SOURCE_DECIMALS` + `resolveDecimals`). This document records *why* each
policy was chosen; the code is what the runtime enforces.

## Per-provider policy

| Source | Policy | Scale | Why |
|---|---|---|---|
| `chainlink` | `fixed` | **8** | `GET /price` returns `{ USD: { PRICE } }` and has no `decimals` field at all. 8 dp is part of that endpoint's response contract, so it is declared as a fixed scale rather than being a fallback for a field the payload never contained. |
| `redstone` | `reported` | provider-reported | `GET /prices` returns `{ <SYMBOL>: { value, decimals } }`. The field is documented, so it is required. |
| `band` | `reported` | provider-reported | `GET /oracle/v1/feeds/<symbol>` returns `{ data: { price, decimals, updated_at } }`. The field is documented, so it is required. |
| `reflector` | `reported` | provider-reported | `GET /v1/prices` returns `{ prices: { <symbol>: { price, decimals, timestamp } } }`. The field is documented, so it is required. |

There is no default for the three `reported` providers. Historically each of
them used `decimals || <n>` (band `9`, reflector `8`, redstone `8`), which had
two failure modes:

1. `decimals: 0` is falsy, so a legitimate zero-scale feed was silently
   rescaled by `10^9`/`10^8`.
2. A payload with no `decimals` field at all was silently given a
   plausible-looking scale, hiding a provider contract change.

Both are now explicit failures.

## Failure behaviour

`resolveDecimals` throws `InvalidPayloadError` with `code: 'invalid-payload'`
and one of:

| `reason` | Meaning |
|---|---|
| `decimals-missing` | The field is absent (`undefined`/`null`). |
| `decimals-malformed` | Not an integer, or not a number at all. |
| `decimals-out-of-range` | Outside `0..=18`. |

`BaseSource.fetchWithBackoff` catches the throw, counts a **provider** failure
against that source's circuit breaker and health, retries, and finally returns
`null`. The failure is therefore attributed to the source that produced the bad
payload instead of surfacing later as a contract rejection.

## Contract range

The Soroban contract validates `0..=18` and rejects anything else with
`OracleError::InvalidDecimals` (`contracts/price-oracle/src/errors.rs`,
issue #569). `MIN_DECIMALS`/`MAX_DECIMALS` mirror that range so a bad payload
is rejected at the boundary where the provider can still be blamed, rather than
after a submission has been simulated and failed on-chain.

## Determinism of the scale

For a `reported` provider, the value the provider sends is used verbatim —
including `0`. The aggregator never substitutes, rounds, or infers a scale:

```
scaled_price = raw_price * 10^decimals
```

so two payloads for the same raw price at scales `d1` and `d2` always differ by
exactly `10^(d1 - d2)`. `tests/issue-585-source-decimals.test.ts` asserts that
identity directly for `0, 1, 8, 9, 18`.

## Where the tests live

- `services/aggregator/tests/issue-585-source-decimals.test.ts` —
  `decimals: 0`, absent, `null`, boundary (`0`, `18`, `19`, `-1`, non-integer),
  the exact power-of-ten scaling, and the per-source policy table.
- `services/aggregator/tests/oracle-sources.test.ts` — per-source fetch
  behaviour, including zero-decimals payloads and out-of-range rejection.

## Rollout note

Requiring `decimals` is a **contract change on our side**. If a provider
started omitting the field, that source would report a failure instead of
producing prices — which is the intended signal. Before enabling a new source,
confirm its payload actually carries `decimals`, and add it to
`SOURCE_DECIMALS` with its policy and rationale rather than inventing a
fallback.
