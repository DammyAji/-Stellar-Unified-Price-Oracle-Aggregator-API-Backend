# ADR: Kubernetes Health Probes — Separation of Liveness, Readiness, and Startup Concerns

**Date:** 2026-09-29  
**Status:** Accepted  
**Stakeholders:** Platform Engineering, DevOps, SRE, Backend Engineering

## Problem

Previously, both liveness and readiness probes pointed to a single `/health` endpoint that aggregated process state, dependency health, and data freshness. This configuration created several issues:

1. **Restart storms on dependency failures**: If a database or upstream service became unavailable, the liveness probe would fail, causing Kubernetes to restart the pod. The restart removed the process that could have recovered gracefully, converting a downstream outage into a fleet-wide restart cascade.

2. **Inability to tune independently**: Liveness (which protects against truly wedged processes) and readiness (which keeps unhealthy pods out of the load balancer) require different thresholds, check intervals, and delays. A single endpoint forced a one-size-fits-all compromise.

3. **No startup phase distinction**: The API and aggregator used fixed `initialDelaySeconds: 30` as a guess to avoid false restarts during startup. This is wrong in both directions:
   - Too short for slow regions or cold caches → unnecessary restarts during legitimate startup.
   - Too long for fast regions → pod sits in `CrashLoopBackOff` when startup actually fails.

4. **Probe path mismatches**: The k8s manifests were not verified against the actual routes exposed by the services, creating a gap where probe misconfiguration was not caught in CI.

## Solution

Implement three separate health probes with distinct semantics, all verified in CI:

### 1. Startup Probe (`startupProbe`)

**Purpose:** Detect slow but legitimate startups without triggering restarts during initialization.

**Endpoint:** `/api/v1/health/live` (API) or `/health/live` (aggregator)

**Semantics:** Only checks that the event loop is running; does not check dependencies or data freshness.

**Configuration:**
| Parameter | API | Aggregator | Rationale |
|-----------|-----|-----------|-----------|
| `path` | `/api/v1/health/live` | `/health/live` | Shallow liveness check |
| `port` | 3000 | 4002 | Health server ports |
| `initialDelaySeconds` | 0 | 0 | Start probing immediately |
| `periodSeconds` | 5 | 5 | Check every 5 seconds |
| `timeoutSeconds` | 2 | 2 | HTTP timeout |
| `failureThreshold` | 30 | 30 | Allows ~150 seconds startup (30 × 5s) |

**Behavior:**
- Runs from container startup until the first success.
- Once successful, **disables** readiness and liveness probes (they do not run until startup completes).
- If it fails 30 times, Kubernetes kills the pod as unrecoverable.
- Allows cold cache, slow DNS, and regional network delays without restarting.

**Startup time budget:** 150 seconds maximum (5s period × 30 failures). This accommodates:
- Slow cloud regions (10-30s for network setup).
- Cold caches with migration work (30-60s for database initialization).
- Moderate TLS handshake delays (5-10s per endpoint).

### 2. Readiness Probe (`readinessProbe`)

**Purpose:** Keep unhealthy pods out of the load balancer and traffic.

**Endpoint:** `/api/v1/health/ready` (API) or `/health/ready` (aggregator)

**Semantics:** Checks that all dependencies are reachable, data is fresh within the staleness bound, asset coverage meets minimum thresholds, and the instance is not paused/quarantined.

**Configuration:**
| Parameter | API | Aggregator | Rationale |
|-----------|-----|-----------|-----------|
| `path` | `/api/v1/health/ready` | `/health/ready` | Dependency check |
| `port` | 3000 | 4002 | Health server ports |
| `initialDelaySeconds` | 10 | 10 | Allow startup to progress |
| `periodSeconds` | 5 | 5 | Frequent checks (~5s) |
| `timeoutSeconds` | 2 | 2 | HTTP timeout |
| `failureThreshold` | 3 | 3 | 3 failures = 15 seconds → remove from endpoints |

