const { parseMessage } = require('./parse');
const { sendSMS } = require('./twilio');
const { COPY } = require('./copy');
const { getCatalog, searchCatalog, fuzzyMatchCourse } = require('./catalog');
const { notifySlack, notifyTechnicianAdded, notifyCourseAssigned } = require('./slack');
const { createTechnician, inviteTechnician, emailCourseAssignment } = require('./logbook-api');
const { notifyOptOut } = require('./opt-out');
const { capture } = require('./analytics');
const { randomUUID } = require('crypto');
const {
  getSession, upsertSession, deleteSession,
  logMessage, enqueueAction, addLogbookEntry,
  findEmployeeCandidates, getCompanyByPhone, getManagerInfoByPhone,
  getTechnicianByPhone, addTechnicianMedia, getManagersByCompanyId,
  findEmployeeByEmail, createPhoneLinkRequest,
  recordOptOut, clearOptOut, wasRecentlyBroadcast,
  getOptOut, markActioned,
} = require('../db');

// How long after a broadcast a reply from that number is treated as an answer
// to the blast rather than a command. Long enough to cover someone reading the
// text the next morning, short enough that it doesn't permanently soften the
// parser for everyone who has ever been on a broadcast list.
const BROADCAST_REPLY_WINDOW_MS =
  Number(process.env.BROADCAST_REPLY_WINDOW_MS || 24 * 60 * 60 * 1000);

// ----------------------------------------------------------------- add technician (PRD-438)
// A manager/director adds a technician by text, without CS triage:
//   "Add James Carer" → ask email → create → ask "send an invite?" → invite.
// The Logbook app does the create and the invite (lib/logbook-api.js); these
// two session steps carry the conversation between texts.
const ADD_STEPS = new Set(['AWAITING_NEW_TECH_EMAIL', 'AWAITING_TECH_INVITE']);
// A half-finished add older than this is abandoned, so a reply hours later
// ("no", an email) isn't read as an answer to a question they've forgotten.
const ADD_STEP_TTL_MS = 30 * 60 * 1000;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const NO_RE = /^\s*(no|nope|nah|n|none|skip|no email|not sure|unknown|n\/a|na|i don'?t (have|know)( it| one)?|don'?t (have|know)( it| one)?|not now|no thanks|no thank you)[\s.!]*$/i;
const YES_RE = /^\s*(yes|yeah|yep|yup|y|sure|ok|okay|please|yes please|send it|do it|go ahead)[\s.!]*$/i;

function addStepIsLive(session) {
  if (!session || !ADD_STEPS.has(session.step)) return false;
  const at = Date.parse(session.updated_at || '');
  return Number.isFinite(at) && Date.now() - at < ADD_STEP_TTL_MS;
}

// Ask for the email, or — when the first message already had one — create now.
async function startAddTechnician(from, companyId, newEmp) {
  const name = (newEmp.name || '').trim();
  if (newEmp.email) return createAndContinue(from, companyId, name, newEmp.email.trim(), 0);
  upsertSession({
    manager_phone: from,
    step: 'AWAITING_NEW_TECH_EMAIL',
    last_request_type: 'add_employee',
    last_intent_json: JSON.stringify({ name, attempts: 0 }),
  });
  await sendOut(from, COPY.ADD_ASK_EMAIL(name), 'add-ask-email');
}

async function handleAddEmailReply(from, companyId, state, body) {
  const email = (body.match(EMAIL_RE) || [])[0] || null;
  if (email) return createAndContinue(from, companyId, state.name, email, state.attempts);
  if (NO_RE.test(body) || state.attempts >= 1) {
    // Explicit "no", or a second reply that still isn't an email: add them
    // without one rather than loop. The web edit can fill it in later.
    return createAndContinue(from, companyId, state.name, null, state.attempts);
  }
  upsertSession({
    manager_phone: from,
    step: 'AWAITING_NEW_TECH_EMAIL',
    last_request_type: 'add_employee',
    last_intent_json: JSON.stringify({ ...state, attempts: state.attempts + 1 }),
  });
  await sendOut(from, COPY.ADD_ASK_EMAIL_AGAIN(state.name), 'add-ask-email-again');
}

