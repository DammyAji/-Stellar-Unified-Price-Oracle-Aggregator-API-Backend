#!/usr/bin/env node
// Issue #590 — fail CI when declared aggregator ports drift from the ones the
// configuration derives.
//
// Model: PORT (.env.example) is an offset base that is NEVER bound. The
// aggregator listens on base + 1 (WebSocket, infrastructure/ws-server.ts) and
// base + 2 (health + /metrics on one HTTP listener, src/index.ts HealthServer).
// k8s Service/Deployment, docker-compose, terraform, configmaps, docs and the
// ServiceMonitor must all agree on those two real ports — and never declare a
// listener on the base port.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const passed = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function check(label, ok, detail = '') {
  if (ok) {
    passed.push(label);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name.replace(/\\/g, '/'));
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// ── 1. Derive the ports from configuration ──────────────────────────────────

const envExample = read('.env.example');
const baseMatch = envExample.match(/^PORT=(\d+)\s*$/m);
check('.env.example declares PORT (offset base)', Boolean(baseMatch));
const base = baseMatch ? parseInt(baseMatch[1], 10) : 0;

const wsSrc = read('services/aggregator/src/infrastructure/ws-server.ts');
const wsOffsets = [...wsSrc.matchAll(/port\s*\+\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
const wsOffset = wsOffsets[0] ?? 1;
check(
  'ws-server.ts binds PORT + 1 consistently',
  wsOffsets.length > 0 && wsOffsets.every((o) => o === wsOffset),
  `found offsets: ${[...new Set(wsOffsets)].join(', ')}`,
);

const idxSrc = read('services/aggregator/src/index.ts');
const httpMatch = idxSrc.match(/new HealthServer\(config\.port\s*\+\s*(\d+)/);
check('index.ts HealthServer binds PORT + N', Boolean(httpMatch));
const httpOffset = httpMatch ? parseInt(httpMatch[1], 10) : 2;

const ws = base + wsOffset;
const http = base + httpOffset;
const ports = { base, ws, http };
console.log(`Derived ports: base=${base} (unbound), ws=${ws}, health+metrics=${http}`);

// ── 2. k8s manifests must not declare a listener on the base port ───────────

const basePortDecl = new RegExp(`(port|containerPort|number|targetPort):\\s*"?(\\d+)"?`, 'g');
for (const file of walk('k8s')) {
  if (!/\.(ya?ml)$/.test(file)) continue;
  const text = read(file)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  for (const m of text.matchAll(basePortDecl)) {
    const value = parseInt(m[2], 10);
    if (value === base) {
      failures.push(`${file} declares ${m[1]}: ${value} — nothing listens on the base port`);
    }
  }
  for (const m of text.matchAll(/-\s*"(\d+)"/g)) {
    if (parseInt(m[1], 10) === base) {
      failures.push(`${file} allows "${m[1]}" — nothing listens on the base port`);
    }
  }
}
passed.push('k8s manifests declare no listener on the base port');

// ── 3. Required listeners are declared where they should be ─────────────────

const svc = read('k8s/base/aggregator/service.yaml');
check('service.yaml exposes ws-internal on ws', new RegExp(`port:\\s*${ws}\\b`).test(svc) && svc.includes('name: ws-internal'));
check(
  'service.yaml exposes http-metrics on http (health+/metrics listener)',
  new RegExp(`port:\\s*${http}\\b`).test(svc) && svc.includes('name: http-metrics'),
);

const deploy = read('k8s/base/aggregator/deployment.yaml');
check('deployment.yaml containerPorts include ws', new RegExp(`containerPort:\\s*${ws}\\b`).test(deploy));
check('deployment.yaml containerPorts include http', new RegExp(`containerPort:\\s*${http}\\b`).test(deploy));

const sm = read('k8s/base/aggregator/service-monitor.yaml');
check('ServiceMonitor scrapes the http-metrics service port', /port:\s*http-metrics/.test(sm) && /path:\s*\/metrics/.test(sm));

for (const file of walk('k8s').filter((f) => /configmap.*\.ya?ml$/.test(f))) {
  const text = read(file);
  const m = text.match(/AGGREGATOR_URL:\s*(\S+)/);
  if (!m) continue;
  check(`${file} AGGREGATOR_URL targets http (${http})`, m[1].endsWith(`:${http}`), m[1]);
}

// ── 4. docker-compose publishes only real listeners ─────────────────────────

const compose = read('docker-compose.yml');
check(`compose publishes ws ${ws}`, compose.includes(`"${ws}:${ws}"`));
check(`compose publishes http ${http}`, compose.includes(`"${http}:${http}"`));
check(`compose does not publish base ${base}`, !compose.includes(`"${base}:${base}"`));

// ── 5. Terraform agrees ─────────────────────────────────────────────────────

const tf = read('infrastructure/terraform/modules/aggregator/main.tf');
const tfNoComments = tf.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n');
check('terraform healthcheck hits http /health', tfNoComments.includes(`localhost:${http}/health`));
check('terraform declares no base port', !new RegExp(`\\b${base}\\b`).test(tfNoComments));
check('terraform portMappings include ws + http', tfNoComments.includes(`containerPort = ${ws}`) && tfNoComments.includes(`containerPort = ${http}`));

// ── 6. API client and docs agree ────────────────────────────────────────────

const apiConfig = read('api/src/infrastructure/config.ts');
check(`api aggregatorUrl default targets http (${http})`, apiConfig.includes(`http://localhost:${http}`));
check('api aggregatorUrl default does not target base', !apiConfig.includes(`http://localhost:${base}`));

const agents = read('AGENTS.md');
check('AGENTS.md port table has no base-port row', !new RegExp(`^\\|\\s*${base}\\s*\\|`, 'm').test(agents));
check('AGENTS.md port table lists ws + http rows', new RegExp(`^\\|\\s*${ws}\\s*\\|`, 'm').test(agents) && new RegExp(`^\\|\\s*${http}\\s*\\|`, 'm').test(agents));

const monReadme = read('monitoring/README.md');
check(`monitoring/README.md documents /metrics on ${http}`, monReadme.includes(`/metrics\` on port ${http}`));

const k6 = read('load-tests/k6/websocket-benchmark.js');
check(`k6 websocket benchmark targets ws://${ws}`, k6.includes(`ws://localhost:${ws}`));

// ── Report ──────────────────────────────────────────────────────────────────

for (const p of passed) console.log(`ok   ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`\n${failures.length} port consistency failure(s) (issue #590)`);
  process.exit(1);
}
console.log(`\nAll ${passed.length} port consistency checks passed.`);
