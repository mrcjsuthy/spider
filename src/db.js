import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env, or set it in Render.');
  process.exit(1);
}

// Render's managed Postgres presents a certificate the default Node trust
// store does not carry, so verification is relaxed for that host only.
const needsSsl = /render\.com|amazonaws\.com/.test(process.env.DATABASE_URL)
  || process.env.PGSSL === 'require';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

export const q = (text, params) => pool.query(text, params);

/** Run every .sql file in migrations/ once, in filename order. */
export async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
             filename text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now())`);

  const dir = path.join(ROOT, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await q('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[db] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}
