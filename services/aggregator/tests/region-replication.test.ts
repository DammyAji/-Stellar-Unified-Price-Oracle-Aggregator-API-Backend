import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { EachMessagePayload } from 'kafkajs';
import { LwwPriceRegister } from '../src/replication/price-crdt';
import { DriftReport, RegionPriceReplicator } from '../src/replication/region-price-replicator';
import { RegionQuarantineManager } from '../src/replication/region-quarantine';
import { KafkaReplicator, KafkaReplicatorConfig } from '../src/replication/kafka-replicator';
import { AggregatedPrice } from '../src/infrastructure/types';
import { config } from '../src/infrastructure/config';
import {
  replicationBusUp,
  replicationPublishFailuresTotal,
  replicationRecordsInboundTotal,
  replicationRecordsOutboundTotal,
} from '../src/observability/metrics';

const REGION = 'us-east-1';
const PEER = 'eu-west-1';
const TOPIC = 'stellar-oracle-prices';

function aggregated(asset: string, price: string, timestamp: number): AggregatedPrice {
  return {
    asset,
    price,
    decimals: 7,
    sources: [],
    timestamp,
    confidence: 1,
    degradationLevel: 'healthy',
    stale: false,
  };
}

function driftReport(overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    maxDriftPercent: 0,
    maxStalenessMs: 0,
    regions: [],
    regionCount: 0,
    peerCount: 0,
    hasPeers: false,
    driftKnown: false,
    ...overrides,
  };
}

function kafkaConfig(overrides: Partial<KafkaReplicatorConfig> = {}): KafkaReplicatorConfig {
  return {
    regionId: REGION,
    kafkaBrokers: ['kafka-1:9092'],
    replicationTopic: TOPIC,
    consumerGroup: `${REGION}-replication`,
    maxReplicationLagMs: 5000,
    sslEnabled: false,
    ...overrides,
  };
}

function payloadFor(value: unknown, timestamp = Date.now()): EachMessagePayload {
  return {
    topic: TOPIC,
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(value)),
      timestamp: String(timestamp),
      attributes: 0,
      offset: '0',
      headers: {},
    },
    heartbeat: async () => {},
    pause: () => () => {},
  };
}

// prom-client's Counter.get()/Gauge.get() return Promise<{values: {labels, value}[]}>
async function metricValue(
  metric: any,
  labels: Record<string, string>,
): Promise<number> {
  const data = await metric.get();
  const hit = data.values.find((entry: any) =>
    Object.entries(labels).every(([key, want]) => entry.labels[key] === want),
  );
  return hit ? hit.value : 0;
}

beforeAll(() => {
  config.region.id = REGION;
  config.region.quarantineEnabled = true;
  config.region.driftAlertPercent = 1;
  config.region.quarantineRecoverPercent = 0.05;
});

describe('LwwPriceRegister', () => {
  it('keeps the record with the greatest timestamp', () => {
    const register = new LwwPriceRegister();
    register.merge({
      region: PEER, asset: 'XLM', price: 100n, decimals: 0,
      timestamp: 1000, receivedAt: 1000, source: 'remote',
    });
    register.merge({
      region: PEER, asset: 'XLM', price: 110n, decimals: 0,
      timestamp: 2000, receivedAt: 2000, source: 'remote',
    });

    expect(register.latest('XLM')?.price).toBe(110n);

    register.merge({
      region: PEER, asset: 'XLM', price: 99n, decimals: 0,
      timestamp: 1500, receivedAt: 2500, source: 'remote',
    });

    expect(register.latest('XLM')?.price).toBe(110n);
  });

  it('keys records by region and asset so peers never overwrite local', () => {
    const register = new LwwPriceRegister();
    register.mergeLocal(REGION, [aggregated('XLM', '100', 1000)]);
    register.merge({
      region: PEER, asset: 'XLM', price: 110n, decimals: 0,
      timestamp: 1000, receivedAt: 1000, source: 'remote',
    });

    expect(register.byRegion(REGION)).toHaveLength(1);
    expect(register.byRegion(REGION)[0].source).toBe('local');
    expect(register.byRegion(PEER)).toHaveLength(1);
    expect(register.byAsset('XLM')).toHaveLength(2);
  });
});

