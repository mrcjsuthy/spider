import crypto from 'node:crypto';
import { q } from './db.js';

/* Passwords use scrypt from Node's own crypto — no native build step, which
   keeps the Render build simple and the dependency list to three packages. */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export const SESSION_COOKIE = 'upland_sid';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);

export async function createSession(userId, userAgent) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await q(
    'INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1,$2,$3,$4)',
    [id, userId, expires, (userAgent || '').slice(0, 400)],
  );
  return { id, expires };
}

export async function destroySession(id) {
  if (id) await q('DELETE FROM sessions WHERE id = $1', [id]);
}

export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setSessionCookie(res, id, expires) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${id}; Path=/; HttpOnly;${secure} SameSite=Lax; Expires=${expires.toUTCString()}`);
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`);
}

/** Resolve a session id to a live user, or null. Shared by HTTP and websockets. */
export async function userForSession(sid) {
  if (!sid) return null;
  const { rows } = await q(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`,
    [sid],
  );
  return rows[0] || null;
}

/* ------------------------------------------------------------ middleware */

export async function attachUser(req, _res, next) {
  try {
    req.user = await userForSession(readCookie(req, SESSION_COOKIE));
  } catch (err) {
    console.error('[auth] session lookup failed:', err.message);
    req.user = null;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
  next();
}

const RANK = { viewer: 0, editor: 1, admin: 2 };

export function requireRole(minimum) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
    if (RANK[req.user.role] < RANK[minimum]) {
      return res.status(403).json({ error: 'Your account has read-only access to the map' });
    }
    next();
  };
}

/** Delete expired sessions. Cheap; called on an interval from server.js. */
export async function pruneSessions() {
  const { rowCount } = await q('DELETE FROM sessions WHERE expires_at < now()');
  if (rowCount) console.log(`[auth] pruned ${rowCount} expired session(s)`);
}
