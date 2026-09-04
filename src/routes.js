import express from 'express';
import crypto from 'node:crypto';
import { q } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, clearSessionCookie, readCookie, SESSION_COOKIE,
  requireUser, requireRole,
} from './auth.js';
import { broadcast } from './realtime.js';

export const router = express.Router();

/* Only these columns can ever be written from the browser. Anything else in a
   request body is ignored rather than rejected, so an older client that still
   sends a retired field keeps working. */
const SYSTEM_FIELDS = [
  'name', 'domain', 'vendor', 'owner', 'capability', 'standard',
  'lifecycle', 'health', 'criticality', 'notes',
  'monitor_method', 'monitor_endpoint', 'monitor_interval', 'x', 'y',
];
const LINK_FIELDS = ['from_id', 'to_id', 'label', 'protocol', 'direction', 'health', 'owner', 'notes'];

const INT_FIELDS = new Set(['x', 'y', 'monitor_interval']);

function clean(body, allowed) {
  const out = {};
  for (const f of allowed) {
    if (!(f in body)) continue;
    let v = body[f];
    if (INT_FIELDS.has(f)) {
      if (v === '' || v === null || v === undefined) { out[f] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[f] = Math.round(n);
    } else {
      out[f] = String(v ?? '').slice(0, 4000);
    }
  }
  return out;
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

async function audit(req, action, entity, entityId, changes) {
  try {
    await q(
      `INSERT INTO audit_log (user_id, user_email, action, entity, entity_id, changes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.id, req.user.email, action, entity, entityId, changes ? JSON.stringify(changes) : null],
    );
  } catch (err) {
    // An audit failure must never lose the user's edit.
    console.error('[audit] write failed:', err.message);
  }
}

/** Postgres check-constraint violations are user error, not server error. */
function fail(res, err) {
  if (err && err.code === '23514') return res.status(400).json({ error: 'That value is not allowed for this field' });
  if (err && err.code === '23503') return res.status(400).json({ error: 'That system no longer exists' });
  if (err && err.code === '23505') return res.status(409).json({ error: 'That already exists' });
  console.error('[api]', err);
  return res.status(500).json({ error: 'Something went wrong saving that' });
}

/* ==================================================================== auth */

const loginAttempts = new Map(); // ip -> {n, until}

router.post('/auth/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  const rec = loginAttempts.get(ip);
  if (rec && rec.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const { rows } = await q(
      'SELECT id, email, name, role, password_hash FROM users WHERE email_lower = $1 AND is_active',
      [email],
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      const n = (rec?.n || 0) + 1;
      loginAttempts.set(ip, { n, until: n >= 8 ? Date.now() + 60_000 : 0 });
      return res.status(401).json({ error: 'That email and password do not match' });
    }
    loginAttempts.delete(ip);

    const { id, expires } = await createSession(user.id, req.headers['user-agent']);
    setSessionCookie(res, id, expires);
    await q('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) { fail(res, err); }
});

router.post('/auth/logout', async (req, res) => {
  await destroySession(readCookie(req, SESSION_COOKIE));
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.user });
});

router.post('/auth/password', requireUser, async (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (next.length < 10) return res.status(400).json({ error: 'Use at least 10 characters' });
  try {
    const { rows } = await q('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0] || !verifyPassword(current, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Your current password is not right' });
    }
    await q('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(next), req.user.id]);
    await q('DELETE FROM sessions WHERE user_id = $1 AND id <> $2',
      [req.user.id, readCookie(req, SESSION_COOKIE)]);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* =================================================================== users */

router.get('/users', requireRole('admin'), async (_req, res) => {
  try {
    const { rows } = await q(
      `SELECT id, email, name, role, is_active, created_at, last_login_at
         FROM users ORDER BY lower(name), email_lower`,
    );
    res.json({ users: rows });
  } catch (err) { fail(res, err); }
});

router.post('/users', requireRole('admin'), async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const name = String(req.body?.name || '').trim();
  const role = String(req.body?.role || 'viewer');
  const password = String(req.body?.password || '');
  if (!email.includes('@')) return res.status(400).json({ error: 'That does not look like an email address' });
  if (password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for the password' });
  if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'Unknown role' });
  try {
    const { rows } = await q(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4)
       RETURNING id, email, name, role, is_active, created_at`,
      [email, name, role, hashPassword(password)],
    );
    await audit(req, 'create', 'user', rows[0].id, { email, role });
    res.status(201).json({ user: rows[0] });
  } catch (err) { fail(res, err); }
});

router.patch('/users/:id', requireRole('admin'), async (req, res) => {
  const sets = [], vals = [];
  if ('role' in req.body) {
    if (!['viewer', 'editor', 'admin'].includes(req.body.role)) return res.status(400).json({ error: 'Unknown role' });
    sets.push(`role = $${sets.length + 1}`); vals.push(req.body.role);
  }
  if ('name' in req.body) { sets.push(`name = $${sets.length + 1}`); vals.push(String(req.body.name).slice(0, 200)); }
  if ('is_active' in req.body) { sets.push(`is_active = $${sets.length + 1}`); vals.push(!!req.body.is_active); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  if (req.params.id === req.user.id && 'role' in req.body && req.body.role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin access' });
  }
  try {
    vals.push(req.params.id);
    const { rows } = await q(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, email, name, role, is_active`, vals,
    );
    if (!rows[0]) return res.status(404).json({ error: 'No such user' });
    if (rows[0].is_active === false) await q('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
    await audit(req, 'update', 'user', rows[0].id, req.body);
    res.json({ user: rows[0] });
  } catch (err) { fail(res, err); }
});

/* =================================================================== graph */

router.get('/graph', requireUser, async (_req, res) => {
  try {
    const [systems, links, status] = await Promise.all([
      q(`SELECT id,name,domain,vendor,owner,capability,standard,lifecycle,health,
                criticality,notes,monitor_method,monitor_endpoint,monitor_interval,
                health_source,x,y,updated_at
           FROM systems ORDER BY id`),
      q('SELECT id,from_id,to_id,label,protocol,direction,health,owner,notes,updated_at FROM links ORDER BY id'),
      q('SELECT * FROM system_status'),
    ]);
    res.json({ systems: systems.rows, links: links.rows, status: status.rows });
  } catch (err) { fail(res, err); }
});

router.post('/systems', requireRole('editor'), async (req, res) => {
  const data = clean(req.body || {}, SYSTEM_FIELDS);
  if (!data.name) return res.status(400).json({ error: 'A system needs a name' });
  if (!data.domain) data.domain = 'ops';
  const id = String(req.body?.id || newId('sys')).slice(0, 80);
  const cols = ['id', ...Object.keys(data), 'updated_by'];
  const vals = [id, ...Object.values(data), req.user.id];
  try {
    const { rows } = await q(
      `INSERT INTO systems (${cols.join(',')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals,
    );
    await audit(req, 'create', 'system', id, data);
    broadcast({ type: 'system.upsert', system: rows[0] });
    res.status(201).json({ system: rows[0] });
  } catch (err) { fail(res, err); }
});

router.patch('/systems/:id', requireRole('editor'), async (req, res) => {
  const data = clean(req.body || {}, SYSTEM_FIELDS);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to change' });
  // A person setting health by hand takes it back from the poller.
  if ('health' in data) data.health_source = 'manual';
  const keys = Object.keys(data);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const vals = [...Object.values(data), req.user.id, req.params.id];
  try {
    const { rows } = await q(
      `UPDATE systems SET ${sets.join(', ')}, updated_at = now(),
              updated_by = $${keys.length + 1}
        WHERE id = $${keys.length + 2} RETURNING *`, vals,
    );
    if (!rows[0]) return res.status(404).json({ error: 'That system has been deleted' });
    // Dragging generates a lot of writes; only the meaningful ones are audited.
    const meaningful = keys.filter((k) => k !== 'x' && k !== 'y');
    if (meaningful.length) await audit(req, 'update', 'system', req.params.id, data);
    broadcast({ type: 'system.upsert', system: rows[0] });
    res.json({ system: rows[0] });
  } catch (err) { fail(res, err); }
});

router.delete('/systems/:id', requireRole('editor'), async (req, res) => {
  try {
    const { rows } = await q('DELETE FROM systems WHERE id = $1 RETURNING name', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Already gone' });
    await audit(req, 'delete', 'system', req.params.id, { name: rows[0].name });
    broadcast({ type: 'system.delete', id: req.params.id });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

router.post('/links', requireRole('editor'), async (req, res) => {
  const data = clean(req.body || {}, LINK_FIELDS);
  if (!data.from_id || !data.to_id) return res.status(400).json({ error: 'A link needs both ends' });
  if (data.from_id === data.to_id) return res.status(400).json({ error: 'A system cannot link to itself' });
  const id = String(req.body?.id || newId('lnk')).slice(0, 80);
  const cols = ['id', ...Object.keys(data), 'updated_by'];
  const vals = [id, ...Object.values(data), req.user.id];
  try {
    const { rows } = await q(
      `INSERT INTO links (${cols.join(',')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals,
    );
    await audit(req, 'create', 'link', id, data);
    broadcast({ type: 'link.upsert', link: rows[0] });
    res.status(201).json({ link: rows[0] });
  } catch (err) { fail(res, err); }
});

router.patch('/links/:id', requireRole('editor'), async (req, res) => {
  const data = clean(req.body || {}, LINK_FIELDS);
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to change' });
  const keys = Object.keys(data);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const vals = [...Object.values(data), req.user.id, req.params.id];
  try {
    const { rows } = await q(
      `UPDATE links SET ${sets.join(', ')}, updated_at = now(),
              updated_by = $${keys.length + 1}
        WHERE id = $${keys.length + 2} RETURNING *`, vals,
    );
    if (!rows[0]) return res.status(404).json({ error: 'That link has been deleted' });
    await audit(req, 'update', 'link', req.params.id, data);
    broadcast({ type: 'link.upsert', link: rows[0] });
    res.json({ link: rows[0] });
  } catch (err) { fail(res, err); }
});

router.delete('/links/:id', requireRole('editor'), async (req, res) => {
  try {
    const { rowCount } = await q('DELETE FROM links WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Already gone' });
    await audit(req, 'delete', 'link', req.params.id, null);
    broadcast({ type: 'link.delete', id: req.params.id });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ================================================================ history */

router.get('/systems/:id/checks', requireUser, async (req, res) => {
  try {
    const { rows } = await q(
      `SELECT checked_at, ok, status_code, response_ms, error
         FROM monitor_checks WHERE system_id = $1
        ORDER BY checked_at DESC LIMIT 200`, [req.params.id],
    );
    res.json({ checks: rows });
  } catch (err) { fail(res, err); }
});

router.get('/audit', requireUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const params = [limit];
    let where = '';
    if (req.query.entity_id) { params.push(String(req.query.entity_id)); where = 'WHERE entity_id = $2'; }
    const { rows } = await q(
      `SELECT at, user_email, action, entity, entity_id, changes
         FROM audit_log ${where} ORDER BY at DESC LIMIT $1`, params,
    );
    res.json({ entries: rows });
  } catch (err) { fail(res, err); }
});
