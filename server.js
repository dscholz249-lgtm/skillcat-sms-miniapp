require('dotenv').config();
const express = require('express');
const platform = require('./lib/platform');
const { validateSignature } = require('./lib/twilio');
const { startBatch, handleInbound } = require('./lib/conversation');
const { listSessions, recentLog } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Open CORS so the dashboard prototype (served from the mock on a different
// origin) can POST to /test/start-batch. The mock-stage app is a test harness
// with fake data — there is nothing sensitive to protect at the browser layer;
// real auth lives at the deployment boundary (Railway password protection).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ----------------------------------------------------------------- TWILIO INBOUND
// Twilio posts form-encoded. Mount the urlencoded parser only on this route so
// our other JSON routes (launcher → /test/start-batch) stay JSON-typed.
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

// ----------------------------------------------------------------- TEST LAUNCHER
app.post('/test/start-batch', async (req, res) => {
  const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
  if (pairs.length === 0) return res.status(400).json({ error: 'pairs required' });
  try {
    const summary = await startBatch({ pairs });
    res.json(summary);
  } catch (e) {
    console.error('[start-batch]', e);
    res.status(500).json({ error: e.message, detail: e.body });
  }
});

// Launcher UI — fetch roster, stack pairs, Send All.
app.get('/', async (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>SkillCat SMS Mini-App — launcher</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; max-width: 780px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .muted { color: #666; }
  .row { display: flex; gap: 8px; margin: 6px 0; align-items: center; }
  select { padding: 6px; min-width: 200px; }
  button { padding: 8px 14px; cursor: pointer; }
  pre { background: #f4f4f4; padding: 10px; border-radius: 6px; white-space: pre-wrap; }
  .err { color: #c33; }
</style></head><body>
<h1>SkillCat SMS Mini-App — test launcher</h1>
<p class="muted">Stack manager → technician pairs, hit Send All. Reviews land in the platform; SMS-eligible managers get texted.</p>
<div id="loading">Loading roster…</div>
<div id="ui" style="display:none">
  <div id="pairs"></div>
  <div class="row"><button id="add">+ Add pair</button> <button id="send">Send All →</button></div>
  <pre id="out"></pre>
</div>
<script>
(async function(){
  try {
    const r = await fetch('/api/roster').then(r=>r.json());
    const managers = r.managers, techs = r.technicians;
    const pairsEl = document.getElementById('pairs');
    function pairRow() {
      const div = document.createElement('div'); div.className = 'row';
      div.innerHTML = '<select class="m"></select> → <select class="t"></select> <button class="rm">×</button>';
      const m = div.querySelector('.m'), t = div.querySelector('.t');
      for (const x of managers) m.add(new Option(x.name + (x.sms_opt_in ? ' (sms)' : ' (app-only)'), x.id));
      for (const x of techs) t.add(new Option(x.name, x.id));
      div.querySelector('.rm').onclick = () => div.remove();
      pairsEl.appendChild(div);
    }
    pairRow();
    document.getElementById('add').onclick = pairRow;
    document.getElementById('send').onclick = async () => {
      const pairs = [...pairsEl.querySelectorAll('.row')].map(r => ({
        manager_id: r.querySelector('.m').value,
        technician_id: r.querySelector('.t').value,
      }));
      const out = document.getElementById('out');
      out.textContent = 'Sending…';
      try {
        const resp = await fetch('/test/start-batch', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ pairs }),
        });
        const j = await resp.json();
        out.textContent = JSON.stringify(j, null, 2);
      } catch (e) { out.textContent = 'Error: ' + e.message; out.className = 'err'; }
    };
    document.getElementById('loading').style.display = 'none';
    document.getElementById('ui').style.display = 'block';
  } catch (e) {
    document.getElementById('loading').innerHTML = '<span class="err">Failed to load roster: ' + e.message + '</span>';
  }
})();
</script></body></html>`);
});

// Roster proxy for the launcher UI.
app.get('/api/roster', async (_req, res) => {
  try { res.json(await platform.getRoster()); }
  catch (e) { res.status(502).json({ error: e.message, detail: e.body }); }
});

// ----------------------------------------------------------------- DEBUG / HEALTH
app.get('/debug', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>debug — skillcat sms mini-app</title>
<style>
  body { font: 13px/1.45 ui-monospace, monospace; max-width: 1100px; margin: 18px auto; padding: 0 16px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: #555; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { color: #777; font-weight: 600; }
  tr.in td { background: #f5f9ff; }
  tr.out td { background: #f7f7f7; }
  .muted { color: #888; }
  pre { margin: 0; white-space: pre-wrap; font: inherit; }
</style></head><body>
<h1 style="font-size:16px;margin:0">SkillCat SMS Mini-App — debug</h1>
<p class="muted">Auto-refresh every 3s.</p>
<div id="root">loading…</div>
<script>
async function tick() {
  try {
    const j = await fetch('/api/debug/state').then(r=>r.json());
    const sess = j.sessions.map(s => '<tr><td>'+s.manager_phone+'</td><td>'+s.step+'</td><td>'+s.current_review_id+'</td><td>'+s.pending_readiness+'</td><td>'+(s.pending_review_ids||[]).join(', ')+'</td><td>'+s.original_count+'</td><td class="muted">'+s.updated_at+'</td></tr>').join('');
    const log = j.log.map(r => '<tr class="'+r.direction+'"><td>'+r.created_at+'</td><td>'+r.manager_phone+'</td><td>'+r.direction+'</td><td>'+(r.step_before||'')+'→'+(r.step_after||'')+'</td><td><pre>'+(r.body||'')+'</pre></td><td><pre>'+(r.parsed_json||'')+'</pre></td></tr>').join('');
    document.getElementById('root').innerHTML =
      '<h2>sessions ('+j.sessions.length+')</h2>'+
      '<table><thead><tr><th>phone</th><th>step</th><th>current</th><th>readiness</th><th>pending</th><th>n</th><th>updated</th></tr></thead><tbody>'+sess+'</tbody></table>'+
      '<h2>message log (newest first, 100)</h2>'+
      '<table><thead><tr><th>at</th><th>phone</th><th>dir</th><th>step</th><th>body</th><th>parsed</th></tr></thead><tbody>'+log+'</tbody></table>';
  } catch (e) {
    document.getElementById('root').innerHTML = 'error: '+e.message;
  }
}
tick(); setInterval(tick, 3000);
</script></body></html>`);
});

app.get('/api/debug/state', (_req, res) => {
  res.json({ sessions: listSessions(), log: recentLog(100) });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// 404 fallthrough — keep noise low
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

app.listen(PORT, () => {
  console.log(`[miniapp] http://0.0.0.0:${PORT}`);
  console.log(`[miniapp] PLATFORM_BASE_URL=${process.env.PLATFORM_BASE_URL || '(unset)'}`);
  console.log(`[miniapp] COMPANY_ID=${process.env.COMPANY_ID || 'co_test'}`);
  if (!process.env.TWILIO_AUTH_TOKEN) console.log('[miniapp] WARNING: TWILIO_AUTH_TOKEN unset — signature validation disabled');
  if (!process.env.TWILIO_MESSAGING_SERVICE_SID) console.log('[miniapp] WARNING: TWILIO_MESSAGING_SERVICE_SID unset — outbound SMS logs to console only');
  if (!process.env.ANTHROPIC_API_KEY) console.log('[miniapp] WARNING: ANTHROPIC_API_KEY unset — NL parse will fall back to unclear on every non-fast-path reply');
});
