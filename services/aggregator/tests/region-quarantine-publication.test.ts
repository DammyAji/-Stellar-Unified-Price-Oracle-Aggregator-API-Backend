import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Account, Keypair } from '@stellar/stellar-sdk';
import AlertManager from '../src/observability/alert-manager';
import { resolveEscalationRoute } from '../src/observability/escalation-policy';
import { ContractPublisher } from '../src/contract-publishing/publisher';
import { RegionQuarantineManager } from '../src/replication/region-quarantine';
import { DriftReport } from '../src/replication/region-price-replicator';
import { config } from '../src/infrastructure/config';
import { AggregatedPrice } from '../src/infrastructure/types';
import {
  regionQuarantineState,
  regionQuarantineTransitionsTotal,
  retryQueueOrphanedRetriesTotal,
} from '../src/observability/metrics';

const REGION = 'us-east-1';
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

const prices: AggregatedPrice[] = [
  { asset: 'XLM', price: '1200000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1, degradationLevel: 'healthy', stale: false },
  { asset: 'USDC', price: '1000000', decimals: 7, timestamp: 1700000000, sources: ['chainlink'], confidence: 1, degradationLevel: 'healthy', stale: false },
];

function drift(overrides: Partial<DriftReport> = {}): DriftReport {
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
  config.soroban.adminSecret = Keypair.random().secret();
  config.soroban.contractId = CONTRACT_ID;
});

