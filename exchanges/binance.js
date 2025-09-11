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
    }

    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

export default BinanceWS;
