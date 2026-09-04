import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { migrate, ROOT, pool } from './db.js';
import { attachUser, pruneSessions } from './auth.js';
import { router } from './routes.js';
import { attachRealtime } from './realtime.js';
import { startMonitor } from './monitor.js';
import { bootstrapAdmin, seedIfEmpty } from './bootstrap.js';

const app = express();
app.set('trust proxy', 1);            // Render terminates TLS in front of us
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));
app.use(attachUser);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', router);

// The map itself requires a session; the login page does not.
app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});
app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.sendFile(path.join(ROOT, 'public', 'login.html'));
});

app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: '1h' }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'No such endpoint' });
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  res.status(500).json({ error: 'Something went wrong' });
});

const server = http.createServer(app);
attachRealtime(server);

const port = Number(process.env.PORT || 3000);

try {
  await migrate();
  await bootstrapAdmin();
  await seedIfEmpty();
} catch (err) {
  console.error('[server] startup failed:', err.message);
  process.exit(1);
}

setInterval(() => pruneSessions().catch(() => {}), 3600_000).unref?.();
startMonitor();

server.listen(port, () => console.log(`[server] listening on :${port}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} — shutting down`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref?.();
  });
}
