# Active-active multi-region operation

The production topology runs independent API and aggregator stacks in `us-east-1`, `eu-west-1`, and `ap-southeast-1`. Each region is active and serves traffic through the global load balancer using latency-based routing and `/api/v1/health` checks every 5 seconds.

Price replication is asynchronous and local-first. Each regional aggregator publishes local aggregate prices to the cross-region Kafka mirror. Consumers store local and remote observations as last-writer-wins registers keyed by asset and region. The latest wall-clock timestamp wins, so regions converge without synchronous reads or consensus. The API always reads from local regional storage and may serve data up to the configured replication lag behind another region.

Operations thresholds are configured in `k8s/base/multi-region/geo-config.yaml`: replication p99 target `<5s`, drift alert threshold `10` bps, failover window `100ms`, and automatic quarantine enabled.

## Quarantine vs emergency pause

These are two independent stop mechanisms with different scopes. Reach for the
one that matches what you are seeing.

| | Region quarantine | Contract emergency pause |
|---|---|---|
| Where it lives | Off-chain, per aggregator region | On-chain, in the price oracle contract |
| Who sets it | Automatically, when `maxDriftPercent > REGION_DRIFT_ALERT_PERCENT` | A multi-sig governance `pause` proposal (Issue #297 / #379) |
| Scope | This region only | Every region — the contract is shared |
| What stops | This region's contract writes (`submit_price`, `submit_batch`, `apply_batch_entry` are never attempted) | All contract writes; `submission.rs` returns a paused error for `submit_price`, `submit_batch` and `apply_batch_entry` regardless of caller |
| What keeps running | REST/WS reads, health endpoints, replication in and out | Reads (`get_price`, `get_assets`, `get_price_history`, `is_paused`) |
| How it clears | Automatically, when drift falls to `REGION_QUARANTINE_RECOVER_PERCENT` **and** at least one peer region has reported (`driftKnown`) | An explicit multi-sig `unpause` proposal |

**Operator guidance.** Reach for quarantine first: it is automatic, local, and
self-healing, so a single divergent region stops writing without touching the
others. Reach for the emergency pause only when the corruption is in shared
state rather than in one region — a bad deploy across regions, a compromised
admin key, or a contract-level incident — because pausing stops every region
and needs a multi-sig proposal to undo. Never use the pause to stop one
region; use quarantine, or remove the region from the load balancer.

## What quarantine does

`RegionQuarantineManager.evaluate` flips `quarantined: true` when drift exceeds
`REGION_DRIFT_ALERT_PERCENT`, and `index.ts` reacts to the transition in the
same poll round, **before** `publishAggregated` runs:

- `ContractPublisher.setPublishingEnabled(false)` — `publishAggregated`
  returns immediately, so no `submit_price`, `submit_batch` or
  `apply_batch_entry` transaction is built or signed. Cross-region
  replication, aggregation, history writes and the REST/WS API are untouched;
  cached reads keep serving.
- The submission retry queue is suspended and every item already queued is
  discarded as orphaned (`retryQueueOrphanedRetriesTotal`). The processor
  interval is stopped and `enqueue()` becomes a no-op, so nothing queued
  before the boundary can be flushed after recovery or on shutdown.
  `drainRetryQueue()` breaks out immediately while suspended.
- There are no in-flight submissions to reconcile: quarantine is evaluated
  before publication in the same `poll()`, so a publish round cannot straddle
  the boundary.
- `/health/ready` returns `503` while quarantined, so the load balancer stops
  routing reads to this region too.

Because the boundary is evaluated before publication and the retry queue is
emptied at the boundary, a recovered region starts from a clean slate: the
first poll after recovery republishes the current aggregate from scratch.

Recovery is automatic when `maxDriftPercent <= REGION_QUARANTINE_RECOVER_PERCENT`
**and** `driftKnown` is true. `driftKnown` requires at least one asset with
records from two or more regions and a non-zero median, so a Kafka outage
(which makes `peerCount` drop to zero) can never be mistaken for drift falling
back under the threshold. Publication resumes on the next poll round.

## Alerts and metrics

Quarantine transitions fire a `region_quarantine` alert through the normal
alert pipeline (console, `data/alerts.jsonl`, webhook, Slack, PagerDuty,
Opsgenie, email) with the drift evidence attached: `deviationPercent`,
`regionCount`, `peerCount`, `driftKnown` and `transition`. The escalation
policy routes it as `critical`/PagerDuty with a 15 minute ack window and
`docs/multi-region.md` as the runbook. On recovery PagerDuty receives a
`resolve` for the same `dedup_key`, closing the incident that quarantine
opened. `transition` is part of the dedup key, so enter and clear are never
suppressed against each other.

| Metric | Meaning |
|---|---|
| `region_quarantine_state{region}` | `1` while quarantined, `0` otherwise — alert on this instead of scraping `/health` |
| `region_quarantine_transitions_total{region,to}` | `to="quarantined"` or `to="recovered"`; counts every transition even when alert dedup suppresses the notification |
| `region_drift_percent{region}` | Maximum cross-region drift at the last evaluation |
| `region_drift_known{region}` | `1` only when at least one asset was comparable across regions |
| `region_peers_reporting{region}` | Regions in the local register other than this one |
| `region_peers_configured{region}` | Peers listed in `REGION_PEERS` |

## Disaster recovery drills

Weekly staging DR drills run through the existing Chaos Mesh schedule in `k8s/chaos/schedules/weekly-chaos-schedule.yaml`; load testing uses the k6 scenarios under `load-tests/k6/` and should include a 50% regional traffic-loss run before production promotion. A drill should confirm that a partitioned region enters quarantine, stops writing on chain, and resumes publication after the partition is removed and drift converges.
