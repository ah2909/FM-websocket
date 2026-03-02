import jwt from 'jsonwebtoken';
import { createPublicKey } from 'crypto';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:8086';

let cachedPublicKey = null;

async function fetchPublicKey() {
    const res = await fetch(`${AUTH_SERVICE_URL}/.well-known/jwks.json`);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const { keys } = await res.json();
    if (!keys?.length) throw new Error('No keys found in JWKS response');
    const publicKey = createPublicKey({ key: keys[0], format: 'jwk' });
    return publicKey.export({ type: 'spki', format: 'pem' });
}

async function getPublicKey() {
    if (!cachedPublicKey) {
        cachedPublicKey = await fetchPublicKey();
    }
    return cachedPublicKey;
}

export async function authMiddleware(socket, next) {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication error: No token provided'));
    }

    try {
        const publicKey = await getPublicKey();
        const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
        socket.data.user = decoded;
        next();
    } catch (err) {
        next(new Error('Authentication error: Invalid or expired token'));
    }
}