describe('quarantine gating of contract publication', () => {
  let publisher: ContractPublisher;
  let keypair: Keypair;
  let server: {
    getAccount: ReturnType<typeof vi.fn>;
    simulateTransaction: ReturnType<typeof vi.fn>;
    sendTransaction: ReturnType<typeof vi.fn>;
    getTransaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    keypair = Keypair.random();
    server = {
      getAccount: vi.fn(async () => new Account(keypair.publicKey(), '100')),
      simulateTransaction: vi.fn(async () => ({ minResourceFee: '150', results: [{}] })),
      sendTransaction: vi.fn(async () => ({
        status: 'PENDING',
        hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        fee: '200',
      })),
      getTransaction: vi.fn(async () => ({ status: 'SUCCESS', resultMetaXdr: [] })),
    };

    publisher = new ContractPublisher();
    (publisher as unknown as { server: unknown }).server = server;
    (publisher as unknown as { keypair: unknown }).keypair = keypair;
  });

  afterEach(async () => {
    await publisher.shutdown();
    vi.restoreAllMocks();
  });

  it('writes nothing to the contract while quarantined', async () => {
    publisher.setPublishingEnabled(false, 'drift 9.0909% exceeds 1%');

    await publisher.publishAggregated(prices);

    expect(publisher.isPublishingEnabled()).toBe(false);
    expect(server.getAccount).not.toHaveBeenCalled();
    expect(server.simulateTransaction).not.toHaveBeenCalled();
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it('resumes publication automatically after recovery', async () => {
    publisher.setPublishingEnabled(false, 'quarantine');
    await publisher.publishAggregated(prices);
    expect(server.sendTransaction).not.toHaveBeenCalled();

    publisher.setPublishingEnabled(true, 'quarantine cleared');
    await publisher.publishAggregated(prices);

    expect(publisher.isPublishingEnabled()).toBe(true);
    expect(server.getAccount).toHaveBeenCalled();
    expect(server.sendTransaction).toHaveBeenCalled();
  });

  it('discards queued submissions at the boundary so nothing is flushed later', async () => {
    const orphanedBefore = await metricValue(retryQueueOrphanedRetriesTotal, {});

    publisher.retryQueue.enqueue({ asset: 'XLM', price: 100n, decimals: 7, timestamp: 1 });
    publisher.retryQueue.enqueue({ asset: 'USDC', price: 100n, decimals: 7, timestamp: 2 });
    expect(publisher.getRetryQueueSize()).toBe(2);

    publisher.setPublishingEnabled(false, 'quarantine');

    expect(publisher.getRetryQueueSize()).toBe(0);
    expect(publisher.retryQueue.isSuspended()).toBe(true);
    expect(await metricValue(retryQueueOrphanedRetriesTotal, {})).toBe(orphanedBefore + 2);

    const sendsBefore = server.sendTransaction.mock.calls.length;
    await publisher.drainRetryQueue();
    publisher.processRetryQueue();

    expect(server.sendTransaction.mock.calls.length).toBe(sendsBefore);
    expect(publisher.getRetryQueueSize()).toBe(0);
  });

  it('drops new submissions while suspended and accepts them again after recovery', async () => {
    publisher.setPublishingEnabled(false, 'quarantine');
    publisher.retryQueue.enqueue({ asset: 'XLM', price: 100n, decimals: 7, timestamp: 3 });
    expect(publisher.getRetryQueueSize()).toBe(0);

    publisher.setPublishingEnabled(true, 'quarantine cleared');
    publisher.retryQueue.enqueue({ asset: 'XLM', price: 100n, decimals: 7, timestamp: 3 });
    expect(publisher.getRetryQueueSize()).toBe(1);
    expect(publisher.retryQueue.isSuspended()).toBe(false);
  });

  it('is a no-op when the state does not change', async () => {
    const suspended = vi.spyOn(publisher.retryQueue, 'setSuspended');
    publisher.setPublishingEnabled(true, 'already on');
    expect(suspended).not.toHaveBeenCalled();
    publisher.setPublishingEnabled(false, 'quarantine');
    publisher.setPublishingEnabled(false, 'quarantine again');
    expect(suspended).toHaveBeenCalledTimes(1);
    suspended.mockRestore();
  });
});

describe('quarantine state, transitions and alerts', () => {
  it('enters quarantine on drift, refuses recovery without peers, then clears', async () => {
    const manager = new RegionQuarantineManager();
    const stateBefore = await metricValue(regionQuarantineState, { region: REGION });
    const transitionsBefore = await metricValue(regionQuarantineTransitionsTotal, { region: REGION, to: 'quarantined' });

    expect(manager.evaluate(drift()).transition).toBeNull();

    const entered = manager.evaluate(drift({ maxDriftPercent: 9.0909, driftKnown: true, regionCount: 2, peerCount: 1, hasPeers: true }));
    expect(entered).toMatchObject({ quarantined: true, transition: 'quarantined' });
    expect(entered.reason).toContain('9.0909');
    expect(await metricValue(regionQuarantineState, { region: REGION })).toBe(stateBefore + 1);
    expect(await metricValue(regionQuarantineTransitionsTotal, { region: REGION, to: 'quarantined' })).toBe(transitionsBefore + 1);

    expect(manager.evaluate(drift({ maxDriftPercent: 5, driftKnown: true }))).toMatchObject({ quarantined: true, transition: null });

    const noPeers = manager.evaluate(drift({ regionCount: 1, peerCount: 0, hasPeers: false, driftKnown: false }));
    expect(noPeers).toMatchObject({ quarantined: true, transition: null });

    const recoveredBefore = await metricValue(regionQuarantineTransitionsTotal, { region: REGION, to: 'recovered' });
    const left = manager.evaluate(drift({ maxDriftPercent: 0, regionCount: 2, peerCount: 1, hasPeers: true, driftKnown: true }));
    expect(left).toMatchObject({ quarantined: false, transition: 'recovered' });
    expect(left.reason).toBeUndefined();
    expect(await metricValue(regionQuarantineState, { region: REGION })).toBe(0);
    expect(await metricValue(regionQuarantineTransitionsTotal, { region: REGION, to: 'recovered' })).toBe(recoveredBefore + 1);
  });

  it('never quarantines while the feature is disabled', async () => {
    config.region.quarantineEnabled = false;
    try {
      const manager = new RegionQuarantineManager();
      const stateBefore = await metricValue(regionQuarantineState, { region: REGION });
      const result = manager.evaluate(drift({ maxDriftPercent: 90, driftKnown: true }));
      expect(result).toMatchObject({ quarantined: false, transition: null });
      expect(await metricValue(regionQuarantineState, { region: REGION })).toBe(0);
      expect(await metricValue(regionQuarantineState, { region: REGION })).toBe(stateBefore === 0 ? 0 : stateBefore);
    } finally {
      config.region.quarantineEnabled = true;
    }
  });

  it('alerts on enter and clear with the drift evidence attached', async () => {
    const alerts = new AlertManager({ enableConsoleLog: false, enableFileLog: false });

    await alerts.reportRegionQuarantine({
      region: REGION,
      transition: 'quarantined',
      maxDriftPercent: 9.0909,
      thresholdPercent: 1,
      recoverPercent: 0.05,
      driftKnown: true,
      regionCount: 2,
      peerCount: 1,
    });
    await alerts.reportRegionQuarantine({
      region: REGION,
      transition: 'recovered',
      maxDriftPercent: 0,
      thresholdPercent: 1,
      recoverPercent: 0.05,
      driftKnown: true,
      regionCount: 2,
      peerCount: 1,
    });

    const history = alerts.getAlertHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      type: 'region_quarantine',
      asset: REGION,
      region: REGION,
      transition: 'quarantined',
      deviationPercent: 9.0909,
      regionCount: 2,
      peerCount: 1,
      driftKnown: true,
    });
    expect(history[0].message).toContain('Contract publication suspended');
    expect(history[1]).toMatchObject({ type: 'region_quarantine', transition: 'recovered' });
    expect(history[1].message).toContain('publication resumed');
  });

  it('routes region quarantine to critical/PagerDuty with the multi-region runbook', () => {
    const route = resolveEscalationRoute({
      type: 'region_quarantine',
      asset: REGION,
      message: 'Region quarantined',
    });

    expect(route).toMatchObject({
      severity: 'critical',
      primaryChannel: 'pagerduty',
      primaryTarget: 'primary-oncall',
      ackWindowMinutes: 15,
      runbook: 'docs/multi-region.md',
    });
  });
});
