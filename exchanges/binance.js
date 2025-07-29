import WebSocket from 'ws';
import EventEmitter from 'events';

class BinanceWS extends EventEmitter {
    constructor(streams) {
        super();
        this.streams = streams;
        this.ws = null;
    }

    connect() {
        this.ws = new WebSocket(`wss://stream.binance.com:443${this.streams}`);

        this.ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.stream && message.data) {
                const stream = message.stream;
                const eventType = stream.split('@')[1];
                this.emit(eventType, message.data);
            }
        });

        this.ws.on('open', () => console.log('Connected to Binance WS'));
        this.ws.on('error', (err) => console.error('Binance WS Error:', err));
    }
}

export default BinanceWS;