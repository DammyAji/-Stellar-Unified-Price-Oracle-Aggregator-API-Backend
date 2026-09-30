import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const AGED_ISO = '2020-01-01T00:00:00.000Z';
const AGED_MS = Date.parse(AGED_ISO);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-audit-'));
process.env.AUDIT_LOG_DIR = tmpDir;

const mod = await import('../../src/governance/audit-logger');
const logger = (await import('../../src/observability/logger')).logger;
const paths = mod.getAuditLogPaths();

type AuditModule = typeof mod;

function readActiveLines(): string[] {
  if (!fs.existsSync(paths.file)) return [];
  return fs.readFileSync(paths.file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

function activeEntries(): AuditModule['AuditEntry'][] {
  return readActiveLines().map((l) => JSON.parse(l) as AuditModule['AuditEntry']);
}

function everyLineParses(lines: string[]): boolean {
  return lines.every((line) => {
    JSON.parse(line);
    return true;
  });
}

function archiveLines(): string[] {
  if (!fs.existsSync(paths.archiveDir)) return [];
  return fs
    .readdirSync(paths.archiveDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(paths.archiveDir, f), 'utf8').split('\n'))
    .filter((l) => l.trim().length > 0);
}

function leftoverTemps(): string[] {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith('.audit.log'));
}

function seedEntries(count: number, timestamp: string, event = 'auth.success'): string[] {
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      event,
      timestamp,
      ip: '127.0.0.1',
      userAgent: 'vitest',
      apiKeyPrefix: 'seeded',
      hmac: `seed-${i}`,
    }),
  );
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.file, `${lines.join('\n')}\n`, 'utf8');
  return lines;
}

function writeAgedThenFresh(aged: number, fresh: number): void {
  const realNow = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGED_MS);
  for (let i = 0; i < aged; i += 1) mod.auditLog('auth.success', { apiKeyPrefix: 'aged' });
  vi.setSystemTime(realNow);
  for (let i = 0; i < fresh; i += 1) mod.auditLog('auth.success', { apiKeyPrefix: 'fresh' });
  vi.useRealTimers();
}

function chainHead(entries: AuditModule['AuditEntry'][]): string {
  return entries[0]?.prevHmac ?? '';
}

