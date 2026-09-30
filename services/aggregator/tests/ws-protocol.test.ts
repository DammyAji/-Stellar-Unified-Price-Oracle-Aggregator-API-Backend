import { describe, expect, it } from 'vitest';
import {
  WS_DROP_CLOSE_CODES,
  WS_PROTOCOL_VERSION,
  WS_SUBSCRIPTION_WILDCARD,
  createEnvelope,
  encodeEnvelope,
  normalizeAssets,
  parseClientMessage,
} from '../src/infrastructure/ws-protocol';
import { ClientSession, type PushSocket, type SessionOptions } from '../src/infrastructure/ws-session';
import { WebSocketServer } from '../src/infrastructure/ws-server';

class FakeSocket implements PushSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  pings = 0;

  send(data: string, cb?: (err?: Error) => void): void {
    if (this.closed) {
      cb?.(new Error('socket closed'));
      return;
    }
    this.sent.push(data);
    cb?.();
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  ping(): void {
    this.pings += 1;
  }
}

const OPTIONS: SessionOptions = {
  maxSubscriptions: 3,
  dropBufferBytes: 1024,
  maxMessageBytes: 4096,
};

function newSession(socket = new FakeSocket(), options: SessionOptions = OPTIONS) {
  return { session: new ClientSession(socket, options), socket };
}

function price(asset: string) {
  return { asset, price: '1.0', decimals: 7 };
}

describe('push protocol envelope (Issue #587)', () => {
  it('versions every envelope', () => {
    const envelope = createEnvelope({ type: 'price_update', sequence: 7, data: [price('BTC')] });
    expect(envelope.version).toBe(WS_PROTOCOL_VERSION);
    expect(envelope.version).toBe(2);
    expect(envelope.sequence).toBe(7);
    expect(envelope.timestamp).toBeGreaterThan(1_600_000_000);
    expect(envelope.data).toEqual([price('BTC')]);
  });

  it('omits traceContext when the caller has none', () => {
    const envelope = createEnvelope({ type: 'alert', sequence: 1, data: {} });
    expect('traceContext' in envelope).toBe(false);
  });

  it('round-trips through encodeEnvelope', () => {
    const envelope = createEnvelope({
      type: 'price_update',
      sequence: 3,
      data: [price('XLM')],
      traceContext: { traceparent: '00-a-b-01' },
    });
    const decoded = JSON.parse(encodeEnvelope(envelope));
    expect(decoded.version).toBe(2);
    expect(decoded.traceContext).toEqual({ traceparent: '00-a-b-01' });
  });
});

describe('client message parsing (Issue #587)', () => {
  it('accepts subscribe, unsubscribe and ping', () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({
      ok: true,
      message: { type: 'ping' },
    });
    expect(parseClientMessage('{"type":"subscribe","assets":["btc","ETH"]}')).toEqual({
      ok: true,
      message: { type: 'subscribe', assets: ['BTC', 'ETH'] },
    });
    expect(parseClientMessage('{"type":"unsubscribe","assets":["*"]}')).toEqual({
      ok: true,
      message: { type: 'unsubscribe', assets: [WS_SUBSCRIPTION_WILDCARD] },
    });
  });

  it('rejects malformed input with a reason', () => {
    expect(parseClientMessage('not json')).toEqual({
      ok: false,
      error: 'message must be valid JSON',
    });
    expect(parseClientMessage('"a string"')).toMatchObject({ ok: false });
    expect(parseClientMessage('{"type":"nope"}')).toMatchObject({ ok: false });
    expect(parseClientMessage('{"type":"subscribe"}')).toMatchObject({ ok: false });
    expect(parseClientMessage('{"type":"subscribe","assets":[]}')).toMatchObject({ ok: false });
    expect(parseClientMessage('{"type":"subscribe","assets":["BTC/USD"]}')).toMatchObject({
      ok: false,
    });
    expect(parseClientMessage('{"type":"subscribe","assets":["BTC",12]}')).toMatchObject({
      ok: false,
    });
  });

  it('trims, upper-cases and de-duplicates requested assets', () => {
    expect(normalizeAssets([' xlm ', 'XLM', 'usdc'])).toEqual({
      ok: true,
      assets: ['XLM', 'USDC'],
    });
  });
});

