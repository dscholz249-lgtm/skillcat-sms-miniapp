const { parseMessage } = require('./parse');
const { sendSMS } = require('./twilio');
const { COPY } = require('./copy');
const { getCatalog, searchCatalog, fuzzyMatchCourse } = require('./catalog');
const { notifySlack } = require('./slack');
const { capture } = require('./analytics');
const {
  getSession, upsertSession, deleteSession,
  logMessage, enqueueAction, addLogbookEntry,
  findEmployeeCandidates, getCompanyByPhone, getManagerInfoByPhone,
} = require('../db');

// Resolve a numeric or name reply against a list of candidates.
// Works for both employee objects ({name}) and course objects ({name}).
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

  // STOP/HELP fast-path — before any state processing
  const upper = body.trim().toUpperCase();
  if (upper === 'STOP') { deleteSession(from); return; }
  if (upper === 'HELP') { await sendOut(from, COPY.HELP, 'help'); return; }

  // Employee name disambiguation
  if (stepBefore === 'AWAITING_NAME_SELECTION') {
    const priorData = JSON.parse(session.last_intent_json || '{}');
    const { _candidates: candidates = [], ...baseIntent } = priorData;
    const companyId = getCompanyByPhone(from);
    const resolved = resolveSelection(body, candidates);
    if (resolved) {
      await writeIntent({ ...baseIntent, employee_name: resolved.name, _resolvedEmployee: resolved }, from, companyId, msgId, session);
    } else {
      enqueueAction({ type: 'human_review', payload: { raw: body, prior_intent: session.last_intent_json }, managerPhone: from, companyId });
      notifySlack('human_review', { raw: body }, from, getManagerInfoByPhone(from)).catch(() => {});
      deleteSession(from);
      await sendOut(from, COPY.FALLBACK, 'fallback');
    }
    return;
  }

  // Course disambiguation
  if (stepBefore === 'AWAITING_COURSE_SELECTION') {
    const priorData = JSON.parse(session.last_intent_json || '{}');
    const { _courseCandidates: courseCandidates = [], ...baseIntent } = priorData;
    const companyId = getCompanyByPhone(from);
    const resolved = resolveSelection(body, courseCandidates);
    if (resolved) {
      await writeIntent({ ...baseIntent, certification_name: resolved.name, _resolvedCourse: resolved }, from, companyId, msgId, session);
    } else {
      enqueueAction({ type: 'human_review', payload: { raw: body, prior_intent: session.last_intent_json }, managerPhone: from, companyId });
      notifySlack('human_review', { raw: body }, from, getManagerInfoByPhone(from)).catch(() => {});
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

  capture(from, 'intent_parsed', { intent: parsed.intent, confidence: parsed.confidence, company_id: companyId });

  // Catalog query — search, reply, store context for follow-up assignments
  if (parsed.intent === 'query_catalog') {
    const catalog = await getCatalog();
    const results = searchCatalog(catalog, parsed.search_query || body);
    capture(from, 'catalog_searched', { query: parsed.search_query || body, results_count: results.length, company_id: companyId });
    upsertSession({
      manager_phone: from,
      step: 'IDLE',
      last_request_type: 'query_catalog',
      last_intent_json: JSON.stringify({ type: 'catalog_context', courses: results.slice(0, 10) }),
    });
    if (results.length === 0) {
      await sendOut(from, COPY.CATALOG_EMPTY(parsed.search_query || body), 'catalog-empty');
    } else {
      await sendOut(from, COPY.CATALOG_RESULTS(results), 'catalog-results');
    }
    return;
  }

  // Second attempt after a general clarification round
  if (stepBefore === 'AWAITING_CLARIFICATION') {
    if (parsed.confidence === 'high' && parsed.intent !== 'unclear') {
      await writeIntent(parsed, from, companyId, msgId, session);
      return;
    }
    capture(from, 'disambiguation_abandoned', { type: 'unclear', company_id: companyId });
    enqueueAction({
      type: 'human_review',
      payload: { raw: body, prior_intent: session.last_intent_json },
      managerPhone: from,
      companyId,
    });
    notifySlack('human_review', { raw: body }, from, getManagerInfoByPhone(from)).catch(() => {});
    deleteSession(from);
    await sendOut(from, COPY.FALLBACK, 'fallback');
    return;
  }

  // First attempt — low confidence or unclear
  if (parsed.confidence === 'low' || parsed.intent === 'unclear') {
    capture(from, 'disambiguation_prompted', { type: 'unclear', company_id: companyId });
    upsertSession({
      manager_phone: from,
      step: 'AWAITING_CLARIFICATION',
      last_request_type: parsed.intent,
      last_intent_json: JSON.stringify(parsed),
    });
    await sendOut(from, COPY.CLARIFY_GENERAL, 'clarify');
    return;
  }

  // Missing required field for assign_training
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
      capture(from, 'disambiguation_prompted', { type: 'employee', company_id: companyId, candidate_count: candidates.length });
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
    let certName = parsed.certification_name;

    // Resolve cert name against catalog unless already resolved via disambiguation
    if (certName && !parsed._resolvedCourse) {
      const catalog = await getCatalog();
      if (catalog.length > 0) {
        // Prefer recently listed courses from a prior catalog query as the match pool
        let matchPool = catalog;
        if (session && session.last_request_type === 'query_catalog') {
          try {
            const ctx = JSON.parse(session.last_intent_json || '{}');
            if (ctx.type === 'catalog_context' && Array.isArray(ctx.courses) && ctx.courses.length > 0) {
              matchPool = ctx.courses;
            }
          } catch (_) {}
        }
        const matches = fuzzyMatchCourse(matchPool, certName);
        if (matches.length === 1) {
          certName = matches[0].name;
        } else if (matches.length >= 2 && matches.length <= 5) {
          capture(from, 'disambiguation_prompted', { type: 'course', company_id: companyId, candidate_count: matches.length });
          upsertSession({
            manager_phone: from,
            step: 'AWAITING_COURSE_SELECTION',
            last_request_type: 'assign_training',
            last_intent_json: JSON.stringify({ ...parsed, _courseCandidates: matches }),
          });
          await sendOut(from, COPY.CLARIFY_COURSE(matches), 'clarify-course');
          return;
        }
        // 0 or >5 matches — proceed with the raw certName as-is
      }
    }

    enqueueAction({
      type: 'assign_training',
      payload: {
        employee_name: parsed.employee_name,
        employee_id: employee?.id ?? null,
        certification_name: certName,
      },
      managerPhone: from,
      companyId: companyId ?? employee?.company_id ?? null,
    });
    capture(from, 'request_queued', { request_type: 'assign_training', company_id: companyId, course: certName });
    notifySlack('assign_training', { employee_name: parsed.employee_name, certification_name: certName }, from, getManagerInfoByPhone(from)).catch(() => {});
    deleteSession(from);
    const reply = employeeNotFound
      ? COPY.EMPLOYEE_NOT_FOUND(parsed.employee_name)
      : COPY.CONFIRM_ASSIGN(parsed.employee_name, certName);
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
    capture(from, 'request_queued', { request_type: 'add_employee', company_id: companyId });
    notifySlack('add_employee', { name: newEmp.name, email: newEmp.email ?? null, title: newEmp.title ?? null }, from, getManagerInfoByPhone(from)).catch(() => {});
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
    capture(from, 'request_queued', { request_type: 'log_note', company_id: companyId });
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
