import { config } from '../infrastructure/config';
import { AggregatedPrice } from '../infrastructure/types';
import { LwwPriceRegister, RegionPriceRecord } from './price-crdt';
import { propagateForHop, TraceHeaders } from './trace-context';

export interface DriftReport {
  maxDriftPercent: number;
  maxStalenessMs: number;
  asset?: string;
  regions: string[];
  regionCount: number;
  peerCount: number;
  hasPeers: boolean;
  driftKnown: boolean;
}

export class RegionPriceReplicator {
  private readonly register = new LwwPriceRegister();

  mergeLocalPrices(prices: AggregatedPrice[]): void {
    this.register.mergeLocal(config.region.id, prices);
  }

  mergeRemotePrice(record: Omit<RegionPriceRecord, 'receivedAt' | 'source'>): void {
    this.register.merge({ ...record, receivedAt: Date.now(), source: 'remote' });
  }

  getLatestPrices(): RegionPriceRecord[] {
    return this.register.latestAll();
  }

  getLocalPrices(): RegionPriceRecord[] {
    return this.register
      .byRegion(config.region.id)
      .filter((record) => record.source === 'local');
  }

  /**
   * Trace headers to attach to an outbound replication message for `asset`
   * (issue #419). Continues the trace carried by the last inbound record for
   * that asset, or starts a fresh one, and tags this region into `tracestate`.
   */
  outboundTraceHeaders(asset: string, inbound?: TraceHeaders): TraceHeaders {
    const carried = inbound
      ?? this.register
        .byAsset(asset)
        .filter((r) => r.source === 'remote' && r.traceparent)
        .sort((a, b) => b.receivedAt - a.receivedAt)[0];
    return propagateForHop(
      carried ? { traceparent: carried.traceparent, tracestate: carried.tracestate } : undefined,
      config.region.id,
    );
  }

  getDriftReport(now = Date.now()): DriftReport {
    let maxDriftPercent = 0;
    let maxStalenessMs = 0;
    let asset: string | undefined;
    let comparableAssets = 0;
    const regions = new Set<string>();
    const assets = new Set<string>();

    for (const price of this.register.latestAll()) {
      assets.add(price.asset);
    }

    for (const assetName of assets) {
      const records = this.register.byAsset(assetName);
      for (const record of records) {
        regions.add(record.region);
        maxStalenessMs = Math.max(maxStalenessMs, now - record.receivedAt);
      }
      if (records.length < 2) continue;

      const values = records.map((record) => Number(record.price));
      const median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      if (median === 0) continue;

      comparableAssets += 1;
      for (const value of values) {
        const drift = Math.abs(value - median) / median * 100;
        if (drift > maxDriftPercent) {
          maxDriftPercent = drift;
          asset = assetName;
        }
      }
    }

    const regionCount = regions.size;
    const peerCount = regions.has(config.region.id) ? regionCount - 1 : regionCount;

    return {
      maxDriftPercent,
      maxStalenessMs,
      asset,
      regions: Array.from(regions).sort(),
      regionCount,
      peerCount,
      hasPeers: peerCount > 0,
      driftKnown: comparableAssets > 0,
    };
  }
}
