import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { decryptSecret } from './crypto';
import { logger } from '../observability/logger';
import {
  auditAppendsTotal,
  auditAppendDuration,
  auditEntriesArchivedTotal,
  auditRetentionFailuresTotal,
  auditRetentionRunsTotal,
} from '../observability/metrics';

export type AuditEvent =
  | 'auth.success'
  | 'auth.failure'
  | 'auth.rate_limited'
  | 'admin.key_created'
  | 'admin.key_rotated'
  | 'admin.key_deactivated'
  | 'admin.key_deleted'
  | 'admin.key_reactivated'
  | 'admin.rate_limit_updated'
  | 'admin.role_assigned'
  | 'key.rotation_started'
  | 'key.rotation_completed'
  | 'archival.run'
  | 'archival.restore'
  | 'consistency.check'
  | 'backup.run'
  | 'backup.test-restore'
  | 'backup.restore'
  | 'governance.proposal_created'
  | 'governance.vote_cast'
  | 'governance.proposal_queued'
  | 'governance.proposal_executed'
  | 'governance.proposal_cancelled'
  | 'governance.emergency_execute'
  | 'multisig.proposal_created'
  | 'multisig.proposal_approved'
  | 'multisig.proposal_executed';

export interface AuditEntry {
  event: AuditEvent;
  timestamp: string;
  ip: string;
  userAgent: string;
  apiKeyPrefix: string;
  prevHmac?: string;
  details?: Record<string, unknown>;
  prevState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  hmac: string;
}

const AUDIT_SECRET = process.env.AUDIT_SECRET
  ? decryptSecret(process.env.AUDIT_SECRET)
  : 'default-audit-secret-change-in-prod';

export const auditRetentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10);

/** Directory holding audit.log, the archive/ sub-directory and the retention lock. */
export const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR
  ? path.resolve(process.env.AUDIT_LOG_DIR)
  : path.resolve(process.cwd(), 'logs');

const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, 'audit.log');
const AUDIT_ARCHIVE_DIR = path.join(AUDIT_LOG_DIR, 'audit-archive');
const AUDIT_RETENTION_LOCK = path.join(AUDIT_LOG_DIR, '.audit-retention.lock');
const AUDIT_LOG_TMP = path.join(AUDIT_LOG_DIR, `.audit.log.${process.pid}.tmp`);

const LOCK_STALE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;

export const auditRetentionSweepIntervalMs =
  parseInt(process.env.AUDIT_RETENTION_SWEEP_MS || '', 10) > 0
    ? parseInt(process.env.AUDIT_RETENTION_SWEEP_MS || '', 10)
    : DEFAULT_SWEEP_MS;

export interface AuditRetentionResult {
  status: 'completed' | 'skipped' | 'failed';
  total: number;
  kept: number;
  archived: number;
  archiveDir?: string;
  error?: string;
}

export function getAuditLogPaths(): { dir: string; file: string; archiveDir: string; lock: string } {
  return {
    dir: AUDIT_LOG_DIR,
    file: AUDIT_LOG_FILE,
    archiveDir: AUDIT_ARCHIVE_DIR,
    lock: AUDIT_RETENTION_LOCK,
  };
}

let auditLogDirReady = false;
let lastHmac = '';

function ensureAuditLogDir(): void {
  if (auditLogDirReady) return;
  fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
  auditLogDirReady = true;
}

export function computeAuditHmac(
  data: Omit<AuditEntry, 'hmac'>,
  previousHmac = '',
): string {
  const payload = JSON.stringify({ ...data, prevHmac: previousHmac });
  return crypto.createHmac('sha256', AUDIT_SECRET).update(payload).digest('hex');
}

