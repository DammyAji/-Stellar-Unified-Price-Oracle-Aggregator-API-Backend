import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEBHOOK_MAX_CONCURRENT = '4';
  process.env.WEBHOOK_MAX_RETRIES = '2';
  process.env.WEBHOOK_BASE_DELAY_MS = '10';
  process.env.WEBHOOK_MAX_DELAY_MS = '20';
  process.env.WEBHOOK_CIRCUIT_THRESHOLD = '2';
  process.env.WEBHOOK_CIRCUIT_COOLDOWN_MS = '500';
  process.env.WEBHOOK_MAX_PENDING = '100';
});

import { webhookService } from '../src/webhooks/webhook-service';
import {
  webhookCircuitsOpen,
  webhookDeliveriesInFlight,
  webhookQueueDepth,
} from '../src/observability/metrics';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const gaugeValue = async (gauge: { get(): Promise<{ values: { value: number }[] }> }) => {
  const metric = await gauge.get();
  return metric.values.reduce((sum, sample) => sum + sample.value, 0);
};

describe('Webhook delivery queue (issue #602)', () => {
  beforeEach(() => {
    webhookService.reset();
  });

  afterEach(() => {
    webhookService.reset();
    vi.unstubAllGlobals();
  });

  it('keeps a burst of 100 slow registrations within the concurrency bound and measures it', async () => {
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active -= 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    for (let i = 0; i < 100; i++) {
      webhookService.register(`https://slow.example/${i}`, 'burst-key', {
        type: 'interval',
        asset: 'XLM',
        value: 1,
      });
    }

    await webhookService.handlePriceUpdate('XLM', 1);

    const inFlight = await gaugeValue(webhookDeliveriesInFlight);
    const depth = await gaugeValue(webhookQueueDepth);
    expect(inFlight).toBe(4);
    expect(depth).toBe(100);

    await webhookService.drain();

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(webhookService.deliveries().length).toBe(100);
    expect(await gaugeValue(webhookQueueDepth)).toBe(0);
    expect(await gaugeValue(webhookDeliveriesInFlight)).toBe(0);
  });

  it('delivers to a single destination strictly in FIFO order', async () => {
    const prices: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        prices.push(Number(JSON.parse(String(init?.body)).price));
        await sleep(5);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    webhookService.register('https://ordered.example', 'order-key', {
      type: 'threshold',
      asset: 'XLM',
      value: 0,
    });

    for (const price of [100, 200, 400, 800, 1600, 3200]) {
      await webhookService.handlePriceUpdate('XLM', price);
    }
    await webhookService.drain();

    expect(prices).toEqual([200, 400, 800, 1600, 3200]);
  });

  it('parks a dead endpoint behind an open circuit and probes it after the cool-down', async () => {
    let failMode = true;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (failMode) throw new Error('connection refused');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const webhook = webhookService.register('https://dead.example', 'dead-key', {
      type: 'threshold',
      asset: 'BTC',
      value: 0,
    });
    expect(webhook.circuit).toBe('closed');

    await webhookService.handlePriceUpdate('BTC', 100);
    await webhookService.handlePriceUpdate('BTC', 200);
    await webhookService.drain();

    await webhookService.handlePriceUpdate('BTC', 400);
    await webhookService.drain();

    expect(webhook.circuit).toBe('open');
    expect(webhook.status).toBe('dead-letter');
    expect(webhook.nextProbeAt).toBeGreaterThan(Date.now());
    expect(await gaugeValue(webhookCircuitsOpen)).toBe(1);
    const parkedCalls = calls;
    expect(calls).toBe(parkedCalls);

    await webhookService.handlePriceUpdate('BTC', 800);
    expect(calls).toBe(parkedCalls);

    const untilProbe = Math.max(0, (webhook.nextProbeAt ?? 0) - Date.now() - 60);
    if (untilProbe > 0) await sleep(untilProbe);
    expect(calls).toBe(parkedCalls);

    failMode = false;
    await webhookService.drain(3000);

    expect(calls).toBe(parkedCalls + 1);
    expect(webhook.circuit).toBe('closed');
    expect(webhook.status).toBe('healthy');
    expect(webhook.nextProbeAt).toBeUndefined();
    expect(await gaugeValue(webhookCircuitsOpen)).toBe(0);
    const successes = webhookService.deliveries(webhook.id).filter((d) => d.success);
    expect(successes.length).toBe(1);
  });

  it('never blocks price updates while deliveries are slow or failing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new Error('endpoint down')), 200);
          }),
      ),
    );

    webhookService.register('https://isolated.example', 'iso-key', {
      type: 'threshold',
      asset: 'ETH',
      value: 0,
    });

    await webhookService.handlePriceUpdate('ETH', 10);
    const started = performance.now();
    await webhookService.handlePriceUpdate('ETH', 20);
    await webhookService.handlePriceUpdate('ETH', 40);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(50);
    expect(await gaugeValue(webhookDeliveriesInFlight)).toBe(1);

    await webhookService.drain(10000);
    expect(await gaugeValue(webhookQueueDepth)).toBe(0);
    expect(await gaugeValue(webhookDeliveriesInFlight)).toBe(0);
  });
});
