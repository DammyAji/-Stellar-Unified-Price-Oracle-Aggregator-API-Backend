import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import rawVitestConfig from '../vitest.config';

const here = dirname(fileURLToPath(import.meta.url));
const aggregatorRoot = resolve(here, '..');

interface CoverageConfig {
  include?: string[];
  exclude?: string[];
  thresholds?: Record<string, number>;
}

interface ResolvedConfig {
  test?: { coverage?: CoverageConfig };
}

const config = rawVitestConfig as ResolvedConfig;
const coverage = config.test?.coverage;

const ENTRYPOINT_EXCLUSION = 'src/index.ts';
const DELETED_MODULE = 'src/performance/high-throughput-pipeline.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(relative(aggregatorRoot, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const source = escaped
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:.*/)?');
    return new RegExp(`^${source}$`).test(file);
  });
}

describe('Issue #588: coverage configuration cannot mask unused modules', () => {
  it('excludes exactly the process entrypoint and nothing else', () => {
    expect(coverage?.exclude).toEqual([ENTRYPOINT_EXCLUSION]);
    expect(existsSync(resolve(aggregatorRoot, ENTRYPOINT_EXCLUSION))).toBe(true);
  });

  it('measures every other file under src/', () => {
    expect(coverage?.include).toEqual(['src/**/*.ts']);

    const include = coverage?.include ?? [];
    const exclude = coverage?.exclude ?? [];
    const unmeasured = sourceFiles(resolve(aggregatorRoot, 'src'))
      .filter((file) => file !== ENTRYPOINT_EXCLUSION)
      .filter((file) => !matchesAny(file, include) || matchesAny(file, exclude));
    expect(unmeasured).toEqual([]);
  });

  it('no module can hide behind an exclusion other than the entrypoint', () => {
    const exclude = (coverage?.exclude ?? []).map((entry) => entry.replace(/\\/g, '/'));
    expect(exclude).toEqual([ENTRYPOINT_EXCLUSION]);

    for (const entry of exclude) {
      expect(existsSync(resolve(aggregatorRoot, entry))).toBe(true);
    }
  });

  it('still declares the thresholds CI asserts', () => {
    expect(coverage?.thresholds).toBeDefined();
    for (const metric of ['lines', 'functions', 'statements', 'branches'] as const) {
      expect(typeof coverage?.thresholds?.[metric]).toBe('number');
    }
  });

  it('the deleted pipeline module is still gone', () => {
    expect(existsSync(resolve(aggregatorRoot, DELETED_MODULE))).toBe(false);
    expect(existsSync(resolve(aggregatorRoot, 'src/performance'))).toBe(false);
  });
});
