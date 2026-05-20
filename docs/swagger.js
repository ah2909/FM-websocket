const credentialsSchema = {
    type: 'object',
    description: 'API credentials keyed by exchange name',
    additionalProperties: {
        type: 'object',
        properties: {
            api_key:    { type: 'string' },
            api_secret: { type: 'string' },
            password:   { type: 'string', description: 'Required for OKX' },
        },
        required: ['api_key', 'api_secret'],
    },
    example: {
        binance: { api_key: 'your_key', api_secret: 'your_secret' },
        okx:     { api_key: 'your_key', api_secret: 'your_secret', password: 'your_pass' },
    },
};

const successResponse = (dataSchema) => ({
    type: 'object',
    properties: {
        success: { type: 'boolean', example: true },
        data:    dataSchema,
    },
});

const errorResponse = {
    type: 'object',
    properties: {
        success: { type: 'boolean', example: false },
        error:   { type: 'string' },
    },
};

export const swaggerSpec = {
    openapi: '3.0.0',
    info: {
        title: 'WebSocket Service HTTP API',
        version: '1.0.0',
        description:
            'HTTP endpoints exposed by the WebSocket service (port 3003). ' +
            'Handles CEX data fetching, credential validation, and Socket.IO event emission.',
    },
    servers: [{ url: 'http://localhost:3003', description: 'Local' }],
    paths: {
        '/api/cex/ticker': {
            post: {
                summary: 'Get ticker data for symbols',
                description: 'Fetches live ticker data from Binance for the given trading pairs.',
                tags: ['CEX'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['symbols'],
                                properties: {
                                    symbols: {
                                        type: 'array',
                                        items: { type: 'string' },
                                        example: ['BTC/USDT', 'ETH/USDT'],
                                    },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Ticker data', content: { 'application/json': { schema: successResponse({ type: 'object' }) } } },
                    400: { description: 'Invalid request body', content: { 'application/json': { schema: errorResponse } } },
                    500: { description: 'Exchange error', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },

        '/api/cex/portfolio': {
            post: {
                summary: 'Get portfolio balances from exchanges',
                tags: ['CEX'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['credentials'],
                                properties: {
                                    exchanges:   { type: 'array', items: { type: 'string' }, example: ['binance'] },
                                    credentials: credentialsSchema,
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Balances keyed by exchange', content: { 'application/json': { schema: successResponse({ type: 'object' }) } } },
                    400: { description: 'Missing credentials', content: { 'application/json': { schema: errorResponse } } },
                    500: { description: 'Exchange error', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },

        '/api/cex/transaction': {
            post: {
                summary: 'Get trade history for a symbol',
                tags: ['CEX'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['symbol', 'credentials'],
                                properties: {
                                    symbol:      { type: 'string', example: 'BTC/USDT' },
                                    exchanges:   { type: 'array', items: { type: 'string' } },
                                    credentials: credentialsSchema,
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Sorted list of trades across exchanges', content: { 'application/json': { schema: successResponse({ type: 'array', items: { type: 'object' } }) } } },
                    400: { description: 'Invalid body', content: { 'application/json': { schema: errorResponse } } },
                    500: { description: 'Exchange error', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },

        '/api/cex/sync-transactions': {
            post: {
                summary: 'Sync trades since a timestamp',
                tags: ['CEX'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['since', 'symbols', 'credentials'],
                                properties: {
                                    since:       { type: 'number', description: 'Timestamp in ms', example: 1700000000000 },
                                    exchanges:   { type: 'array', items: { type: 'string' } },
                                    symbols:     { type: 'array', items: { type: 'string' }, example: ['BTC/USDT'] },
                                    user_id:     { type: 'number' },
                                    credentials: credentialsSchema,
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Sorted trades since the given timestamp', content: { 'application/json': { schema: successResponse({ type: 'array', items: { type: 'object' } }) } } },
                    400: { description: 'Invalid body', content: { 'application/json': { schema: errorResponse } } },
                    500: { description: 'Exchange error', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },

        '/api/cex/sync-deposits-withdrawals': {
            post: {
                summary: 'Sync deposit and withdrawal history since a timestamp',
                tags: ['CEX'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['since', 'currencies', 'credentials'],
                                properties: {
                                    since:       { type: 'string', description: 'Timestamp or ISO date', example: '2024-01-01T00:00:00Z' },
                                    exchanges:   { type: 'array', items: { type: 'string' } },
                                    currencies:  { type: 'array', items: { type: 'string' }, example: ['BTC', 'ETH'] },
                                    user_id:     { type: 'number' },
                                    credentials: credentialsSchema,
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Completed deposits and withdrawals sorted by timestamp',
                        content: {
                            'application/json': {
                                schema: successResponse({
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            currency:   { type: 'string' },
                                            amount:     { type: 'number' },
                                            type:       { type: 'string', enum: ['deposit', 'withdrawal'] },
                                            address:    { type: 'string' },
                                            addressTo:  { type: 'string' },
                                            exchange:   { type: 'string' },
                                            timestamp:  { type: 'number' },
                                        },
                                    },
                                }),
                            },
                        },
                    },
                    400: { description: 'Invalid body', content: { 'application/json': { schema: errorResponse } } },
                    500: { description: 'Exchange error', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },

        '/api/cex/update-portfolio': {
            post: {
                summary: 'Emit portfolio update event to a user via Socket.IO',
                tags: ['Events'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['user_id'],
                                properties: {
                                    user_id: { type: 'number' },
                                    status:  { type: 'boolean', default: true },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Event emitted', content: { 'application/json': { schema: successResponse({}) } } },
                    500: { description: 'Emit error', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },

        '/api/cex/validate': {
            post: {
                summary: 'Validate API credentials for an exchange',
                tags: ['CEX'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['exchange', 'credentials'],
                                properties: {
                                    exchange:    { type: 'string', example: 'binance' },
                                    credentials: credentialsSchema,
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Credentials valid', content: { 'application/json': { schema: successResponse({}) } } },
                    400: { description: 'Missing fields', content: { 'application/json': { schema: errorResponse } } },
                    401: { description: 'Invalid API key or secret', content: { 'application/json': { schema: errorResponse } } },
                    500: { description: 'Exchange error', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },

        '/api/emit-event': {
            post: {
                summary: 'Emit a custom Socket.IO event to a user',
                tags: ['Events'],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['event', 'data', 'userId'],
                                properties: {
                                    event:  { type: 'string', example: 'price-alert' },
                                    data:   { type: 'object' },
                                    userId: { type: 'number' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Event emitted', content: { 'application/json': { schema: successResponse({}) } } },
                    400: { description: 'Missing fields', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },

        '/api/cex/ohlcv': {
            get: {
                summary: 'Get OHLCV (candlestick) data',
                tags: ['CEX'],
                parameters: [
                    { name: 'symbol',    in: 'query', required: true,  schema: { type: 'string' },  example: 'BTC/USDT' },
                    { name: 'timeframe', in: 'query', required: false, schema: { type: 'string' },  example: '1h' },
                    { name: 'limit',     in: 'query', required: false, schema: { type: 'integer' }, example: 100 },
                    { name: 'exchange',  in: 'query', required: false, schema: { type: 'string' },  example: 'binance' },
                ],
                responses: {
                    200: {
                        description: 'OHLCV array — each element is [timestamp, open, high, low, close, volume]',
                        content: {
                            'application/json': {
                                schema: successResponse({
                                    type: 'array',
                                    items: { type: 'array', items: { type: 'number' } },
                                }),
                            },
                        },
                    },
                    400: { description: 'Missing symbol or unsupported exchange', content: { 'application/json': { schema: errorResponse } } },
                    500: { description: 'Exchange error', content: { 'application/json': { schema: errorResponse } } },
                },
            },
        },
    },
};