async function createAndContinue(from, companyId, name, email, attempts) {
  const result = await createTechnician({ managerPhone: from, name, email });

  if (!result.ok && result.code === 'email_taken') {
    upsertSession({
      manager_phone: from,
      step: 'AWAITING_NEW_TECH_EMAIL',
      last_request_type: 'add_employee',
      last_intent_json: JSON.stringify({ name, attempts }),
    });
    await sendOut(from, COPY.ADD_EMAIL_TAKEN(email, name), 'add-email-taken');
    return;
  }
  if (!result.ok) {
    // Couldn't create (Logbook unreachable, phone not on file as a manager):
    // fall back to the old CS triage request so the add isn't lost.
    deleteSession(from);
    await queueAddForTriage(from, companyId, { name, email });
    return;
  }

  capture(from, 'technician_added_by_sms', { company_id: companyId, has_email: !!email });
  if (!email) {
    deleteSession(from);
    notifyTechnicianAdded({ name, email: null, invited: false }, from, getManagerInfoByPhone(from)).catch(() => {});
    await sendOut(from, COPY.ADD_DONE_NO_EMAIL(name), 'add-done-no-email');
    return;
  }
  upsertSession({
    manager_phone: from,
    step: 'AWAITING_TECH_INVITE',
    last_request_type: 'add_employee',
    last_intent_json: JSON.stringify({ name, email, technicianId: result.technicianId }),
  });
  await sendOut(from, COPY.ADD_ASK_INVITE(name), 'add-ask-invite');
}

// Returns false when the reply isn't a yes/no, so the caller can treat it as a
// fresh message (the technician is already added either way).
async function handleInviteReply(from, state, body) {
  const yes = YES_RE.test(body);
  if (!yes && !NO_RE.test(body)) {
    deleteSession(from);
    notifyTechnicianAdded({ name: state.name, email: state.email, invited: false }, from, getManagerInfoByPhone(from)).catch(() => {});
    return false;
  }
  deleteSession(from);
  let invited = false;
  if (yes) {
    invited = (await inviteTechnician({ managerPhone: from, technicianId: state.technicianId })).ok;
    capture(from, 'technician_invited_by_sms', { sent: invited });
    await sendOut(
      from,
      invited ? COPY.ADD_INVITE_SENT(state.name, state.email) : COPY.ADD_INVITE_FAILED(state.name),
      invited ? 'add-invite-sent' : 'add-invite-failed',
    );
  } else {
    await sendOut(from, COPY.ADD_NO_INVITE(state.name), 'add-no-invite');
  }
  notifyTechnicianAdded({ name: state.name, email: state.email, invited }, from, getManagerInfoByPhone(from)).catch(() => {});
  return true;
}

// The pre-PRD-438 path: queue for CS and tell the manager someone will action it.
async function queueAddForTriage(from, companyId, newEmp) {
  const queueId = enqueueAction({
    type: 'add_employee',
    payload: { name: newEmp.name, email: newEmp.email ?? null, title: newEmp.title ?? null },
    managerPhone: from,
    companyId,
  });
  capture(from, 'request_queued', { request_type: 'add_employee', company_id: companyId });
  notifySlack('add_employee', { name: newEmp.name, email: newEmp.email ?? null, title: newEmp.title ?? null }, from, getManagerInfoByPhone(from), queueId).catch(() => {});
  await sendOut(from, COPY.CONFIRM_ADD(newEmp.name || 'them'), 'confirm-add');
}

