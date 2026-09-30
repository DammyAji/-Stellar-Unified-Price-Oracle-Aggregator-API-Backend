#!/usr/bin/env node
/**
 * scripts/integration-test.mjs
 *
 * One-command integration-test orchestrator for issue #619.
 *
 * Usage
 * -----
 *   node scripts/integration-test.mjs            # build + run
 *   SKIP_BUILD=1 node scripts/integration-test.mjs  # skip build (CI reuse)
 *
 * What it does
 * ------------
 *   1. Optionally builds all backend packages (SKIP_BUILD=1 to skip).
 *   2. Starts scripts/stub-oracle-server.mjs on STUB_PORT (default 4010).
 *   3. Creates a shared data directory (no symlink required).
 *   4. Starts the aggregator with HISTORY_DIR pointing at the shared dir.
 *   5. Starts the API with HISTORY_DIR pointing at the same shared dir.
 *   6. Waits for the API /health endpoint to return 200.
 *   7. Runs the three gated vitest integration test files with
 *      RUN_INTEGRATION_TESTS=1 and TEST_API_KEY set.
 *   8. Tears down all child processes on exit (success or failure).
 *   9. Propagates the vitest exit code.
 *
 * Environment variables (all optional)
 * -------------------------------------
 *   SKIP_BUILD=1          Skip the npm run build:backend step.
 *   API_PORT              API HTTP port          (default 3000)
 *   WS_PORT               API WebSocket port     (default 3001)
 *   AGG_PORT              Aggregator base port   (default 4000)
 *   STUB_PORT             Stub oracle port       (default 4010)
 *   TEST_API_KEY          API key injected into tests (default test-key)
 *   POLLING_INTERVAL_MS   Aggregator poll cadence (default 1000)
 *   WATCHED_ASSETS        Comma-separated assets  (default XLM,USDC)
 *   SSRF_ALLOW_PRIVATE_IPS  Bypass SSRF guard in tests (default true)
 *   WS_REQUIRE_ORIGIN     Origin enforcement     (default false)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ── Configuration ──────────────────────────────────────────────────────────────

const ROOT = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const API_PORT       = parseInt(process.env.API_PORT || '3000', 10);
const WS_PORT        = parseInt(process.env.WS_PORT || '3001', 10);
const AGG_PORT       = parseInt(process.env.AGG_PORT || '4000', 10);
const AGG_WS_PORT    = AGG_PORT + 1;   // aggregator websocket: PORT + 1
const AGG_HEALTH     = AGG_PORT + 2;   // aggregator health:    PORT + 2
const STUB_PORT      = parseInt(process.env.STUB_PORT || '4010', 10);
const TEST_API_KEY   = process.env.TEST_API_KEY || 'test-key';
const SKIP_BUILD     = process.env.SKIP_BUILD === '1' || process.env.SKIP_BUILD === 'true';
const POLLING_MS     = process.env.POLLING_INTERVAL_MS || '1000';
const WATCHED_ASSETS = process.env.WATCHED_ASSETS || 'XLM,USDC';

// Shared hermetic data directory — no symlink required.
const HISTORY_DIR = join(tmpdir(), `stellar-oracle-integration-${process.pid}`);

const children = [];
let testExitCode = 1;

// ── Cleanup ────────────────────────────────────────────────────────────────────

function cleanup() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  }
  try { rmSync(HISTORY_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.on('exit', cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('uncaughtException', (err) => {
  console.error('[integration] uncaughtException:', err);
  cleanup();
  process.exit(1);
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[integration] ${msg}`);
}

/**
 * Spawn a child process, register it for cleanup, and stream its output
 * under a labelled prefix. Never resolves (background daemon).
 */