**Behavior:**
- Pod removed from load balancer's endpoints list after 3 consecutive failures (~15 seconds).
- Allows Kubernetes to drain connections and redirect traffic to healthy replicas.
- Readiness failures do **not** restart the pod; they just hide it from traffic.
- Re-added automatically when it succeeds again.

**Dependency checks** (all cached/bounded):
- **Database**: Simple connectivity check with 1s timeout (not running transactions).
- **Cache**: Redis/memcached ping with 1s timeout.
- **Price data freshness**: Cached verdict (updated every 5s, not on every probe).
- **Asset coverage**: `available_assets / configured_assets ≥ MIN_ASSET_COVERAGE_PERCENT` (e.g., 80%).
- **Quarantine state**: Not paused by manual admin action or auto-quarantine.

### 3. Liveness Probe (`livenessProbe`)

**Purpose:** Detect truly wedged processes (event loop hung, out of memory, etc.) and force a restart.

**Endpoint:** `/api/v1/health/live` (API) or `/health/live` (aggregator)

**Semantics:** Only checks that the process is running and the event loop is responsive. Does **not** check dependencies, databases, caches, or data freshness.

**Configuration:**
| Parameter | API | Aggregator | Rationale |
|-----------|-----|-----------|-----------|
| `path` | `/api/v1/health/live` | `/health/live` | Shallow liveness check |
| `port` | 3000 | 4002 | Health server ports |
| `initialDelaySeconds` | 30 | 30 | Give startup time |
| `periodSeconds` | 10 | 10 | Slower than readiness |
| `timeoutSeconds` | 2 | 2 | HTTP timeout |
| `failureThreshold` | 5 | 5 | 5 failures = 50 seconds → restart |

**Behavior:**
- Restarts the pod if it fails 5 times (~50 seconds of unresponsiveness).
- Does **not** check dependencies, preventing restart storms.
- Only fires if the event loop is truly wedged or the process is hung.

**Why liveness is intentionally shallow:**
```
A liveness probe that checks dependencies creates a restart storm:

  Database down
    ↓
  Liveness probe fails
    ↓
  Kubernetes restarts pod
    ↓
  New pod also checks dependencies
    ↓
  Database still down → new pod also fails
    ↓
  CrashLoopBackOff across entire fleet

Solution: Liveness only checks process health. Dependencies are monitored
via readiness (keeps pod out of rotation) and alerting (pages on-call).
A pod can be "alive" and "not ready"—that is the healthy state for
handling transient dependency issues.
```

## Implementation Details

### For API (`k8s/base/api/deployment-stable.yaml`)

```yaml
containers:
  - name: api
    ports:
      - name: http
        containerPort: 3000
    startupProbe:
      httpGet:
        path: /api/v1/health/live
        port: http
      initialDelaySeconds: 0
      periodSeconds: 5
      failureThreshold: 30
    readinessProbe:
      httpGet:
        path: /api/v1/health/ready
        port: http
      initialDelaySeconds: 10
      periodSeconds: 5
      failureThreshold: 3
    livenessProbe:
      httpGet:
        path: /api/v1/health/live
        port: http
      initialDelaySeconds: 30
      periodSeconds: 10
      failureThreshold: 5
```

### For Aggregator (`k8s/base/aggregator/deployment.yaml`)

```yaml
containers:
  - name: aggregator
    ports:
      - name: http-health
        containerPort: 4002
    startupProbe:
      httpGet:
        path: /health/live
        port: http-health
      initialDelaySeconds: 0
      periodSeconds: 5
      failureThreshold: 30
    readinessProbe:
      httpGet:
        path: /health/ready
        port: http-health
      initialDelaySeconds: 10
      periodSeconds: 5
      failureThreshold: 3
    livenessProbe:
      httpGet:
        path: /health/live
        port: http-health
      initialDelaySeconds: 30
      periodSeconds: 10
      failureThreshold: 5
```