// ----------------------------------------------------------------- assign course (PRD-436)
// Text + email the technician the course link, confirm to the manager, and log
// it in both logbooks. Returns false when nothing reached the technician, so
// the caller falls back to CS triage.
async function assignCourseDirectly(from, companyId, employee, course) {
  const managerInfo = getManagerInfoByPhone(from);
  const managerName = managerInfo?.name || 'Your manager';
  const channels = [];

  const optOut = employee.phone ? getOptOut(employee.phone) : null;
  if (employee.phone && !(optOut && !optOut.cleared_at)) {
    try {
      await sendOut(employee.phone, COPY.ASSIGN_TO_TECH(managerName, course.name, course.link), 'assign-to-tech');
      channels.push('text');
    } catch (e) {
      console.error('[assign] technician SMS failed', e.message);
    }
  }
  if (employee.email) {
    const r = await emailCourseAssignment({
      managerPhone: from, technicianId: employee.id, courseName: course.name, courseLink: course.link,
    });
    if (r.emailed) channels.push('email');
  }
  if (channels.length === 0) return false;

  // Keep the "Assignment" record managers see on the Technicians pages — the
  // same queue row as the triage path, but completed on creation (no CS step).
  const queueId = enqueueAction({
    type: 'assign_training',
    payload: {
      employee_name: employee.name,
      employee_id: employee.id,
      certification_name: course.name,
      course_link: course.link,
      lms_course_id: course.lmsCourseId ?? null,
      self_serve: true,
    },
    managerPhone: from,
    companyId: companyId ?? employee.company_id ?? null,
  });
  markActioned(queueId, { actionedBy: 'sms-self-serve', note: `Course link sent by ${channels.join(' and ')}` });

  // Manager's own logbook (no employee attached, so it lands in their grid)…
  addLogbookEntry({
    employeeId: null,
    employeeNameRaw: null,
    managerPhone: from,
    companyId: companyId ?? employee.company_id ?? null,
    body: `Assigned ${course.name} to ${employee.name}`,
    tags: ['course_assigned'],
  });
  // …and the technician's own logbook. getLogbook hides this copy from
  // manager views so it isn't shown twice there.
  addLogbookEntry({
    employeeId: employee.id,
    employeeNameRaw: employee.name,
    managerPhone: '',
    companyId: companyId ?? employee.company_id ?? null,
    body: `${managerName} assigned you ${course.name}: ${course.link}`,
    tags: ['course_assigned', 'technician_copy'],
  });

  const channelText = channels.join(' and ');
  capture(from, 'course_assigned_by_sms', { company_id: companyId, course: course.name, channels: channelText });
  notifyCourseAssigned(
    { employeeName: employee.name, courseName: course.name, courseLink: course.link, channels: channelText },
    from, managerInfo,
  ).catch(() => {});
  await sendOut(from, COPY.ASSIGN_DONE(employee.name, course.name, channelText), 'assign-done');
  return true;
}

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

