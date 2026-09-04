import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { q, ROOT } from './db.js';
import { hashPassword } from './auth.js';

/* First-run setup, so a fresh Render deploy comes up usable without a shell.
   Both steps are no-ops once they have run. */

export async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const { rows } = await q('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;

  if (!email || !password) {
    console.warn('[bootstrap] no users exist and BOOTSTRAP_ADMIN_EMAIL / '
      + 'BOOTSTRAP_ADMIN_PASSWORD are not set — nobody can sign in yet');
    return;
  }
  if (password.length < 10) {
    console.error('[bootstrap] BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters');
    return;
  }
  await q(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,'admin',$3)`,
    [email, process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator', hashPassword(password)],
  );
  console.log(`[bootstrap] created the first admin account: ${email}`);
  console.log('[bootstrap] sign in, change that password, then remove '
    + 'BOOTSTRAP_ADMIN_PASSWORD from the environment');
}

export async function seedIfEmpty() {
  if (process.env.SEED_ON_BOOT === 'false') return;
  const { rows } = await q('SELECT count(*)::int AS n FROM systems');
  if (rows[0].n > 0) return;
  await seed();
}

/** Load seed/systems.json and seed/links.json into an empty map. */
export async function seed() {
  const read = async (f) => JSON.parse(await readFile(path.join(ROOT, 'seed', f), 'utf8'));
  const systems = await read('systems.json');
  const links = await read('links.json');

  for (const s of systems) {
    await q(
      `INSERT INTO systems
         (id,name,domain,vendor,owner,capability,standard,lifecycle,health,
          criticality,notes,monitor_method,monitor_endpoint,monitor_interval,x,y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING`,
      [
        s.id, s.name, s.domain, s.vendor || '', s.owner || '', s.capability || '',
        s.standard || '', s.status || s.lifecycle || 'proposed', s.health || 'unset',
        s.criticality || 'standard', s.notes || '',
        s.monitor || s.monitor_method || 'none', s.endpoint || s.monitor_endpoint || '',
        s.interval ? Number(s.interval) : null,
        Number(s.x) || 0, Number(s.y) || 0,
      ],
    );
  }

  for (const l of links) {
    await q(
      `INSERT INTO links (id,from_id,to_id,label,protocol,direction,health,owner,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        l.id, l.from || l.from_id, l.to || l.to_id, l.label || '', l.protocol || '',
        l.direction || '', l.health || 'unset', l.owner || '', l.notes || '',
      ],
    );
  }

  console.log(`[seed] loaded ${systems.length} systems and ${links.length} links`);
}
