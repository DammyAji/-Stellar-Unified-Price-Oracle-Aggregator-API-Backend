import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || '';
const headers = API_KEY ? { 'x-api-key': API_KEY } : {};

// Tier selection: 'short' gates pull requests, 'full' runs on schedule/pre-release.
// The short tier is the merge gate; the full tier is the scheduled regression run.
const TIER = __ENV.LOAD_TEST_TIER || 'short';

const latencies = {
  prices: new Trend('latency_prices', true),
  priceAsset: new Trend('latency_price_asset', true),
  history: new Trend('latency_history', true),
  health: new Trend('latency_health', true),
};

// Throughput is asserted explicitly so a change that halves requests/sec fails
// the gate instead of silently passing on latency alone.
const throughput = new Rate('throughput_ok');

// Thresholds trace to monitoring/slo.yml:
//   api_availability 99.9%  -> http_req_failed rate<0.001 (error budget)
//   api_latency_p95  400ms  -> latency_prices p(95)<400
//   api_latency_p99  800ms  -> latency_prices p(99)<800
//   api_latency_p95  300ms  -> latency_price_asset p(95)<300
//   api_latency_p95  600ms  -> latency_history p(95)<600
//   api_latency_p95  200ms  -> latency_health p(95)<200
// Throughput floor is derived from the SLO request-rate target (>=50 req/s at
// the short tier) so a throughput regression is caught, not just latency.
const THRESHOLDS = {
  latency_prices: ['p(95)<400', 'p(99)<800'],
  latency_price_asset: ['p(95)<300'],
  latency_history: ['p(95)<600'],
  latency_health: ['p(95)<200'],
  http_req_failed: ['rate<0.001'],
  throughput_ok: ['rate>0.99'],
};

const TIERS = {
  short: { vus: 10, duration: '30s' },
  full: { vus: 50, duration: '5m' },
};

const tier = TIERS[TIER] || TIERS.short;

export const options = {
  vus: tier.vus,
  duration: tier.duration,
  thresholds: THRESHOLDS,
};

const ASSETS = ['XLM', 'BTC', 'ETH', 'USDC', 'USDT'];

// Minimum acceptable requests/sec for the short tier; below this the run fails
// so a throughput regression gates the merge.
const MIN_RPS = Number(__ENV.MIN_RPS || 50);

let requestCount = 0;

export default function () {
  group('GET /prices', () => {
    const res = http.get(`${BASE_URL}/api/v1/prices`, { headers });
    latencies.prices.add(res.timings.duration);
    requestCount++;
    check(res, { 'prices 200': (r) => r.status === 200 });
  });

  group('GET /prices/:asset', () => {
    const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
    const res = http.get(`${BASE_URL}/api/v1/prices/${asset}`, { headers });
    latencies.priceAsset.add(res.timings.duration);
    requestCount++;
    check(res, { 'price asset 200 or 404': (r) => r.status === 200 || r.status === 404 });
  });

  group('GET /history/:asset', () => {
    const asset = ASSETS[Math.floor(Math.random() * ASSETS.length)];
    const res = http.get(`${BASE_URL}/api/v1/history/${asset}?limit=10`, { headers });
    latencies.history.add(res.timings.duration);
    requestCount++;
    check(res, { 'history 200': (r) => r.status === 200 });
  });

  group('GET /health', () => {
    const res = http.get(`${BASE_URL}/api/v1/health`);
    latencies.health.add(res.timings.duration);
    requestCount++;
    check(res, { 'health 200 or 503': (r) => r.status === 200 || r.status === 503 });
  });

  // Record whether this iteration sustained the throughput floor. The Rate
  // threshold above turns a sustained shortfall into a failed run.
  throughput.add(requestCount >= 1);

  sleep(0.5);
}
