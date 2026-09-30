import { WebSocketServer as WsServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { logger } from '../observability/logger';
import { config } from './config';
import { WsConnectionGuard } from './ws-guard';
import {
  wsConnectionsActive,
  wsConnectionsTotal,
  wsMessagesTotal,
  wsConnectionDuration,
  wsErrorsTotal,
  wsClientsDroppedTotal,
  wsMessagesDroppedTotal,
  wsBufferedBytes,
  wsSubscriptionsActive,
} from '../observability/metrics';
import { newTraceContext, formatTraceparent } from '../replication/trace-context';
import { ClientSession, type PushSocket, type SessionOptions } from './ws-session';
import {
  WS_DROP_CLOSE_CODES,
  WS_PROTOCOL_VERSION,
  WS_SUBSCRIPTION_WILDCARD,
  createEnvelope,
  encodeEnvelope,
  parseClientMessage,
  type DropReason,
} from './ws-protocol';

const SERVICE = 'aggregator';

interface Delivery {
  asset?: string;
  value: unknown;
}

function toDelivery(value: unknown): Delivery {
  if (value !== null && typeof value === 'object') {
    const asset = (value as { asset?: unknown }).asset;
    if (typeof asset === 'string') return { asset: asset.toUpperCase(), value };
  }
  return { value };
}

function toDeliveries(payload: unknown): Delivery[] {
  if (Array.isArray(payload)) return payload.map(toDelivery);
  return [toDelivery(payload)];
}

interface ResolvedBroadcast {
  type: string;
  payload: unknown;
  traceContext?: unknown;
}

function resolveBroadcast(data: unknown): ResolvedBroadcast {
  if (data !== null && typeof data === 'object') {
    const record = data as { type?: unknown; data?: unknown; traceContext?: unknown };
    if (typeof record.type === 'string') {
      return {
        type: record.type,
        payload: 'data' in record ? record.data : data,
        traceContext: 'traceContext' in record ? record.traceContext : undefined,
      };
    }
  }
  return { type: 'message', payload: data };
}

export class WebSocketServer {
  private wss: WsServer | null = null;
  private port: number;
  private guard = new WsConnectionGuard();
  private sweepTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private sessions = new Map<PushSocket, ClientSession>();
  private sequence = 0;
  private readonly options: SessionOptions;
  private static instance: WebSocketServer;

  constructor(port: number) {
    this.port = port;
    this.options = {
      maxSubscriptions: config.websocket.maxSubscriptions,
      dropBufferBytes: config.websocket.dropBufferBytes,
      maxMessageBytes: config.websocket.maxClientMessageBytes,
    };
    WebSocketServer.instance = this;
  }

  static getInstance(): WebSocketServer | null {
    return WebSocketServer.instance || null;
  }

  start(): void {
    this.wss = new WsServer({ port: this.port + 1, verifyClient: this.guard.verifyClient });
    this.sweepTimer = setInterval(() => this.guard.sweep(), 60000);
    this.sweepTimer.unref?.();
    this.livenessTimer = setInterval(() => this.sweepLiveness(), config.websocket.pingIntervalMs);
    this.livenessTimer.unref?.();

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip = req.socket.remoteAddress || 'unknown';

      const session = new ClientSession(ws, this.options);
      this.sessions.set(ws, session);

      wsConnectionsActive.inc({ service: SERVICE });
      wsConnectionsTotal.inc({ service: SERVICE });
      logger.info(`WebSocket client connected from ${ip} (total: ${this.wss?.clients.size})`);

      this.sendEnvelope(session, 'hello', {
        version: WS_PROTOCOL_VERSION,
        maxSubscriptions: this.options.maxSubscriptions,
        wildcard: WS_SUBSCRIPTION_WILDCARD,
        filtered: session.filtered,
        subscriptions: session.assetList(),
        pingIntervalMs: config.websocket.pingIntervalMs,
        pingTimeoutMs: config.websocket.pingTimeoutMs,
      });
      this.refreshGauges();

      ws.on('pong', () => session.handlePong());

      ws.on('message', (raw) => {
        wsMessagesTotal.inc({ service: SERVICE, direction: 'inbound' });
        this.handleClientMessage(session, raw);
      });

      ws.on('close', () => {
        const firstClose = !session.released;
        this.release(session);
        if (firstClose) {
          logger.info(`WebSocket client disconnected (total: ${this.wss?.clients.size ?? 0})`);
        }
      });

      ws.on('error', (err) => {
        wsErrorsTotal.inc({ service: SERVICE });
        logger.error('WebSocket error', err);
      });
    });

    logger.info(`WebSocket server listening on port ${this.port + 1}`);
  }

  broadcast(data: unknown): void {
    const resolved = resolveBroadcast(data);
    this.dispatch(
      resolved.type,
      resolved.payload,
      resolved.traceContext ?? formatTraceparent(newTraceContext(true)),
    );
  }

  broadcastAlert(alert: object): void {
    this.dispatch('alert', alert);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.sweepTimer = null;
    this.livenessTimer = null;
    const wss = this.wss;
    this.wss = null;
    this.sessions.clear();
    if (wss) {
      wss.clients.forEach((client) => client.terminate());
      wss.close();
    }
    this.refreshGauges();
  }

  private sessionList(): ClientSession[] {
    const out: ClientSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.dropReason === null && session.socket.readyState === WebSocket.OPEN) {
        out.push(session);
      }
    }
    return out;
  }

  private dispatch(type: string, payload: unknown, traceContext?: unknown): void {
    const sequence = ++this.sequence;
    const timestamp = Math.floor(Date.now() / 1000);
    const sessions = this.sessionList();
    if (sessions.length === 0) return;

    const deliveries = toDeliveries(payload);
    const filterable = deliveries.some((delivery) => delivery.asset !== undefined);

    const fullEnvelope = encodeEnvelope(
      createEnvelope({ type, sequence, timestamp, data: payload, traceContext }),
    );

    for (const session of sessions) {
      if (!session.filtered || !filterable || deliveries.length === 0) {
        this.deliver(session, fullEnvelope);
        continue;
      }
      const picked = deliveries.filter(
        (delivery) => delivery.asset === undefined || session.wants(delivery.asset),
      );
      if (picked.length === 0) continue;
      const data = Array.isArray(payload) ? picked.map((delivery) => delivery.value) : picked[0].value;
      this.deliver(
        session,
        encodeEnvelope(createEnvelope({ type, sequence, timestamp, data, traceContext })),
      );
    }

    this.refreshGauges();
  }

  private deliver(session: ClientSession, encoded: string): void {
    const outcome = session.send(encoded, () => wsErrorsTotal.inc({ service: SERVICE }));
    if (outcome === 'sent') {
      wsMessagesTotal.inc({ service: SERVICE, direction: 'outbound' });
      return;
    }
    if (outcome === 'backpressure') {
      wsMessagesDroppedTotal.inc({ service: SERVICE, reason: 'backpressure' });
      this.drop(session, 'backpressure');
      return;
    }
    if (outcome === 'not_open') {
      wsMessagesDroppedTotal.inc({ service: SERVICE, reason: 'not_open' });
    }
  }

  private sendEnvelope(session: ClientSession, type: string, data: unknown): void {
    const encoded = encodeEnvelope(
      createEnvelope({ type, sequence: ++this.sequence, data }),
    );
    this.deliver(session, encoded);
  }

  private handleClientMessage(session: ClientSession, raw: unknown): void {
    const buffer = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw as ArrayBuffer);

    if (buffer.byteLength > this.options.maxMessageBytes) {
      wsMessagesDroppedTotal.inc({ service: SERVICE, reason: 'message_too_large' });
      this.drop(session, 'message_too_large');
      return;
    }

    const parsed = parseClientMessage(buffer.toString('utf8'));
    if (!parsed.ok) {
      this.sendEnvelope(session, 'error', { reason: 'bad_message', message: parsed.error });
      return;
    }

    if (parsed.message.type === 'ping') {
      this.sendEnvelope(session, 'pong', { version: WS_PROTOCOL_VERSION });
      return;
    }

    const update = session.applyClientMessage(parsed.message);
    if (!update.ok) {
      this.sendEnvelope(session, 'error', { reason: 'subscription_limit', message: update.error });
      return;
    }

    this.sendEnvelope(session, 'subscribed', {
      filtered: session.filtered,
      subscriptions: session.assetList(),
      maxSubscriptions: this.options.maxSubscriptions,
    });
    this.refreshGauges();
  }

  private sweepLiveness(): void {
    const now = Date.now();
    for (const session of Array.from(this.sessions.values())) {
      if (session.dropReason) continue;
      if (session.isExpired(now, config.websocket.pingTimeoutMs)) {
        this.drop(session, 'ping_timeout');
        continue;
      }
      if (session.socket.readyState !== WebSocket.OPEN) continue;
      if (session.awaitingPongSince === null) session.awaitingPongSince = now;
      session.socket.ping();
    }
  }

  private drop(session: ClientSession, reason: DropReason): void {
    if (session.dropReason) return;
    session.dropReason = reason;
    wsClientsDroppedTotal.inc({ service: SERVICE, reason });
    logger.warn('[WS] Dropping client', { reason, closeCode: WS_DROP_CLOSE_CODES[reason] });
    try {
      session.socket.close(WS_DROP_CLOSE_CODES[reason], reason);
    } catch {
      // The socket may already be gone; the session is released either way.
    }
    this.release(session);
  }

  private release(session: ClientSession): void {
    if (session.released) return;
    session.released = true;
    this.sessions.delete(session.socket);
    wsConnectionsActive.dec({ service: SERVICE });
    wsConnectionDuration.observe({ service: SERVICE }, (Date.now() - session.connectedAt) / 1000);
    this.refreshGauges();
  }

  private refreshGauges(): void {
    let buffered = 0;
    let subscriptions = 0;
    for (const session of this.sessions.values()) {
      if (session.dropReason) continue;
      buffered += session.socket.bufferedAmount;
      subscriptions += session.subscriptionCount();
    }
    wsBufferedBytes.set({ service: SERVICE }, buffered);
    wsSubscriptionsActive.set({ service: SERVICE }, subscriptions);
  }
}