async function handleTechnicianInbound({ technician, from, body, media }) {
  const msgId = logMessage({ phone: from, direction: 'in', body: body || '(mms)', parsed: null, stepBefore: null, stepAfter: null });
  const techName = technician.name || from;
  const companyId = technician.company_id ?? null;
  const employeeId = technician.id ?? null; // employees table primary key

  if (!media || media.length === 0) {
    // Log text message to the technician's logbook
    if (body && body.trim()) {
      addLogbookEntry({
        employeeId,
        employeeNameRaw: techName,
        managerPhone: '',
        companyId,
        body: body.trim(),
        tags: ['technician', 'text'],
        sourceMessageId: msgId,
      });
    }
    await sendOut(from, "Got it. I've added it to your logbook.", 'tech-no-media');
    return;
  }

  // Save each media item and log to the technician's logbook
  for (const m of media) {
    addTechnicianMedia({
      technicianId: employeeId,
      technicianName: techName,
      technicianPhone: from,
      companyId,
      mediaUrl: m.url,
      mediaContentType: m.contentType,
      caption: body || null,
    });
  }
  const photoCount = media.length;
  const logText = `📸 Sent ${photoCount} photo${photoCount !== 1 ? 's' : ''}${body ? ` — ${body}` : ''}`;
  // Encode media URLs into the body as JSON so the dashboard can render actual images
  const logBody = JSON.stringify({
    text: logText,
    media: media.map(m => ({ url: m.url, contentType: m.contentType })),
  });
  addLogbookEntry({
    employeeId,
    employeeNameRaw: techName,
    managerPhone: '',
    companyId,
    body: logBody,
    tags: ['technician', 'mms'],
    sourceMessageId: msgId,
  });

  await sendOut(from, 'Thanks! Your photo has been saved 📸', 'tech-media-saved');
  const managers = getManagersByCompanyId(technician.company_id);
  const platformUrl = process.env.NEXTJS_URL ? process.env.NEXTJS_URL.replace(/\/$/, '') : null;
  for (const mgr of managers) {
    if (mgr.phone && mgr.phone !== from) {
      const link = platformUrl && employeeId ? `\n${platformUrl}/manager/technician/${employeeId}` : '';
      await sendOut(mgr.phone, `📸 ${techName} uploaded a photo.${link}`, 'tech-media-notify');
    }
  }
}

