# Active-active multi-region oracle deployment

The oracle supports an active-active topology across `us-east-1`, `eu-west-1`,
and `ap-southeast-1`. Each region runs its own API, aggregator, database, and
history storage. Requests are served from the local region only; cross-region
reads are intentionally asynchronous to keep API latency low.

## Routing and health

Use AWS Global Accelerator or Cloudflare Load Balancing with latency-based
routing. Health checks must call `/health` every 5 seconds and remove unhealthy
regions from rotation. The operational target is sub-100ms failover after the
load balancer observes a failed health check.

## Price replication

Replication is carried by the Kafka bus and implemented in
`services/aggregator/src/replication/kafka-replicator.ts`. It starts only when
**both** `ACTIVE_ACTIVE_REGIONS_ENABLED=true` and `KAFKA_BROKERS` is a
non-empty list; otherwise the aggregator logs `Cross-region replication
disabled` and runs as a single region. `KAFKA_SSL_ENABLED` controls TLS to the
bootstrap servers.

Each aggregator:

- Publishes to `REGION_REPLICATION_TOPIC` once per poll, immediately after its
  own prices are merged into the local register. The payload is a snapshot of
  `RegionPriceReplicator.getLocalPrices()` — every record this region produced,
  keyed `region:asset`, with `price` as the decimal string, `decimals`,
  `timestamp`, and the propagated `traceparent`/`tracestate` in both the Kafka
  record headers and the JSON body.
- Consumes the same topic under the consumer group `<region>-replication`
  starting at `fromBeginning: false`, so a restarted region never replays the
  topic history.
- Skips any record whose `region` equals its own, so a region never merges its
  own echo back in.

Consumers merge remote records into a CRDT last-writer-wins register keyed by
`region:asset`; the winner for an asset is the record with the greatest
aggregator `timestamp`. No synchronous cross-region request path is required.

There is no durable outbound queue. The snapshot is recomputed from the live
register every poll cycle, so publish failure loses nothing that the next poll
will not restate; the register itself is in memory and rebuilt from local
prices plus whatever the bus delivers.

## Bus availability

Publish and consume failures are non-fatal. A failed connection sets
`replication_bus_up{region}` to `0` and increments
`replication_publish_failures_total{region}`, and the aggregator continues to
serve its own region. Reconnection is retried at most once every 30 seconds,
and startup logs `Cross-region replication unavailable; continuing without
peers` rather than crashing the service.

`src/domain-events` (the in-process `EventBus`) carries `price_fetched`,
`price_aggregated`, `price_published`, `anomaly_detected`, `source_degraded`
and `sla_breach` **within one process only**. It is not a cross-region
transport and does not overlap with the Kafka replication path described here.

## Consistency model

Reads are local-first and eventually consistent. A region may serve stale data
until replication catches up. The bounded-staleness target is
`REGION_MAX_REPLICATION_LAG_MS` with a default p99 target of 5 seconds.

## Drift monitoring and quarantine

Aggregators compute cross-region drift from the register: for each asset with
records from at least two regions, the drift is
`|value − median| / median × 100`, and the report exposes the maximum. The
result is published as:

| Metric | Meaning |
|---|---|
| `region_drift_percent{region}` | Maximum cross-region drift for the last evaluation |
| `region_drift_known{region}` | `1` only when at least one asset was comparable across regions |
| `region_peers_reporting{region}` | Regions in the register other than this one |
| `region_peers_configured{region}` | Peers listed in `REGION_PEERS` |

"No peers reported" and "prices agree" are deliberately different states. With
no peer data `region_drift_known` is `0` and `region_drift_percent` stays at
`0`; a single region must never be read as healthy agreement. The aggregator
logs `Cross-region drift cannot be computed: no peer region has reported` in
that case.

If drift exceeds `REGION_DRIFT_ALERT_PERCENT` the region emits an alert. When
`REGION_QUARANTINE_ENABLED=true`, the region marks itself quarantined until
drift falls below `REGION_QUARANTINE_RECOVER_PERCENT` **and** `driftKnown` is
true, so a bus outage cannot be mistaken for recovery. Load balancer health
configuration should stop routing production traffic to quarantined regions.

## Disaster recovery drills

The staging DR drill runs weekly through the chaos workflow. It should block
network traffic from one region, verify the other two regions continue serving
traffic, verify CRDT convergence after the partition is removed, and run the
load-test scenario that models 50% regional traffic loss.
