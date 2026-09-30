import {
  WS_SUBSCRIPTION_WILDCARD,
  normalizeAssets,
  type ClientMessage,
  type DropReason,
} from './ws-protocol';

const OPEN_STATE = 1;

export interface PushSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  ping(): void;
}

export interface SessionOptions {
  maxSubscriptions: number;
  dropBufferBytes: number;
  maxMessageBytes: number;
}

export type SendOutcome = 'sent' | 'backpressure' | 'not_open' | 'dropped';

export type SubscriptionUpdate = { ok: true } | { ok: false; error: string };

export class ClientSession {
  readonly socket: PushSocket;
  readonly options: SessionOptions;
  readonly connectedAt: number;

  subscriptions: Set<string> = new Set([WS_SUBSCRIPTION_WILDCARD]);
  awaitingPongSince: number | null = null;
  dropReason: DropReason | null = null;
  released = false;

  constructor(socket: PushSocket, options: SessionOptions) {
    this.socket = socket;
    this.options = options;
    this.connectedAt = Date.now();
  }

  get filtered(): boolean {
    return !this.subscriptions.has(WS_SUBSCRIPTION_WILDCARD);
  }

  wants(asset: string): boolean {
    if (!this.filtered) return true;
    return this.subscriptions.has(asset.toUpperCase());
  }

  assetList(): string[] {
    return Array.from(this.subscriptions).sort();
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  applyClientMessage(message: ClientMessage): SubscriptionUpdate {
    const normalized = normalizeAssets(message.assets ?? []);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const requested = normalized.assets;

    if (message.type === 'subscribe') {
      if (requested.includes(WS_SUBSCRIPTION_WILDCARD)) {
        this.subscriptions = new Set([WS_SUBSCRIPTION_WILDCARD]);
        return { ok: true };
      }
      const next = new Set(this.subscriptions);
      next.delete(WS_SUBSCRIPTION_WILDCARD);
      for (const asset of requested) next.add(asset);
      if (next.size > this.options.maxSubscriptions) {
        return {
          ok: false,
          error: `${next.size} subscriptions exceed the limit of ${this.options.maxSubscriptions} per connection`,
        };
      }
      this.subscriptions = next;
      return { ok: true };
    }

    const next = new Set(this.subscriptions);
    for (const asset of requested) next.delete(asset);
    if (requested.includes(WS_SUBSCRIPTION_WILDCARD)) next.clear();
    this.subscriptions = next;
    return { ok: true };
  }

  send(payload: string, onError?: (err: Error) => void): SendOutcome {
    if (this.dropReason) return 'dropped';
    if (this.socket.readyState !== OPEN_STATE) return 'not_open';
    if (this.socket.bufferedAmount > this.options.dropBufferBytes) return 'backpressure';
    this.socket.send(payload, (err) => {
      if (err) onError?.(err);
    });
    return 'sent';
  }

  handlePong(): void {
    this.awaitingPongSince = null;
  }

  isExpired(now: number, timeoutMs: number): boolean {
    return this.awaitingPongSince !== null && now - this.awaitingPongSince >= timeoutMs;
  }
}
