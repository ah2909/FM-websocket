import WebSocket from 'ws';
import EventEmitter from 'events';

const BINANCE_WS_URL = 'wss://stream.binance.com:443/ws';
const MAX_STREAMS = 1024;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class BinanceManager extends EventEmitter {
    constructor() {
        super();
        // Map<streamName, subscriberCount>  e.g. { 'btcusdt@ticker': 3 }
        this._refCounts = new Map();

        this._ws = null;
        this._isConnected = false;
        this._isConnecting = false;

        // Monotonically increasing ID for JSON-RPC requests
        this._requestId = 1;

        // Map<id, { resolve, reject }> for in-flight SUBSCRIBE/UNSUBSCRIBE calls
        this._pendingRequests = new Map();

        this._reconnectDelay = RECONNECT_BASE_MS;
        this._reconnectTimer = null;
        this._manualClose = false;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Subscribe to multiple streams in ONE SUBSCRIBE message to Binance.
     * Only sends to Binance for streams where ref count transitions 0 → 1.
     * Rolls back ref counts if the Binance call fails.
     * @param {string[]} streams  e.g. ['btcusdt@ticker', 'ethusdt@ticker']
     */
    async subscribeMany(streams) {
        streams = streams.map(s => s.toLowerCase());
        const newStreams = [];

        for (const stream of streams) {
            const current = this._refCounts.get(stream) ?? 0;
            if (current === 0 && this._refCounts.size >= MAX_STREAMS) {
                console.warn(`[BinanceManager] Stream limit (${MAX_STREAMS}) reached, skipping ${stream}`);
                continue;
            }
            // Increment synchronously before any await to prevent race conditions
            this._refCounts.set(stream, current + 1);
            if (current === 0) newStreams.push(stream);
        }

        if (newStreams.length === 0) return;

        try {
            await this._ensureConnected();
            await this._sendRpc('SUBSCRIBE', newStreams);
        } catch (err) {
            // Rollback new streams so _resubscribeAll doesn't leak stale entries
            for (const stream of newStreams) {
                const current = this._refCounts.get(stream) ?? 0;
                if (current <= 1) this._refCounts.delete(stream);
                else this._refCounts.set(stream, current - 1);
            }
            throw err;
        }
    }

    /**
     * Unsubscribe from multiple streams in ONE UNSUBSCRIBE message to Binance.
     * Only sends to Binance for streams where ref count transitions 1 → 0.
     * @param {string[]} streams  e.g. ['btcusdt@ticker', 'ethusdt@ticker']
     */
    async unsubscribeMany(streams) {
        streams = streams.map(s => s.toLowerCase());
        const toRemove = [];

        for (const stream of streams) {
            const current = this._refCounts.get(stream) ?? 0;
            if (current === 0) continue;
            if (current === 1) {
                this._refCounts.delete(stream);
                toRemove.push(stream);
            } else {
                this._refCounts.set(stream, current - 1);
            }
        }

        if (toRemove.length > 0 && this._isReadyToSend()) {
            await this._sendRpc('UNSUBSCRIBE', toRemove);
        }
    }

    /** Returns a snapshot of active streams and their subscriber counts. */
    getActiveStreams() {
        return new Map(this._refCounts);
    }

    /** Graceful shutdown — prevents reconnection. */
    destroy() {
        this._manualClose = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        this._refCounts.clear();
        this._pendingRequests.clear();
    }

    // ── Connection management ─────────────────────────────────────────────────

    /** True only when the WebSocket is fully open and ready for send(). */
    _isReadyToSend() {
        return this._ws !== null && this._ws.readyState === WebSocket.OPEN;
    }

    _ensureConnected() {
        if (this._isConnected) return Promise.resolve();
        if (this._isConnecting) {
            return new Promise((resolve) => this.once('_connected', resolve));
        }
        return this._connect();
    }

    _connect() {
        this._isConnecting = true;
        this._manualClose = false;

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(BINANCE_WS_URL);
            this._ws = ws;

            ws.once('open', () => {
                this._isConnected = true;
                this._isConnecting = false;
                this._reconnectDelay = RECONNECT_BASE_MS;
                console.log('[BinanceManager] Connected to Binance WebSocket.');
                this.emit('_connected');
                resolve();
            });

            ws.on('message', (raw) => this._onMessage(raw));

            ws.once('error', (err) => {
                console.error('[BinanceManager] WebSocket error:', err.message);
                if (this._isConnecting) {
                    this._isConnecting = false;
                    reject(err);
                }
            });

            ws.once('close', (code, reason) => {
                this._isConnected = false;
                this._isConnecting = false;
                this._ws = null;
                console.warn(`[BinanceManager] Connection closed. Code: ${code}. Reason: ${reason?.toString()}`);

                for (const { reject: r } of this._pendingRequests.values()) {
                    r(new Error('WebSocket connection closed.'));
                }
                this._pendingRequests.clear();

                if (!this._manualClose) {
                    this._scheduleReconnect();
                }
            });
        });
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        console.log(`[BinanceManager] Reconnecting in ${this._reconnectDelay}ms...`);
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            try {
                await this._connect();
                await this._resubscribeAll();
            } catch (err) {
                console.error('[BinanceManager] Reconnect failed:', err.message);
                this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
                this._scheduleReconnect();
            }
        }, this._reconnectDelay);
    }

    async _resubscribeAll() {
        const streams = [...this._refCounts.keys()];
        if (streams.length === 0) return;
        console.log(`[BinanceManager] Resubscribing to ${streams.length} stream(s) after reconnect.`);
        // Binance allows up to 300 params per SUBSCRIBE message
        for (let i = 0; i < streams.length; i += 300) {
            await this._sendRpc('SUBSCRIBE', streams.slice(i, i + 300));
        }
    }

    // ── JSON-RPC ──────────────────────────────────────────────────────────────

    _sendRpc(method, params) {
        return new Promise((resolve, reject) => {
            // Check actual WebSocket readyState, not just _isConnected flag.
            // _isConnected stays true until the 'close' event fires, but the socket
            // can be in CLOSING state (readyState 2) before that.
            if (!this._isReadyToSend()) {
                return reject(new Error('Not connected to Binance.'));
            }
            const id = this._requestId++;
            this._pendingRequests.set(id, { resolve, reject });
            this._ws.send(JSON.stringify({ method, params, id }), (err) => {
                if (err) {
                    this._pendingRequests.delete(id);
                    reject(err);
                }
            });
        });
    }

    // ── Message dispatch ──────────────────────────────────────────────────────

    _onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            console.warn('[BinanceManager] Unparseable message:', raw);
            return;
        }

        // JSON-RPC acknowledgement: { result: null, id: N } or { error: {...}, id: N }
        if ('id' in msg) {
            const pending = this._pendingRequests.get(msg.id);
            if (pending) {
                this._pendingRequests.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(`Binance error ${msg.error.code}: ${msg.error.msg}`));
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Wrapped format (combined stream): { stream: 'btcusdt@ticker', data: { ... } }
        if (msg.stream && msg.data) {
            const eventType = msg.stream.split('@')[1]; // 'ticker'
            this.emit(msg.stream, eventType, msg.data);
            return;
        }

        // Raw format (individual stream fallback): { e: '24hrTicker', s: 'BTCUSDT', ... }
        // Binance may send this format when subscribed to a single stream via JSON-RPC
        if (msg.e && msg.s) {
            const symbol = msg.s.toLowerCase();
            const eventType = msg.e; // e.g. '24hrTicker'
            const streamName = eventType === '24hrTicker' ? `${symbol}@ticker` : `${symbol}@${eventType}`;
            this.emit(streamName, eventType, msg);
        }
    }
}

// Singleton — Node module cache ensures only one instance across all imports
export default new BinanceManager();