describe('subscription filtering (Issue #587)', () => {
  it('starts on the full feed', () => {
    const { session } = newSession();
    expect(session.filtered).toBe(false);
    expect(session.wants('BTC')).toBe(true);
    expect(session.assetList()).toEqual([WS_SUBSCRIPTION_WILDCARD]);
  });

  it('switches to a filtered view on the first subscribe', () => {
    const { session } = newSession();
    expect(session.applyClientMessage({ type: 'subscribe', assets: ['btc'] })).toEqual({ ok: true });
    expect(session.filtered).toBe(true);
    expect(session.wants('BTC')).toBe(true);
    expect(session.wants('ETH')).toBe(false);
    expect(session.applyClientMessage({ type: 'subscribe', assets: ['eth'] })).toEqual({ ok: true });
    expect(session.assetList()).toEqual(['BTC', 'ETH']);
  });

  it('returns to the full feed when * is subscribed', () => {
    const { session } = newSession();
    session.applyClientMessage({ type: 'subscribe', assets: ['BTC'] });
    session.applyClientMessage({ type: 'subscribe', assets: [WS_SUBSCRIPTION_WILDCARD] });
    expect(session.filtered).toBe(false);
    expect(session.assetList()).toEqual([WS_SUBSCRIPTION_WILDCARD]);
  });

  it('receives nothing after unsubscribing from everything', () => {
    const { session } = newSession();
    session.applyClientMessage({ type: 'unsubscribe', assets: [WS_SUBSCRIPTION_WILDCARD] });
    expect(session.subscriptionCount()).toBe(0);
    expect(session.wants('BTC')).toBe(false);
    expect(session.wants('XLM')).toBe(false);
  });

  it('rejects subscriptions beyond the configured limit without changing state', () => {
    const { session } = newSession();
    expect(session.applyClientMessage({ type: 'subscribe', assets: ['BTC'] })).toEqual({ ok: true });
    const result = session.applyClientMessage({
      type: 'subscribe',
      assets: ['ETH', 'XLM', 'USDC'],
    });
    expect(result).toEqual({
      ok: false,
      error: '4 subscriptions exceed the limit of 3 per connection',
    });
    expect(session.assetList()).toEqual(['BTC']);
  });
});

describe('backpressure policy (Issue #587)', () => {
  it('writes only while the buffer is at or below the threshold', () => {
    const { session, socket } = newSession();
    socket.bufferedAmount = 1024;
    expect(session.send('a')).toBe('sent');
    socket.bufferedAmount = 1025;
    expect(session.send('b')).toBe('backpressure');
    expect(socket.sent).toEqual(['a']);
  });

  it('reports send failures through the callback', () => {
    const broken = new FakeSocket();
    broken.send = (_data, cb) => cb?.(new Error('EPIPE'));
    const session = new ClientSession(broken, OPTIONS);
    const errors: Error[] = [];
    expect(session.send('x', (err) => errors.push(err as Error))).toBe('sent');
    expect(errors.map((err) => err.message)).toEqual(['EPIPE']);
  });

  it('stops writing entirely once the session has been dropped', () => {
    const { session, socket } = newSession();
    socket.bufferedAmount = 5000;
    expect(session.send('a')).toBe('backpressure');
    session.dropReason = 'backpressure';
    expect(session.send('b')).toBe('dropped');
    expect(socket.sent).toEqual([]);
  });
});

describe('liveness tracking (Issue #587)', () => {
  it('marks a session expired only after the pong deadline', () => {
    const { session } = newSession();
    session.awaitingPongSince = 1_000;
    expect(session.isExpired(1_000 + 999, 1000)).toBe(false);
    expect(session.isExpired(1_000 + 1000, 1000)).toBe(true);
    session.handlePong();
    expect(session.awaitingPongSince).toBeNull();
    expect(session.isExpired(1_000 + 5_000, 1000)).toBe(false);
  });
});

