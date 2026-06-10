const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function client() {
  if (_client) return _client;
  _client = new Anthropic.default ? new Anthropic.default() : new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You parse SMS replies from a field manager doing ride-along reviews. Output ONLY a JSON object, no prose, no markdown. Schema: {"intent":"select_tech|give_verdict|give_note|skip|done|unclear","tech_id":"<id>|null","readiness":"ready|not_ready|null","note":"<string>|null","confidence":"high|low"}. Map yes/yeah/yep/ready/good/👍 → readiness "ready"; no/nope/not yet/needs work → "not_ready". Match technician names case-insensitively against the provided pending list (first name, last name, or partial). If a name matches none or is ambiguous, set tech_id null and intent "unclear". Support compound replies (name+verdict, or verdict+note). Set confidence "high" or "low".`;

// Fast-path: skip the model call for deterministic, common cases.
// Returns a parsed object or null (null → fall through to model).
function fastPath({ text, step, pending, currentTech }) {
  const t = (text || '').trim();
  if (!t) return { intent: 'unclear', tech_id: null, readiness: null, note: null, confidence: 'high' };

  // STOP/HELP (compliance) — caller should also handle these at the route level.
  if (/^stop\b/i.test(t)) return { intent: 'done', tech_id: null, readiness: null, note: null, confidence: 'high', _stop: true };
  if (/^help\b/i.test(t)) return { intent: 'unclear', tech_id: null, readiness: null, note: null, confidence: 'high', _help: true };

  // done
  if (/^done\b\.?$/i.test(t)) return { intent: 'done', tech_id: null, readiness: null, note: null, confidence: 'high' };

  // skip — only meaningful at the note step, but harmless if surfaced earlier.
  if (/^skip\b\.?$/i.test(t)) return { intent: 'skip', tech_id: null, readiness: null, note: null, confidence: 'high' };

  if (step === 'AWAITING_READINESS') {
    if (/^(y|yes|yeah|yep|yup|ready|good|👍)\b\.?$/i.test(t)) {
      return { intent: 'give_verdict', tech_id: null, readiness: 'ready', note: null, confidence: 'high' };
    }
    if (/^(n|no|nope|not yet|needs work)\b\.?$/i.test(t)) {
      return { intent: 'give_verdict', tech_id: null, readiness: 'not_ready', note: null, confidence: 'high' };
    }
  }

  if (step === 'AWAITING_SELECTION' && Array.isArray(pending)) {
    const lower = t.toLowerCase();
    const exact = pending.filter(p => p.name.toLowerCase() === lower);
    if (exact.length === 1) {
      return { intent: 'select_tech', tech_id: exact[0].id, readiness: null, note: null, confidence: 'high' };
    }
    // bare first-name unique match
    const firstHits = pending.filter(p => p.name.split(/\s+/)[0].toLowerCase() === lower);
    if (firstHits.length === 1) {
      return { intent: 'select_tech', tech_id: firstHits[0].id, readiness: null, note: null, confidence: 'high' };
    }
  }

  return null;
}

function stripFences(s) {
  return String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function modelParse({ text, step, pending, currentTech }) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const user = JSON.stringify({
    step,
    pending_technicians: pending,
    current_technician: currentTech,
    manager_reply: text,
  });
  try {
    const resp = await client().messages.create({
      model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    });
    const block = (resp.content || []).find(b => b.type === 'text');
    if (!block) return null;
    const raw = stripFences(block.text);
    return JSON.parse(raw);
  } catch (e) {
    console.error('[parse] model call failed', e?.message || e);
    return null;
  }
}

// Entry point. Returns a parsed object always; falls back to {intent:'unclear', confidence:'low'}
// on API error/timeout/invalid JSON — caller should re-prompt and never write.
async function parseReply(ctx) {
  const fast = fastPath(ctx);
  if (fast) return fast;
  const model = await modelParse(ctx);
  if (model && typeof model === 'object' && model.intent) return model;
  return { intent: 'unclear', tech_id: null, readiness: null, note: null, confidence: 'low' };
}

module.exports = { parseReply, fastPath, SYSTEM_PROMPT };
