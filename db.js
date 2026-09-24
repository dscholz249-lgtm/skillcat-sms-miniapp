const Database = require('better-sqlite3');
const { upsert, select, configured: supabaseConfigured } = require('./lib/supabase');

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

db.exec(`
  CREATE TABLE IF NOT EXISTS phone_link_requests (
    token       TEXT PRIMARY KEY,
    phone       TEXT NOT NULL,
    email       TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    company_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    company_id TEXT,
    metadata   TEXT,
    read_at    INTEGER,
    created_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS broadcasts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    body            TEXT NOT NULL,
    sent_by         TEXT NOT NULL,
    filter_json     TEXT,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'sending',
    idempotency_key TEXT UNIQUE,
    created_at      INTEGER NOT NULL,
    completed_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS broadcast_recipients (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id   INTEGER NOT NULL,
    employee_id    TEXT,
    phone          TEXT NOT NULL,
    name           TEXT,
    company_id     TEXT,
    company_name   TEXT,
    status         TEXT NOT NULL DEFAULT 'queued',
    twilio_sid     TEXT,
    error_code     TEXT,
    message_log_id INTEGER,
    sent_at        INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_bid
    ON broadcast_recipients (broadcast_id);

  -- Opt-outs live in their own table, NOT on employees: ingestSnapshot() uses
  -- INSERT OR REPLACE, which would silently null out any column it doesn't
  -- list every time a company is saved in the dashboard.
  -- Rows are never deleted (the Supabase mirror is upsert-only) — a START/UNSTOP
  -- sets cleared_at instead, and "opted out" means cleared_at IS NULL.
  CREATE TABLE IF NOT EXISTS sms_opt_outs (
    phone         TEXT PRIMARY KEY,
    opted_out_at  INTEGER NOT NULL,
    cleared_at    INTEGER,
    source        TEXT NOT NULL DEFAULT 'stop_keyword',
    email_sent_at INTEGER
  );
`);

// Safe migrations for existing databases
try { db.exec('ALTER TABLE employees ADD COLUMN company_name TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE sms_opt_outs ADD COLUMN email_sent_at INTEGER'); } catch (_) {}

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
  const createdAt = now();
  const result = db.prepare(`
    INSERT INTO message_log (manager_phone, direction, body, parsed_json, step_before, step_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    phone, direction, body ?? null, parsed ? JSON.stringify(parsed) : null,
    stepBefore ?? null, stepAfter ?? null, createdAt,
  );
  upsert('sms_message_log', {
    id: Number(result.lastInsertRowid),
    manager_phone: phone,
    direction,
    body: body ?? null,
    parsed_json: parsed ?? null,
    step_before: stepBefore ?? null,
    step_after: stepAfter ?? null,
    created_at: createdAt,
  });
  return result.lastInsertRowid;
}

function recentLog(limit = 100) {
  return db.prepare('SELECT * FROM message_log ORDER BY id DESC LIMIT ?').all(limit);
}

function getMessagesByPhones(phones) {
  if (!phones.length) return [];
  const ph = phones.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, manager_phone, direction, body, step_after, created_at
    FROM message_log
    WHERE manager_phone IN (${ph})
      AND body != '(parsed)'
    ORDER BY created_at ASC
  `).all(...phones);
}

// ----------------------------------------------------------------- opt-outs
function recordOptOut(phone, source = 'stop_keyword') {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const optedOutAt = nowMs();
  db.prepare(`
    INSERT INTO sms_opt_outs (phone, opted_out_at, cleared_at, source)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT(phone) DO UPDATE SET
      opted_out_at = excluded.opted_out_at,
      cleared_at   = NULL,
      source       = excluded.source
  `).run(normalized, optedOutAt, source);
  upsert('sms_opt_outs', { phone: normalized, opted_out_at: optedOutAt, cleared_at: null, source });
  console.log(`[opt-out] ${normalized} opted out (${source})`);
}

