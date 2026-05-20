# WebSocket Service

Real-time market data gateway. Bridges Binance WebSocket streams to authenticated frontend clients via Socket.IO, and exposes a REST API for CEX account operations (portfolio, trades, deposits/withdrawals) via CCXT.

## Features

- Real-time Binance ticker data over Socket.IO
- Single shared Binance WebSocket connection with reference-counted subscriptions
- Per-user, per-stream 10-second throttle to prevent client flooding
- Automatic reconnect with exponential backoff and full stream resubscription
- JWT authentication for Socket.IO connections via JWKS
- REST endpoints for CEX data (Binance, OKX, Bybit) using CCXT
- Swagger docs at `/docs` (development mode)

## Architecture

```
Frontend (Socket.IO client)
        │
        │  JWT in handshake.auth.token
        ▼
  Socket.IO Server (port 3003)
        │
        │  auth middleware → verifies RS256 JWT via JWKS
        │  user joins room keyed by user_id
        ▼
  BinanceManager (singleton EventEmitter)
        │
        │  ONE persistent WebSocket
        ▼
  wss://stream.binance.com:443/ws
```

---

## How the Binance WebSocket Connection Works

### Single Persistent Connection

`BinanceManager` is a module-level singleton (Node's module cache ensures one instance per process). It maintains **one WebSocket** to `wss://stream.binance.com:443/ws` regardless of how many clients are connected.

The connection is opened lazily on the first `subscribe` event. All subsequent subscribes reuse it.

### JSON-RPC Subscribe / Unsubscribe

Binance's combined stream endpoint uses a JSON-RPC protocol. To subscribe or unsubscribe, the service sends:

```json
{ "method": "SUBSCRIBE", "params": ["btcusdt@ticker", "ethusdt@ticker"], "id": 1 }
```

Binance responds with:

```json
{ "result": null, "id": 1 }
```

`BinanceManager` tracks in-flight requests in a `Map<id, { resolve, reject }>`. Each sent message gets a monotonically increasing integer ID; the matching response resolves or rejects the awaiting promise.

### Incoming Message Dispatch

Binance sends ticker data in two possible formats:

**Combined stream format** (used when subscribed via JSON-RPC to multiple streams):
```json
{ "stream": "btcusdt@ticker", "data": { "e": "24hrTicker", "s": "BTCUSDT", ... } }
```

**Raw format** (fallback for single-stream subscriptions):
```json
{ "e": "24hrTicker", "s": "BTCUSDT", ... }
```

`BinanceManager._onMessage()` handles both. In either case it calls `this.emit(streamName, eventType, data)`, making `BinanceManager` an `EventEmitter` keyed by stream name (e.g. `'btcusdt@ticker'`).

### Reconnect with Exponential Backoff

If the Binance WebSocket closes unexpectedly:

1. All pending JSON-RPC promises are rejected.
2. A reconnect is scheduled after `reconnectDelay` ms (starts at 1 s).
3. On each failed reconnect attempt, the delay doubles (cap: 30 s).
4. On successful reconnect, `_resubscribeAll()` replays `SUBSCRIBE` messages for all streams still in `_refCounts`, batched in groups of 300 (Binance's per-message limit).

---

## How Client Connection is Optimized

### Reference-Counted Subscriptions

`BinanceManager._refCounts` is a `Map<streamName, subscriberCount>`. This is the core optimization:

| Event | Action |
|-------|--------|
| Client A subscribes to `btcusdt@ticker` (count: 0 → 1) | Sends `SUBSCRIBE` to Binance |
| Client B also subscribes to `btcusdt@ticker` (count: 1 → 2) | **No message sent** — already subscribed |
| Client A disconnects (count: 2 → 1) | **No message sent** — still needed by B |
| Client B disconnects (count: 1 → 0) | Sends `UNSUBSCRIBE` to Binance |

Binance sees at most one `SUBSCRIBE` and one `UNSUBSCRIBE` per stream, regardless of how many clients share it. This avoids redundant Binance messages and keeps the connection clean.

The ref count is incremented **synchronously before any `await`** in `subscribeMany()` to prevent race conditions where two concurrent subscribe calls both see count = 0 and both try to send to Binance.

If the Binance call fails, the ref count is rolled back so stale entries don't leak into `_resubscribeAll()`.

### Idempotent Socket Subscribe

Before calling into `BinanceManager`, the server filters out streams the socket is already tracking:

```js
const newStreams = parseStreams(path).filter(s => !socketStreams.has(s));
if (newStreams.length === 0) return;
```

A client that emits `subscribe` twice for the same stream does nothing on the second call.

### Batch Subscribe / Unsubscribe

`subscribeMany()` and `unsubscribeMany()` collect all new/removed streams and send **one JSON-RPC message** to Binance rather than one per stream. The path parser also supports Binance's multi-stream URL format:

```
/stream?streams=btcusdt@ticker/ethusdt@ticker   →  ['btcusdt@ticker', 'ethusdt@ticker']
/ws/btcusdt@ticker                              →  ['btcusdt@ticker']
btcusdt@ticker                                  →  ['btcusdt@ticker']
```

### Per-User Rooms

On connection, each socket joins a Socket.IO room named after the user's ID:

```js
socket.join(user_id);
```

When a ticker event arrives, the service emits to the room rather than the specific socket:

```js
io.to(user_id).emit('ticker', data);
```

This means all open tabs or devices of the same user receive the data from a single Binance stream listener, with no duplicated Binance subscriptions.

### Per-User, Per-Stream Throttle (10 seconds)

`makeThrottle(10000)` creates a shared throttle keyed by `${user_id}:${stream}`. Each key has its own independent timer — throttling one user's BTC data does not suppress another user's ETH data.

```
[BTC tick arrives]
  → throttle('user1:btcusdt@ticker', fn)
      → if 10 s elapsed since last call: emit, update timer
      → otherwise: drop
```

This caps outbound Socket.IO messages to one per 10 seconds per symbol per user, preventing clients from being overwhelmed by Binance's high-frequency updates.

### Per-Socket Listener References

Each socket stores its own `Map<streamName, listenerFn>` alongside a `Set<streamName>`. Listener references are required to call `EventEmitter.off()` with the exact same function reference:

```js
binanceManager.on(stream, listener);    // subscribe
binanceManager.off(stream, listener);   // precise removal on unsubscribe / disconnect
```

On disconnect, all listeners are removed **synchronously** before the async `unsubscribeMany()` call. This prevents any in-flight Binance messages from being routed to a listener whose socket is already gone, and ensures the throttle state for that user is cleared immediately (`throttle.deletePrefix(user_id + ':')`).

### Stream Limit

`BinanceManager` enforces a hard cap of **1024 concurrent streams** (`MAX_STREAMS`). Attempts to subscribe beyond this limit are skipped with a warning, and the operation still succeeds for the streams that were under the limit.

---

## Authentication

Socket.IO connections require a valid RS256 JWT in the handshake:

```js
const socket = io('http://localhost:3003', {
    auth: { token: '<access_token>' }
});
```

The auth middleware (`middleware/auth.js`) fetches the public key from the auth service's `/.well-known/jwks.json` endpoint on first use, caches it in memory, and verifies every connecting token against it. Connections with missing or invalid tokens are rejected before the `connection` event fires.

---

## Socket.IO Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `subscribe` | `string` — stream path or name | Subscribe to one or more ticker streams |
| `unsubscribe` | `string` — stream path or name | Unsubscribe from streams |

**Examples:**
```js
socket.emit('subscribe', 'btcusdt@ticker');
socket.emit('subscribe', '/stream?streams=btcusdt@ticker/ethusdt@ticker');
socket.emit('unsubscribe', 'btcusdt@ticker');
```

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `ticker` | Binance 24hr ticker object | Real-time price update (throttled to 1/10 s per stream) |
| `error` | `{ message: string }` | Subscribe/unsubscribe failure |
| `update-portfolio` | `{ success: boolean }` | Triggered by backend after a portfolio sync completes |

---

## REST API Endpoints

All routes are under `/api`. No JWT required (internal service-to-service calls).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/cex/ticker` | Fetch spot ticker prices via CCXT |
| `POST` | `/api/cex/portfolio` | Fetch account balances (requires API credentials) |
| `POST` | `/api/cex/transaction` | Fetch trade history for a symbol |
| `POST` | `/api/cex/sync-transactions` | Fetch all trades since a timestamp, across symbols |
| `POST` | `/api/cex/sync-deposits-withdrawals` | Fetch deposit/withdrawal history since a timestamp |
| `POST` | `/api/cex/validate` | Validate exchange API credentials |
| `POST` | `/api/cex/update-portfolio` | Emit `update-portfolio` event to a user's room |
| `POST` | `/api/emit-event` | Emit an arbitrary Socket.IO event to a user's room |
| `GET` | `/api/cex/ohlcv` | Fetch OHLCV (candlestick) data |

### Supported Exchanges

`binance`, `okx`, `bybit` — passed as the `exchange` or `exchanges` field in the request body.

---

## Prerequisites

- Node.js v18+

## Installation

```bash
npm install
```

## Running

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_SERVICE_URL` | `http://auth-service:8086` | URL of the auth service for JWKS key fetch |
| `NODE_ENV` | — | Set to `production` to disable Swagger docs |