export function verifyAuditLogChain(
  entries: AuditEntry[],
  startHead = '',
): { valid: boolean; firstInvalidIndex: number | null } {
  let previousHmac = startHead;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedHmac = computeAuditHmac(
      {
        event: entry.event,
        timestamp: entry.timestamp,
        ip: entry.ip,
        userAgent: entry.userAgent,
        apiKeyPrefix: entry.apiKeyPrefix,
        ...(entry.details && { details: entry.details }),
        ...(entry.prevState && { prevState: entry.prevState }),
        ...(entry.newState && { newState: entry.newState }),
      },
      entry.prevHmac ?? previousHmac,
    );

    if (entry.hmac !== expectedHmac || (entry.prevHmac ?? previousHmac) !== previousHmac) {
      return { valid: false, firstInvalidIndex: index };
    }

    previousHmac = entry.hmac;
  }

  return { valid: true, firstInvalidIndex: null };
}

function readAuditLines(contents: string): string[] {
  return contents.split('\n').filter((line) => line.trim().length > 0);
}

function parseLine(line: string): AuditEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('event' in parsed)) return null;
    return parsed as AuditEntry;
  } catch {
    return null;
  }
}

/**
 * The tamper-evident chain spans the archive and the active log, so a
 * verification run has to read both (issue #599).
 */
export function readAuditChain(): AuditEntry[] {
  const entries: AuditEntry[] = [];
  const collect = (filePath: string): void => {
    if (!fs.existsSync(filePath)) return;
    for (const line of readAuditLines(fs.readFileSync(filePath, 'utf8'))) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
  };

  if (fs.existsSync(AUDIT_ARCHIVE_DIR)) {
    const archives = fs.readdirSync(AUDIT_ARCHIVE_DIR).filter((f) => f.endsWith('.jsonl')).sort();
    for (const file of archives) collect(path.join(AUDIT_ARCHIVE_DIR, file));
  }
  collect(AUDIT_LOG_FILE);

  return entries;
}

function releaseRetentionLock(): void {
  try {
    if (fs.existsSync(AUDIT_RETENTION_LOCK)) fs.unlinkSync(AUDIT_RETENTION_LOCK);
  } catch {
    /* a stale lock is recovered by the staleness check on the next run */
  }
}

