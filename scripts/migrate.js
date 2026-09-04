import { migrate, pool } from '../src/db.js';

await migrate();
console.log('[migrate] up to date');
await pool.end();
