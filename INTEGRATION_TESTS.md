# Integration Tests

Integration tests validate the full data pipeline end to end:

1. **Source Fetching** — a local stub replaces the four upstream oracle APIs
   (Chainlink, Redstone, Band, Reflector) so tests never depend on external
   network connectivity.
2. **Aggregation** — the real aggregator polls the stub, computes the median,
   and writes history files.
3. **API Serving** — the real API reads the history files written by the
   aggregator and serves them via REST.

## Running Integration Tests Locally

From the repository root, run:

```sh
npm run test:integration
```

That is the complete command. No symlinks, no hand-started processes, no
manually injected API keys.

`scripts/integration-test.mjs` orchestrates the full sequence:

| Step | What happens |
|------|-------------|
| 1 | Builds all backend packages (`npm run build:backend`) |
| 2 | Starts the stub oracle server on port 4010 |
| 3 | Creates a hermetic shared data directory in `$TMPDIR` |
| 4 | Starts the aggregator pointing at the stub and the shared dir via `HISTORY_DIR` |
| 5 | Starts the API pointing at the same shared dir via `HISTORY_DIR` |
| 6 | Waits for `/api/v1/health` and the aggregator `/health` to return 200 |
| 7 | Runs the three gated vitest test files with `RUN_INTEGRATION_TESTS=1` |
| 8 | Kills all child processes and removes the temp directory (success **and** failure) |
| 9 | Exits with the vitest exit code |

### Skip the build step

If you have already built (`npm run build:backend`) and are iterating on the
tests themselves, skip the rebuild:

```sh
SKIP_BUILD=1 npm run test:integration
```

### Environment variables

All are optional; the defaults match the CI job.

| Variable | Default | Description |
|---|---|---|
| `SKIP_BUILD` | unset | Set to `1` to skip the build step |
| `API_PORT` | `3000` | API HTTP port |
| `WS_PORT` | `3001` | API WebSocket port |
| `AGG_PORT` | `4000` | Aggregator base port (WS=+1, health=+2) |
| `STUB_PORT` | `4010` | Stub oracle server port |
| `TEST_API_KEY` | `test-key` | Injected into `API_KEYS`; passed to vitest as `TEST_API_KEY` |
| `POLLING_INTERVAL_MS` | `1000` | Aggregator poll cadence |
| `WATCHED_ASSETS` | `XLM,USDC` | Comma-separated assets the aggregator tracks |
| `SSRF_ALLOW_PRIVATE_IPS` | `true` | Bypass the SSRF guard for loopback connections |
| `WS_REQUIRE_ORIGIN` | `false` | Skip WebSocket Origin check in tests |

## Test Files

The integration suite consists of three gated vitest files in `api/tests/`:

| File | What it covers |
|---|---|
| `integration.test.ts` | Full data pipeline: price endpoints, WebSocket, aggregator health |
| `v2-assets.test.ts` | v2 `/assets` endpoint — asset discovery and metadata |
| `v2-batch-prices.test.ts` | v2 `/prices/batch` — batch price queries |

All three use `describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)` so they are
excluded from the ordinary `npm run test:api` run.

## CI

The `api-integration` job in `.github/workflows/ci.yml` runs exactly the same
command:

```yaml
- name: Run integration tests (build + stack + tests + teardown)
  env:
    SSRF_ALLOW_PRIVATE_IPS: 'true'
    WS_REQUIRE_ORIGIN: 'false'
    TEST_API_KEY: 'integration-ci-key'
  run: npm run test:integration
```

CI and contributors use the same entry point and the same script.

## Cleanup guarantees

`scripts/integration-test.mjs` registers `process.on('exit')`, `SIGINT`, and
`SIGTERM` handlers that:

- Send `SIGTERM` to every child process (stub, aggregator, API).
- Remove the shared temporary data directory.

This means no orphaned node processes and no partially-written data survive a
failure or a Ctrl-C.

## Architecture note: why no symlink?

The old setup required:

```sh
rm -rf api/data && ln -s "$PWD/services/aggregator/data" api/data
```

because each service resolved its data directory relative to its own `dist`
folder. The fix adds `HISTORY_DIR` support to both:

- `services/aggregator/src/persistence/history.ts` — `DATA_DIR` reads from
  `process.env.HISTORY_DIR` when set.
- `api/src/price-serving/price-store.ts` — `DATA_DIR` reads from
  `process.env.HISTORY_DIR` when set.

Both fall back to the original relative path when `HISTORY_DIR` is absent, so
existing Docker deployments and the `docker-compose.yml` stack are unaffected.

## Debugging

To keep the child-process logs after a run, redirect them:

```sh
SKIP_BUILD=1 npm run test:integration 2>&1 | tee /tmp/integration-run.log
```

The script prefixes every log line with the service name (`[aggregator]`,
`[api]`, `[stub-oracle]`, `[vitest]`) so you can filter:

```sh
grep '^\[aggregator\]' /tmp/integration-run.log
```

To test against a stack you started manually, boot the services first and then
run only vitest:

```sh
RUN_INTEGRATION_TESTS=1 TEST_API_KEY=test-key \
  npx vitest run api/tests/integration.test.ts \
                 api/tests/v2-assets.test.ts \
                 api/tests/v2-batch-prices.test.ts
```
