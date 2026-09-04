# Upland Systems Map

The source of truth for every digital system in the Upland retirement village
build — what exists, who owns it, what it connects to, where it is in its
lifecycle, and (once anything is installed) whether it is actually up.

A pan-and-zoom canvas in the browser, backed by Postgres, with accounts and
roles, live multi-user editing, and an endpoint poller that sits idle until
there is something to poll.

---

## What is in here

```
migrations/001_init.sql   the whole schema, safe to re-run
seed/systems.json         62 systems — the NZ retirement village stack
seed/links.json           72 integrations between them
src/server.js             entry point: migrate, bootstrap, seed, listen
src/db.js                 pool + migration runner
src/auth.js               scrypt passwords, database-backed sessions, roles
src/routes.js             the REST API, with audit logging
src/realtime.js           websocket broadcast + presence
src/monitor.js            the endpoint poller
src/bootstrap.js          first-admin and first-seed, both no-ops after the first run
public/index.html         the canvas
public/login.html         sign in
render.yaml               Render blueprint
```

Three runtime dependencies: `express`, `pg`, `ws`. Passwords use Node's own
`crypto.scrypt`, so there is no native build step and nothing to go wrong in
the Render build.

---

## Deploying to Render

### 1. Put it on GitHub

```bash
cd upland-systems-map
git init
git add .
git commit -m "Upland Systems Map"
git branch -M main
git remote add origin git@github.com:YOUR-ORG/upland-systems-map.git
git push -u origin main
```

Make the repository **private**. It has no secrets in it, but the map will
eventually carry vendor names, endpoints and commercial notes.

### 2. Create the Blueprint on Render

In Render: **New → Blueprint**, choose the repository. It reads `render.yaml`
and proposes one web service and one Postgres database.

Before you click create, set these three values (they are marked `sync: false`
so Render asks you rather than storing them in the repo):

| Variable | Set it to |
|---|---|
| `BOOTSTRAP_ADMIN_EMAIL` | your email |
| `BOOTSTRAP_ADMIN_PASSWORD` | a long password you will change immediately |
| `BOOTSTRAP_ADMIN_NAME` | your name |

Deploy. On first boot the service creates the tables, creates your admin
account, and loads the 62 seeded systems.

### 3. Sign in and clean up

Open the service URL, sign in, then **delete `BOOTSTRAP_ADMIN_PASSWORD` from
the Render environment**. It is only read when the users table is empty, but
there is no reason to leave a password sitting in a dashboard.

### 4. Add your team

As an admin you can create accounts through the API:

```bash
curl -X POST https://YOUR-APP.onrender.com/api/users \
  -H 'content-type: application/json' \
  -b 'upland_sid=YOUR-SESSION-COOKIE' \
  -d '{"email":"someone@upland.co.nz","name":"Their Name","role":"editor","password":"a-long-starter-password"}'
```

Or, from a Render shell on a paid instance:

```bash
npm run create-user -- someone@upland.co.nz "Their Name" editor 'a-long-starter-password'
```

**Roles.** `viewer` reads the map and nothing else — the right level for the
construction team, consultants and vendors. `editor` can change systems and
links. `admin` can also manage accounts.

---

## About the plans — read this before it becomes your source of truth

`render.yaml` asks for **`basic-256mb`** Postgres and a **`starter`** web
service on purpose.

- **Render's free Postgres is deleted 30 days after it is created.** There is a
  14-day grace period to upgrade, then it is gone. It is fine for a look, and
  completely wrong for the system of record for a $400m build.
- **Free web services spin down after 15 minutes of no traffic.** They wake in
  about a minute on the next request, which is merely annoying — but a
  suspended service is not polling anything, so live monitoring silently stops.

If you want to trial it for free first, change both `plan:` lines to `free`,
and put a calendar reminder at 25 days. Check Render's current pricing before
committing; the numbers move.

---

## Running it locally

You need Postgres and Node 20+.

```bash
cp .env.example .env          # then edit DATABASE_URL and the bootstrap admin
createdb upland
npm install
npm start
```

Open http://localhost:3000. Migrations, the first admin and the seed all run
automatically on boot.

Useful scripts:

```bash
npm run migrate       # apply migrations only
npm run seed          # load seed/*.json (skips anything already there)
npm run create-user -- <email> "<name>" <viewer|editor|admin> <password>
```

