import { q } from './db.js';
import { broadcast } from './realtime.js';

/* The poller nothing needs yet.

   No system in the village is installed, so this sits idle: it only ever
   looks at rows whose monitor_method is something other than 'none' AND that
   carry an endpoint. The day the first system is commissioned, someone fills
   in a URL and an interval and this starts working with no code change.

   It deliberately never overwrites a health rating a person set by hand —
   health_source has to be 'monitor' for the poller to own that field. A
   system flips to monitor-owned the first time a check runs against it, and
   flips back the moment someone chooses a health value in the inspector. */

const TIMEOUT_MS = Number(process.env.MONITOR_TIMEOUT_MS || 10_000);
const SWEEP_MS = Number(process.env.MONITOR_SWEEP_MS || 30_000);
const FAILURES_BEFORE_RISK = 2;
const FAILURES_BEFORE_BLOCKED = 4;

async function due() {
  const { rows } = await q(
    `SELECT s.id, s.monitor_method, s.monitor_endpoint,
            COALESCE(s.monitor_interval, 300) AS interval_s,
            st.last_checked_at, st.consecutive_failures
       FROM systems s
       LEFT JOIN system_status st ON st.system_id = s.id
      WHERE s.monitor_method <> 'none'
        AND s.monitor_endpoint <> ''
        AND (st.last_checked_at IS NULL
             OR st.last_checked_at < now() - make_interval(secs => COALESCE(s.monitor_interval, 300)))`,
  );
  return rows;
}

async function checkOne(sys) {
  const started = Date.now();
  let ok = false, statusCode = null, error = null;

  if (sys.monitor_method === 'agent') {
    // Agent/webhook systems report in to /api/systems/:id/checks themselves;
    // the poller does not reach out to them.
    return null;
  }

  try {
    // 'ping' is treated as a HEAD request — ICMP is not available from a
    // Render web service, and a HEAD is a better liveness signal anyway.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(sys.monitor_endpoint, {
      method: sys.monitor_method === 'ping' ? 'HEAD' : 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'upland-systems-map/1.0 (+health check)' },
    });
    clearTimeout(timer);
    statusCode = res.status;
    ok = res.status >= 200 && res.status < 400;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err.name === 'AbortError' ? `No response within ${TIMEOUT_MS / 1000}s` : err.message;
  }

  return { ok, statusCode, error, responseMs: Date.now() - started };
}

async function record(sys, result) {
  const failures = result.ok ? 0 : (sys.consecutive_failures || 0) + 1;

  await q(
    `INSERT INTO monitor_checks (system_id, ok, status_code, response_ms, error)
     VALUES ($1,$2,$3,$4,$5)`,
    [sys.id, result.ok, result.statusCode, result.responseMs, result.error],
  );

  await q(
    `INSERT INTO system_status
       (system_id, last_ok, last_checked_at, last_response_ms, last_status_code,
        last_error, consecutive_failures)
     VALUES ($1,$2,now(),$3,$4,$5,$6)
     ON CONFLICT (system_id) DO UPDATE SET
       last_ok = EXCLUDED.last_ok,
       last_checked_at = EXCLUDED.last_checked_at,
       last_response_ms = EXCLUDED.last_response_ms,
       last_status_code = EXCLUDED.last_status_code,
       last_error = EXCLUDED.last_error,
       consecutive_failures = EXCLUDED.consecutive_failures`,
    [sys.id, result.ok, result.responseMs, result.statusCode, result.error, failures],
  );

  const health = result.ok ? 'good'
    : failures >= FAILURES_BEFORE_BLOCKED ? 'blocked'
      : failures >= FAILURES_BEFORE_RISK ? 'risk' : 'watch';

  const { rows } = await q(
    `UPDATE systems SET health = $1, health_source = 'monitor', updated_at = now()
      WHERE id = $2 AND health_source <> 'manual'
      RETURNING *`,
    [health, sys.id],
  );

  broadcast({
    type: 'status',
    status: {
      system_id: sys.id,
      last_ok: result.ok,
      last_checked_at: new Date().toISOString(),
      last_response_ms: result.responseMs,
      last_status_code: result.statusCode,
      last_error: result.error,
      consecutive_failures: failures,
    },
  });
  if (rows[0]) broadcast({ type: 'system.upsert', system: rows[0] });
}

let running = false;

async function sweep() {
  if (running) return;             // a slow sweep must not stack on the next tick
  running = true;
  try {
    const rows = await due();
    if (!rows.length) return;
    // Small concurrency cap so one sweep cannot exhaust the instance.
    const queue = [...rows];
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length) {
        const sys = queue.shift();
        const result = await checkOne(sys);
        if (result) await record(sys, result).catch((e) => console.error('[monitor]', e.message));
      }
    });
    await Promise.all(workers);
    console.log(`[monitor] checked ${rows.length} system(s)`);
  } catch (err) {
    console.error('[monitor] sweep failed:', err.message);
  } finally {
    running = false;
  }
}

export function startMonitor() {
  if (process.env.MONITOR_ENABLED === 'false') {
    console.log('[monitor] disabled by MONITOR_ENABLED=false');
    return;
  }
  console.log(`[monitor] sweeping every ${SWEEP_MS / 1000}s (idle until a system has an endpoint)`);
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref?.();
  setTimeout(sweep, 5_000);
}