### Routes Exposed by Services

#### API (`api/src/price-serving/v1.ts`)
- `GET /api/v1/health/live` → `{ status: 'alive', uptime: <seconds> }`
- `GET /api/v1/health/ready` → `{ status: 'ready' | 'not_ready', assetsTracked: <int> }` (status 200 or 503)
- `GET /api/v1/health` → comprehensive health status (for external monitoring)

#### Aggregator (`services/aggregator/src/observability/health-server.ts`)
- `GET /health/live` → `{ status: 'alive', uptime: <seconds> }`
- `GET /health/ready` → `{ status: 'ready' | 'not_ready', ... }` (status 200 or 503)
- `GET /health` → comprehensive health status (for external monitoring)

Both services expose `/metrics` for Prometheus.

## Verification in CI

**Test files:**
- `api/tests/k8s-health-probes.test.ts` — verifies API probe configuration and route availability.
- `services/aggregator/tests/k8s-health-probes.test.ts` — verifies aggregator probe configuration and route availability.

**Test strategy:**
1. Parse the k8s deployment YAML.
2. Assert probe paths match the expected service routes.
3. Assert probe timing (failure threshold, period, delays) matches policy.
4. Fail fast in CI if probes are misconfigured or routes don't exist.

## Benefits

| Problem | Before | After |
|---------|--------|-------|
| **Restart storms on dependency outages** | Liveness checked deps → restart cascade | Readiness hides pod; liveness ignores deps |
| **Slow startups triggering restarts** | Fixed 30s guess; wrong in both directions | ~150s startup budget; adapts to region |
| **Load balancer serving unhealthy pods** | Single endpoint; readiness ≈ liveness | Readiness removed from endpoints in 15s |
| **Probe misconfiguration not caught** | Manual review only | Automated CI test |
| **Untunable probes** | One-size-fits-all thresholds | Independent tuning per concern |

## Trade-offs

1. **More complexity**: Three probes instead of one.
   - **Mitigated by**: Clear separation of concerns; good documentation; automated CI verification.

2. **More HTTP calls**: Startup (frequent for 150s) + readiness (every 5s) + liveness (every 10s).
   - **Impact**: Negligible (health server runs on separate port; not competing with API traffic).
   - **Benefit**: Much better diagnosability; faster failure detection.

## Monitoring and Alerts

**Metrics to track:**
- Probe failure rates (startup, readiness, liveness) by pod/region.
- Time-to-ready (how long startup takes).
- Readiness churn (pods frequently entering/leaving ready state).

**Alerts:**
- Startup probe failures → investigate slow startup; check regional DNS, network latency, database initialization time.
- Readiness failures → check dependency health (DB, Redis); check asset coverage; check staleness thresholds.
- Liveness failures → investigate event loop hangs; check memory pressure; file handles; CPU limits.

## Related Documents

- `docs/adr/readiness-semantics.md` — detailed readiness endpoint behavior and dependencies.
- `api/docs/API.md` → `/health` endpoints section.
- Runbook: `docs/runbooks/pod-crashes-debugging.md` — diagnose probe-related crashes.

## Appendix: Startup Time Budget Justification

The 150-second startup budget (30 failures × 5s period) is based on:

| Component | Worst-case time | Notes |
|-----------|-----------------|-------|
| Network initialization | 15s | Cloud region spinup, DNS resolution |
| TLS handshakes (3-5 endpoints) | 15-20s | Including timeouts for unreachable services |
| Database connection pool warm-up | 20-30s | Reusing connections; not full migrations |
| Redis cluster discovery | 10-15s | Optional; depends on replication setup |
| Cache cold-start (if applicable) | 30-60s | Worst case: loading from disk |
| **Total (99th percentile)** | **~150 seconds** | Covers regional and cold-start scenarios |

Most startups complete in 10-30 seconds; 150 is a safe upper bound.
