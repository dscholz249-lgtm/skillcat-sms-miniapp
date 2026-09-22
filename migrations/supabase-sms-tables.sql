-- SMS miniapp durability tables
-- Run this once in the Supabase SQL editor for the SkillCat Logbook project.
-- These are the write-through targets for logbook_entries, technician_media,
-- and message_log. SQLite remains the operational store; Supabase is the
-- durable backup that re-seeds SQLite after a Railway container restart.

-- ----------------------------------------------------------------- logbook entries
CREATE TABLE IF NOT EXISTS sms_logbook_entries (
  id                BIGINT PRIMARY KEY,       -- mirrors SQLite autoincrement id
  employee_id       TEXT,
  employee_name_raw TEXT,
  manager_phone     TEXT NOT NULL,
  company_id        TEXT,
  body              TEXT NOT NULL,
  tags              JSONB NOT NULL DEFAULT '[]',
  source_message_id BIGINT,
  created_at        BIGINT NOT NULL,          -- unix ms, matches SQLite
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_logbook_company_id  ON sms_logbook_entries (company_id);
CREATE INDEX IF NOT EXISTS idx_sms_logbook_created_at  ON sms_logbook_entries (created_at DESC);

-- ----------------------------------------------------------------- technician media
CREATE TABLE IF NOT EXISTS sms_technician_media (
  id                  BIGINT PRIMARY KEY,
  technician_id       TEXT,
  technician_name     TEXT,
  technician_phone    TEXT NOT NULL,
  company_id          TEXT,
  media_url           TEXT NOT NULL,
  media_content_type  TEXT,
  caption             TEXT,
  created_at          BIGINT NOT NULL,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_media_company_id    ON sms_technician_media (company_id);
CREATE INDEX IF NOT EXISTS idx_sms_media_technician_id ON sms_technician_media (technician_id);
CREATE INDEX IF NOT EXISTS idx_sms_media_created_at    ON sms_technician_media (created_at DESC);

-- ----------------------------------------------------------------- message log
CREATE TABLE IF NOT EXISTS sms_message_log (
  id            BIGINT PRIMARY KEY,
  manager_phone TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body          TEXT,
  parsed_json   JSONB,
  step_before   TEXT,
  step_after    TEXT,
  created_at    TEXT NOT NULL,               -- ISO string, matches SQLite
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_phone      ON sms_message_log (manager_phone);
CREATE INDEX IF NOT EXISTS idx_sms_messages_created_at ON sms_message_log (created_at DESC);

-- ----------------------------------------------------------------- broadcasts
CREATE TABLE IF NOT EXISTS sms_broadcasts (
  id              BIGINT PRIMARY KEY,
  body            TEXT NOT NULL,
  sent_by         TEXT NOT NULL,
  filter_json     JSONB,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at      BIGINT NOT NULL,
  completed_at    BIGINT,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_broadcasts_created_at ON sms_broadcasts (created_at DESC);

CREATE TABLE IF NOT EXISTS sms_broadcast_recipients (
  id             BIGINT PRIMARY KEY,
  broadcast_id   BIGINT NOT NULL,
  employee_id    TEXT,
  phone          TEXT NOT NULL,
  name           TEXT,
  company_id     TEXT,
  company_name   TEXT,
  status         TEXT NOT NULL,
  twilio_sid     TEXT,
  error_code     TEXT,
  message_log_id BIGINT,
  sent_at        BIGINT,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_broadcast_recipients_bid ON sms_broadcast_recipients (broadcast_id);

-- ----------------------------------------------------------------- opt-outs
-- Deliberately not a column on the employee snapshot: that table is rebuilt
-- with INSERT OR REPLACE on every company save, which would wipe the flag.
-- Rows are never deleted; a START/UNSTOP sets cleared_at.
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone        TEXT PRIMARY KEY,
  opted_out_at BIGINT NOT NULL,
  cleared_at   BIGINT,
  source       TEXT NOT NULL DEFAULT 'stop_keyword',
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------- RLS
-- The miniapp uses the service role key so these policies don't affect it,
-- but enabling RLS blocks any accidental anon exposure.
ALTER TABLE sms_logbook_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_technician_media      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_message_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_broadcasts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_broadcast_recipients  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_opt_outs              ENABLE ROW LEVEL SECURITY;
