import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import BinanceWS from './exchanges/binance.js';
import OkxWS from './exchanges/okx.js';
import BybitWS from './exchanges/bybit.js';
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
  console.log('Client connected:', socket.id);
  const user_id = socket.handshake.auth.token;
  socket.join(user_id);
  
  socket.on('subscribe', (stream) => {
      console.log(`Subscribed to ${stream}`);

      const binanceWS = new BinanceWS(stream);
      binanceWS.connect();

      binanceWS.on('ticker', throttle((data) => {
          io.to(user_id).emit(`ticker`, data);
      }, 10000));
  });
  
  socket.on('unsubscribe', (stream) => {
    console.log(`Unsubscribed from ${stream}`);
  });

  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});


server.listen(PORT, () => {
  console.log(`Websocket server listening on port ${PORT}`);
});