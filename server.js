require('dotenv').config();
const express = require('express');
const { validateSignature } = require('./lib/twilio');
const { handleInbound } = require('./lib/conversation');
const { initReminders } = require('./lib/reminders');
const {
  listSessions, recentLog,
  getQueue, markActioned,
  getLogbook, ingestSnapshot,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ----------------------------------------------------------------- TWILIO INBOUND
app.post('/twilio/inbound',
  express.urlencoded({ extended: false }),
  validateSignature,
  async (req, res) => {
    const from = req.body.From;
    const body = req.body.Body;
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    try {
      await handleInbound({ from, body });
    } catch (e) {
      console.error('[inbound] unhandled error', e);
    }
  }
);

// ----------------------------------------------------------------- ACTION QUEUE
app.get('/api/queue', (req, res) => {
  const status = req.query.status || null;
  const companyId = req.query.company_id || null;
  res.json(getQueue(status, companyId));
});

app.post('/api/queue/:id/action', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const { actioned_by, note } = req.body || {};
  markActioned(id, { actionedBy: actioned_by, note });
  res.json({ ok: true });
});

// ----------------------------------------------------------------- LOGBOOK
app.get('/api/logbook', (req, res) => {
  const companyId = req.query.company_id || null;
  res.json(getLogbook(companyId));
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

// 404 fallthrough
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

app.listen(PORT, () => {
  console.log(`[logbook] http://0.0.0.0:${PORT}`);
  initReminders();
  if (!process.env.TWILIO_AUTH_TOKEN) console.warn('[logbook] WARNING: TWILIO_AUTH_TOKEN unset — signature validation disabled');
  if (!process.env.TWILIO_MESSAGING_SERVICE_SID) console.warn('[logbook] WARNING: TWILIO_MESSAGING_SERVICE_SID unset — outbound SMS logs to console only');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[logbook] WARNING: ANTHROPIC_API_KEY unset — NL parse will always return unclear');
});