function clearOptOut(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const row = db.prepare('SELECT * FROM sms_opt_outs WHERE phone = ?').get(normalized);
  if (!row || row.cleared_at !== null) return;
  const clearedAt = nowMs();
  // email_sent_at resets too: if they opt out again later, that is a new event
  // and deserves a new notification.
  db.prepare('UPDATE sms_opt_outs SET cleared_at = ?, email_sent_at = NULL WHERE phone = ?')
    .run(clearedAt, normalized);
  upsert('sms_opt_outs', { ...row, phone: normalized, cleared_at: clearedAt, email_sent_at: null });
  console.log(`[opt-out] ${normalized} opted back in`);
}

function getOptOut(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return db.prepare('SELECT * FROM sms_opt_outs WHERE phone = ?').get(normalized) || null;
}

function markOptOutEmailSent(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const sentAt = nowMs();
  db.prepare('UPDATE sms_opt_outs SET email_sent_at = ? WHERE phone = ?').run(sentAt, normalized);
  const row = db.prepare('SELECT * FROM sms_opt_outs WHERE phone = ?').get(normalized);
  if (row) upsert('sms_opt_outs', row);
}

// Role-agnostic lookup — the opt-out flow has to reach technicians and
// managers alike, and the existing helpers are split by title.
function getEmployeeByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return db.prepare('SELECT * FROM employees WHERE phone = ? LIMIT 1').get(normalized) || null;
}

// Returns the subset of `phones` that are currently opted out (normalized).
function getOptedOutPhones(phones) {
  const normalized = (phones || []).map(normalizePhone).filter(Boolean);
  if (!normalized.length) return [];
  const ph = normalized.map(() => '?').join(',');
  return db.prepare(`
    SELECT phone FROM sms_opt_outs
    WHERE phone IN (${ph}) AND cleared_at IS NULL
  `).all(...normalized).map(r => r.phone);
}

// ----------------------------------------------------------------- broadcasts
function getBroadcastByIdempotencyKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM broadcasts WHERE idempotency_key = ?').get(key) || null;
}

// Creates the broadcast and its recipient rows in one transaction. Opted-out
// numbers are dropped here rather than trusting the caller's list, so the API
// is safe no matter what the dashboard sends.
function createBroadcast({ body, sentBy, filterJson, recipients, idempotencyKey }) {
  const optedOut = new Set(getOptedOutPhones((recipients || []).map(r => r.phone)));
  const seen = new Set();
  const eligible = [];
  for (const r of recipients || []) {
    const phone = normalizePhone(r.phone);
    if (!phone || optedOut.has(phone) || seen.has(phone)) continue;
    seen.add(phone);
    eligible.push({ ...r, phone });
  }

  const createdAt = nowMs();
  const insertBroadcast = db.prepare(`
    INSERT INTO broadcasts (body, sent_by, filter_json, recipient_count, status, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, 'sending', ?, ?)
  `);
  const insertRecipient = db.prepare(`
    INSERT INTO broadcast_recipients
      (broadcast_id, employee_id, phone, name, company_id, company_name, status)
    VALUES (?, ?, ?, ?, ?, ?, 'queued')
  `);

  const run = db.transaction(() => {
    const result = insertBroadcast.run(
      body, sentBy, filterJson ? JSON.stringify(filterJson) : null,
      eligible.length, idempotencyKey ?? null, createdAt,
    );
    const broadcastId = Number(result.lastInsertRowid);
    for (const r of eligible) {
      insertRecipient.run(broadcastId, r.employee_id ?? null, r.phone,
        r.name ?? null, r.company_id ?? null, r.company_name ?? null);
    }
    return broadcastId;
  });

  const broadcastId = run();
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
  mirrorBroadcast(broadcastId);
  // Mirror the queued recipients up front, so an interrupted send is still
  // recoverable from Supabase if the container is replaced mid-drain.
  upsert('sms_broadcast_recipients',
    db.prepare('SELECT * FROM broadcast_recipients WHERE broadcast_id = ?').all(broadcastId));
  return {
    broadcast,
    excluded_opt_out: (recipients || []).length - eligible.length,
  };
}

