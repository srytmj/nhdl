const crypto = require('crypto');

// Simple one-time-login session auth: enter the password once, get a long-lived session
// cookie, and stay logged in until it expires or the server restarts (sessions are kept
// in memory only — nothing session-related ever touches disk). The password itself lives
// in the NHDL_PASSWORD environment variable (see .env.example), never in source or git.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Map(); // token -> expiresAt

function isAuthRequired() {
    return !!process.env.NHDL_PASSWORD;
}

function checkPassword(input) {
    const expected = process.env.NHDL_PASSWORD || '';
    if (!expected || typeof input !== 'string') return false;
    const a = Buffer.from(input);
    const b = Buffer.from(expected);
    // timingSafeEqual requires equal-length buffers; pad so length itself doesn't leak info.
    if (a.length !== b.length) {
        crypto.timingSafeEqual(Buffer.alloc(Math.max(a.length, b.length)), Buffer.alloc(Math.max(a.length, b.length)));
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
}

function isValidSession(token) {
    if (!token || !sessions.has(token)) return false;
    const expiresAt = sessions.get(token);
    if (Date.now() > expiresAt) {
        sessions.delete(token);
        return false;
    }
    return true;
}

function destroySession(token) {
    if (token) sessions.delete(token);
}

function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    cookieHeader.split(';').forEach(pair => {
        const eq = pair.indexOf('=');
        if (eq === -1) return;
        out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
    });
    return out;
}

module.exports = {
    isAuthRequired,
    checkPassword,
    createSession,
    isValidSession,
    destroySession,
    parseCookies,
    SESSION_TTL_MS
};
