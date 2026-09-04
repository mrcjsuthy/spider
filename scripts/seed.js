import { migrate, pool } from '../src/db.js';
import { seed } from '../src/bootstrap.js';

await migrate();
await seed();
await pool.end();