function background(label, cmd, args, env = {}) {
  log(`starting ${label}: ${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      log(`${label} exited with code ${code}`);
    }
  });
  return child;
}

/**
 * Spawn a command and wait for it to exit, forwarding its stdio to ours.
 * Rejects if the process exits non-zero.
 */
function run(label, cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    log(`running ${label}: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

/**
 * Poll a URL until it responds with a 2xx status.
 * Throws if maxAttempts is exceeded.
 */
async function waitForHttp(url, maxAttempts = 60, intervalMs = 2000) {
  log(`waiting for ${url} …`);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) { log(`${url} is ready`); return; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${url} did not become ready after ${maxAttempts} attempts`);
}

// ── Step 1: Build ──────────────────────────────────────────────────────────────

if (!SKIP_BUILD) {
  log('building backend packages …');
  await run('build', 'npm', ['run', 'build:backend']);
} else {
  log('SKIP_BUILD=1 — skipping build');
}

// ── Step 2: Create shared data directory ──────────────────────────────────────

mkdirSync(HISTORY_DIR, { recursive: true });
log(`shared data directory: ${HISTORY_DIR}`);

// ── Step 3: Start stub oracle server ──────────────────────────────────────────

background('stub-oracle', 'node', ['scripts/stub-oracle-server.mjs'], {
  STUB_ORACLE_PORT: String(STUB_PORT),
});
await new Promise((r) => setTimeout(r, 500)); // brief settle

// ── Step 4: Start aggregator ───────────────────────────────────────────────────

background('aggregator', 'node', ['services/aggregator/dist/index.js'], {
  PORT:                    String(AGG_PORT),
  HISTORY_DIR,
  POLLING_INTERVAL_MS:     POLLING_MS,
  WATCHED_ASSETS,
  SSRF_ALLOW_PRIVATE_IPS:  'true',
  WS_REQUIRE_ORIGIN:       'false',
  CHAINLINK_BASE_URL:      `http://localhost:${STUB_PORT}`,
  REDSTONE_BASE_URL:       `http://localhost:${STUB_PORT}`,
  BAND_BASE_URL:           `http://localhost:${STUB_PORT}`,
  REFLECTOR_BASE_URL:      `http://localhost:${STUB_PORT}`,
  // Suppress contract-publishing startup noise in test output.
  SOROBAN_RPC_URL:         '',
  CONTRACT_ID:             '',
});

// ── Step 5: Start API ──────────────────────────────────────────────────────────

// Validate that TEST_API_KEY is non-empty so tests never silently get 401s.
if (!TEST_API_KEY) {
  console.error('[integration] ERROR: TEST_API_KEY is empty. Set it before running integration tests.');
  process.exit(1);
}
// API_KEYS format: key:rateLimit:description:tier:role
const API_KEYS = `${TEST_API_KEY}:10000:integration-test:pro:viewer`;

background('api', 'node', ['api/dist/index.js'], {
  API_PORT:           String(API_PORT),
  WS_PORT:            String(WS_PORT),
  PORT:               String(API_PORT),
  HISTORY_DIR,
  API_KEYS,
  WS_REQUIRE_ORIGIN:  'false',
  AGGREGATOR_URL:     `http://localhost:${AGG_HEALTH}`,
});

// ── Step 6: Wait for readiness ─────────────────────────────────────────────────

await waitForHttp(`http://localhost:${API_PORT}/api/v1/health`);
await waitForHttp(`http://localhost:${AGG_HEALTH}/health`);

// Give the aggregator a moment to write at least one price file before tests read.
log('waiting for first aggregator poll cycle …');
await new Promise((r) => setTimeout(r, parseInt(POLLING_MS, 10) * 3));

// ── Step 7: Run tests ──────────────────────────────────────────────────────────

log('running integration tests …');

const testFiles = [
  'tests/integration.test.ts',
  'tests/v2-assets.test.ts',
  'tests/v2-batch-prices.test.ts',
];

try {
  await run(
    'vitest',
    'npx',
    ['vitest', 'run', '--reporter=verbose', ...testFiles],
    {
      RUN_INTEGRATION_TESTS: '1',
      TEST_API_KEY,
      API_ORIGIN: `http://localhost:${API_PORT}`,
      WS_URL:     `ws://localhost:${WS_PORT}`,
      AGGREGATOR_WS_URL:    `ws://localhost:${AGG_WS_PORT}`,
      AGGREGATOR_HEALTH_URL:`http://localhost:${AGG_HEALTH}`,
    },
  );
  testExitCode = 0;
} catch {
  testExitCode = 1;
}

// ── Step 8: Teardown ───────────────────────────────────────────────────────────
// cleanup() is registered as a process.on('exit') handler above so it always
// runs. We set the exit code here and let process.exit trigger it.

log(`tests finished — exit code ${testExitCode}`);
process.exit(testExitCode);
