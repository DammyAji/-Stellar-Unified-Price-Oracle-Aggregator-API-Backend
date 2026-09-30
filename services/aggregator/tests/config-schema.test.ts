import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  AGGREGATOR_ENV_KEYS,
  ConfigValidationError,
  parseConfigEnv,
  redactConfig,
} from '../src/infrastructure/config-schema';
import { loadConfig } from '../src/infrastructure/config';

const ENV_EXAMPLE = path.resolve(__dirname, '../../../.env.example');

const DOC_LINE = /^#\s*([A-Z][A-Z0-9_]+)\s*\|\s*([a-z]+)\s*\|\s*default=(".*?"|\S*)\s*\|\s*(.+)$/;

interface DocEntry {
  key: string;
  type: string;
  defaultValue: string;
  effect: string;
}

function readEnvExample(): string {
  return fs.readFileSync(ENV_EXAMPLE, 'utf8');
}

function documentedEntries(raw: string): DocEntry[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.match(DOC_LINE))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      key: match[1],
      type: match[2],
      defaultValue: match[3].replace(/^"(.*)"$/, '$1'),
      effect: match[4].trim(),
    }));
}

function assignments(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function expectIssue(env: Record<string, string | undefined>, variable: string): void {
  try {
    parseConfigEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    const issues = (error as ConfigValidationError).issues;
    expect(issues.map((issue) => issue.variable)).toContain(variable);
    return;
  }
  throw new Error(`expected ${variable} to be rejected`);
}

describe('.env.example documentation (Issue #582)', () => {
  const raw = readEnvExample();
  const entries = documentedEntries(raw);

  it('documents every schema variable with type, default and effect', () => {
    const documented = new Set(entries.map((entry) => entry.key));
    const undocumented = AGGREGATOR_ENV_KEYS.filter((key) => !documented.has(key));
    expect(undocumented).toEqual([]);
  });

  it('gives every documented variable a non-empty type and effect', () => {
    for (const entry of entries) {
      expect(entry.type, entry.key).toMatch(/^(int|float|bool|string|csv|url)$/);
      expect(entry.effect.length, entry.key).toBeGreaterThan(0);
    }
  });

  it('schema accepts the documented defaults', () => {
    const env: Record<string, string> = {};
    for (const entry of entries) {
      env[entry.key] = entry.defaultValue;
    }
    expect(() => parseConfigEnv(env)).not.toThrow();
  });

  it('documented defaults equal the schema defaults', () => {
    const documented: Record<string, string> = {};
    for (const entry of entries) {
      documented[entry.key] = entry.defaultValue;
    }
    expect(parseConfigEnv(documented)).toEqual(parseConfigEnv({}));
  });

  it('schema accepts the values assigned in .env.example', () => {
    expect(() => parseConfigEnv(assignments(raw))).not.toThrow();
  });
});

describe('asset list normalization (Issue #582)', () => {
  it('trims, upper-cases and de-duplicates', () => {
    const parsed = parseConfigEnv({ WATCHED_ASSETS: 'XLM, xlm ,BTC,Usdc' } as NodeJS.ProcessEnv);
    expect(parsed.WATCHED_ASSETS).toEqual(['XLM', 'BTC', 'USDC']);
  });

  it('rejects an empty list', () => {
    expectIssue({ WATCHED_ASSETS: '' }, 'WATCHED_ASSETS');
  });

  it('rejects empty entries produced by a trailing or doubled comma', () => {
    expectIssue({ WATCHED_ASSETS: 'XLM,' }, 'WATCHED_ASSETS');
    expectIssue({ WATCHED_ASSETS: 'XLM,,USDC' }, 'WATCHED_ASSETS');
    expectIssue({ WATCHED_ASSETS: ' , ' }, 'WATCHED_ASSETS');
  });

  it('rejects malformed symbols', () => {
    expectIssue({ WATCHED_ASSETS: 'XLM/BTC' }, 'WATCHED_ASSETS');
    expectIssue({ WATCHED_ASSETS: `${'A'.repeat(33)}` }, 'WATCHED_ASSETS');
  });

  it('rejects more assets than the curated budget', () => {
    const many = Array.from({ length: 51 }, (_, index) => `A${index}`).join(',');
    expectIssue({ WATCHED_ASSETS: many }, 'WATCHED_ASSETS');
  });

  it('defaults to the documented asset list when unset', () => {
    expect(parseConfigEnv({}).WATCHED_ASSETS).toEqual(['XLM', 'USDC', 'BTC', 'ETH', 'USDT']);
  });
});

describe('numeric variables (Issue #582)', () => {
  it('rejects non-numeric integers instead of producing NaN', () => {
    expectIssue({ POLLING_INTERVAL_MS: '30s' }, 'POLLING_INTERVAL_MS');
    expectIssue({ STALENESS_THRESHOLD_MS: '2m' }, 'STALENESS_THRESHOLD_MS');
    expectIssue({ HISTORY_MAX_ENTRIES: '1e3' }, 'HISTORY_MAX_ENTRIES');
  });

  it('rejects negative and zero thresholds', () => {
    expectIssue({ STALENESS_THRESHOLD_MS: '-1' }, 'STALENESS_THRESHOLD_MS');
    expectIssue({ HISTORY_MAX_ENTRIES: '-5' }, 'HISTORY_MAX_ENTRIES');
    expectIssue({ POLLING_INTERVAL_MS: '0' }, 'POLLING_INTERVAL_MS');
  });

  it('rejects values outside the documented range', () => {
    expectIssue({ PORT: '70000' }, 'PORT');
    expectIssue({ PORT: '0' }, 'PORT');
    expectIssue({ REGION_MAX_REPLICATION_LAG_MS: '0' }, 'REGION_MAX_REPLICATION_LAG_MS');
    expectIssue({ WS_RATE_LIMIT_WINDOW_MS: '10' }, 'WS_RATE_LIMIT_WINDOW_MS');
  });

  it('rejects non-numeric percentages so drift detection cannot silently stop', () => {
    expectIssue({ REGION_DRIFT_ALERT_PERCENT: 'abc' }, 'REGION_DRIFT_ALERT_PERCENT');
    expectIssue({ REGION_QUARANTINE_RECOVER_PERCENT: 'NaN' }, 'REGION_QUARANTINE_RECOVER_PERCENT');
    expectIssue({ REGION_DRIFT_ALERT_PERCENT: '101' }, 'REGION_DRIFT_ALERT_PERCENT');
  });

  it('accepts the documented ranges at their boundaries', () => {
    const low = { PORT: '1', REGION_DRIFT_ALERT_PERCENT: '0', REGION_QUARANTINE_RECOVER_PERCENT: '0' };
    const high = { PORT: '65535', REGION_DRIFT_ALERT_PERCENT: '100', REGION_QUARANTINE_RECOVER_PERCENT: '100' };
    expect(() => parseConfigEnv(low as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => parseConfigEnv(high as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('URL, boolean and enum variables (Issue #582)', () => {
  it('rejects malformed source URLs', () => {
    expectIssue({ CHAINLINK_BASE_URL: 'not a url' }, 'CHAINLINK_BASE_URL');
    expectIssue({ REDSTONE_BASE_URL: '' }, 'REDSTONE_BASE_URL');
    expectIssue({ SOROBAN_RPC_URL: 'ftp://example.com' }, 'SOROBAN_RPC_URL');
  });

  it('rejects booleans that are not true/false', () => {
    expectIssue({ SSRF_PROTECTION_ENABLED: 'yes' }, 'SSRF_PROTECTION_ENABLED');
    expectIssue({ REGION_QUARANTINE_ENABLED: '1' }, 'REGION_QUARANTINE_ENABLED');
    expectIssue({ ENCRYPT_HISTORY: 'no' }, 'ENCRYPT_HISTORY');
  });

  it('rejects unknown log levels', () => {
    expectIssue({ LOG_LEVEL: 'chatty' }, 'LOG_LEVEL');
  });

  it('rejects malformed encryption keys', () => {
    expectIssue({ ENCRYPTION_KEY: 'not-hex' }, 'ENCRYPTION_KEY');
    expectIssue({ ENCRYPTION_KEY: 'abcd' }, 'ENCRYPTION_KEY');
    expect(() => parseConfigEnv({ ENCRYPTION_KEY: 'a'.repeat(64) })).not.toThrow();
  });

  it('rejects malformed comma-separated lists', () => {
    expectIssue({ ORACLE_ALLOWED_HOSTS: 'exa mple.com' }, 'ORACLE_ALLOWED_HOSTS');
    expectIssue({ WS_ALLOWED_ORIGINS: 'example.com' }, 'WS_ALLOWED_ORIGINS');
    expectIssue({ REGION_PEERS: 'us_east_1' }, 'REGION_PEERS');
  });
});

describe('cross-variable validation (Issue #582)', () => {
  it('rejects a recovery threshold that can never be reached', () => {
    try {
      parseConfigEnv({
        REGION_DRIFT_ALERT_PERCENT: '0.1',
        REGION_QUARANTINE_RECOVER_PERCENT: '0.5',
      } as NodeJS.ProcessEnv);
      throw new Error('expected a configuration error');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues[0].variable).toBe(
        'REGION_QUARANTINE_RECOVER_PERCENT',
      );
    }
  });
});

describe('fail-fast reporting (Issue #582)', () => {
  it('lists every invalid variable in a single error', () => {
    try {
      parseConfigEnv({
        POLLING_INTERVAL_MS: '30s',
        REGION_DRIFT_ALERT_PERCENT: 'abc',
        WATCHED_ASSETS: '',
        CHAINLINK_BASE_URL: 'nope',
        SSRF_PROTECTION_ENABLED: 'yes',
      } as NodeJS.ProcessEnv);
      throw new Error('expected a configuration error');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const validation = error as ConfigValidationError;
      expect(validation.issues.map((issue) => issue.variable).sort()).toEqual([
        'CHAINLINK_BASE_URL',
        'POLLING_INTERVAL_MS',
        'REGION_DRIFT_ALERT_PERCENT',
        'SSRF_PROTECTION_ENABLED',
        'WATCHED_ASSETS',
      ]);
      expect(validation.message).toContain('POLLING_INTERVAL_MS');
      expect(validation.message).toContain('WATCHED_ASSETS');
    }
  });
});

describe('redacted configuration view (Issue #582)', () => {
  it('hides secrets but keeps operational values readable', () => {
    const config = loadConfig({
      ADMIN_SECRET_KEY: 's'.repeat(64),
      CHAINLINK_API_KEY: 'chain-key',
      ENCRYPTION_KEY: 'a'.repeat(64),
      DATABASE_URL: 'postgresql://oracle:hunter2@db:5432/oracle',
      POLLING_INTERVAL_MS: '45000',
    } as NodeJS.ProcessEnv);

    const view = JSON.stringify(redactConfig(config));
    expect(view).not.toContain('hunter2');
    expect(view).not.toContain('chain-key');
    expect(view).toContain('***');
    expect(view).toContain('45000');
    expect(view).toContain('https://min-api.cryptocompare.com/data');
    expect(JSON.parse(view).soroban.networkPassphrase).toBe(
      'Test SDF Network ; September 2015',
    );
  });
});
