import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, saltlen: 16 };
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltlen);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), key.toString('base64'),
  ].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function issueToken(userId, secret, now = Date.now()) {
  const payload = b64url(JSON.stringify({ uid: userId, iat: now, exp: now + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the user id, or null when the token is missing, forged or expired. */
export function readToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payloadB64 = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || typeof payload.uid !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload.uid;
  } catch {
    return null;
  }
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * A small in-memory throttle so a stolen email cannot be brute forced. It resets
 * when the process restarts, which is fine for a single-user-ish deployment.
 */
export function createThrottle({ limit = 10, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    check(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || now - entry.start > windowMs) {
        hits.set(key, { start: now, count: 1 });
        return true;
      }
      entry.count += 1;
      if (hits.size > 5000) hits.clear();
      return entry.count <= limit;
    },
    clear(key) { hits.delete(key); },
  };
}
