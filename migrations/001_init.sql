-- Upland Systems Map — initial schema
-- Everything here is additive and idempotent so it is safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- people

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  email_lower   text GENERATED ALWAYS AS (lower(email)) STORED,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer','editor','admin')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (email_lower);

CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------- the map

CREATE TABLE IF NOT EXISTS systems (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  domain           text NOT NULL
                     CHECK (domain IN ('network','building','care','sales',
                                       'resident','ops','security','safety','data')),
  vendor           text NOT NULL DEFAULT '',
  owner            text NOT NULL DEFAULT '',
  capability       text NOT NULL DEFAULT '',
  standard         text NOT NULL DEFAULT '',
  lifecycle        text NOT NULL DEFAULT 'proposed'
                     CHECK (lifecycle IN ('proposed','evaluating','approved','procured',
                                          'installed','commissioned','live','retired')),
  health           text NOT NULL DEFAULT 'unset'
                     CHECK (health IN ('good','watch','risk','blocked','unset')),
  criticality      text NOT NULL DEFAULT 'standard'
                     CHECK (criticality IN ('standard','high','critical')),
  notes            text NOT NULL DEFAULT '',
  -- monitoring: the spec travels with the system record whether or not
  -- anything is polling it yet
  monitor_method   text NOT NULL DEFAULT 'none'
                     CHECK (monitor_method IN ('none','http','ping','agent')),
  monitor_endpoint text NOT NULL DEFAULT '',
  monitor_interval integer,
  -- Who owns the health rating.
  --   'auto'    nobody has claimed it — the poller may take it over (default)
  --   'manual'  a person set it in the inspector; the poller must not touch it
  --   'monitor' the poller set it from a real check
  -- Before anything is installed, health is a design judgement. Once a system
  -- is live and reachable it becomes an uptime fact. This column is how the
  -- same field carries both without one silently overwriting the other.
  health_source    text NOT NULL DEFAULT 'auto'
                     CHECK (health_source IN ('auto','manual','monitor')),
  x                integer NOT NULL DEFAULT 0,
  y                integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS systems_domain_idx    ON systems (domain);
CREATE INDEX IF NOT EXISTS systems_lifecycle_idx ON systems (lifecycle);

CREATE TABLE IF NOT EXISTS links (
  id         text PRIMARY KEY,
  from_id    text NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  to_id      text NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  label      text NOT NULL DEFAULT '',
  protocol   text NOT NULL DEFAULT '',
  direction  text NOT NULL DEFAULT ''
               CHECK (direction IN ('','one','two')),
  health     text NOT NULL DEFAULT 'unset'
               CHECK (health IN ('good','watch','risk','blocked','unset')),
  owner      text NOT NULL DEFAULT '',
  notes      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT links_not_self CHECK (from_id <> to_id)
);
CREATE INDEX IF NOT EXISTS links_from_idx ON links (from_id);
CREATE INDEX IF NOT EXISTS links_to_idx   ON links (to_id);

-- ------------------------------------------------------------ monitoring

CREATE TABLE IF NOT EXISTS monitor_checks (
  id          bigserial PRIMARY KEY,
  system_id   text NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  status_code integer,
  response_ms integer,
  error       text
);
CREATE INDEX IF NOT EXISTS monitor_checks_system_time_idx
  ON monitor_checks (system_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS system_status (
  system_id            text PRIMARY KEY REFERENCES systems(id) ON DELETE CASCADE,
  last_ok              boolean,
  last_checked_at      timestamptz,
  last_response_ms     integer,
  last_status_code     integer,
  last_error           text,
  consecutive_failures integer NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- audit

CREATE TABLE IF NOT EXISTS audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  user_email text NOT NULL DEFAULT '',
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text NOT NULL,
  changes   jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx     ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id);