function getQueuedRecipients(broadcastId) {
  return db.prepare(`
    SELECT * FROM broadcast_recipients
    WHERE broadcast_id = ? AND status = 'queued'
    ORDER BY id ASC
  `).all(broadcastId);
}

function markRecipientSent(id, { twilioSid, messageLogId }) {
  db.prepare(`
    UPDATE broadcast_recipients
    SET status = 'sent', twilio_sid = ?, message_log_id = ?, sent_at = ?
    WHERE id = ?
  `).run(twilioSid ?? null, messageLogId ?? null, nowMs(), id);
  mirrorRecipient(id);
}

function markRecipientFailed(id, errorCode) {
  db.prepare(`
    UPDATE broadcast_recipients
    SET status = 'failed', error_code = ?, sent_at = ?
    WHERE id = ?
  `).run(errorCode ? String(errorCode) : null, nowMs(), id);
  mirrorRecipient(id);
}

function completeBroadcast(broadcastId) {
  const completedAt = nowMs();
  db.prepare("UPDATE broadcasts SET status = 'complete', completed_at = ? WHERE id = ?")
    .run(completedAt, broadcastId);
  mirrorBroadcast(broadcastId);
}

function listBroadcasts(limit = 50) {
  return db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status = 'sent')   AS sent_count,
      (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status = 'failed') AS failed_count,
      (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status = 'queued') AS queued_count
    FROM broadcasts b
    ORDER BY b.created_at DESC
    LIMIT ?
  `).all(limit);
}

function getBroadcast(id) {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!broadcast) return null;
  const recipients = db.prepare(
    'SELECT * FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY name IS NULL, name ASC'
  ).all(id);
  return { ...broadcast, recipients };
}

// Any broadcast still 'sending' at boot was interrupted by a container restart.
// Returns their ids so the caller can resume the queued recipients.
function findInterruptedBroadcasts() {
  return db.prepare("SELECT id FROM broadcasts WHERE status = 'sending' ORDER BY id ASC")
    .all().map(r => r.id);
}

function mirrorBroadcast(id) {
  const row = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  if (!row) return;
  upsert('sms_broadcasts', {
    ...row,
    filter_json: row.filter_json ? JSON.parse(row.filter_json) : null,
  });
}

function mirrorRecipient(id) {
  const row = db.prepare('SELECT * FROM broadcast_recipients WHERE id = ?').get(id);
  if (row) upsert('sms_broadcast_recipients', row);
}

// ----------------------------------------------------------------- action_queue
function enqueueAction({ type, payload, managerPhone, companyId }) {
  db.prepare(`
    INSERT INTO action_queue (type, payload, manager_phone, company_id, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(type, JSON.stringify(payload), managerPhone, companyId ?? null, nowMs());
}

