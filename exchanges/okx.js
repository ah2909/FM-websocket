import WebSocket from 'ws';
import EventEmitter from 'events';

class OkxWS extends EventEmitter {
    constructor(streams) {
        super();
        this.streams = streams || ['tickers.BTC-USDT']; // Example stream
        this.ws = null;
    }

    connect() {
        this.ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');

        this.ws.on('open', () => {
            const subscription = {
                op: 'subscribe',
                args: this.streams.map(stream => ({ channel: stream }))
            };
            this.ws.send(JSON.stringify(subscription));
            console.log('Connected to OKX WS');
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.arg && message.data) {
                this.emit(message.arg.channel, message.data);
            }
        });

        this.ws.on('error', (err) => console.error('OKX WS Error:', err));
    }
}

export default OkxWS;