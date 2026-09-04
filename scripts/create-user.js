import { pool, q } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

/* Usage: npm run create-user -- someone@upland.co.nz "Their Name" editor 'their-password' */

const [email, name, role = 'viewer', password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: npm run create-user -- <email> "<name>" <viewer|editor|admin> <password>');
  process.exit(1);
}
if (!['viewer', 'editor', 'admin'].includes(role)) {
  console.error(`Unknown role "${role}". Use viewer, editor or admin.`);
  process.exit(1);
}
if (password.length < 10) {
  console.error('Use a password of at least 10 characters.');
  process.exit(1);
}

try {
  const { rows } = await q(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email_lower) DO UPDATE
       SET name = EXCLUDED.name, role = EXCLUDED.role,
           password_hash = EXCLUDED.password_hash, is_active = true
     RETURNING id, email, role`,
    [email, name || '', role, hashPassword(password)],
  );
  console.log(`Ready: ${rows[0].email} (${rows[0].role})`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
