# Aggregator push WebSocket (protocol v2)

The aggregator broadcasts prices and alerts on **`PORT + 1`** (4001 by default).
This is a different socket from the API's WebSocket on 3001, which carries the
API's own client-driven message set defined in
`api/src/infrastructure/ws-messages.ts`. The two servers do not share a
protocol, a port, or a backpressure policy.

Endpoint: `ws://<host>:<PORT + 1>`

Upgrade requests are filtered by `WS_ALLOWED_ORIGINS` / `WS_REQUIRE_ORIGIN` and
a per-IP connection rate limit (`WS_RATE_LIMIT_MAX` / `WS_RATE_LIMIT_WINDOW_MS`).

## Server-to-client envelope

Every message the server sends is a single JSON object with this shape:

| Field          | Type              | Notes                                                        |
| -------------- | ----------------- | ------------------------------------------------------------ |
| `type`         | `string`          | See [message types](#server-message-types).                  |
| `version`      | `number`          | Always `2` for this document.                                |
| `sequence`     | `number`          | Monotonic per connection set; starts at `1`. Increments once per logical broadcast, so every recipient of a broadcast sees the same value. A gap means a message was filtered for you or dropped. |
| `timestamp`    | `number`          | Unix seconds.                                                |
| `traceContext` | `object?`         | W3C `traceparent` / `tracestate` pair. Present on `price_update`, absent on `alert`. |
| `data`         | `any`             | Payload; identical to the pre-v2 message body.               |

### Server message types

| `type`        | `data`                                                            |
| ------------- | ----------------------------------------------------------------- |
| `hello`       | `{ version, maxSubscriptions, wildcard, filtered, subscriptions, pingIntervalMs, pingTimeoutMs }` — sent once, immediately after the handshake. |
| `price_update`| `AggregatedPrice[]` — one entry per watched asset.               |
| `alert`       | `AlertEvent` — may carry `asset`.                                 |
| `subscribed`  | `{ filtered, subscriptions, maxSubscriptions }` — acknowledgement after `subscribe` / `unsubscribe`. |
| `pong`        | `{ version }` — reply to an application-level `ping`.             |
| `error`       | `{ reason, message }` where `reason` is `bad_message` or `subscription_limit`. |

## Client-to-server messages

Send plain JSON text frames. Frames larger than `WS_MAX_CLIENT_MESSAGE_BYTES`
(4096 by default) drop the connection with close code `4003`.

```jsonc
{ "type": "subscribe",   "assets": ["BTC", "ETH"] }
{ "type": "unsubscribe", "assets": ["BTC"] }
{ "type": "unsubscribe", "assets": ["*"] }
{ "type": "ping" }
```

- `subscribe` / `unsubscribe` require a non-empty `assets` array.
- Symbols are trimmed and upper-cased; entries must match `A-Z 0-9 : _ -` and
  be at most 32 characters. Duplicates collapse.
- `ping` is answered with a `pong` envelope. It exists because a browser cannot
  send a WebSocket protocol-level ping itself.

### Subscription semantics

- A new connection starts on the **full feed**: `subscriptions = ["*"]`.
- The first `subscribe` with concrete symbols **replaces the full feed** — after
  it the connection receives only the listed symbols (plus any message with no
  `asset`, such as alerts for other assets).
- `subscribe` with `["*"]` returns the connection to the full feed.
- `unsubscribe` removes symbols. `unsubscribe` with `["*"]` clears the
  subscription set entirely; the connection then stays open but receives
  nothing until it subscribes again.
- A single connection may hold at most `WS_MAX_SUBSCRIPTIONS` (100 by default)
  symbols. A request that would exceed the limit is rejected atomically with a
  `subscription_limit` error and leaves the existing subscriptions untouched.
- Filtering applies to `price_update` and to `alert` messages that carry an
  `asset`. Messages without an `asset` go to every connection.

## Backpressure

Before each send the server reads `socket.bufferedAmount`. If it exceeds
`WS_BACKPRESSURE_DROP_BYTES` (1 MiB by default) the client is dropped:

- close code **`4008`**, reason `backpressure`
- `ws_clients_dropped_total{reason="backpressure"}` is incremented
- `ws_messages_dropped_total{reason="backpressure"}` is incremented
- the client is removed from the subscription set immediately, so its buffer
  stops growing on the very next broadcast

The send callback is observed; a transport failure increments
`ws_errors_total`.

## Liveness

Every `WS_PING_INTERVAL_MS` (30 s by default) the server sends a protocol-level
ping frame. A client that does not answer within `WS_PING_TIMEOUT_MS`
(10 s by default) is dropped with close code **`4001`**, reason `ping_timeout`.
Dead connections therefore stop consuming `ws_connections_active` and stop
inflating `ws_buffered_bytes`.

## Close codes

| Code   | Reason              | Meaning                                          |
| ------ | ------------------- | ------------------------------------------------ |
| `4001` | `ping_timeout`      | Missed the ping deadline.                        |
| `4003` | `message_too_large` | Inbound frame exceeded `WS_MAX_CLIENT_MESSAGE_BYTES`. |
| `4008` | `backpressure`      | Send buffer exceeded `WS_BACKPRESSURE_DROP_BYTES`. |

## Metrics

| Metric                     | Labels             | Meaning                                        |
| -------------------------- | ------------------ | ---------------------------------------------- |
| `ws_connections_active`    | `service`          | Live connections.                               |
| `ws_connections_total`     | `service`          | Connections ever accepted.                      |
| `ws_messages_total`        | `service`,`direction` | Inbound / outbound frames.                  |
| `ws_connection_duration_seconds` | `service`     | Connection lifetime histogram.                  |
| `ws_errors_total`          | `service`          | Socket errors and failed send callbacks.        |
| `ws_clients_dropped_total` | `service`,`reason` | `backpressure`, `ping_timeout`, `message_too_large`. |
| `ws_messages_dropped_total`| `service`,`reason` | `backpressure`, `not_open`, `message_too_large`. |
| `ws_buffered_bytes`        | `service`          | Sum of `bufferedAmount` across live clients.     |
| `ws_subscriptions_active`  | `service`          | Sum of subscription counts across live clients.  |

## Compatibility

Protocol v1 was the implicit shape
`{ type: 'price_update', data: prices, traceContext }` with no filtering, no
version field and no send-buffer policy. Protocol v2 is **additive**:

- `version`, `sequence` and `timestamp` are new fields; `data` and `type` are
  unchanged, so a v1 consumer keeps working.
- `traceContext` moved next to `timestamp` but kept its object shape.
- The only behaviour change for an unmodified consumer is the `hello` message
  it now receives first, and disconnection with `4008` / `4001` if it stops
  reading or stops answering pings. Consumers should ignore unknown `type`
  values rather than closing the socket.

## Configuration

| Variable                       | Default    | Range             |
| ------------------------------ | ---------- | ----------------- |
| `WS_ALLOWED_ORIGINS`           | *(empty)*  | origin list       |
| `WS_REQUIRE_ORIGIN`            | `true`     | `true` / `false`  |
| `WS_RATE_LIMIT_MAX`            | `20`       | 1 .. 10000        |
| `WS_RATE_LIMIT_WINDOW_MS`      | `60000`    | 1000 .. 3600000   |
| `WS_MAX_SUBSCRIPTIONS`         | `100`      | 1 .. 10000        |
| `WS_BACKPRESSURE_DROP_BYTES`   | `1048576`  | 1024 .. 268435456 |
| `WS_PING_INTERVAL_MS`          | `30000`    | 1000 .. 600000    |
| `WS_PING_TIMEOUT_MS`           | `10000`    | 1000 .. 600000    |
| `WS_MAX_CLIENT_MESSAGE_BYTES`  | `4096`     | 256 .. 65536      |

Run `npm run check-config` from `services/aggregator` to print the resolved
values without starting the service.
