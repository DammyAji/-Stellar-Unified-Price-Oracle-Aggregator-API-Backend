import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ASSET = 'issue589xlm';
const ACTIVE_KEY = 'a'.repeat(64);
const WRONG_KEY = 'b'.repeat(64);

type HistoryModule = typeof import('../src/persistence/history');
type ReadError = InstanceType<HistoryModule['HistoryReadError']>;

let history: HistoryModule;
let filePath = '';
let quarantineDir = '';

async function loadModule(): Promise<void> {
  vi.resetModules();
  history = await import('../src/persistence/history');
  filePath = history.HISTORY_FILE(ASSET);
  quarantineDir = history.QUARANTINE_DIR;
}

function quarantineArtifacts(reason: string): string[] {
  if (!fs.existsSync(quarantineDir)) return [];
  return fs
    .readdirSync(quarantineDir)
    .filter((f) => f.startsWith(`history-${ASSET}-${reason}-`));
}

function expectReadFailure(fn: () => unknown, reason: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(history.HistoryReadError);
  expect((caught as ReadError).reason).toBe(reason);
}

function cleanup(): void {
  if (filePath && fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  if (quarantineDir && fs.existsSync(quarantineDir)) {
    for (const f of fs.readdirSync(quarantineDir)) {
      if (f.startsWith(`history-${ASSET}`)) fs.rmSync(path.join(quarantineDir, f), { force: true });
    }
  }
}

describe('issue #589 — history file integrity', () => {
  beforeEach(async () => {
    delete process.env.ENCRYPT_HISTORY;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    await loadModule();
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    delete process.env.ENCRYPT_HISTORY;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
  });

  it('appends to a valid file and preserves every existing entry', () => {
    const base = Math.floor(Date.now() / 1000) - 600;
    history.writeHistoryFile(filePath, [
      { price: '100', decimals: 7, source: 'chainlink', timestamp: base },
      { price: '101', decimals: 7, source: 'chainlink', timestamp: base + 1 },
      { price: '102', decimals: 7, source: 'chainlink', timestamp: base + 2 },
    ]);

    history.appendHistoricalPrice(ASSET, '103', 7, 'redstone', base + 3);

    const entries = history.readHistoryFile(filePath);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ price: '100', decimals: 7, source: 'chainlink', timestamp: base });
    expect(entries[3]).toEqual({ price: '103', decimals: 7, source: 'redstone', timestamp: base + 3 });
    expect(quarantineArtifacts('malformed')).toHaveLength(0);
    expect(quarantineArtifacts('undecryptable')).toHaveLength(0);
  });

  it('distinguishes an absent file from an unreadable one', () => {
    expect(fs.existsSync(filePath)).toBe(false);
    expect(history.readHistoryFileStatus(filePath).state).toBe('absent');
    expect(history.getHistoricalPrices(ASSET)).toEqual([]);

    fs.writeFileSync(filePath, '{"not":"an array"}');
    const status = history.readHistoryFileStatus(filePath);
    expect(status.state).toBe('unreadable');
    if (status.state === 'unreadable') expect(status.reason).toBe('malformed');
    expectReadFailure(() => history.getHistoricalPrices(ASSET), 'malformed');
  });

  it('treats an empty file as empty rather than unreadable', () => {
    fs.writeFileSync(filePath, '');

    expect(history.readHistoryFileStatus(filePath).state).toBe('empty');
    expect(history.getHistoricalPrices(ASSET)).toEqual([]);

    history.appendHistoricalPrice(ASSET, '100', 7, 'chainlink', Math.floor(Date.now() / 1000));

    expect(history.readHistoryFile(filePath)).toHaveLength(1);
    expect(quarantineArtifacts('malformed')).toHaveLength(0);
  });

  it('quarantines truncated JSON instead of overwriting it', async () => {
    const truncated = '[{"price":"100","decimals":7,"source":"chainlink","timestamp":1},{"price":"101"';
    fs.writeFileSync(filePath, truncated);
    expectReadFailure(() => history.getHistoricalPrices(ASSET), 'malformed');

    history.appendHistoricalPrice(ASSET, '200', 7, 'chainlink', Math.floor(Date.now() / 1000));

    const quarantined = quarantineArtifacts('malformed');
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantineDir, quarantined[0]), 'utf-8')).toBe(truncated);

    const entries = history.readHistoryFile(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].price).toBe('200');

    const { register } = await import('../src/observability/metrics');
    const text = await register.metrics();
    expect(text).toContain('history_file_quarantines_total{asset="issue589xlm",reason="malformed"} 1');
    expect(text).toContain('history_file_read_failures_total{asset="issue589xlm",reason="malformed"} 1');
  });

  it('quarantines a file that cannot be decrypted with the current key', async () => {
    process.env.ENCRYPT_HISTORY = 'true';
    process.env.ENCRYPTION_KEY = ACTIVE_KEY;
    await loadModule();

    const now = Math.floor(Date.now() / 1000) - 60;
    history.writeHistoryFile(filePath, [
      { price: '300', decimals: 7, source: 'chainlink', timestamp: now },
      { price: '301', decimals: 7, source: 'chainlink', timestamp: now + 1 },
    ]);
    expect(fs.readFileSync(filePath, 'utf-8')).toMatch(/^enc:v1:/);

    process.env.ENCRYPTION_KEY = WRONG_KEY;
    await loadModule();

    expectReadFailure(() => history.readHistoryFile(filePath), 'undecryptable');

    history.appendHistoricalPrice(ASSET, '302', 7, 'chainlink', now + 2);

    const quarantined = quarantineArtifacts('undecryptable');
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantineDir, quarantined[0]), 'utf-8')).toMatch(/^enc:v1:/);

    const entries = history.readHistoryFile(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].price).toBe('302');
  });

  it('leaves an unreadable file in place when quarantine itself fails', () => {
    const truncated = '[{"price":"100"';
    fs.writeFileSync(filePath, truncated);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => history.appendHistoricalPrice(ASSET, '400', 7, 'chainlink', Math.floor(Date.now() / 1000))).toThrow(
      history.HistoryReadError,
    );
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(truncated);
    rename.mockRestore();
  });

  it('writes atomically and leaves no temporary files behind', () => {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(filePath, `[{"price":"500","decimals":7,"source":"chainlink","timestamp":${now}}]`);

    history.appendHistoricalPrice(ASSET, '501', 7, 'chainlink', now + 1);

    expect(history.readHistoryFile(filePath)).toHaveLength(2);
    const leftovers = fs
      .readdirSync(path.dirname(filePath))
      .filter((f) => f.includes(`history-${ASSET}`) && f.includes('.tmp'));
    expect(leftovers).toHaveLength(0);
  });

  it('verifies the payload after writing', () => {
    const now = Math.floor(Date.now() / 1000);
    const stored = [{ price: '600', decimals: 7, source: 'chainlink', timestamp: now }];
    history.writeHistoryFile(filePath, stored);

    expect(() => history.verifyHistoryFile(filePath, stored)).not.toThrow();
    expect(() =>
      history.verifyHistoryFile(filePath, [...stored, { price: '601', decimals: 7, source: 'chainlink', timestamp: now + 1 }]),
    ).toThrow(history.HistoryWriteError);
    expect(() => history.verifyHistoryFile(filePath, stored)).not.toThrow();

    fs.writeFileSync(filePath, 'not-json');
    expect(() => history.verifyHistoryFile(filePath, stored)).toThrow(history.HistoryWriteError);
  });
});
