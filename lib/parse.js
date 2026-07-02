const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function client() {
  if (_client) return _client;
  _client = new Anthropic.default ? new Anthropic.default() : new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You parse SMS messages from field managers making logbook requests. Output ONLY a JSON object — no prose, no markdown fences.

Schema:
{
  "intent": "assign_training | add_employee | log_note | unclear",
  "employee_name": "<string> | null",
  "certification_name": "<string> | null",
  "new_employee": { "name": "<string>", "email": "<string | null>", "title": "<string | null>" } | null,
  "note_body": "<string> | null",
  "tags": ["completion" | "safety" | "concern" | "attendance" | "general"],
  "confidence": "high | low"
}

Rules:
- assign_training: manager wants to assign a certification or training to an employee. Requires employee_name and certification_name.
- add_employee: manager wants to add a new person to the team. Requires new_employee.name. Email and title are optional.
- log_note: manager is recording an observation about an employee. Requires employee_name and note_body.
- unclear: message does not match any of the above, or is too ambiguous to action safely.
- confidence "low": intent is guessed, names are ambiguous, or a required field is missing or unclear.
- confidence "high": intent is clear and all required fields are present.
- tags: auto-detect from note_body or message context. Pick all that apply from: completion (finished/completed/passed/done), safety (safety/hazard/injury/incident), concern (issue/problem/struggling/failed/concern), attendance (late/absent/no-show/attendance), general (anything else or no specific signal).
- For assign_training: tags should be empty [].
- For add_employee: tags should be empty [].`;

// Fast-path: handle STOP/HELP before hitting the model.
function fastPath(text) {
  const t = (text || '').trim();
  if (!t) return { intent: 'unclear', confidence: 'high' };
  if (/^stop\b/i.test(t)) return { intent: 'done', confidence: 'high', _stop: true };
  if (/^help\b/i.test(t)) return { intent: 'unclear', confidence: 'high', _help: true };
  return null;
}

function stripFences(s) {
  return String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function modelParse(text) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  try {
    const resp = await client().messages.create({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
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

async function parseMessage(text) {
  const fast = fastPath(text);
  if (fast) return fast;
  const result = await modelParse(text);
  if (result && typeof result === 'object' && result.intent) return result;
  return { intent: 'unclear', confidence: 'low' };
}

module.exports = { parseMessage, fastPath };
