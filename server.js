require('dotenv').config();

// Sentry must be initialised before anything else
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.2 });
}

const express = require('express');
const { validateSignature } = require('./lib/twilio');
const { handleInbound } = require('./lib/conversation');
const { initReminders } = require('./lib/reminders');
const { sendSMS } = require('./lib/twilio');
const { COPY } = require('./lib/copy');
const { capture } = require('./lib/analytics');
const {
  listSessions, recentLog,
  getQueue, getQueueItem, markActioned,
  getLogbook, ingestSnapshot, logMessage, getAnalytics, getGlobalAnalytics,
  getTechnicianMedia,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const API_SECRET = process.env.API_SECRET;
if (!API_SECRET) {
  console.error('[SECURITY] API_SECRET is not set — all /api/* requests will be rejected with 503');
}

function requireApiSecret(req, res, next) {
  if (!API_SECRET) {
    return res.status(503).json({ error: 'server misconfigured: API_SECRET not set' });
  }
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const nextjsOrigin = process.env.NEXTJS_URL ? process.env.NEXTJS_URL.replace(/\/$/, '') : null;
  if (origin && nextjsOrigin && origin === nextjsOrigin) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// All /api/* routes require the shared Bearer secret
app.use('/api', requireApiSecret);

// ----------------------------------------------------------------- TWILIO INBOUND
app.post('/twilio/inbound',
  express.urlencoded({ extended: false }),
  validateSignature,
  async (req, res) => {
    const from = req.body.From;
    const body = req.body.Body ?? '';
    const numMedia = parseInt(req.body.NumMedia ?? '0', 10);
    const media = [];
    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      const contentType = req.body[`MediaContentType${i}`];
      if (url) media.push({ url, contentType: contentType ?? 'application/octet-stream' });
    }
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    try {
      await handleInbound({ from, body, media });
    } catch (e) {
      console.error('[inbound] unhandled error', e);
    }
  }
);

// ----------------------------------------------------------------- ACTION QUEUE
app.get('/api/queue', (req, res) => {
  const status = req.query.status || null;
  const companyId = req.query.company_id || null;
  const managerPhone = req.query.manager_phone || null;
  res.json(getQueue(status, companyId, managerPhone));
});

app.post('/api/queue/:id/action', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const { actioned_by, note } = req.body || {};
  const item = getQueueItem(id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const alreadyActioned = item.status === 'actioned';
  markActioned(id, { actionedBy: actioned_by, note });
  res.json({ ok: true });
  if (!alreadyActioned) {
    capture(item.manager_phone, 'request_actioned', { request_type: item.type, company_id: item.company_id });
    notifyManagerActioned(item).catch(e => console.error('[action] notify failed', e.message));
  }
});

async function notifyManagerActioned(item) {
  if (!item.manager_phone) return;
  let payload = {};
  try { payload = JSON.parse(item.payload || '{}'); } catch (_) {}
  let msg;
  if (item.type === 'assign_training' && payload.employee_name && payload.certification_name) {
    msg = COPY.ACTIONED_ASSIGN(payload.employee_name, payload.certification_name);
  } else if (item.type === 'add_employee' && payload.name) {
    msg = COPY.ACTIONED_ADD(payload.name);
  } else {
    msg = COPY.ACTIONED_GENERIC;
  }
  await sendSMS(item.manager_phone, msg);
  logMessage({ phone: item.manager_phone, direction: 'out', body: msg, parsed: null, stepBefore: null, stepAfter: 'actioned-notify' });
}

// ----------------------------------------------------------------- ANALYTICS
app.get('/api/analytics', (req, res) => {
  const companyId = req.query.company_id || null;
  const managerPhones = req.query.manager_phones || null;
  res.json(getAnalytics(companyId, managerPhones));
});

app.get('/api/analytics/global', (_req, res) => {
  res.json(getGlobalAnalytics());
});

// ----------------------------------------------------------------- LOGBOOK
app.get('/api/logbook', (req, res) => {
  const companyId = req.query.company_id || null;
  const managerPhone = req.query.manager_phone || null;
  res.json(getLogbook(companyId, managerPhone));
});

// ----------------------------------------------------------------- SNAPSHOT INGEST
app.post('/api/snapshot/ingest', (req, res) => {
  const { employees } = req.body || {};
  if (!Array.isArray(employees)) {
    return res.status(400).json({ error: 'employees array required' });
  }
  ingestSnapshot(employees);
  res.json({ ok: true, count: employees.length });
});

// ----------------------------------------------------------------- PARSE TEST
app.post('/api/debug/parse', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new (Anthropic.default || Anthropic)();
    const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    const { SYSTEM_PROMPT } = require('./lib/parse');
    const resp = await client.messages.create({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
    const raw = resp.content?.[0]?.text ?? '(no text block)';
    let parsed = null;
    try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); } catch {}
    res.json({ input: text, model, raw_model_output: raw, parsed });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  }
});

