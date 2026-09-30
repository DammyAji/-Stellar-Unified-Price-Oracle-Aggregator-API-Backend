import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebSocketServer } from '../src/infrastructure/ws-server';
import { WS_DROP_CLOSE_CODES, WS_PROTOCOL_VERSION } from '../src/infrastructure/ws-protocol';

const PORT = 9107;

interface TestClient {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  closed: { code: number; reason: string } | null;
  send(payload: unknown): void;
}

const clients: TestClient[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(): Promise<TestClient> {
  const socket = new WebSocket(`ws://localhost:${PORT + 1}`, { origin: 'http://localhost' });
  const client: TestClient = {
    socket,
    messages: [],
    closed: null,
    send: (payload) => socket.send(JSON.stringify(payload)),
  };
  socket.on('message', (data) => {
    try {
      client.messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // Non-JSON frames are not part of the protocol.
    }
  });
  socket.on('close', (code, reason) => {
    client.closed = { code, reason: reason.toString() };
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  clients.push(client);
  return client;
}

async function waitFor(
  client: TestClient,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `timed out waiting for message; received: ${client.messages.map((m) => String(m.type)).join(', ')}`,
  );
}

function priceUpdate(client: TestClient): Record<string, unknown>[] {
  return client.messages.filter((m) => m.type === 'price_update');
}

function price(asset: string) {
  return { asset, price: '1.0', decimals: 7, sources: [], timestamp: 1, confidence: 1 };
}

describe('push subscriptions over a live socket (Issue #587)', () => {
  let server: WebSocketServer;

  beforeAll(() => {
    server = new WebSocketServer(PORT);
    server.start();
  });

  afterAll(() => {
    server.stop();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.socket.terminate();
    }
  });

  it('greets a new connection with a versioned hello envelope', async () => {
    const client = await connect();
    const hello = await waitFor(client, (m) => m.type === 'hello');
    expect(hello.version).toBe(WS_PROTOCOL_VERSION);
    expect(hello.version).toBe(2);
    expect(hello.data).toMatchObject({
      version: 2,
      filtered: false,
      subscriptions: ['*'],
      maxSubscriptions: 100,
    });
    expect(typeof hello.sequence).toBe('number');
    expect(typeof hello.timestamp).toBe('number');
  });

  it('acknowledges subscribe and then filters the broadcast', async () => {
    const client = await connect();
    await waitFor(client, (m) => m.type === 'hello');

    client.send({ type: 'subscribe', assets: ['btc'] });
    const ack = await waitFor(client, (m) => m.type === 'subscribed');
    expect(ack.data).toEqual({
      filtered: true,
      subscriptions: ['BTC'],
      maxSubscriptions: 100,
    });

    server.broadcast({ type: 'price_update', data: [price('BTC'), price('ETH'), price('XLM')] });
    const update = await waitFor(client, (m) => m.type === 'price_update');

    expect(update.version).toBe(2);
    expect(update.data).toEqual([price('BTC')]);
  });

  it('keeps a fresh connection on the full feed', async () => {
    const client = await connect();
    await waitFor(client, (m) => m.type === 'hello');

    server.broadcast({ type: 'price_update', data: [price('BTC'), price('ETH')] });
    const update = await waitFor(client, (m) => m.type === 'price_update');
    expect(update.data).toHaveLength(2);
  });

  it('stops delivering once the connection unsubscribes from everything', async () => {
    const client = await connect();
    await waitFor(client, (m) => m.type === 'hello');

    client.send({ type: 'unsubscribe', assets: ['*'] });
    const ack = await waitFor(client, (m) => m.type === 'subscribed');
    expect(ack.data).toEqual({
      filtered: true,
      subscriptions: [],
      maxSubscriptions: 100,
    });

    server.broadcast({ type: 'price_update', data: [price('BTC')] });
    await sleep(250);
    expect(priceUpdate(client)).toHaveLength(0);
  });

  it('answers an application-level ping with a pong envelope', async () => {
    const client = await connect();
    await waitFor(client, (m) => m.type === 'hello');
    client.send({ type: 'ping' });
    const pong = await waitFor(client, (m) => m.type === 'pong');
    expect(pong.data).toEqual({ version: 2 });
  });

  it('rejects a subscription beyond the documented limit without changing state', async () => {
    const client = await connect();
    await waitFor(client, (m) => m.type === 'hello');

    const assets = Array.from({ length: 101 }, (_, index) => `A${index}`);
    client.send({ type: 'subscribe', assets });
    const error = await waitFor(client, (m) => m.type === 'error');
    expect(error.data).toMatchObject({ reason: 'subscription_limit' });

    client.send({ type: 'subscribe', assets: ['BTC'] });
    const ack = await waitFor(client, (m) => m.type === 'subscribed');
    expect(ack.data).toMatchObject({ subscriptions: ['BTC'] });
  });

  it('drops a client that sends an oversized frame', async () => {
    const client = await connect();
    await waitFor(client, (m) => m.type === 'hello');
    client.socket.send('x'.repeat(5000));
    const deadline = Date.now() + 3000;
    while (client.closed === null && Date.now() < deadline) await sleep(20);
    expect(client.closed).toEqual({
      code: WS_DROP_CLOSE_CODES.message_too_large,
      reason: 'message_too_large',
    });
  });
});
