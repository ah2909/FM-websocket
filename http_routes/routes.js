import express from "express";
import ccxt from "ccxt";
import { io } from "../server.js";

const router = express.Router();

// Supported exchanges configuration
const SUPPORTED_EXCHANGES = {
	binance: {
		name: "binance",
		class: ccxt.binance,
		options: { 
            enableRateLimit: true,
            adjustForTimeDifference: true
        },
	},
	okx: {
		name: "okx",
		class: ccxt.okx,
		options: { enableRateLimit: true },
	},
	bybit: {
		name: "bybit",
		class: ccxt.bybit,
		options: { 
            enableRateLimit: true,
            adjustForTimeDifference: true
        },
	},
};

// Exchange instance manager
class ExchangeManager {
	static getExchange(exchangeName = "binance", credentials = null) {
        try {
            const exchange = SUPPORTED_EXCHANGES[exchangeName.toLowerCase()];
            if (!exchange) {
                throw new Error(`Unsupported exchange: ${exchangeName}`);
            }

            const options = { ...exchange.options };
            
            // Add credentials if provided
            if (credentials) {
                options.apiKey = credentials.api_key;
                options.secret = credentials.api_secret;
                
                // Special case for OKX which requires a password
                if (exchangeName.toLowerCase() === 'okx' && credentials.password) {
                    options.password = credentials.password;
                }
            }

            return new exchange.class(options);
        } catch (error) {
            throw new Error(`Failed to initialize exchange: ${error.message}`);
        }
    }

	static async getExchanges(requestedExchanges = [], credentials = null) {
        const exchanges = {};
        const exchangeList = requestedExchanges.length ? requestedExchanges : ["binance"];

        for (const name of exchangeList) {
            // Get exchange-specific credentials if provided
            const exchangeCredentials = credentials?.[name] || null;
            exchanges[name] = ExchangeManager.getExchange(name, exchangeCredentials);
        }

        return exchanges;
    }
}

/**
 * Get ticker data for symbols from specified exchanges (defaults to Binance)
 * @route POST /api/cex/ticker
 * @request_body {string[]} symbols - Required array of trading pair symbol (e.g., ["BTC/USDT", "ETH/USDT"])
 */
router.post("/cex/ticker", async (req, res) => {
	try {
        const body = req.body;
        if (!body || !Array.isArray(body.symbols) || body.symbols.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: "Invalid request body. 'symbols' must be a non-empty array." 
            });
        }
		const symbols = body.symbols;
		const exchanges = await ExchangeManager.getExchanges();
        const market = await exchanges['binance'].loadMarkets();
        // Validate symbols against the exchange's markets
        let formatSymbols = new Set([...symbols]);
        symbols.forEach((symbol) => {
            if (!market[symbol]) {
               // remove invalid symbols
                formatSymbols.delete(symbol);
            }
        });
        formatSymbols = formatSymbols.size > 0 ? Array.from(formatSymbols) : [];
        let results = {};
        if (formatSymbols.length !== 0) 
            results = await exchanges['binance'].fetchTickers(formatSymbols);
		res.json({ success: true, data: results });
	} catch (error) {
        console.error("Error in /cex/ticker route:", error.message);
		res.status(500).json({ success: false, error: error.message });
	}
});

/**
 * Get portfolio balances from specified exchanges
 * @route POST /api/cex/portfolio
 * @request_body {string[]} exchanges - Optional array of exchange names
 * @request_body {object} credentials - Optional object containing API credentials for each exchange
 * "credentials": {
        "binance": {
            "api_key": "your_binance_api_key",
            "api_secret": "your_binance_secret"
        },
        "okx": {
            "api_key": "your_okx_api_key",
            "api_secret": "your_okx_secret",
            "password": "your_okx_password"
        }
    }
 */
router.post("/cex/portfolio", async (req, res) => {
	try {
        const body = req.body;
        
        if (!body.credentials) {
            return res.status(400).json({
                success: false,
                error: "API credentials are required"
            });
        }
		const requestedExchanges= body.exchanges || [];
		const exchanges = await ExchangeManager.getExchanges(requestedExchanges, body.credentials);
        const results = {};
        // handle multiple exchanges
		await Promise.all(
			Object.entries(exchanges).map(async ([name, exchange]) => {
				try {
					let balance = await exchange.fetchBalance({omitZeroBalances: true});
					results[name] = balance;
				} catch (error) {
                    console.log(`Error fetching balance for ${name}:`, error.message);
					results[name] = { error: error.message };
				}
			})
		);
    
		res.json({ success: true, data: results });
	} catch (error) {
        console.error("Error in /cex/portfolio route:", error.message);
		res.status(500).json({ success: false, error: error.message });
	}
});

/**
 * Get transaction history for a specific symbol from specified exchanges
 * @route POST /api/cex/transaction
 * @request_body {string} symbol - Required trading pair symbol (e.g., "BTC/USDT")
 * @request_body {string[]} exchanges - Optional array of exchange names
 * @request_body {object} credentials - Optional object containing API credentials for each exchange
 * "credentials": {
        "binance": {
            "api_key": "your_binance_api_key",
            "api_secret": "your_binance_secret"
        },
        "okx": {
            "api_key": "your_okx_api_key",
            "api_secret": "your_okx_secret",
            "password": "your_okx_password"
        }
    }
 */
