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

-- ----------------------------------------------------------------- RLS
-- The miniapp uses the service role key so these policies don't affect it,
-- but enabling RLS blocks any accidental anon exposure.
ALTER TABLE sms_logbook_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_technician_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_message_log      ENABLE ROW LEVEL SECURITY;
