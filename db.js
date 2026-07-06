const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || 'miniapp.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    manager_phone       TEXT PRIMARY KEY,
    step                TEXT NOT NULL DEFAULT 'IDLE',
    last_request_type   TEXT,
    last_intent_json    TEXT,
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

  CREATE TABLE IF NOT EXISTS action_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,
    payload       TEXT NOT NULL,
    manager_phone TEXT NOT NULL,
    company_id    TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    actioned_by   TEXT,
    actioned_note TEXT,
    created_at    INTEGER NOT NULL,
    actioned_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS logbook_entries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id       TEXT,
    employee_name_raw TEXT,
    manager_phone     TEXT NOT NULL,
    company_id        TEXT,
    body              TEXT NOT NULL,
    tags              TEXT NOT NULL DEFAULT '[]',
    source_message_id INTEGER,
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS employees (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT,
    email       TEXT,
    title       TEXT,
    company_id  TEXT,
    snapshot_at INTEGER
  );
`);

function now() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }

// ----------------------------------------------------------------- sessions
function getSession(phone) {
  return db.prepare('SELECT * FROM sessions WHERE manager_phone = ?').get(phone) || null;
}

function upsertSession(s) {
  db.prepare(`
    INSERT INTO sessions (manager_phone, step, last_request_type, last_intent_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(manager_phone) DO UPDATE SET
      step               = excluded.step,
      last_request_type  = excluded.last_request_type,
      last_intent_json   = excluded.last_intent_json,
      updated_at         = excluded.updated_at
  `).run(s.manager_phone, s.step, s.last_request_type ?? null, s.last_intent_json ?? null, now());
}

function deleteSession(phone) {
  db.prepare('DELETE FROM sessions WHERE manager_phone = ?').run(phone);
}

function listSessions() {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
}

// ----------------------------------------------------------------- message_log
function logMessage({ phone, direction, body, parsed, stepBefore, stepAfter }) {
  return db.prepare(`
    INSERT INTO message_log (manager_phone, direction, body, parsed_json, step_before, step_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    phone, direction, body ?? null, parsed ? JSON.stringify(parsed) : null,
    stepBefore ?? null, stepAfter ?? null, now(),
  ).lastInsertRowid;
}

function recentLog(limit = 100) {
  return db.prepare('SELECT * FROM message_log ORDER BY id DESC LIMIT ?').all(limit);
}

// ----------------------------------------------------------------- action_queue
function enqueueAction({ type, payload, managerPhone, companyId }) {
  db.prepare(`
    INSERT INTO action_queue (type, payload, manager_phone, company_id, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(type, JSON.stringify(payload), managerPhone, companyId ?? null, nowMs());
}

function getQueue(status, companyId) {
  if (status && companyId) {
    return db.prepare('SELECT * FROM action_queue WHERE status = ? AND company_id = ? ORDER BY created_at DESC').all(status, companyId);
  }
  if (status) {
    return db.prepare('SELECT * FROM action_queue WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  if (companyId) {
    return db.prepare('SELECT * FROM action_queue WHERE company_id = ? ORDER BY created_at DESC').all(companyId);
  }
  return db.prepare('SELECT * FROM action_queue ORDER BY created_at DESC').all();
}

function getQueueItem(id) {
  return db.prepare('SELECT * FROM action_queue WHERE id = ?').get(id) || null;
}

function markActioned(id, { actionedBy, note }) {
  db.prepare(`
    UPDATE action_queue SET status = 'actioned', actioned_by = ?, actioned_note = ?, actioned_at = ?
    WHERE id = ?
  `).run(actionedBy ?? null, note ?? null, nowMs(), id);
}

// ----------------------------------------------------------------- logbook_entries
function addLogbookEntry({ employeeId, employeeNameRaw, managerPhone, companyId, body, tags, sourceMessageId }) {
  db.prepare(`
    INSERT INTO logbook_entries
      (employee_id, employee_name_raw, manager_phone, company_id, body, tags, source_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employeeId ?? null, employeeNameRaw ?? null, managerPhone,
    companyId ?? null, body, JSON.stringify(tags || []),
    sourceMessageId ?? null, nowMs(),
  );
}

function getLogbook(companyId) {
  if (companyId) {
    return db.prepare('SELECT * FROM logbook_entries WHERE company_id = ? ORDER BY created_at DESC').all(companyId);
  }
  return db.prepare('SELECT * FROM logbook_entries ORDER BY created_at DESC').all();
}

// Normalize any US phone format to E.164 (+1XXXXXXXXXX) for consistent storage/lookup.
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone; // return as-is if we can't normalize
}

// ----------------------------------------------------------------- employees (snapshot)
function ingestSnapshot(employees) {
  const replace = db.prepare(`
    INSERT OR REPLACE INTO employees (id, name, phone, email, title, company_id, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const ts = nowMs();
  db.transaction((rows) => {
    for (const e of rows) {
      replace.run(e.id, e.name, normalizePhone(e.phone), e.email ?? null, e.title ?? null, e.company_id ?? null, ts);
    }
  })(employees || []);
}

function findEmployee(name, companyId) {
  const candidates = findEmployeeCandidates(name, companyId);
  return candidates.length === 1 ? candidates[0] : null;
}

function findEmployeeCandidates(name, companyId) {
  if (!name) return [];
  const lower = name.toLowerCase().trim();
  let all = db.prepare('SELECT * FROM employees').all();
  if (companyId) all = all.filter(e => e.company_id === companyId);
  const exact = all.filter(e => e.name.toLowerCase() === lower);
  if (exact.length > 0) return exact;
  const first = lower.split(/\s+/)[0];
  return all.filter(e => e.name.toLowerCase().split(/\s+/)[0] === first);
}

function getCompanyByPhone(phone) {
  const normalized = normalizePhone(phone);
  const row = db.prepare('SELECT company_id FROM employees WHERE phone = ?').get(normalized);
  return row ? row.company_id : null;
}

module.exports = {
  db,
  getSession, upsertSession, deleteSession, listSessions,
  logMessage, recentLog,
  enqueueAction, getQueue, getQueueItem, markActioned,
  addLogbookEntry, getLogbook,
  ingestSnapshot, findEmployee, findEmployeeCandidates, getCompanyByPhone,
};