describe('RegionPriceReplicator drift report', () => {
  it('reports no peers and unknown drift when only this region has data', async () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('XLM', '100', 1000)]);

    const report = replicator.getDriftReport();

    expect(report.regionCount).toBe(1);
    expect(report.peerCount).toBe(0);
    expect(report.hasPeers).toBe(false);
    expect(report.driftKnown).toBe(false);
    expect(report.maxDriftPercent).toBe(0);
    expect(replicator.getLocalPrices()).toHaveLength(1);
    expect(await metricValue(replicationBusUp, { region: REGION })).toBe(0);
  });

  it('computes drift against the peer median once a peer reports', () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('XLM', '100', 1000)]);
    replicator.mergeRemotePrice({
      region: PEER, asset: 'XLM', price: 110n, decimals: 0, timestamp: 1000,
    });

    const report = replicator.getDriftReport();

    expect(report.regionCount).toBe(2);
    expect(report.peerCount).toBe(1);
    expect(report.hasPeers).toBe(true);
    expect(report.driftKnown).toBe(true);
    expect(report.maxDriftPercent).toBeCloseTo(10 / 110 * 100, 6);
    expect(report.asset).toBe('XLM');
    expect(report.regions).toEqual([REGION, PEER].sort());
  });

  it('counts every reporting region across three regions', () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('XLM', '100', 1000)]);
    replicator.mergeRemotePrice({ region: PEER, asset: 'XLM', price: 110n, decimals: 0, timestamp: 1000 });
    replicator.mergeRemotePrice({ region: 'ap-southeast-1', asset: 'XLM', price: 120n, decimals: 0, timestamp: 1000 });

    const report = replicator.getDriftReport();

    expect(report.regionCount).toBe(3);
    expect(report.peerCount).toBe(2);
    expect(report.hasPeers).toBe(true);
    expect(report.driftKnown).toBe(true);
    expect(report.maxDriftPercent).toBeCloseTo(10 / 110 * 100, 6);
  });

  it('treats a zero-median asset as not comparable rather than as zero drift', () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('ZERO', '0', 1000)]);
    replicator.mergeRemotePrice({ region: PEER, asset: 'ZERO', price: 0n, decimals: 0, timestamp: 1000 });

    const report = replicator.getDriftReport();

    expect(report.driftKnown).toBe(false);
    expect(report.maxDriftPercent).toBe(0);
    expect(report.peerCount).toBe(1);
  });

  it('excludes remote records from the outbound snapshot', () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('XLM', '100', 1000)]);
    replicator.mergeRemotePrice({ region: PEER, asset: 'XLM', price: 110n, decimals: 0, timestamp: 1000 });

    const local = replicator.getLocalPrices();

    expect(local).toHaveLength(1);
    expect(local[0].region).toBe(REGION);
    expect(local[0].source).toBe('local');
    expect(replicator.getLatestPrices()).toHaveLength(1);
  });
});

describe('RegionQuarantineManager', () => {
  it('quarantines on drift, refuses recovery while drift is unknown, then recovers', () => {
    const manager = new RegionQuarantineManager();

    expect(manager.evaluate(driftReport({ maxDriftPercent: 9.09, driftKnown: true })).quarantined).toBe(true);

    const stillQuarantined = manager.evaluate(driftReport({ regionCount: 1, peerCount: 0 }));
    expect(stillQuarantined.quarantined).toBe(true);
    expect(manager.getStatus().quarantined).toBe(true);

    const recovered = manager.evaluate(driftReport({ maxDriftPercent: 0, regionCount: 2, peerCount: 1, hasPeers: true, driftKnown: true }));
    expect(recovered.quarantined).toBe(false);
  });

  it('leaves the region untouched while quarantine is disabled', () => {
    config.region.quarantineEnabled = false;
    try {
      const manager = new RegionQuarantineManager();
      expect(manager.evaluate(driftReport({ maxDriftPercent: 90, driftKnown: true })).quarantined).toBe(false);
    } finally {
      config.region.quarantineEnabled = true;
    }
  });
});

