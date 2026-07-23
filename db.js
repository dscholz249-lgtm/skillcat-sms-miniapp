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
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    phone        TEXT,
    email        TEXT,
    title        TEXT,
    company_id   TEXT,
    company_name TEXT,
    snapshot_at  INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS technician_media (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    technician_id       TEXT,
    technician_name     TEXT,
    technician_phone    TEXT NOT NULL,
    company_id          TEXT,
    media_url           TEXT NOT NULL,
    media_content_type  TEXT,
    caption             TEXT,
    created_at          INTEGER NOT NULL
  );
`);

// Safe migrations for existing databases
try { db.exec('ALTER TABLE employees ADD COLUMN company_name TEXT'); } catch (_) {}

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

function getQueue(status, companyId, managerPhone) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (companyId) { conditions.push('company_id = ?'); params.push(companyId); }
  if (managerPhone) { conditions.push('manager_phone = ?'); params.push(managerPhone); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM action_queue ${where} ORDER BY created_at DESC`).all(...params);
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

function getLogbook(companyId, managerPhone, technicianId) {
  const conditions = [];
  const params = [];
  if (companyId) { conditions.push('company_id = ?'); params.push(companyId); }
  if (technicianId) {
    // Technician's own entries only — manager_phone = '' marks technician-originated entries
    conditions.push("employee_id = ? AND manager_phone = ''");
    params.push(technicianId);
  } else if (managerPhone) {
    // Manager's own entries + technician-originated entries (visible company-wide)
    conditions.push("(manager_phone = ? OR manager_phone = '')");
    params.push(managerPhone);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM logbook_entries ${where} ORDER BY created_at DESC`).all(...params);
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
    INSERT OR REPLACE INTO employees (id, name, phone, email, title, company_id, company_name, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ts = nowMs();
  db.transaction((rows) => {
    for (const e of rows) {
      replace.run(e.id, e.name, normalizePhone(e.phone), e.email ?? null, e.title ?? null, e.company_id ?? null, e.company_name ?? null, ts);
    }
  })(employees || []);
}

function getManagerInfoByPhone(phone) {
  const normalized = normalizePhone(phone);
  return db.prepare(
    "SELECT name, company_id, company_name FROM employees WHERE phone = ? AND title = 'Manager' LIMIT 1"
  ).get(normalized) || null;
}

function getTechnicianByPhone(phone) {
  const normalized = normalizePhone(phone);
  return db.prepare(
    "SELECT * FROM employees WHERE phone = ? AND title != 'Manager' LIMIT 1"
  ).get(normalized) || null;
}

function addTechnicianMedia({ technicianId, technicianName, technicianPhone, companyId, mediaUrl, mediaContentType, caption }) {
  return db.prepare(`
    INSERT INTO technician_media (technician_id, technician_name, technician_phone, company_id, media_url, media_content_type, caption, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(technicianId ?? null, technicianName ?? null, technicianPhone, companyId ?? null, mediaUrl, mediaContentType ?? null, caption ?? null, nowMs());
}

function getTechnicianMedia(companyId, technicianId, technicianPhone) {
  let query = 'SELECT * FROM technician_media WHERE 1=1';
  const params = [];
  if (companyId) { query += ' AND company_id = ?'; params.push(companyId); }
  if (technicianId && technicianPhone) {
    // Match by ID or by phone (covers legacy rows stored before the ID bug was fixed)
    query += ' AND (technician_id = ? OR technician_phone = ?)';
    params.push(technicianId, technicianPhone);
  } else if (technicianId) {
    query += ' AND technician_id = ?';
    params.push(technicianId);
  } else if (technicianPhone) {
    query += ' AND technician_phone = ?';
    params.push(technicianPhone);
  }
  query += ' ORDER BY created_at DESC';
  return db.prepare(query).all(...params);
}

function getManagersByCompanyId(companyId) {
  return db.prepare(
    "SELECT * FROM employees WHERE company_id = ? AND title = 'Manager' AND phone IS NOT NULL AND phone != ''"
  ).all(companyId);
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

// ----------------------------------------------------------------- analytics
function getAnalytics(companyId, managerPhonesStr) {
  const phones = managerPhonesStr
    ? managerPhonesStr.split(',').map(p => p.trim()).filter(Boolean)
    : [];

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // Build IN placeholder for dynamic phone lists
  const ph = phones.length ? phones.map(() => '?').join(',') : null;

  let messagesByDay = [];
  if (ph) {
    messagesByDay = db.prepare(`
      SELECT
        substr(created_at, 1, 10) AS date,
        SUM(CASE WHEN direction = 'in'  THEN 1 ELSE 0 END) AS inbound,
        SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outbound
      FROM message_log
      WHERE manager_phone IN (${ph})
        AND substr(created_at, 1, 10) >= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY date ASC
    `).all(...phones, thirtyDaysAgo);
  }

  let requestsByType = [];
  if (companyId) {
    requestsByType = db.prepare(`
      SELECT type, COUNT(*) AS total,
        SUM(CASE WHEN status = 'actioned' THEN 1 ELSE 0 END) AS actioned
      FROM action_queue WHERE company_id = ?
      GROUP BY type ORDER BY total DESC
    `).all(companyId);
  }

  let dau = 0;
  if (ph) {
    dau = db.prepare(`
      SELECT COUNT(DISTINCT manager_phone) AS count FROM message_log
      WHERE direction = 'in' AND manager_phone IN (${ph}) AND substr(created_at, 1, 10) = ?
    `).get(...phones, today)?.count ?? 0;
  }

  let mau = 0;
  if (ph) {
    mau = db.prepare(`
      SELECT COUNT(DISTINCT manager_phone) AS count FROM message_log
      WHERE direction = 'in' AND manager_phone IN (${ph}) AND substr(created_at, 1, 10) >= ?
    `).get(...phones, thirtyDaysAgo)?.count ?? 0;
  }

  // Cohort retention across all company managers
  let retention = { total_managers: 0, day_2: null, day_7: null, day_30: null };
  if (ph) {
    const retRow = db.prepare(`
      WITH cohorts AS (
        SELECT manager_phone, MIN(substr(created_at,1,10)) AS cohort_date
        FROM message_log WHERE direction = 'in' AND manager_phone IN (${ph})
        GROUP BY manager_phone
      ),
      activity AS (
        SELECT DISTINCT manager_phone, substr(created_at,1,10) AS activity_date
        FROM message_log WHERE direction = 'in' AND manager_phone IN (${ph})
      )
      SELECT
        COUNT(DISTINCT c.manager_phone) AS total,
        COUNT(DISTINCT CASE WHEN julianday(a.activity_date) - julianday(c.cohort_date) >= 2  THEN c.manager_phone END) AS retained_2d,
        COUNT(DISTINCT CASE WHEN julianday(a.activity_date) - julianday(c.cohort_date) >= 7  THEN c.manager_phone END) AS retained_7d,
        COUNT(DISTINCT CASE WHEN julianday(a.activity_date) - julianday(c.cohort_date) >= 30 THEN c.manager_phone END) AS retained_30d
      FROM cohorts c LEFT JOIN activity a ON c.manager_phone = a.manager_phone
    `).get(...phones, ...phones);
    const total = retRow?.total ?? 0;
    const pct = n => total > 0 ? Math.round((n / total) * 100) : null;
    retention = {
      total_managers: total,
      day_2:  pct(retRow?.retained_2d  ?? 0),
      day_7:  pct(retRow?.retained_7d  ?? 0),
      day_30: pct(retRow?.retained_30d ?? 0),
    };
  }

  return {
    messages_by_day: messagesByDay,
    requests_by_type: requestsByType,
    totals: {
      inbound_messages:  messagesByDay.reduce((s, r) => s + r.inbound,  0),
      outbound_messages: messagesByDay.reduce((s, r) => s + r.outbound, 0),
      requests_total:    requestsByType.reduce((s, r) => s + r.total,    0),
      requests_actioned: requestsByType.reduce((s, r) => s + r.actioned, 0),
    },
    dau,
    mau,
    retention,
  };
}

function getGlobalAnalytics() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const dau = db.prepare(`
    SELECT COUNT(DISTINCT manager_phone) AS count FROM message_log
    WHERE direction = 'in' AND substr(created_at, 1, 10) = ?
  `).get(today)?.count ?? 0;

  const mau = db.prepare(`
    SELECT COUNT(DISTINCT manager_phone) AS count FROM message_log
    WHERE direction = 'in' AND substr(created_at, 1, 10) >= ?
  `).get(thirtyDaysAgo)?.count ?? 0;

  const dauTrend = db.prepare(`
    SELECT substr(created_at, 1, 10) AS date, COUNT(DISTINCT manager_phone) AS unique_users
    FROM message_log
    WHERE direction = 'in' AND substr(created_at, 1, 10) >= ?
    GROUP BY date ORDER BY date ASC
  `).all(thirtyDaysAgo);

  const requestsByType = db.prepare(`
    SELECT type, COUNT(*) AS total,
      SUM(CASE WHEN status = 'actioned' THEN 1 ELSE 0 END) AS actioned
    FROM action_queue GROUP BY type ORDER BY total DESC
  `).all();

  const retRow = db.prepare(`
    WITH cohorts AS (
      SELECT manager_phone, MIN(substr(created_at,1,10)) AS cohort_date
      FROM message_log WHERE direction = 'in' GROUP BY manager_phone
    ),
    activity AS (
      SELECT DISTINCT manager_phone, substr(created_at,1,10) AS activity_date
      FROM message_log WHERE direction = 'in'
    )
    SELECT
      COUNT(DISTINCT c.manager_phone) AS total,
      COUNT(DISTINCT CASE WHEN julianday(a.activity_date) - julianday(c.cohort_date) >= 2  THEN c.manager_phone END) AS retained_2d,
      COUNT(DISTINCT CASE WHEN julianday(a.activity_date) - julianday(c.cohort_date) >= 7  THEN c.manager_phone END) AS retained_7d,
      COUNT(DISTINCT CASE WHEN julianday(a.activity_date) - julianday(c.cohort_date) >= 30 THEN c.manager_phone END) AS retained_30d
    FROM cohorts c LEFT JOIN activity a ON c.manager_phone = a.manager_phone
  `).get();

  const total = retRow?.total ?? 0;
  const pct = (n) => total > 0 ? Math.round((n / total) * 100) : null;

  return {
    dau,
    mau,
    dau_trend: dauTrend,
    requests_by_type: requestsByType,
    retention: {
      total_managers: total,
      day_2:  pct(retRow?.retained_2d  ?? 0),
      day_7:  pct(retRow?.retained_7d  ?? 0),
      day_30: pct(retRow?.retained_30d ?? 0),
    },
  };
}

// Returns the most recent inbound message timestamp for each phone in the list.
// Covers both managers and technicians — message_log captures all inbound SMS/MMS.
function getLastActiveByPhones(phones) {
  if (!phones || phones.length === 0) return [];
  const ph = phones.map(() => '?').join(',');
  return db.prepare(`
    SELECT manager_phone AS phone, MAX(created_at) AS last_active_at
    FROM message_log
    WHERE direction = 'in'
      AND manager_phone IN (${ph})
    GROUP BY manager_phone
  `).all(...phones);
}

module.exports = {
  db,
  getSession, upsertSession, deleteSession, listSessions,
  logMessage, recentLog,
  enqueueAction, getQueue, getQueueItem, markActioned,
  addLogbookEntry, getLogbook,
  ingestSnapshot, findEmployee, findEmployeeCandidates, getCompanyByPhone, getManagerInfoByPhone,
  getTechnicianByPhone, addTechnicianMedia, getTechnicianMedia, getManagersByCompanyId,
  getAnalytics, getGlobalAnalytics, getLastActiveByPhones,
};
