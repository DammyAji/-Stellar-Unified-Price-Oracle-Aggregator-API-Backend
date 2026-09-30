export const WS_PROTOCOL_VERSION = 2;

export const WS_SUBSCRIPTION_WILDCARD = '*';

export const WS_DROP_CLOSE_CODES = {
  backpressure: 4008,
  ping_timeout: 4001,
  message_too_large: 4003,
} as const;

export type DropReason = keyof typeof WS_DROP_CLOSE_CODES;

export type ClientMessageType = 'subscribe' | 'unsubscribe' | 'ping';

export interface ClientMessage {
  type: ClientMessageType;
  assets?: string[];
}

export interface Envelope {
  type: string;
  version: number;
  sequence: number;
  timestamp: number;
  traceContext?: unknown;
  data: unknown;
}

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

const ASSET_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,31}$/;

export type NormalizeAssetsResult =
  | { ok: true; assets: string[] }
  | { ok: false; error: string };

export function normalizeAssets(value: unknown): NormalizeAssetsResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'assets must be an array of asset symbols' };
  }
  if (value.length === 0) {
    return { ok: false, error: 'assets must contain at least one symbol' };
  }
  const assets: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { ok: false, error: 'assets must contain only strings' };
    }
    const normalized = entry.trim().toUpperCase();
    if (normalized !== WS_SUBSCRIPTION_WILDCARD && !ASSET_SYMBOL.test(normalized)) {
      return {
        ok: false,
        error: `"${entry}" is not a valid asset symbol (A-Z 0-9 : _ -, max 32 chars)`,
      };
    }
    if (!assets.includes(normalized)) assets.push(normalized);
  }
  return { ok: true, assets };
}

export function parseClientMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'message must be valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'message must be a JSON object' };
  }

  const { type, assets } = parsed as { type?: unknown; assets?: unknown };

  if (type === 'ping') return { ok: true, message: { type: 'ping' } };
  if (type !== 'subscribe' && type !== 'unsubscribe') {
    return { ok: false, error: 'type must be one of subscribe, unsubscribe, ping' };
  }

  const normalized = normalizeAssets(assets);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  return { ok: true, message: { type, assets: normalized.assets } };
}

export function createEnvelope(input: {
  type: string;
  sequence: number;
  data: unknown;
  timestamp?: number;
  traceContext?: unknown;
}): Envelope {
  const envelope: Envelope = {
    type: input.type,
    version: WS_PROTOCOL_VERSION,
    sequence: input.sequence,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    data: input.data,
  };
  if (input.traceContext !== undefined) envelope.traceContext = input.traceContext;
  return envelope;
}

export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}
