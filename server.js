import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import BinanceWS from './exchanges/binance.js';
import router from './http_routes/routes.js';

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

function throttle(func, delay) {
  let lastCall = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      return func(...args);
    }
  };
}

// Handle client connections
io.on('connection', (socket) => {
  const user_id = socket.handshake.auth.token;
  socket.join(user_id);
  console.log('Total connected clients:', io.engine.clientsCount);

  const userStreams = new Map();

  socket.on('subscribe', (stream) => {
    const binanceWS = new BinanceWS(stream);
    binanceWS.connect();

    userStreams.set(stream, binanceWS);

    binanceWS.on('ticker', throttle((data) => {
      io.to(user_id).emit(`ticker`, data);
    }, 5000));
  });

  socket.on('unsubscribe', (stream) => {
    userStreams.delete(stream);
  });

  socket.on('disconnect', () => {
    for (const [stream, binanceWS] of userStreams.entries()) {
      binanceWS.close();
    }
    userStreams.clear();
  });
});



server.listen(PORT, () => {
  console.log(`Websocket server listening on port ${PORT}`);
});