function getQueue(status, companyId, managerPhone) {
  const normalizedPhone = normalizePhone(managerPhone);
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (companyId) { conditions.push('company_id = ?'); params.push(companyId); }
  if (normalizedPhone) { conditions.push('manager_phone = ?'); params.push(normalizedPhone); }
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

function markIgnored(id, { actionedBy, note }) {
  db.prepare(`
    UPDATE action_queue SET status = 'ignored', actioned_by = ?, actioned_note = ?, actioned_at = ?
    WHERE id = ?
  `).run(actionedBy ?? null, note ?? null, nowMs(), id);
}

// ----------------------------------------------------------------- logbook_entries
function addLogbookEntry({ employeeId, employeeNameRaw, managerPhone, companyId, body, tags, sourceMessageId }) {
  const createdAt = nowMs();
  const result = db.prepare(`
    INSERT INTO logbook_entries
      (employee_id, employee_name_raw, manager_phone, company_id, body, tags, source_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employeeId ?? null, employeeNameRaw ?? null, managerPhone,
    companyId ?? null, body, JSON.stringify(tags || []),
    sourceMessageId ?? null, createdAt,
  );
  upsert('sms_logbook_entries', {
    id: Number(result.lastInsertRowid),
    employee_id: employeeId ?? null,
    employee_name_raw: employeeNameRaw ?? null,
    manager_phone: managerPhone,
    company_id: companyId ?? null,
    body,
    tags: tags || [],
    source_message_id: sourceMessageId ?? null,
    created_at: createdAt,
  });
}

function getLogbook(companyId, managerPhone, technicianId, selfOnly = false) {
  const normalizedPhone = normalizePhone(managerPhone);
  const conditions = [];
  const params = [];
  if (companyId) { conditions.push('company_id = ?'); params.push(companyId); }
  if (technicianId) {
    // Technician's own entries only — manager_phone = '' marks technician-originated entries
    conditions.push("employee_id = ? AND manager_phone = ''");
    params.push(technicianId);
  } else if (selfOnly && normalizedPhone) {
    // Manager's own self-submitted entries only (no employee attached)
    conditions.push("manager_phone = ? AND employee_id IS NULL AND employee_name_raw IS NULL");
    params.push(normalizedPhone);
  } else if (normalizedPhone) {
    // Manager's own entries + technician-originated entries (visible company-wide)
    conditions.push("(manager_phone = ? OR manager_phone = '')");
    params.push(normalizedPhone);
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
  const createdAt = nowMs();
  const result = db.prepare(`
    INSERT INTO technician_media (technician_id, technician_name, technician_phone, company_id, media_url, media_content_type, caption, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(technicianId ?? null, technicianName ?? null, technicianPhone, companyId ?? null, mediaUrl, mediaContentType ?? null, caption ?? null, createdAt);
  upsert('sms_technician_media', {
    id: Number(result.lastInsertRowid),
    technician_id: technicianId ?? null,
    technician_name: technicianName ?? null,
    technician_phone: technicianPhone,
    company_id: companyId ?? null,
    media_url: mediaUrl,
    media_content_type: mediaContentType ?? null,
    caption: caption ?? null,
    created_at: createdAt,
  });
  return result;
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
  const phones = (managerPhonesStr
    ? managerPhonesStr.split(',').map(p => p.trim()).filter(Boolean)
    : []).map(normalizePhone).filter(Boolean);

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

// ----------------------------------------------------------------- phone_link_requests
function createPhoneLinkRequest({ token, phone, email, employeeId, companyId }) {
  const createdAt = nowMs();
  const expiresAt = createdAt + 24 * 60 * 60 * 1000; // 24 hours
  db.prepare(`
    INSERT INTO phone_link_requests (token, phone, email, employee_id, company_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(token, phone, email, employeeId, companyId, createdAt, expiresAt);
}

function getPhoneLinkRequest(token) {
  return db.prepare('SELECT * FROM phone_link_requests WHERE token = ?').get(token) || null;
}

function deletePhoneLinkRequest(token) {
  db.prepare('DELETE FROM phone_link_requests WHERE token = ?').run(token);
}

function findEmployeeByEmail(email) {
  if (!email) return null;
  return db.prepare("SELECT * FROM employees WHERE LOWER(email) = LOWER(?) LIMIT 1").get(email) || null;
}

function updateEmployeePhone(employeeId, phone) {
  db.prepare('UPDATE employees SET phone = ? WHERE id = ?').run(phone, employeeId);
}

// ----------------------------------------------------------------- alerts
function createAlert({ type, title, body, companyId = null, metadata = null }) {
  db.prepare(`
    INSERT INTO alerts (type, title, body, company_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(type, title, body, companyId, metadata ? JSON.stringify(metadata) : null, nowMs());
}

function getAlerts(companyId, includeRead = false) {
  if (companyId) {
    const where = includeRead ? 'WHERE company_id = ?' : 'WHERE company_id = ? AND read_at IS NULL';
    return db.prepare(`SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT 50`).all(companyId);
  }
  const where = includeRead ? '' : 'WHERE read_at IS NULL';
  return db.prepare(`SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT 50`).all();
}

function markAlertRead(id) {
  db.prepare('UPDATE alerts SET read_at = ? WHERE id = ?').run(nowMs(), id);
}

// Returns the most recent inbound message timestamp for each phone in the list.
// Covers both managers and technicians — message_log captures all inbound SMS/MMS.
function getLastActiveByPhones(phones) {
  if (!phones || phones.length === 0) return [];
  const normalized = phones.map(normalizePhone).filter(Boolean);
  if (!normalized.length) return [];
  const ph = normalized.map(() => '?').join(',');
  return db.prepare(`
    SELECT manager_phone AS phone, MAX(created_at) AS last_active_at
    FROM message_log
    WHERE direction = 'in'
      AND manager_phone IN (${ph})
    GROUP BY manager_phone
  `).all(...normalized);
}

// ----------------------------------------------------------------- startup seed
// Called once at boot. If a critical SQLite table is empty (fresh container
// after a Railway restart), pulls all rows from Supabase and inserts them.
// Runs synchronously-ish via await so the HTTP server doesn't open until done.
async function seedFromSupabase() {
  if (!supabaseConfigured()) {
    console.log('[seed] Supabase not configured — skipping seed');
    return;
  }

  const logbookCount   = db.prepare('SELECT COUNT(*) AS n FROM logbook_entries').get().n;
  const mediaCount     = db.prepare('SELECT COUNT(*) AS n FROM technician_media').get().n;
  const msgCount       = db.prepare('SELECT COUNT(*) AS n FROM message_log').get().n;
  const broadcastCount = db.prepare('SELECT COUNT(*) AS n FROM broadcasts').get().n;
  const optOutCount    = db.prepare('SELECT COUNT(*) AS n FROM sms_opt_outs').get().n;

  const needs = {
    logbook: logbookCount === 0,
    media: mediaCount === 0,
    messages: msgCount === 0,
    broadcasts: broadcastCount === 0,
    optOuts: optOutCount === 0,
  };
  if (!needs.logbook && !needs.media && !needs.messages && !needs.broadcasts && !needs.optOuts) {
    console.log('[seed] SQLite tables populated — skipping seed');
    return;
  }

  console.log('[seed] Fresh container detected — seeding from Supabase...');

  if (needs.logbook) {
    const rows = await select('sms_logbook_entries', { order: 'created_at.asc' });
    if (rows.length) {
      const ins = db.prepare(`
        INSERT OR IGNORE INTO logbook_entries
          (id, employee_id, employee_name_raw, manager_phone, company_id, body, tags, source_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rs) => {
        for (const r of rs) {
          ins.run(r.id, r.employee_id, r.employee_name_raw, r.manager_phone,
            r.company_id, r.body, JSON.stringify(r.tags ?? []), r.source_message_id, r.created_at);
        }
      })(rows);
      console.log(`[seed] logbook_entries: ${rows.length} rows restored`);
    }
  }

  if (needs.media) {
    const rows = await select('sms_technician_media', { order: 'created_at.asc' });
    if (rows.length) {
      const ins = db.prepare(`
        INSERT OR IGNORE INTO technician_media
          (id, technician_id, technician_name, technician_phone, company_id, media_url, media_content_type, caption, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rs) => {
        for (const r of rs) {
          ins.run(r.id, r.technician_id, r.technician_name, r.technician_phone,
            r.company_id, r.media_url, r.media_content_type, r.caption, r.created_at);
        }
      })(rows);
      console.log(`[seed] technician_media: ${rows.length} rows restored`);
    }
  }

  if (needs.messages) {
    // Cap message log seed at 10 000 most recent rows to keep startup fast.
    const rows = await select('sms_message_log', { order: 'created_at.desc', limit: 10000 });
    if (rows.length) {
      const ins = db.prepare(`
        INSERT OR IGNORE INTO message_log
          (id, manager_phone, direction, body, parsed_json, step_before, step_after, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rs) => {
        for (const r of rs) {
          ins.run(r.id, r.manager_phone, r.direction, r.body,
            r.parsed_json ? JSON.stringify(r.parsed_json) : null,
            r.step_before, r.step_after, r.created_at);
        }
      })(rows);
      console.log(`[seed] message_log: ${rows.length} rows restored`);
    }
  }

  // Opt-outs are restored first and unconditionally — sending to someone who
  // texted STOP because their row was still in flight is the one mistake here
  // that cannot be walked back.
  if (needs.optOuts) {
    const rows = await select('sms_opt_outs', { order: 'opted_out_at.asc' });
    if (rows.length) {
      const ins = db.prepare(`
        INSERT OR IGNORE INTO sms_opt_outs (phone, opted_out_at, cleared_at, source, email_sent_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      db.transaction((rs) => {
        for (const r of rs) {
          ins.run(r.phone, r.opted_out_at, r.cleared_at ?? null, r.source, r.email_sent_at ?? null);
        }
      })(rows);
      console.log(`[seed] sms_opt_outs: ${rows.length} rows restored`);
    }
  }

  if (needs.broadcasts) {
    const rows = await select('sms_broadcasts', { order: 'created_at.asc' });
    if (rows.length) {
      const ins = db.prepare(`
        INSERT OR IGNORE INTO broadcasts
          (id, body, sent_by, filter_json, recipient_count, status, idempotency_key, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rs) => {
        for (const r of rs) {
          ins.run(r.id, r.body, r.sent_by,
            r.filter_json ? JSON.stringify(r.filter_json) : null,
            r.recipient_count, r.status, r.idempotency_key, r.created_at, r.completed_at);
        }
      })(rows);
      console.log(`[seed] broadcasts: ${rows.length} rows restored`);
    }

    const recipientRows = await select('sms_broadcast_recipients', { order: 'id.asc' });
    if (recipientRows.length) {
      const ins = db.prepare(`
        INSERT OR IGNORE INTO broadcast_recipients
          (id, broadcast_id, employee_id, phone, name, company_id, company_name,
           status, twilio_sid, error_code, message_log_id, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rs) => {
        for (const r of rs) {
          ins.run(r.id, r.broadcast_id, r.employee_id, r.phone, r.name, r.company_id,
            r.company_name, r.status, r.twilio_sid, r.error_code, r.message_log_id, r.sent_at);
        }
      })(recipientRows);
      console.log(`[seed] broadcast_recipients: ${recipientRows.length} rows restored`);
    }
  }

  console.log('[seed] Seed complete');
}

module.exports = {
  db,
  getSession, upsertSession, deleteSession, listSessions,
  logMessage, recentLog, getMessagesByPhones,
  enqueueAction, getQueue, getQueueItem, markActioned, markIgnored,
  addLogbookEntry, getLogbook,
  ingestSnapshot, findEmployee, findEmployeeCandidates, getCompanyByPhone, getManagerInfoByPhone,
  getTechnicianByPhone, addTechnicianMedia, getTechnicianMedia, getManagersByCompanyId,
  getAnalytics, getGlobalAnalytics, getLastActiveByPhones,
  createPhoneLinkRequest, getPhoneLinkRequest, deletePhoneLinkRequest,
  findEmployeeByEmail, updateEmployeePhone,
  createAlert, getAlerts, markAlertRead,
  recordOptOut, clearOptOut, getOptedOutPhones,
  getOptOut, markOptOutEmailSent, getEmployeeByPhone,
  createBroadcast, getBroadcastByIdempotencyKey, getQueuedRecipients,
  markRecipientSent, markRecipientFailed, completeBroadcast,
  listBroadcasts, getBroadcast, findInterruptedBroadcasts,
  seedFromSupabase,
};
