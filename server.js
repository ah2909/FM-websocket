import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import binanceManager from './exchanges/binance.js';
import router from './http_routes/routes.js';
import { authMiddleware } from './middleware/auth.js';

const PORT = 3003;

const app = express();
app.use(express.json());
app.use('/api', router);

const server = createServer(app);
export const io = new Server(server, {
    cors: {
        origin: '*'
    }
});

/**
 * Parses a Binance stream path into individual stream names.
 *
 * Handles:
 *   "/stream?streams=btcusdt@ticker/ethusdt@ticker"  → ['btcusdt@ticker', 'ethusdt@ticker']
 *   "/ws/btcusdt@ticker"                             → ['btcusdt@ticker']
 *   "btcusdt@ticker"                                 → ['btcusdt@ticker']
 */
function parseStreams(path) {
    if (path.includes('?streams=')) {
        return path.split('?streams=')[1].split('/').filter(Boolean);
    }
    if (path.startsWith('/ws/')) return [path.slice(4)];
    return [path];
}

/**
 * Returns a throttle function keyed by an arbitrary string key.
 * Each unique key has its own independent timer, so one user's
 * BTC data does not suppress another user's ETH data.
 */
function makeThrottle(delay) {
    const lastCall = new Map();
    function throttle(key, fn) {
        const now = Date.now();
        if ((now - (lastCall.get(key) ?? 0)) >= delay) {
            lastCall.set(key, now);
            fn();
        }
    }
    throttle.deletePrefix = function (prefix) {
        for (const key of lastCall.keys()) {
            if (key.startsWith(prefix)) lastCall.delete(key);
        }
    };
    return throttle;
}

const throttle = makeThrottle(10000);

io.use(authMiddleware);

// Handle client connections
io.on('connection', (socket) => {
    const user_id = socket.data.user.id.toString();
    socket.join(user_id);
    console.log('Total connected clients:', io.engine.clientsCount);

    // Individual stream names this socket is subscribed to
    const socketStreams = new Set();

    // Per-socket listener references — required for precise EventEmitter.off() cleanup
    const binanceListeners = new Map();

    socket.on('subscribe', async (path) => {
        // Filter out streams this socket is already subscribed to (idempotent)
        const newStreams = parseStreams(path).filter(s => !socketStreams.has(s));
        if (newStreams.length === 0) return;

        try {
            // One batch SUBSCRIBE message to Binance for all new streams
            await binanceManager.subscribeMany(newStreams);

            for (const stream of newStreams) {
                socketStreams.add(stream);

                const listener = (eventType, data) => {
                    throttle(`${user_id}:${stream}`, () => {
                        io.to(user_id).emit('ticker', data);
                    });
                };

                binanceListeners.set(stream, listener);
                binanceManager.on(stream, listener);
            }
        } catch (err) {
            console.error('[server] Failed to subscribe:', err.message);
            socket.emit('error', { message: 'Failed to subscribe to streams' });
        }
    });

    socket.on('unsubscribe', async (path) => {
        const streams = parseStreams(path).filter(s => socketStreams.has(s));
        if (streams.length === 0) return;

        // Remove listeners first, synchronously
        for (const stream of streams) {
            socketStreams.delete(stream);
            const listener = binanceListeners.get(stream);
            if (listener) {
                binanceManager.off(stream, listener);
                binanceListeners.delete(stream);
            }
        }

        try {
            // One batch UNSUBSCRIBE message to Binance for all removed streams
            await binanceManager.unsubscribeMany(streams);
        } catch (err) {
            console.error('[server] Failed to unsubscribe:', err.message);
        }
    });

    socket.on('disconnect', async () => {
        const streams = [...socketStreams];

        // Remove all listeners synchronously first
        for (const stream of streams) {
            const listener = binanceListeners.get(stream);
            if (listener) binanceManager.off(stream, listener);
        }
        binanceListeners.clear();
        socketStreams.clear();
        throttle.deletePrefix(`${user_id}:`);

        try {
            // One batch UNSUBSCRIBE for all streams this socket held
            await binanceManager.unsubscribeMany(streams);
        } catch (err) {
            console.error('[server] Failed to unsubscribe on disconnect:', err.message);
        }
    });
});

process.on('SIGTERM', () => {
    binanceManager.destroy();
    server.close(() => process.exit(0));
});

server.listen(PORT, () => {
    console.log(`Websocket server listening on port ${PORT}`);
});
