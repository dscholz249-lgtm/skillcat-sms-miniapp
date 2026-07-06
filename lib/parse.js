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
  "intent": "assign_training | add_employee | log_note | query_catalog | unclear",
  "employee_name": "<string> | null",
  "certification_name": "<string> | null",
  "new_employee": { "name": "<string>", "email": "<string | null>", "title": "<string | null>" } | null,
  "note_body": "<string> | null",
  "search_query": "<string> | null",
  "tags": ["completion" | "safety" | "concern" | "attendance" | "general"],
  "confidence": "high | low"
}

Intent rules (apply in this order):

1. assign_training — message contains action words like assign, enroll, register, sign up, put in, certify, or training/course AND a person's name. Extract employee_name and certification_name. confidence = "high" if both are present, "low" if certification is missing or ambiguous.

2. add_employee — manager explicitly wants to add a new person to the team (hire, add, onboard, new hire, new tech, joining). Requires new_employee.name. Email and title optional. confidence = "high" if name is clear.

3. query_catalog — manager is asking what courses or certifications are available (e.g. "what courses do you have", "what training is available", "do you have any HVAC courses", "show me split system training"). No person's name is required. Extract search_query from the keywords describing the course type they want. confidence = "high".

4. log_note — ANY message that mentions a person's name and is not an assign_training, add_employee, or query_catalog intent. Use this broadly: a manager texting anything about a named technician is a note. Set employee_name to the person's name. Set note_body to the full message text verbatim. confidence = "high" if the name is unambiguous, "low" only if the name is genuinely unclear.

5. unclear — no person's name is present AND no clear action can be determined. Use sparingly.

Tag rules (log_note only):
- completion: finished, completed, passed, done, signed off
- safety: safety, hazard, injury, incident, accident
- concern: issue, problem, struggling, failed, concern, worried
- attendance: late, absent, no-show, missed
- general: anything else or no specific signal
- assign_training, add_employee, query_catalog: tags = []`;

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

module.exports = { parseMessage, fastPath, SYSTEM_PROMPT };
