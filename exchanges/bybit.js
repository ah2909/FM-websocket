import WebSocket from 'ws';
import EventEmitter from 'events';

class BybitWS extends EventEmitter {
    constructor(streams) {
        super();
        this.streams = streams || ['trade.BTCUSD']; // Example stream
        this.ws = null;
    }

    connect() {
        this.ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');

        this.ws.on('open', () => {
            const subscription = {
                op: 'subscribe',
                args: this.streams
            };
            this.ws.send(JSON.stringify(subscription));
            console.log('Connected to Bybit WS');
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.topic && message.data) {
                this.emit(message.topic, message.data);
            }
        });

        this.ws.on('error', (err) => console.error('Bybit WS Error:', err));
    }
}

export default BybitWS;