---

## How it fits together

### Health means two different things, and the schema knows which

Before anything is installed, a system's health is a **design judgement** —
someone's read on whether it is on track. Once a system is live and reachable,
health is an **uptime fact**. Both live in the same field so the dot on the
canvas always means "how worried should I be", and `health_source` records
which kind it currently is:

- `auto` — nobody has claimed it. The poller may take it over.
- `manual` — a person set it in the inspector. **The poller will not touch it.**
- `monitor` — the poller set it from a real check.

Choosing a health value in the inspector always flips a system to `manual`, so
a human judgement is never silently overwritten by a machine.

### The poller

`src/monitor.js` sweeps every 30 seconds and looks only at systems where
`monitor_method` is not `none` **and** an endpoint is set. Right now that is
nothing, so it does nothing. The day the first system is commissioned, fill in
the method, URL and interval in the inspector and checks begin — no deploy, no
code change.

`http` does a GET, `ping` does a HEAD (ICMP is not available from a Render web
service, and a HEAD is a better liveness signal anyway), and `agent` means the
system reports in itself rather than being polled.

Two consecutive failures move a system to `at risk`, four to `blocked`. Every
check is kept in `monitor_checks`, so `GET /api/systems/:id/checks` gives you
uptime history when you want to draw it.

The poller runs inside the web service. If it ever needs to survive the web
service restarting, move it to a Render Background Worker: add a service to
`render.yaml` with `startCommand: node src/monitor-worker.js`, set
`MONITOR_ENABLED=false` on the web service, and give the worker the same
`DATABASE_URL`.

### Realtime

One websocket room at `/ws`, authenticated with the same session cookie as the
API. Durable changes are broadcast **after** the database commits, so what
appears on someone else's screen is always what is actually stored. Cursors and
presence are relayed and never persisted. Clients reconnect on their own.

Nothing durable is accepted over the socket — every write goes through the REST
API so it is validated, authorised and audited.

### The audit log

Every create, update and delete is written to `audit_log` with who did it and
what changed. Node position changes are excluded, or dragging the canvas around
would drown it. `GET /api/audit?limit=100` reads it back, and
`?entity_id=nurse-call` filters to one system.

---

## API

All endpoints need a session cookie. Write endpoints need `editor` or better.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` |
| POST | `/api/auth/logout` | |
| GET | `/api/auth/me` | current user |
| POST | `/api/auth/password` | `{current, next}`; signs out other sessions |
| GET | `/api/graph` | systems + links + monitor status |
| POST | `/api/systems` | |
| PATCH | `/api/systems/:id` | |
| DELETE | `/api/systems/:id` | cascades to its links |
| POST | `/api/links` | |
| PATCH | `/api/links/:id` | |
| DELETE | `/api/links/:id` | |
| GET | `/api/systems/:id/checks` | last 200 monitor checks |
| GET | `/api/audit` | `?limit=`, `?entity_id=` |
| GET | `/api/users` | admin only |
| POST | `/api/users` | admin only |
| PATCH | `/api/users/:id` | admin only; role, name, is_active |
| GET | `/healthz` | for Render's health check |

---

## Using the map

- **Drag** a system to move it. **Drag from the dot** on its right edge onto
  another system to draw a link.
- **Click** anything to open the inspector on the right.
- **Filter** by domain, lifecycle stage or design health in the left rail; the
  search box matches names, vendors, owners and capability tags.
- **Arrange** re-lays everything out in domain bands. **Fit** zooms to the whole
  estate. **Export** downloads the entire map as JSON, including the open checks.
- **Checks** in the left rail run continuously: systems with no owner, systems
  with no links, business-critical systems with fewer than two links, life-safety
  systems not marked critical, links missing a protocol or direction, systems
  live but unrated, monitors with no endpoint, and two systems claiming the same
  capability tag. Click one to jump to it.

### A note for whoever inherits this

The life-safety links — fire alarm to door release, to lift homing, to smoke
control — are drawn as hard-wired on purpose. They are regulated paths that must
work with the network down. There is a separate, deliberately read-only link
from the fire alarm into the event bus so dashboards can see state. Do not let
anyone collapse those into a single IP integration because it looks tidier on
the map.