function acquireRetentionLock(): void {
  ensureAuditLogDir();
  try {
    const fd = fs.openSync(AUDIT_RETENTION_LOCK, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  try {
    const info = JSON.parse(fs.readFileSync(AUDIT_RETENTION_LOCK, 'utf8')) as { acquiredAt?: string };
    const acquiredAt = info.acquiredAt ? Date.parse(info.acquiredAt) : NaN;
    if (Number.isNaN(acquiredAt) || Date.now() - acquiredAt <= LOCK_STALE_MS) {
      throw new Error('audit retention is already running in another process');
    }
    fs.unlinkSync(AUDIT_RETENTION_LOCK);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('audit retention is already running')) throw err;
    throw new Error(
      `audit retention lock could not be recovered: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const fd = fs.openSync(AUDIT_RETENTION_LOCK, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
}

function archiveDated(dated: Map<string, string[]>): { paths: string[]; appended: number } {
  fs.mkdirSync(AUDIT_ARCHIVE_DIR, { recursive: true });
  const paths: string[] = [];
  let appended = 0;

  for (const [date, datedLines] of dated) {
    const target = path.join(AUDIT_ARCHIVE_DIR, `audit-${date}.jsonl`);
    const alreadyArchived = fs.existsSync(target)
      ? new Set(readAuditLines(fs.readFileSync(target, 'utf8')))
      : new Set<string>();
    const fresh = datedLines.filter((line) => !alreadyArchived.has(line));
    if (fresh.length > 0) {
      fs.appendFileSync(target, `${fresh.join('\n')}\n`, 'utf8');
      appended += fresh.length;
    }
    paths.push(target);
  }

  return { paths, appended };
}

interface RetentionPlan {
  keep: string[];
  byDate: Map<string, string[]>;
  archived: number;
  unparseable: number;
}

function buildPlan(lines: string[], retentionDays: number): RetentionPlan {
  const cutoffMs = Date.now() - retentionDays * DAY_MS;
  const keep: string[] = [];
  const byDate = new Map<string, string[]>();
  let archived = 0;
  let unparseable = 0;

  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) {
      unparseable += 1;
      keep.push(line);
      continue;
    }
    const timestampMs = Date.parse(entry.timestamp);
    if (Number.isNaN(timestampMs) || timestampMs >= cutoffMs) {
      keep.push(line);
      continue;
    }
    const date = new Date(timestampMs).toISOString().slice(0, 10);
    const bucket = byDate.get(date) ?? [];
    bucket.push(line);
    byDate.set(date, bucket);
    archived += 1;
  }

  return { keep, byDate, archived, unparseable };
}

function removeTempFile(): void {
  try {
    if (fs.existsSync(AUDIT_LOG_TMP)) fs.unlinkSync(AUDIT_LOG_TMP);
  } catch {
    /* the temp file is only ever a partial rewrite */
  }
}

/**
 * Retention runs on its own schedule under an exclusive lock, never on the
 * request path (issue #599). Aged entries are archived first with an
 * append-only, de-duplicating write so a crash can duplicate but never lose
 * evidence; the active log is then replaced through temp file + rename, and
 * the replace is retried if another writer touched the log while we worked.
 */
export function enforceAuditRetention(retentionDays = auditRetentionDays): AuditRetentionResult {
  let locked = false;
  try {
    acquireRetentionLock();
    locked = true;

    if (!fs.existsSync(AUDIT_LOG_FILE)) {
      auditRetentionRunsTotal.inc({ status: 'completed' });
      return { status: 'completed', total: 0, kept: 0, archived: 0 };
    }

    let source = readAuditLines(fs.readFileSync(AUDIT_LOG_FILE, 'utf8'));
    let plan = buildPlan(source, retentionDays);

    if (plan.archived === 0) {
      auditRetentionRunsTotal.inc({ status: 'completed' });
      if (plan.unparseable > 0) {
        logger.warn('Audit log contains unparseable lines that retention left in place', {
          unparseable: plan.unparseable,
          file: AUDIT_LOG_FILE,
        });
      }
      return { status: 'completed', total: source.length, kept: source.length, archived: 0 };
    }

    let archivePaths: string[] = [];
    let archivedAppended = 0;
    let renamed = false;
    let lastTotal = source.length;
    let lastKept = plan.keep.length;
    let lastArchived = plan.archived;

    for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
      if (attempt > 0) {
        source = readAuditLines(fs.readFileSync(AUDIT_LOG_FILE, 'utf8'));
        plan = buildPlan(source, retentionDays);
      }

      if (plan.archived > 0) {
        const archive = archiveDated(plan.byDate);
        archivePaths = archive.paths;
        archivedAppended += archive.appended;
      }
      lastTotal = source.length;
      lastKept = plan.keep.length;
      lastArchived = plan.archived;

      const output = plan.keep.length ? `${plan.keep.join('\n')}\n` : '';
      fs.writeFileSync(AUDIT_LOG_TMP, output, 'utf8');

      const current = readAuditLines(fs.readFileSync(AUDIT_LOG_FILE, 'utf8'));
      const changed = current.length !== source.length || current.some((line, i) => line !== source[i]);
      if (changed) continue;

      fs.renameSync(AUDIT_LOG_TMP, AUDIT_LOG_FILE);
      renamed = true;
    }

    if (archivedAppended > 0) auditEntriesArchivedTotal.inc(archivedAppended);

    if (!renamed) {
      removeTempFile();
      auditRetentionRunsTotal.inc({ status: 'skipped' });
      const reason = 'concurrent writer changed the audit log during retention';
      logger.warn('Audit retention skipped', { file: AUDIT_LOG_FILE, reason });
      return { status: 'skipped', total: lastTotal, kept: lastKept, archived: lastArchived, error: reason };
    }

    const verified = readAuditLines(fs.readFileSync(AUDIT_LOG_FILE, 'utf8'));
    if (verified.length < lastKept || verified.some((line) => parseLine(line) === null)) {
      throw new Error(
        `post-retention verification failed: expected at least ${lastKept} entries, read ${verified.length}`,
      );
    }

    removeTempFile();
    auditRetentionRunsTotal.inc({ status: 'completed' });
    logger.info('Audit retention sweep completed', {
      total: lastTotal,
      kept: lastKept,
      archived: lastArchived,
      archivedAppended,
      archiveDir: AUDIT_ARCHIVE_DIR,
      archivePaths,
      retentionDays,
    });

    return {
      status: 'completed',
      total: lastTotal,
      kept: lastKept,
      archived: lastArchived,
      archiveDir: AUDIT_ARCHIVE_DIR,
    };
  } catch (err) {
    removeTempFile();
    const reason = err instanceof Error ? err.message : String(err);
    const status = reason.startsWith('audit retention is already running') ? 'skipped' : 'failed';

    if (status === 'failed') {
      auditRetentionFailuresTotal.inc({ reason: classifyRetentionFailure(reason) });
      logger.error('Audit retention could not run', {
        error: reason,
        file: AUDIT_LOG_FILE,
        severity: 'error',
        alert: 'audit-retention',
      });
    }
    auditRetentionRunsTotal.inc({ status });

    return { status, total: 0, kept: 0, archived: 0, error: reason };
  } finally {
    if (locked) releaseRetentionLock();
  }
}

function classifyRetentionFailure(reason: string): string {
  if (/ENOSPC/i.test(reason)) return 'disk_full';
  if (/EACCES|EPERM|EROFS/i.test(reason)) return 'permission';
  if (/already running/i.test(reason)) return 'lock_held';
  return 'other';
}

let retentionTimer: NodeJS.Timeout | null = null;
let initialSweepTimer: NodeJS.Timeout | null = null;

export function startAuditRetentionScheduler(intervalMs = auditRetentionSweepIntervalMs): void {
  if (retentionTimer) return;
  const sweep = intervalMs > 0 ? intervalMs : DEFAULT_SWEEP_MS;
  initialSweepTimer = setTimeout(() => {
    enforceAuditRetention();
  }, Math.min(sweep, 30_000));
  initialSweepTimer.unref?.();
  retentionTimer = setInterval(() => {
    enforceAuditRetention();
  }, sweep);
  retentionTimer.unref?.();
}

export function stopAuditRetentionScheduler(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  if (initialSweepTimer) {
    clearTimeout(initialSweepTimer);
    initialSweepTimer = null;
  }
}

export function auditLog(
  event: AuditEvent,
  context: {
    ip?: string;
    userAgent?: string;
    apiKeyPrefix?: string;
    details?: Record<string, unknown>;
    prevState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
  },
): void {
  const data: Omit<AuditEntry, 'hmac'> = {
    event,
    timestamp: new Date().toISOString(),
    ip: context.ip || 'unknown',
    userAgent: context.userAgent || 'unknown',
    apiKeyPrefix: context.apiKeyPrefix || 'unknown',
    prevHmac: lastHmac,
    ...(context.details && { details: context.details }),
    ...(context.prevState && { prevState: context.prevState }),
    ...(context.newState && { newState: context.newState }),
  };

  const hmac = computeAuditHmac(data, lastHmac);
  lastHmac = hmac;

  const entry: AuditEntry = { ...data, hmac };
  const startedAt = performance.now();

  try {
    ensureAuditLogDir();
    fs.appendFileSync(AUDIT_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    auditAppendsTotal.inc({ status: 'ok' });
  } catch (err) {
    auditAppendsTotal.inc({ status: 'failed' });
    logger.error('Failed to append audit entry', {
      event,
      file: AUDIT_LOG_FILE,
      error: err instanceof Error ? err.message : String(err),
      severity: 'error',
      alert: 'audit-write',
    });
  } finally {
    auditAppendDuration.observe({ status: 'ok' }, (performance.now() - startedAt) / 1000);
  }
}