router.post("/cex/transaction", async (req, res) => {
	try {
        const body = req.body;
        
        if (!body.credentials) {
            return res.status(400).json({
                success: false,
                error: "API credentials are required"
            });
        }
        if (!body.symbol || typeof body.symbol !== 'string') {
            return res.status(400).json({
                success: false,
                error: "Invalid request body. 'symbol' must be a non-empty string."
            });
        }

		const requestedExchanges= body.exchanges || [];
		const exchanges = await ExchangeManager.getExchanges(requestedExchanges, body.credentials);
        const results = {};
        // handle multiple exchanges
		await Promise.allSettled(
			Object.entries(exchanges).map(async ([name, exchange]) => {
				try {
					let transaction = await exchange.fetchMyTrades(body.symbol);
					results[name] = transaction;
				} catch (error) {
                    console.error(`Error fetching trades for ${name}:`, error.message);
					results[name] = [{ error: error.message }];
				}
			})
		);
        //sort transactions of multiple exchanges by timestamp and add field exchange
        let allTransactions = [];
        Object.entries(results).forEach(([exchange, transactions]) => {
            transactions.forEach(transaction => {
                transaction.exchange = exchange;
            });
            allTransactions = allTransactions.concat(transactions);
        })
        allTransactions.sort((a, b) => a.timestamp - b.timestamp);
        
		res.json({ success: true, data: allTransactions });
	} catch (error) {
        console.error("Error in /cex/transaction route:", error);
		res.status(500).json({ success: false, error: error.message });
	}
});

/**
 * Get transaction history from specific time
 * @route POST /api/cex/sync-transactions
 * @request_body {number} since - Required timestamp in milliseconds from which to fetch transactions
 * @request_body {string[]} exchanges - Required array of exchange names
 * @request_body {string[]} symbols - Required array of symbols
 * @request_body {number} user_id - Required user_id to emit events to the specific user
 * @request_body {object} credentials - Required object containing API credentials for each exchange
 * "credentials": {
        "binance": {
            "api_key": "your_binance_api_key",
            "api_secret": "your_binance_secret"
        },
        "okx": {
            "api_key": "your_okx_api_key",
            "api_secret": "your_okx_secret",
            "password": "your_okx_password"
        }
    }
 */
router.post("/cex/sync-transactions", async (req, res) => {
    const room = req.body.user_id.toString();
    try {
        const body = req.body;
        
        if (!body.credentials) {
            io.to(room).emit("sync-transactions", {status: "error"});
            return res.status(400).json({
                success: false,
                error: "API credentials are required"
            });
        }
        if (!body.since) {
            io.to(room).emit("sync-transactions", {status: "error"});
            return res.status(400).json({
                success: false,
                error: "Invalid request body. 'since' must be a number."
            });
        }
        if (!body.symbols || !Array.isArray(body.symbols)) {
            io.to(room).emit("sync-transactions", {status: "error"});
            return res.status(400).json({
                success: false,
                error: "Invalid request body. 'symbols' is required."
            });
        }
        if (body.symbols.length === 0) {
             return res.json({
                success: true,
            });
        }

        const formatTimestamp = (timestamp) => {
            // Convert string to number if needed
            const date = new Date(timestamp);
            return date.getTime();
        };

        const requestedExchanges = body.exchanges || [];
        const exchanges = await ExchangeManager.getExchanges(requestedExchanges, body.credentials);
        const symbols = body.symbols;
        const allTrades = {};
        
        await Promise.all(
            Object.entries(exchanges).map(async ([name, exchange]) => {
                try {
                    const formattedSince = formatTimestamp(body.since);
                    let trades = symbols.map(symbol => exchange.fetchMyTrades(symbol, formattedSince));
                    trades = await Promise.allSettled(trades);
                    allTrades[name] = trades.map((trade) => trade.value ?? []).flat();
                } catch (error) {
                    console.error(`Error fetching trades for ${name}:`, error.message);
                    allTrades[name] = [];
                }
            })
        );
        //sort transactions of multiple exchanges by timestamp and add field exchange
        let allTransactions = [];
        Object.entries(allTrades).forEach(([exchange, transactions]) => {
            transactions.forEach(transaction => {
                transaction.exchange = exchange;
            });
            allTransactions = allTransactions.concat(transactions);
        })
        allTransactions.sort((a, b) => b.timestamp - a.timestamp);
        io.to(room).emit("sync-transactions", {status: "success", data: allTransactions});
		res.json({ success: true, data: allTransactions });
    } catch (error) {
        io.to(room).emit("sync-transactions", {status: "error"});
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post("/cex/update-portfolio", async (req, res) => {
    const room = req.body.user_id.toString();
    const status = req.body.status || true;
    try {
        io.to(room).emit("update-portfolio", { success: status });
        res.json({ success: status });
    } catch (error) {
        io.to(room).emit("update-portfolio", { success: false });
        res.status(500).json({ success: false, error: error.message });
    }
});
/**
 * Validate API credentials for a specific exchange
 * @route POST /api/cex/validate
 * @request_body {string[]} exchanges - Required array of exchange names
 * @request_body {object} credentials - Required object containing API credentials for exchange
 * "credentials": {
        "binance": {
            "api_key": "your_binance_api_key",
            "api_secret": "your_binance_secret"
        }
    }
*/
router.post('/cex/validate', async (req, res) => {
    const { exchange, credentials } = req.body;
    if (!credentials) {
        return res.status(400).json({
            success: false,
            error: "API credentials are required"
        });
    }
    if (!exchange) {
        return res.status(400).json({
            success: false,
            error: "Exchange name is required"
        });
    }

    try {
        // Call a lightweight authenticated endpoint
        const exchangeObj = ExchangeManager.getExchange(exchange, credentials);
        let response = await exchangeObj.fetchBalance()
        res.status(200).json({ success: true });
    } catch (error) {
        // Handle authentication errors or other issues
        console.error(`Error validating API credentials for ${exchange}:`, error.message);
        if (error instanceof ccxt.AuthenticationError) {
            return res.status(401).json({ success: false, error: 'Invalid API key or secret' });
        }
        return res.status(500).json({ success: false, error: error.message || 'An error occurred while validating the API key' });
    }
});


export default router;
