import { config } from '../infrastructure/config';
import { DriftReport } from './region-price-replicator';
import { regionQuarantineState, regionQuarantineTransitionsTotal } from '../observability/metrics';

export interface RegionQuarantineStatus {
  region: string;
  quarantined: boolean;
  reason?: string;
}

export type RegionQuarantineTransition = 'quarantined' | 'recovered';

export interface RegionQuarantineEvaluation extends RegionQuarantineStatus {
  transition: RegionQuarantineTransition | null;
}

export class RegionQuarantineManager {
  private status: RegionQuarantineStatus = {
    region: config.region.id,
    quarantined: false,
  };

  evaluate(report: DriftReport): RegionQuarantineEvaluation {
    const previous = this.status.quarantined;
    const quarantined = this.nextState(report);

    this.status = quarantined
      ? {
          region: config.region.id,
          quarantined: true,
          reason: previous
            ? this.status.reason
            : `drift ${report.maxDriftPercent.toFixed(4)}% exceeds ${config.region.driftAlertPercent}%`,
        }
      : { region: config.region.id, quarantined: false };

    regionQuarantineState.set({ region: config.region.id }, quarantined ? 1 : 0);
    if (quarantined === previous) return { ...this.status, transition: null };

    const transition: RegionQuarantineTransition = quarantined ? 'quarantined' : 'recovered';
    regionQuarantineTransitionsTotal.inc({ region: config.region.id, to: transition });
    return { ...this.status, transition };
  }

  getStatus(): RegionQuarantineStatus {
    return this.status;
  }

  private nextState(report: DriftReport): boolean {
    if (!config.region.quarantineEnabled) return false;

    if (report.maxDriftPercent > config.region.driftAlertPercent) return true;

    const recovered =
      report.driftKnown && report.maxDriftPercent <= config.region.quarantineRecoverPercent;
    return this.status.quarantined && !recovered;
  }
}
