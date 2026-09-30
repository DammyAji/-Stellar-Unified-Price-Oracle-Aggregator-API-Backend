import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpClient } from '../src/infrastructure/http-client';
import { RedstoneSource } from '../src/oracle-sources/redstone';
import { BandSource } from '../src/oracle-sources/band';
import { ReflectorSource } from '../src/oracle-sources/reflector';
import { ChainlinkSource } from '../src/oracle-sources/chainlink';
import {
  InvalidPayloadError,
  MAX_DECIMALS,
  MIN_DECIMALS,
  SOURCE_DECIMALS,
  resolveDecimals,
} from '../src/oracle-sources/decimals';

vi.mock('../src/infrastructure/http-client', () => ({
  httpClient: {
    get: vi.fn(),
  },
}));

vi.mock('../src/price-aggregation/source-circuit-breaker', () => ({
  sourceCircuitBreaker: {
    isAllowed: vi.fn(() => true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock('../src/observability/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observability/metrics')>();
  const mockCounter = { inc: vi.fn() };
  return {
    ...actual,
    oracleSourceLatency: {
      startTimer: vi.fn(() => vi.fn(() => 0)),
    },
    oracleSourceRequestsTotal: mockCounter,
    oracleSourceSlaBreaches: mockCounter,
    oracleApiCallsTotal: mockCounter,
    oracleApiCostTotal: mockCounter,
    oracleApiBudgetUtilization: { set: vi.fn(), inc: vi.fn() },
  };
});

const mockedHttpClient = vi.mocked(httpClient);

const POWERS: Array<{ decimals: number; factor: bigint }> = [
  { decimals: 0, factor: 1n },
  { decimals: 1, factor: 10n },
  { decimals: 8, factor: 10n ** 8n },
  { decimals: 9, factor: 10n ** 9n },
  { decimals: 18, factor: 10n ** 18n },
];

type PayloadFactory = (decimals: number | undefined) => unknown;

const payloads: Record<string, { source: () => { fetchPrice(a: string): Promise<unknown> }; build: PayloadFactory }> = {
  redstone: {
    source: () => new RedstoneSource(),
    build: (decimals) => ({ XLM: { value: '12', ...(decimals === undefined ? {} : { decimals }) } }),
  },
  band: {
    source: () => new BandSource(),
    build: (decimals) => ({
      data: { price: '12', ...(decimals === undefined ? {} : { decimals }), updated_at: 1719000000 },
    }),
  },
  reflector: {
    source: () => new ReflectorSource(),
    build: (decimals) => ({
      prices: {
        'Crypto.XLM/USD': {
          price: '12',
          ...(decimals === undefined ? {} : { decimals }),
          timestamp: 1719000000,
        },
      },
    }),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Issue #585: source decimals handling', () => {
  describe('decimals: 0 is a real scale, not a missing value', () => {
    for (const [name, fixture] of Object.entries(payloads)) {
      it(`${name} keeps decimals 0 and scales the price by exactly 10^0`, async () => {
        mockedHttpClient.get.mockResolvedValue({ data: fixture.build(0) } as never);

        const price = await fixture.source().fetchPrice('XLM');

        expect(price).toMatchObject({ decimals: 0, price: 12n });
      });

      it(`${name} scales the same raw price by exactly 10^decimals for every legal scale`, async () => {
        for (const { decimals, factor } of POWERS) {
          mockedHttpClient.get.mockResolvedValue({ data: fixture.build(decimals) } as never);
          const price = (await fixture.source().fetchPrice('XLM')) as { price: bigint; decimals: number };

          expect(price.decimals).toBe(decimals);
          expect(price.price).toBe(12n * factor);
        }
      });
    }

    it('a zero-decimals reading differs from an 8-decimals reading by exactly 10^8', async () => {
      const fixture = payloads.redstone;

      mockedHttpClient.get.mockResolvedValue({ data: fixture.build(0) } as never);
      const zero = (await fixture.source().fetchPrice('XLM')) as { price: bigint };

      mockedHttpClient.get.mockResolvedValue({ data: fixture.build(8) } as never);
      const eight = (await fixture.source().fetchPrice('XLM')) as { price: bigint };

      expect(eight.price / zero.price).toBe(10n ** 8n);
      expect(eight.price).toBe(zero.price * 10n ** 8n);
    });
  });

  describe('missing decimals is an explicit failure, never a default', () => {
    for (const [name, fixture] of Object.entries(payloads)) {
      it(`${name} fails with invalid-payload when the field is absent`, async () => {
        mockedHttpClient.get.mockResolvedValue({ data: fixture.build(undefined) } as never);

        await expect(fixture.source().fetchPrice('XLM')).rejects.toMatchObject({
          code: 'invalid-payload',
          reason: 'decimals-missing',
        });
      });

      it(`${name} fails when the field is null`, async () => {
        mockedHttpClient.get.mockResolvedValue({
          data: fixture.build(null as unknown as number),
        } as never);

        await expect(fixture.source().fetchPrice('XLM')).rejects.toMatchObject({
          code: 'invalid-payload',
          reason: 'decimals-missing',
        });
      });
    }
  });

  describe('boundary values', () => {
    it('accepts the contract minimum (0) and maximum (18)', () => {
      expect(resolveDecimals('band', MIN_DECIMALS)).toBe(0);
      expect(resolveDecimals('band', MAX_DECIMALS)).toBe(18);
    });

    it('rejects one past the contract maximum', () => {
      expect(() => resolveDecimals('band', MAX_DECIMALS + 1)).toThrow(InvalidPayloadError);
      expect(() => resolveDecimals('band', MAX_DECIMALS + 1)).toThrow(/outside contract range/);
    });

    it('rejects negative scales', () => {
      expect(() => resolveDecimals('reflector', MIN_DECIMALS - 1)).toThrow(InvalidPayloadError);
    });

    it('rejects non-integer and non-numeric scales', () => {
      expect(() => resolveDecimals('redstone', 8.5)).toThrow(/non-integer/);
      expect(() => resolveDecimals('redstone', '8')).toThrow(InvalidPayloadError);
      expect(() => resolveDecimals('redstone', true)).toThrow(InvalidPayloadError);
    });

    it('every error carries the invalid-payload code the issue requires', () => {
      for (const value of [undefined, null, 19, -1, 8.5, '8']) {
        try {
          resolveDecimals('band', value);
          throw new Error(`expected resolveDecimals(${String(value)}) to throw`);
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidPayloadError);
          expect((err as InvalidPayloadError).code).toBe('invalid-payload');
          expect((err as InvalidPayloadError).source).toBe('band');
        }
      }
    });

    it('a rejected scale never reaches normalize(), so no price is produced', async () => {
      mockedHttpClient.get.mockResolvedValue({
        data: { data: { price: '12', decimals: 19 } },
      } as never);

      await expect(new BandSource().fetchPrice('XLM')).rejects.toBeInstanceOf(InvalidPayloadError);
    });
  });

  describe('per-source scale policy', () => {
    it('chainlink has no decimals field, so its scale is fixed at 8', () => {
      expect(SOURCE_DECIMALS.chainlink).toEqual({ kind: 'fixed', value: 8 });
      expect(resolveDecimals('chainlink', undefined)).toBe(8);
      expect(resolveDecimals('chainlink', 0)).toBe(8);
    });

    it('every provider that reports decimals uses the reported policy', () => {
      expect(SOURCE_DECIMALS.redstone).toEqual({ kind: 'reported' });
      expect(SOURCE_DECIMALS.band).toEqual({ kind: 'reported' });
      expect(SOURCE_DECIMALS.reflector).toEqual({ kind: 'reported' });
    });

    it('chainlink still normalizes at 8 dp', async () => {
      mockedHttpClient.get.mockResolvedValue({ data: { USD: { PRICE: 0.12 } } } as never);

      const price = await new ChainlinkSource().fetchPrice('XLM');

      expect(price).toMatchObject({ decimals: 8, price: 12000000n });
    });
  });
});
