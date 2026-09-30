import fs from 'fs';
import path from 'path';
import { logger } from '../observability/logger';

export type DsarStatus = 'received' | 'processing' | 'fulfilled' | 'rejected';
export type DsarRequestType = 'access' | 'erasure' | 'explanation';

export interface DsarHistoryEntry {
  at: string;
  actor: string;
  from: DsarStatus | 'created';
  to: DsarStatus;
  note?: string;
}

export interface DsarRecord {
  id: string;
  subjectId: string;
  requestType: DsarRequestType;
  status: DsarStatus;
  owner: string;
  createdAt: string;
  updatedAt: string;
  fulfilledAt?: string;
  stores: string[];
  notes?: string[];
  history: DsarHistoryEntry[];
  result?: Record<string, unknown>;
}

export interface DsarStore {
  load(): Promise<DsarRecord[]>;
  save(records: DsarRecord[]): Promise<void>;
}

function normalize(raw: unknown): DsarRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<DsarRecord>;
  if (typeof record.id !== 'string' || typeof record.subjectId !== 'string') return null;
  if (typeof record.status !== 'string' || typeof record.requestType !== 'string') return null;
  return {
    id: record.id,
    subjectId: record.subjectId,
    requestType: record.requestType as DsarRequestType,
    status: record.status as DsarStatus,
    owner: record.owner || 'unknown',
    createdAt: record.createdAt || new Date(0).toISOString(),
    updatedAt: record.updatedAt || record.createdAt || new Date(0).toISOString(),
    ...(record.fulfilledAt && { fulfilledAt: record.fulfilledAt }),
    stores: Array.isArray(record.stores) ? record.stores : [],
    ...(record.notes && { notes: record.notes }),
    history: Array.isArray(record.history) ? record.history : [],
    ...(record.result && { result: record.result }),
  };
}

export class FileDsarStore implements DsarStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ||
      process.env.DSAR_STORE_PATH ||
      path.resolve(process.cwd(), 'logs/data-subject-requests.json');
  }

  async load(): Promise<DsarRecord[]> {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(data)) return [];
      return data.map(normalize).filter((record): record is DsarRecord => record !== null);
    } catch (err) {
      logger.warn(`Failed to load DSAR state from ${this.filePath}`, err);
      return [];
    }
  }

  async save(records: DsarRecord[]): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2));
    fs.renameSync(tmpPath, this.filePath);
  }
}
