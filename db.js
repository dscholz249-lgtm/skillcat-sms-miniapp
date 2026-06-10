const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || 'miniapp.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    manager_phone       TEXT PRIMARY KEY,
    company_id          TEXT NOT NULL,
    batch_id            TEXT NOT NULL,
    pending_review_ids  TEXT NOT NULL,
    current_review_id   TEXT,
    pending_readiness   TEXT,
    step                TEXT NOT NULL,
    original_count      INTEGER NOT NULL DEFAULT 0,
    updated_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_phone TEXT NOT NULL,
    direction     TEXT NOT NULL,
    body          TEXT,
    parsed_json   TEXT,
    step_before   TEXT,
    step_after    TEXT,
    created_at    TEXT NOT NULL
  );
`);

function now() { return new Date().toISOString(); }

function getSession(phone) {
  const row = db.prepare('SELECT * FROM sessions WHERE manager_phone = ?').get(phone);
  if (!row) return null;
  return {
    ...row,
    pending_review_ids: JSON.parse(row.pending_review_ids),
  };
}

function upsertSession(s) {
  db.prepare(`
    INSERT INTO sessions (manager_phone, company_id, batch_id, pending_review_ids,
                         current_review_id, pending_readiness, step, original_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(manager_phone) DO UPDATE SET
      company_id         = excluded.company_id,
      batch_id           = excluded.batch_id,
      pending_review_ids = excluded.pending_review_ids,
      current_review_id  = excluded.current_review_id,
      pending_readiness  = excluded.pending_readiness,
      step               = excluded.step,
      original_count     = excluded.original_count,
      updated_at         = excluded.updated_at
  `).run(
    s.manager_phone, s.company_id, s.batch_id,
    JSON.stringify(s.pending_review_ids),
    s.current_review_id ?? null,
    s.pending_readiness ?? null,
    s.step,
    s.original_count,
    now(),
  );
}

function deleteSession(phone) {
  db.prepare('DELETE FROM sessions WHERE manager_phone = ?').run(phone);
}

function listSessions() {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all()
    .map(r => ({ ...r, pending_review_ids: JSON.parse(r.pending_review_ids) }));
}

function logMessage({ phone, direction, body, parsed, stepBefore, stepAfter }) {
  db.prepare(`
    INSERT INTO message_log (manager_phone, direction, body, parsed_json, step_before, step_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(phone, direction, body ?? null, parsed ? JSON.stringify(parsed) : null,
         stepBefore ?? null, stepAfter ?? null, now());
}

function recentLog(limit = 100) {
  return db.prepare('SELECT * FROM message_log ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  db, getSession, upsertSession, deleteSession, listSessions, logMessage, recentLog,
};