describe('KafkaReplicator', () => {
  it('is disabled without brokers and never opens a connection', async () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('XLM', '100', 1000)]);
    const kafka = new KafkaReplicator(kafkaConfig({ kafkaBrokers: [] }), replicator);

    expect(kafka.enabled).toBe(false);
    expect(await kafka.ensureStarted()).toBe(false);
    expect(kafka.isRunning).toBe(false);

    await kafka.publish();
    expect(await metricValue(replicationPublishFailuresTotal, { region: REGION })).toBe(0);
  });

  it('publishes only local snapshot records with trace headers', async () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([
      aggregated('XLM', '100', 1000),
      aggregated('USDC', '1000000', 1000),
    ]);
    replicator.mergeRemotePrice({ region: PEER, asset: 'XLM', price: 110n, decimals: 0, timestamp: 1000 });

    const kafka = new KafkaReplicator(kafkaConfig(), replicator);
    const send = vi.fn().mockResolvedValue([]);
    const internals = kafka as unknown as { producer: unknown; consumer: unknown };
    internals.producer = { send };
    internals.consumer = {};

    const before = await metricValue(replicationRecordsOutboundTotal, { region: REGION });
    await kafka.publish();

    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0][0];
    expect(request.topic).toBe(TOPIC);
    expect(request.compression).toBe(1);
    expect(request.messages).toHaveLength(2);
    expect(request.messages.map((m: any) => JSON.parse(m.value).region)).toEqual([REGION, REGION]);

    const xlm = JSON.parse(
      request.messages.find((m: any) => JSON.parse(m.value).asset === 'XLM').value,
    );
    expect(xlm).toMatchObject({ region: REGION, asset: 'XLM', price: '100', decimals: 7, source: 'local', timestamp: 1000 });
    expect(typeof xlm.wallClock).toBe('number');

    const traceHeader = request.messages[0].headers.traceparent;
    expect(traceHeader).toMatch(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(xlm.traceparent).toBe(traceHeader);

    expect(await metricValue(replicationRecordsOutboundTotal, { region: REGION })).toBe(before + 2);
    expect(await metricValue(replicationPublishFailuresTotal, { region: REGION })).toBe(0);
    expect(await metricValue(replicationBusUp, { region: REGION })).toBe(1);
  });

  it('counts a publish failure and reports the bus down when the broker is unreachable', async () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('XLM', '100', 1000)]);

    const kafka = new KafkaReplicator(kafkaConfig(), replicator);
    (kafka as unknown as { kafkaClient: unknown }).kafkaClient = {
      connect: async () => {
        throw new Error('broker unreachable');
      },
    };

    const before = await metricValue(replicationPublishFailuresTotal, { region: REGION });
    await kafka.publish();

    expect(kafka.isRunning).toBe(false);
    expect(await metricValue(replicationPublishFailuresTotal, { region: REGION })).toBe(before + 1);
    expect(await metricValue(replicationBusUp, { region: REGION })).toBe(0);
    expect(await kafka.ensureStarted()).toBe(false);
  });

  it('merges a peer record through the real message handler', async () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('XLM', '100', 1000)]);
    const kafka = new KafkaReplicator(kafkaConfig(), replicator);

    const before = await metricValue(replicationRecordsInboundTotal, { region: REGION, source_region: PEER });
    await kafka.handleReplicatedMessage(
      payloadFor({
        region: PEER,
        asset: 'XLM',
        price: '110',
        decimals: 0,
        timestamp: 2000,
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      }),
    );

    const report = replicator.getDriftReport();
    expect(report.regionCount).toBe(2);
    expect(report.peerCount).toBe(1);
    expect(report.driftKnown).toBe(true);
    expect(report.maxDriftPercent).toBeCloseTo(10 / 110 * 100, 6);
    expect(replicator.getLatestPrices()[0]).toMatchObject({
      region: PEER,
      source: 'remote',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    expect(await metricValue(replicationRecordsInboundTotal, { region: REGION, source_region: PEER })).toBe(before + 1);
  });

  it('ignores its own region echo and malformed envelopes', async () => {
    const replicator = new RegionPriceReplicator();
    replicator.mergeLocalPrices([aggregated('XLM', '100', 1000)]);
    const kafka = new KafkaReplicator(kafkaConfig(), replicator);
    const before = await metricValue(replicationRecordsInboundTotal, { region: REGION, source_region: PEER });

    await kafka.handleReplicatedMessage(
      payloadFor({ region: REGION, asset: 'XLM', price: '999', decimals: 0, timestamp: 5000 }),
    );
    await kafka.handleReplicatedMessage(payloadFor({ asset: 'XLM' }));
    await kafka.handleReplicatedMessage(payloadFor({ region: PEER, asset: 'XLM', price: 'nope' }));
    await kafka.handleReplicatedMessage({
      ...payloadFor({ region: PEER, asset: 'XLM', price: '110' }),
      message: { ...payloadFor({ region: PEER }).message, value: null },
    });

    const report = replicator.getDriftReport();
    expect(report.regionCount).toBe(1);
    expect(report.peerCount).toBe(0);
    expect(report.driftKnown).toBe(false);
    expect(replicator.getLatestPrices()[0].price).toBe(100n);
    expect(await metricValue(replicationRecordsInboundTotal, { region: REGION, source_region: PEER })).toBe(before);
  });

  it('tracks lag and health status from inbound timestamps', async () => {
    const replicator = new RegionPriceReplicator();
    const kafka = new KafkaReplicator(kafkaConfig(), replicator);

    expect(kafka.getReplicationMetrics()).toEqual({ lagMs: 0, healthStatus: 'healthy' });

    await kafka.handleReplicatedMessage(
      payloadFor({ region: PEER, asset: 'XLM', price: '110', decimals: 0, timestamp: 1000 }, Date.now() - 90_000),
    );

    expect(kafka.isHighLag()).toBe(true);
    expect(kafka.getReplicationMetrics().healthStatus).toBe('degraded');
  });
});