describe('server dispatch over an injected session (Issue #587)', () => {
  function seed(server: WebSocketServer, socket: FakeSocket, session: ClientSession): void {
    (server as unknown as { sessions: Map<PushSocket, ClientSession> }).sessions.set(socket, session);
  }

  function broadcastPrices(server: WebSocketServer, assets: string[]): FakeSocket {
    const { session, socket } = newSession();
    seed(server, socket, session);
    server.broadcast({ type: 'price_update', data: assets.map(price) });
    return socket;
  }

  it('drops a stalled consumer instead of growing its buffer', () => {
    const server = new WebSocketServer(-1);
    const { session, socket } = newSession();
    socket.bufferedAmount = OPTIONS.dropBufferBytes + 1;
    seed(server, socket, session);

    server.broadcast({ type: 'price_update', data: [price('BTC')] });
    expect(socket.sent).toEqual([]);
    expect(session.dropReason).toBe('backpressure');
    expect(socket.closed?.code).toBe(WS_DROP_CLOSE_CODES.backpressure);

    server.broadcast({ type: 'price_update', data: [price('BTC')] });
    expect(socket.sent).toEqual([]);
  });

  it('does not drop a consumer whose buffer is exactly at the threshold', () => {
    const server = new WebSocketServer(-1);
    const { session, socket } = newSession();
    socket.bufferedAmount = OPTIONS.dropBufferBytes;
    seed(server, socket, session);

    server.broadcast({ type: 'price_update', data: [price('BTC')] });
    expect(socket.sent).toHaveLength(1);
    expect(session.dropReason).toBeNull();
  });

  it('never writes an unsubscribed asset', () => {
    const server = new WebSocketServer(-1);
    const { session, socket } = newSession();
    session.applyClientMessage({ type: 'subscribe', assets: ['BTC'] });
    seed(server, socket, session);

    server.broadcast({ type: 'price_update', data: [price('BTC'), price('ETH'), price('XLM')] });
    expect(socket.sent).toHaveLength(1);
    const decoded = JSON.parse(socket.sent[0]);
    expect(decoded.version).toBe(2);
    expect(decoded.type).toBe('price_update');
    expect(decoded.data).toEqual([price('BTC')]);
  });

  it('keeps the full payload for a wildcard subscriber', () => {
    const server = new WebSocketServer(-1);
    const socket = broadcastPrices(server, ['BTC', 'ETH']);
    const decoded = JSON.parse(socket.sent[0]);
    expect(decoded.data).toHaveLength(2);
    expect(decoded.sequence).toBeGreaterThan(0);
    expect(typeof decoded.timestamp).toBe('number');
  });

  it('shares one sequence across recipients of the same broadcast', () => {
    const server = new WebSocketServer(-1);
    const filtered = newSession();
    filtered.session.applyClientMessage({ type: 'subscribe', assets: ['BTC'] });
    seed(server, filtered.socket, filtered.session);
    const wildcard = newSession();
    seed(server, wildcard.socket, wildcard.session);

    server.broadcast({ type: 'price_update', data: [price('BTC'), price('ETH')] });

    const a = JSON.parse(filtered.socket.sent[0]);
    const b = JSON.parse(wildcard.socket.sent[0]);
    expect(a.sequence).toBe(b.sequence);
    expect(a.data).toEqual([price('BTC')]);
    expect(b.data).toHaveLength(2);
  });

  it('delivers alerts without an asset to every subscriber', () => {
    const server = new WebSocketServer(-1);
    const filtered = newSession();
    filtered.session.applyClientMessage({ type: 'subscribe', assets: ['BTC'] });
    seed(server, filtered.socket, filtered.session);

    server.broadcastAlert({ asset: 'ETH', type: 'deviation', message: 'moved' });
    expect(filtered.socket.sent).toHaveLength(0);

    server.broadcastAlert({ type: 'source_down', message: 'all sources down' });
    expect(filtered.socket.sent).toHaveLength(1);
    expect(JSON.parse(filtered.socket.sent[0]).type).toBe('alert');
  });

  it('ignores a dropped session', () => {
    const server = new WebSocketServer(-1);
    const { session, socket } = newSession();
    session.dropReason = 'ping_timeout';
    seed(server, socket, session);

    server.broadcast({ type: 'price_update', data: [price('BTC')] });
    expect(socket.sent).toEqual([]);
  });
});
