# API key store (issue #591)

API key state used to live only in the `ApiKeyManager` process-local `Map`,
seeded from the `API_KEYS` environment variable and mirrored into Vault at
bootstrap. That meant every replica generated its own default admin key, a key
created on one replica did not exist on another, and a revocation took effect
only on the replica that processed it — usually not the one serving the next
request. Restarting a replica also dropped anything created after boot.

This document is the contract for how that state is shared now.

## The store

`api/src/governance/api-key-store.ts` defines a three-method interface:

```ts
interface ApiKeyStore {
  readonly kind: 'memory' | 'redis';
  load(): Promise<ApiKeyMetadata[]>;   // full snapshot
  put(entry: ApiKeyMetadata): Promise<void>;
  remove(keyHash: string): Promise<void>;
}
```

Two implementations:

| Store | Selected when | Shared | Survives restart |
|---|---|---|---|
| `InMemoryApiKeyStore` | `API_KEY_STORE=memory`, or no `REDIS_URL` | No — one per process | No |
| `RedisApiKeyStore` | `API_KEY_STORE=redis` with `REDIS_URL` set | Yes — all replicas | Yes |

Redis was chosen over Vault or the primary database because it is already part
of the deployment (the L2 price cache and the rate limiter both use it), it has
no per-request latency budget attached to key reads, and a key hash read is
independent of database availability — an API that cannot reach TimescaleDB can
still authenticate. Vault remains in place as the durable *secret* store for the
bootstrap path; it is not on the request path.

The Redis layout is a single hash, `oracle:api-keys`, with `keyHash` as the
field and the JSON `ApiKeyMetadata` as the value — one `HGETALL` gives a replica
its whole snapshot.

## Propagation and the staleness window

Mutations are applied to the local mirror immediately and written through to the
store. Reads are served from the local mirror, so they stay synchronous.

Each replica re-reads the full snapshot every `API_KEY_STORE_REFRESH_MS`
(default **1000 ms**) via `apiKeyManager.startRefresh()`. **The refresh interval
is the documented staleness window**: a create, revoke, rotation or tier change
is visible on every replica within one interval of the write completing.

`apiKeyManager.flush()` awaits every queued write. Tests (and any operator
code that needs read-your-own-write across processes) call `flush()` on the
writing replica and `refresh()` on the reading one instead of sleeping.

`lastUsed` and `requestCount` are per-replica activity counters, not shared
state: a refresh keeps the locally observed values rather than overwriting them
with another replica's.

## Bootstrap

`apiKeyManager.initialize()` runs before anything else in `initializeApp()`:

1. Load the full snapshot from the store.
2. If the store is **non-empty**, it wins — whatever this replica parsed from
   `API_KEYS` in its constructor is discarded. `API_KEYS` seeds an empty store
   and is not an override.
3. If the store is **empty**, the locally loaded keys (from `API_KEYS`, or the
   auto-generated default admin key when `API_KEYS` is unset) are written into
   it, so the *first* replica to boot defines the key set and every later
   replica — including after a full restart — reads the same one.

Vault bootstrapping in `index.ts` runs after this and writes through to the
store as well, so keys imported from Vault reach every replica.

## Store-unavailable behaviour: fail closed

When a `load()` or `put()` fails, the manager sets `isStoreHealthy = false` and
every validation fails closed until a subsequent `refresh()` succeeds:

- `validateKey()` → `{ valid: false, error: 'API key store unavailable' }`
- `isAdminKey()` → `false`
- `checkRateLimit()` → `{ allowed: false, remaining: 0, resetTime: 0 }`

Serving stale credentials after the store has become unreachable is the one
defensible-free default here: a replica that cannot read revocations cannot
honestly claim a key is still active. The same applies at bootstrap — a replica
that cannot read the key set starts, but authenticates nothing. `init`,
`/readyz` and the API key audit test continue to reflect store state; recovery
is automatic on the next successful refresh.

Set `API_KEY_STORE_FAIL_CLOSED=false` only for local development.

## Export / import: the hash is authoritative

`exportKeysForVault()` writes `key: ''`. That is deliberate and now the
documented contract:

- Plaintext keys are generated once, returned to the caller, and never stored
  anywhere — not in memory beyond the map key (which is the SHA-256 hash), not
  in the store, not in Vault.
- Validation hashes the presented key and looks the hash up. `keyHash` is
  therefore the only field a round trip needs, and `export -> import` restores a
  fully validatable key without persisting the secret.
- `loadKeysFromVault()` no longer depends on `entry.key` for the display prefix;
  it falls back to `keyPrefix`, then to the first 12 characters of `keyHash`.

## Tests

`api/tests/governance/api-key-store.test.ts` covers the acceptance criteria:

- a key created on replica A validates on replica B sharing the store;
- revocation, reactivation, rotation, deletion, tier and rate-limit updates all
  propagate;
- staleness is observable *until* a refresh, then converges (the window), plus a
  real-timer background-refresh test;
- both replicas over the same Redis hash propagate create and revoke;
- env seeding happens only against an empty store and never overrides it;
- store-unavailable fails closed at bootstrap, on refresh, and on write, and
  recovers when the store answers again;
- export/import round trip preserves a usable key while the plaintext never
  appears in the persisted bytes;
- `RedisApiKeyStore` round-trips, skips unparsable entries, and surfaces
  connection failures.

Run with:

```
cd api && npx vitest run tests/governance
```