describe('issue #599 — audit log retention', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('only appends on the write path — no read, rewrite or rename', () => {
    mod.auditLog('auth.success', { apiKeyPrefix: 'sk_test' });

    const read = vi.spyOn(fs, 'readFileSync');
    const write = vi.spyOn(fs, 'writeFileSync');
    const rename = vi.spyOn(fs, 'renameSync');
    const exists = vi.spyOn(fs, 'existsSync');

    mod.auditLog('auth.failure', { apiKeyPrefix: 'sk_test' });

    expect(read).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(write.mock.calls.length).toBeGreaterThan(0);
    expect(write.mock.calls.every((call) => (call[2] as { flag?: string } | undefined)?.flag === 'a')).toBe(true);
    expect(readActiveLines()).toHaveLength(2);
  });

  it('keeps per-event cost flat as the log grows', () => {
    seedEntries(20000, new Date().toISOString());

    const run = (count: number): number => {
      const startedAt = performance.now();
      for (let i = 0; i < count; i += 1) {
        mod.auditLog('auth.success', { apiKeyPrefix: 'sk_test' });
      }
      return (performance.now() - startedAt) / count;
    };

    run(20);
    const perEventMs = run(50);

    expect(perEventMs).toBeLessThan(20);
    expect(readActiveLines()).toHaveLength(20070);
  });

  it('does not run retention while writing an entry', () => {
    const aged = seedEntries(1, AGED_ISO)[0];

    mod.auditLog('auth.success', { apiKeyPrefix: 'sk_test' });

    expect(readActiveLines()).toContain(aged);
    expect(archiveLines()).toHaveLength(0);
    expect(fs.existsSync(paths.lock)).toBe(false);
    expect(leftoverTemps()).toHaveLength(0);
  });

  it('archives aged entries, keeps fresh ones and preserves the tamper-evident chain', () => {
    writeAgedThenFresh(3, 2);
    expect(activeEntries()).toHaveLength(5);

    const result = mod.enforceAuditRetention();

    expect(result.status).toBe('completed');
    expect(result.archived).toBe(3);
    expect(result.kept).toBe(2);
    expect(activeEntries()).toHaveLength(2);
    expect(archiveLines()).toHaveLength(3);

    const chain = mod.readAuditChain();
    expect(chain).toHaveLength(5);
    expect(mod.verifyAuditLogChain(chain, chainHead(chain))).toEqual({ valid: true, firstInvalidIndex: null });
    expect(fs.existsSync(paths.lock)).toBe(false);
    expect(leftoverTemps()).toHaveLength(0);
  });

  it('never overwrites the source file when the retention rename fails', () => {
    writeAgedThenFresh(3, 2);
    const before = readActiveLines();

    const errorSpy = vi.spyOn(logger, 'error');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EIO: simulated crash during retention');
    });

    const result = mod.enforceAuditRetention();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('simulated crash');
    expect(readActiveLines()).toEqual(before);
    expect(everyLineParses(readActiveLines())).toBe(true);
    expect(errorSpy.mock.calls.some((call) => call[0] === 'Audit retention could not run')).toBe(true);
    expect(leftoverTemps()).toHaveLength(0);

    vi.restoreAllMocks();
    const retry = mod.enforceAuditRetention();

    expect(retry.status).toBe('completed');
    const chain = mod.readAuditChain();
    expect(chain).toHaveLength(before.length);
    expect(everyLineParses([...archiveLines(), ...readActiveLines()])).toBe(true);
    expect(new Set(chain.map((entry) => entry.hmac)).size).toBe(before.length);
    expect(mod.verifyAuditLogChain(chain, chainHead(chain)).valid).toBe(true);
  });

  it('loses no entries when another writer appends during retention', () => {
    writeAgedThenFresh(3, 2);

    let injected = false;
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(function (
      this: typeof fs,
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: Parameters<typeof fs.writeFileSync>[2],
    ) {
      if (!injected && String(file).includes('.audit.log.')) {
        injected = true;
        mod.auditLog('admin.key_created', { apiKeyPrefix: 'concurrent' });
      }
      return realWrite.call(fs, file as never, data as never, options as never);
    });

    const result = mod.enforceAuditRetention();

    expect(result.status).toBe('completed');
    expect(injected).toBe(true);
    const chain = mod.readAuditChain();
    expect(chain).toHaveLength(6);
    expect(chain.filter((entry) => entry.event === 'admin.key_created')).toHaveLength(1);
    expect(mod.verifyAuditLogChain(chain, chainHead(chain)).valid).toBe(true);
    expect(leftoverTemps()).toHaveLength(0);
  });

  it('alerts instead of swallowing a retention failure', () => {
    writeAgedThenFresh(1, 1);

    const errorSpy = vi.spyOn(logger, 'error');
    const realAppend = fs.appendFileSync;
    vi.spyOn(fs, 'appendFileSync').mockImplementation(function (
      this: typeof fs,
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: Parameters<typeof fs.appendFileSync>[2],
    ) {
      if (String(file).includes('audit-archive')) {
        throw new Error('ENOSPC: no space left on device');
      }
      return realAppend.call(fs, file as never, data as never, options as never);
    });

    const result = mod.enforceAuditRetention();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('ENOSPC');
    expect(errorSpy.mock.calls.some((call) => call[0] === 'Audit retention could not run')).toBe(true);
    expect(archiveLines()).toHaveLength(0);
    expect(activeEntries()).toHaveLength(2);
    expect(leftoverTemps()).toHaveLength(0);
  });

  it('skips when another process holds the retention lock', () => {
    seedEntries(1, new Date().toISOString());
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: 1, acquiredAt: new Date().toISOString() }), 'utf8');

    const result = mod.enforceAuditRetention();

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('already running');
    expect(fs.existsSync(paths.lock)).toBe(true);
    expect(activeEntries()).toHaveLength(1);
  });
});