function formatPhoneDisplay(e164) {
  const m = String(e164).match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

async function handlePhoneLinkRequest({ from, email }) {
  const employee = findEmployeeByEmail(email);
  if (!employee) {
    await sendOut(from, `We couldn't find a SkillCat account for ${email}. Double-check the address and try again.`, 'phone-link-not-found');
    return;
  }
  const token = randomUUID();
  createPhoneLinkRequest({
    token,
    phone: from,
    email,
    employeeId: employee.id,
    companyId: employee.company_id,
  });
  const nextjsUrl = process.env.NEXTJS_URL?.replace(/\/$/, '');
  if (nextjsUrl) {
    const syncSecret = process.env.SYNC_SECRET;
    try {
      await fetch(`${nextjsUrl}/api/internal/phone-link-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(syncSecret ? { Authorization: `Bearer ${syncSecret}` } : {}),
        },
        body: JSON.stringify({ token, email, employeeName: employee.name, phone: from, nextjsUrl }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.error('[phone-link] email send failed', e.message);
    }
  }
  await sendOut(from, `We sent a confirmation email to ${email}. Click the link there to link ${formatPhoneDisplay(from)} to your SkillCat account.`, 'phone-link-sent');
}

async function handleManagerMedia({ managerInfo, from, body, media }) {
  const msgId = logMessage({ phone: from, direction: 'in', body: body || '(mms)', parsed: null, stepBefore: null, stepAfter: null });

  const photoCount = media.length;
  const logText = `📸 Sent ${photoCount} photo${photoCount !== 1 ? 's' : ''}${body ? ` — ${body}` : ''}`;
  const logBody = JSON.stringify({
    text: logText,
    media: media.map(m => ({ url: m.url, contentType: m.contentType })),
  });

  addLogbookEntry({
    employeeId: null,
    employeeNameRaw: null,
    managerPhone: from,
    companyId: managerInfo.company_id,
    body: logBody,
    tags: ['manager', 'mms'],
    sourceMessageId: msgId,
  });

  await sendOut(from, 'Thanks! Your photo has been saved to your logbook 📸', 'manager-media-saved');
}

async function handleInbound({ from, body, media = [] }) {
  const technician = getTechnicianByPhone(from);
  if (technician) {
    await handleTechnicianInbound({ technician, from, body, media });
    return;
  }

  // Manager/director sending an image — log it to their logbook, skip the text flow.
  if (media && media.length > 0) {
    const managerInfo = getManagerInfoByPhone(from);
    if (managerInfo) {
      await handleManagerMedia({ managerInfo, from, body, media });
      return;
    }
  }

  // Phone link flow: any user (tech or manager) texts just their email address.
  // Only triggers when the entire message body is an email — prevents false
  // matches on manager messages like "add john@co.com to the roster".
  // A manager mid-add who was just asked for the new technician's email will
  // reply with exactly that, so the add flow gets it first.
  const trimmedBody = body.trim();
  const sessionNow = getSession(from);
  const awaitingNewTechEmail = sessionNow?.step === 'AWAITING_NEW_TECH_EMAIL' && addStepIsLive(sessionNow);
  if (ADD_STEPS.has(sessionNow?.step) && !addStepIsLive(sessionNow)) deleteSession(from);
  if (!awaitingNewTechEmail && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(trimmedBody)) {
    await handlePhoneLinkRequest({ from, email: trimmedBody });
    return;
  }

  // Silently drop messages from unrecognized numbers — no reply, no cost.
  const knownCompany = getCompanyByPhone(from);
  const existingSession = getSession(from);
  if (!knownCompany && !existingSession) {
    console.log(`[inbound] ignored unknown sender ${from}`);
    return;
  }

  const session = existingSession || { manager_phone: from, step: 'IDLE', last_request_type: null, last_intent_json: null };
  const stepBefore = session.step;

  const msgId = logMessage({ phone: from, direction: 'in', body, parsed: null, stepBefore, stepAfter: null });

  // STOP/HELP fast-path — before any state processing.
  // Twilio's Advanced Opt-Out is authoritative and may block the message before
  // it reaches us; recording it here is what lets the dashboard exclude the
  // number from broadcasts up front instead of discovering it via a 21610.
  const upper = body.trim().toUpperCase();
  if (upper === 'STOP') {
    recordOptOut(from, 'stop_keyword');
    deleteSession(from);
    notifyOptOut(from).catch(e => console.error('[opt-out] notify failed', e.message));
    return;
  }
  if (upper === 'START' || upper === 'UNSTOP') { clearOptOut(from); return; }
  if (upper === 'HELP') { await sendOut(from, COPY.HELP, 'help'); return; }

  // Add-technician conversation (PRD-438). A stale one is dropped and the
  // message handled fresh.
  if (ADD_STEPS.has(stepBefore)) {
    if (!addStepIsLive(session)) {
      deleteSession(from);
    } else {
      const state = JSON.parse(session.last_intent_json || '{}');
      const companyId = getCompanyByPhone(from);
      if (stepBefore === 'AWAITING_NEW_TECH_EMAIL') {
        await handleAddEmailReply(from, companyId, state, body);
        return;
      }
      if (await handleInviteReply(from, state, body)) return;
      // Not a yes/no — fall through and treat it as a new message.
    }
  }

  // Employee name disambiguation
  if (stepBefore === 'AWAITING_NAME_SELECTION') {
    const priorData = JSON.parse(session.last_intent_json || '{}');
    const { _candidates: candidates = [], ...baseIntent } = priorData;
    const companyId = getCompanyByPhone(from);
    const resolved = resolveSelection(body, candidates);
    if (resolved) {
      await writeIntent({ ...baseIntent, employee_name: resolved.name, _resolvedEmployee: resolved }, from, companyId, msgId, session);
    } else {
      const queueId = enqueueAction({ type: 'human_review', payload: { raw: body, prior_intent: session.last_intent_json }, managerPhone: from, companyId });
      notifySlack('human_review', { raw: body }, from, getManagerInfoByPhone(from), queueId).catch(() => {});
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
      const queueId = enqueueAction({ type: 'human_review', payload: { raw: body, prior_intent: session.last_intent_json }, managerPhone: from, companyId });
      notifySlack('human_review', { raw: body }, from, getManagerInfoByPhone(from), queueId).catch(() => {});
      deleteSession(from);
      await sendOut(from, COPY.FALLBACK, 'fallback');
    }
    return;
  }

  // Substitute "me"/"myself" with the sender's actual name BEFORE the model
  // sees it — otherwise the LLM treats "me" as not-a-person and returns unclear.
  let bodyForParsing = body;
  if (/\b(me|myself)\b/i.test(body)) {
    const selfInfo = getManagerInfoByPhone(from);
    if (selfInfo?.name) {
      bodyForParsing = body.replace(/\b(me|myself)\b/gi, selfInfo.name);
    }
  }

  const parsed = await parseMessage(bodyForParsing);
  logMessage({ phone: from, direction: 'in', body: '(parsed)', parsed, stepBefore, stepAfter: null });

  if (parsed._stop) {
    recordOptOut(from, 'stop_keyword');
    deleteSession(from);
    notifyOptOut(from).catch(e => console.error('[opt-out] notify failed', e.message));
    return;
  }
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
    const queueId = enqueueAction({
      type: 'human_review',
      payload: { raw: body, prior_intent: session.last_intent_json },
      managerPhone: from,
      companyId,
    });
    notifySlack('human_review', { raw: body }, from, getManagerInfoByPhone(from), queueId).catch(() => {});
    deleteSession(from);
    // Same reasoning as the first-attempt branch below: a stale clarification
    // session shouldn't turn a broadcast reply into a parse-failure message.
    const broadcastReply = wasRecentlyBroadcast(from, BROADCAST_REPLY_WINDOW_MS);
    await sendOut(
      from,
      broadcastReply ? COPY.BROADCAST_ACK : COPY.FALLBACK,
      broadcastReply ? 'broadcast-reply' : 'fallback',
    );
    return;
  }

  // First attempt — low confidence or unclear
  if (parsed.confidence === 'low' || parsed.intent === 'unclear') {
    // A recent broadcast recipient replying with something we can't parse is
    // almost always answering the blast ("thanks", "we're all set", a
    // question). Acknowledge and hand it to a human instead of walking them
    // through a clarification round they never asked for. A parseable command
    // sent in this window still routes normally — we only reach here on a
    // parse we already gave up on.
    if (wasRecentlyBroadcast(from, BROADCAST_REPLY_WINDOW_MS)) {
      capture(from, 'broadcast_reply_received', { company_id: companyId });
      const queueId = enqueueAction({
        type: 'human_review',
        payload: { raw: body, source: 'broadcast_reply' },
        managerPhone: from,
        companyId,
      });
      notifySlack('human_review', { raw: body }, from, getManagerInfoByPhone(from), queueId).catch(() => {});
      deleteSession(from);
      await sendOut(from, COPY.BROADCAST_ACK, 'broadcast-reply');
      return;
    }
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
    // The catalog row the name resolved to (carries the course link), if any.
    let course = parsed._resolvedCourse || null;

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
          course = matches[0];
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

    // Self-serve (PRD-436): a known person, a course with a link, and a way to
    // reach them. Anything short of that goes to CS triage as before.
    if (employee && course?.link && (employee.phone || employee.email)) {
      const done = await assignCourseDirectly(from, companyId, employee, course);
      if (done) { deleteSession(from); return; }
    }

    const queueId = enqueueAction({
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
    notifySlack('assign_training', { employee_name: parsed.employee_name, certification_name: certName }, from, getManagerInfoByPhone(from), queueId).catch(() => {});
    deleteSession(from);
    const reply = employeeNotFound
      ? COPY.EMPLOYEE_NOT_FOUND(parsed.employee_name)
      : COPY.CONFIRM_ASSIGN(parsed.employee_name, certName);
    await sendOut(from, reply, 'confirm-assign');
    return;
  }

  if (parsed.intent === 'add_employee') {
    const newEmp = parsed.new_employee || {};
    deleteSession(from);
    // Self-serve when we know who's asking and the name; otherwise CS triage.
    if (newEmp.name && getManagerInfoByPhone(from)) {
      await startAddTechnician(from, companyId, newEmp);
    } else {
      await queueAddForTriage(from, companyId, newEmp);
    }
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
