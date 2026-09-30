import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const p95Latency = new Trend('p95_latency', true);
const errorRate = new Rate('error_rate');
const requestCount = new Counter('request_count');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || '';

const headers = API_KEY ? { 'x-api-key': API_KEY } : {};

// Load-test contract (issue #618).
//
// Gating scenario: `smoke` runs on relevant pull requests (short tier) and
// `load`/`spike` run on the schedule / pre-release (full tier). The run fails
// on any threshold breach rather than only reporting.
//
// Thresholds trace to the SLOs in monitoring/slo.yml:
//   - availability 99.9%  -> http_req_failed rate<0.001, error_rate rate<0.001
//   - latency p95 < 500ms -> http_req_duration p(95)<500
//   - latency p99 < 1000ms -> http_req_duration p(99)<1000
//   - throughput floor    -> http_reqs rate>50 (requests/second)
//
// The target environment is deterministic: the same stub stack the integration
// job uses (docker compose up, BASE_URL=http://localhost:3000).
//
// Baseline: results are archived as artifacts and compared against the stored
// baseline in load-tests/results/. To update the baseline after an intentional
// change, run the full tier, review the delta, and commit the new summary as
// load-tests/results/baseline.json (see load-tests/README.md).
const TIER = __ENV.LOAD_TEST_TIER || 'full';
const isShortTier = TIER === 'short';

const scenarios = isShortTier
  ? {
      smoke: {
        executor: 'constant-vus',
        vus: 2,
        duration: '30s',
        tags: { scenario: 'smoke' },
      },
    }
  : {
      smoke: {
        executor: 'constant-vus',
        vus: 2,
        duration: '30s',
        tags: { scenario: 'smoke' },
      },
      load: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '30s', target: 20 },
          { duration: '1m', target: 20 },
          { duration: '30s', target: 0 },
        ],
        gracefulRampDown: '10s',
        tags: { scenario: 'load' },
      },
      spike: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '10s', target: 50 },
          { duration: '20s', target: 50 },
          { duration: '10s', target: 0 },
        ],
        startTime: '2m30s',
        tags: { scenario: 'spike' },
      },
    };

export const options = {
  scenarios,
  thresholds: {
    // Latency SLOs (monitoring/slo.yml).
    http_req_duration: ['p(50)<200', 'p(95)<500', 'p(99)<1000'],
    // Availability SLO: 99.9% success -> error rate below 0.1%.
    error_rate: ['rate<0.001'],
    http_req_failed: ['rate<0.001'],
    // Throughput floor so a throughput regression also fails the gate.
    http_reqs: ['rate>50'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/v1/prices`, { headers });
  requestCount.add(1);
  p95Latency.add(res.timings.duration);
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has prices': (r) => {
      try { return Array.isArray(JSON.parse(r.body).data?.prices); } catch { return false; }
    },
  });
  errorRate.add(!ok);
  sleep(1);
}

export function setup() {
  const res = http.get(`${BASE_URL}/api/v1/health/live`);
  if (res.status !== 200) {
    throw new Error(`API not reachable: ${res.status}`);
  }
}