// ----------------------------------------------------------------- HEALTH / DEBUG
app.get('/health', (_req, res) => {
  const keys = {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
    TWILIO_MESSAGING_SERVICE_SID: !!process.env.TWILIO_MESSAGING_SERVICE_SID,
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const missing = Object.keys(keys).filter(k => !keys[k]);
  res.json({ ok: missing.length === 0, keys, missing });
});

app.get('/api/debug/state', (_req, res) => {
  res.json({ sessions: listSessions(), log: recentLog(100) });
});

// ----------------------------------------------------------------- TECHNICIAN MEDIA
app.get('/api/technician-media', (req, res) => {
  const companyId = req.query.company_id || null;
  const technicianId = req.query.technician_id || null;
  const technicianPhone = req.query.technician_phone || null;
  if (!companyId) return res.status(400).json({ error: 'company_id required' });
  res.json(getTechnicianMedia(companyId, technicianId, technicianPhone));
});

// ----------------------------------------------------------------- MEDIA PROXY
// Fetches a Twilio media URL using Basic auth so the Next.js layer can serve
// the image without embedding Twilio credentials in the browser.
app.get('/api/media-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return res.status(503).json({ error: 'Twilio credentials not configured' });
  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const upstream = await fetch(url, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'upstream error' });
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[media-proxy]', e.message);
    res.status(502).json({ error: 'failed to fetch media' });
  }
});

// 404 fallthrough
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

app.listen(PORT, () => {
  console.log(`[logbook] http://0.0.0.0:${PORT}`);
  initReminders();
  if (!process.env.TWILIO_AUTH_TOKEN) console.warn('[logbook] WARNING: TWILIO_AUTH_TOKEN unset — signature validation disabled');
  if (!process.env.TWILIO_MESSAGING_SERVICE_SID) console.warn('[logbook] WARNING: TWILIO_MESSAGING_SERVICE_SID unset — outbound SMS logs to console only');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[logbook] WARNING: ANTHROPIC_API_KEY unset — NL parse will always return unclear');
  startupRosterSync();
});

// Re-populate SQLite from Next.js after Railway restarts wipe the ephemeral
// container. Retries with backoff so Next.js has time to start if both
// services restart simultaneously.
async function startupRosterSync() {
  const nextjsUrl = process.env.NEXTJS_URL;
  if (!nextjsUrl) return;
  const syncSecret = process.env.SYNC_SECRET;
  const url = `${nextjsUrl.replace(/\/$/, '')}/api/internal/roster-sync`;
  const headers = { 'Content-Type': 'application/json' };
  if (syncSecret) headers['Authorization'] = `Bearer ${syncSecret}`;
  const delay = ms => new Promise(r => setTimeout(r, ms));
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await delay(attempt * 4000);
    try {
      const res = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        console.log(`[logbook] startup roster sync: ${data.synced} companies`);
        return;
      }
      console.warn(`[logbook] startup sync attempt ${attempt}: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`[logbook] startup sync attempt ${attempt}: ${e.message}`);
    }
  }
  console.warn('[logbook] startup roster sync: could not reach Next.js after 5 attempts — run Sync from admin');
}
