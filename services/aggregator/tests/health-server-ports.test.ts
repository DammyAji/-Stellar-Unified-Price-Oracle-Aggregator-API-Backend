import { describe, it, expect, afterEach } from 'vitest';
import { HealthServer, HealthSnapshot } from '../src/observability/health-server';

function snapshotWithPorts(ports: { base: number; ws: number; http: number }): HealthSnapshot {
  return {
    sourceHealth: {
      chainlink: { healthy: true, uptimePercent: 100, consecutiveFailures: 0 },
    },
    lastAggregated: [],
    uptime: 1,
    startupTimeMs: 1,
    ports,
  } as unknown as HealthSnapshot;
}

describe('HealthServer resolved ports (#590)', () => {
  let server: HealthServer | null = null;
  const port = 47321;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('exposes the resolved ports on /health', async () => {
    const ports = { base: 4000, ws: 4001, http: 4002 };
    server = new HealthServer(port, () => snapshotWithPorts(ports));
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ports?: { base: number; ws: number; http: number } };
    expect(body.ports).toEqual(ports);
    expect(body.ports?.http).toBe(body.ports ? body.ports.base + 2 : -1);
  });

  it('omits the ports field when the snapshot has none (back-compat)', async () => {
    server = new HealthServer(port, () => ({
      sourceHealth: { chainlink: { healthy: true, uptimePercent: 100, consecutiveFailures: 0 } },
      lastAggregated: [],
      uptime: 1,
    } as unknown as HealthSnapshot));
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect('ports' in body).toBe(false);
  });
});
