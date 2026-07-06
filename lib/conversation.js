const { parseMessage } = require('./parse');
const { sendSMS } = require('./twilio');
const { COPY } = require('./copy');
const {
  getSession, upsertSession, deleteSession,
  logMessage, enqueueAction, addLogbookEntry,
  findEmployeeCandidates, getCompanyByPhone,
} = require('../db');

function resolveSelection(replyBody, candidates) {
  const trimmed = replyBody.trim();
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= candidates.length) return candidates[num - 1];
  const lower = trimmed.toLowerCase();
  return candidates.find(c => {
    const cLower = c.name.toLowerCase();
    return cLower === lower || cLower.includes(lower) || lower.includes(cLower.split(/\s+/)[0]);
  }) || null;
}

async function sendOut(phone, body, label) {
  await sendSMS(phone, body);
  logMessage({ phone, direction: 'out', body, parsed: null, stepBefore: null, stepAfter: label });
}

async function handleInbound({ from, body }) {
  const session = getSession(from) || { manager_phone: from, step: 'IDLE', last_request_type: null, last_intent_json: null };
  const stepBefore = session.step;

  const msgId = logMessage({ phone: from, direction: 'in', body, parsed: null, stepBefore, stepAfter: null });

  // STOP/HELP fast-path — check before any state processing
  const upper = body.trim().toUpperCase();
  if (upper === 'STOP') { deleteSession(from); return; }
  if (upper === 'HELP') { await sendOut(from, COPY.HELP, 'help'); return; }

  // Name disambiguation — manager is replying "1", "2", or a name to a prior ambiguous request
  if (stepBefore === 'AWAITING_NAME_SELECTION') {
    const priorData = JSON.parse(session.last_intent_json || '{}');
    const { _candidates: candidates = [], ...baseIntent } = priorData;
    const companyId = getCompanyByPhone(from);
    const resolved = resolveSelection(body, candidates);

    if (resolved) {
      await writeIntent({ ...baseIntent, employee_name: resolved.name, _resolvedEmployee: resolved }, from, companyId, msgId, session);
    } else {
      enqueueAction({ type: 'human_review', payload: { raw: body, prior_intent: session.last_intent_json }, managerPhone: from, companyId });
      deleteSession(from);
      await sendOut(from, COPY.FALLBACK, 'fallback');
    }
    return;
  }

  const parsed = await parseMessage(body);
  logMessage({ phone: from, direction: 'in', body: '(parsed)', parsed, stepBefore, stepAfter: null });

  if (parsed._stop) { deleteSession(from); return; }
  if (parsed._help) { await sendOut(from, COPY.HELP, 'help'); return; }
  if (parsed.intent === 'done') { deleteSession(from); return; }

  const companyId = getCompanyByPhone(from);

  // Second attempt after a general clarification round
  if (stepBefore === 'AWAITING_CLARIFICATION') {
    if (parsed.confidence === 'high' && parsed.intent !== 'unclear') {
      await writeIntent(parsed, from, companyId, msgId, session);
      return;
    }
    enqueueAction({
      type: 'human_review',
      payload: { raw: body, prior_intent: session.last_intent_json },
      managerPhone: from,
      companyId,
    });
    deleteSession(from);
    await sendOut(from, COPY.FALLBACK, 'fallback');
    return;
  }

  // First attempt — low confidence or unclear
  if (parsed.confidence === 'low' || parsed.intent === 'unclear') {
    upsertSession({
      manager_phone: from,
      step: 'AWAITING_CLARIFICATION',
      last_request_type: parsed.intent,
      last_intent_json: JSON.stringify(parsed),
    });
    await sendOut(from, COPY.CLARIFY_GENERAL, 'clarify');
    return;
  }

  // Missing required field
  if (parsed.intent === 'assign_training' && !parsed.certification_name) {
    upsertSession({
      manager_phone: from,
      step: 'AWAITING_CLARIFICATION',
      last_request_type: parsed.intent,
      last_intent_json: JSON.stringify(parsed),
    });
    await sendOut(from, COPY.CLARIFY_MISSING_CERT(parsed.employee_name || 'them'), 'clarify-cert');
    return;
  }

  await writeIntent(parsed, from, companyId, msgId, session);
}

async function writeIntent(parsed, from, companyId, msgId, session) {
  let employee = parsed._resolvedEmployee || null;

  if (!employee && parsed.employee_name) {
    const candidates = findEmployeeCandidates(parsed.employee_name, companyId);
    if (candidates.length > 1) {
      upsertSession({
        manager_phone: from,
        step: 'AWAITING_NAME_SELECTION',
        last_request_type: parsed.intent,
        last_intent_json: JSON.stringify({ ...parsed, _candidates: candidates }),
      });
      await sendOut(from, COPY.CLARIFY_NAME(candidates), 'clarify-name');
      return;
    }
    employee = candidates.length === 1 ? candidates[0] : null;
  }

  const employeeNotFound = parsed.employee_name && !employee;

  if (parsed.intent === 'assign_training') {
    enqueueAction({
      type: 'assign_training',
      payload: {
        employee_name: parsed.employee_name,
        employee_id: employee?.id ?? null,
        certification_name: parsed.certification_name,
      },
      managerPhone: from,
      companyId: companyId ?? employee?.company_id ?? null,
    });
    deleteSession(from);
    const reply = employeeNotFound
      ? COPY.EMPLOYEE_NOT_FOUND(parsed.employee_name)
      : COPY.CONFIRM_ASSIGN(parsed.employee_name, parsed.certification_name);
    await sendOut(from, reply, 'confirm-assign');
    return;
  }

  if (parsed.intent === 'add_employee') {
    const newEmp = parsed.new_employee || {};
    enqueueAction({
      type: 'add_employee',
      payload: {
        name: newEmp.name,
        email: newEmp.email ?? null,
        title: newEmp.title ?? null,
      },
      managerPhone: from,
      companyId,
    });
    deleteSession(from);
    await sendOut(from, COPY.CONFIRM_ADD(newEmp.name || 'them'), 'confirm-add');
    return;
  }

  if (parsed.intent === 'log_note') {
    addLogbookEntry({
      employeeId: employee?.id ?? null,
      employeeNameRaw: parsed.employee_name ?? null,
      managerPhone: from,
      companyId: companyId ?? employee?.company_id ?? null,
      body: parsed.note_body || '',
      tags: parsed.tags || [],
      sourceMessageId: msgId,
    });
    deleteSession(from);
    const reply = employeeNotFound
      ? COPY.EMPLOYEE_NOT_FOUND(parsed.employee_name)
      : COPY.CONFIRM_NOTE(parsed.employee_name || 'them');
    await sendOut(from, reply, 'confirm-note');
    return;
  }

  // Shouldn't reach here — treat as unclear
  deleteSession(from);
  await sendOut(from, COPY.CLARIFY_GENERAL, 'unclear-fallthrough');
}

module.exports = { handleInbound };
