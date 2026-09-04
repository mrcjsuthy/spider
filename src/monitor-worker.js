/* Standalone poller, for when monitoring should keep running independently of
   the web service. Deploy as a Render Background Worker with the same
   DATABASE_URL, and set MONITOR_ENABLED=false on the web service so only one
   of them is checking.

   Note: this process has no websocket clients of its own, so the broadcasts
   from monitor.js go nowhere here — browsers pick the new status up from
   /api/graph on their next load or reconnect. If you want live push from the
   worker, have it NOTIFY on a Postgres channel and have the web service LISTEN
   and rebroadcast. */

import { migrate, pool } from './db.js';
import { startMonitor } from './monitor.js';

await migrate();
startMonitor();
console.log('[worker] monitoring only — no HTTP server in this process');

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} — shutting down`);
    pool.end().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref?.();
  });
}

// Keep the process alive; startMonitor's interval is unref'd on purpose so it
// never holds the process open by itself.
setInterval(() => {}, 1 << 30);
