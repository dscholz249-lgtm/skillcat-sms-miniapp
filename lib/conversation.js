const crypto = require('crypto');
const platform = require('./platform');
const { sendSMS } = require('./twilio');
const { parseReply } = require('./parse');
const { COPY } = require('./copy');
const { getSession, upsertSession, deleteSession, logMessage } = require('../db');

// Roster is re-fetched on each inbound to rebuild the id→name map (sessions
// store IDs only; names are not persisted, per spec).
async function rosterMaps() {
  const roster = await platform.getRoster();
  const techById = new Map((roster.technicians || []).map(t => [t.id, t.name]));
  const managerByPhone = new Map((roster.managers || []).map(m => [m.phone, m]));
  return { roster, techById, managerByPhone };
}

// Given a session and current roster, hydrate review_id → {tech_id, tech_name}
// for the pending set. Skips reviews already complete in the platform (cross-channel skip).
async function hydratePending(session, techById) {
  const out = [];
  const stillPending = [];
  for (const rid of session.pending_review_ids) {
    let r;
    try { r = await platform.getReview(rid); } catch (e) {
      if (e.status === 404) continue;
      throw e;
    }
    if (r.status === 'complete') continue;  // completed in app → drop
    stillPending.push(rid);
    out.push({ review_id: rid, tech_id: r.technician_id, tech_name: techById.get(r.technician_id) || r.technician_id });
  }
  // Mutate the session's pending set to reflect what's still actually pending.
  session.pending_review_ids = stillPending;
  return out;
}

// Send All from the launcher.
async function startBatch({ pairs }) {
  const batchId = crypto.randomUUID();
  const reviews = pairs.map(p => ({ manager_id: p.manager_id, technician_id: p.technician_id }));
  const batch = await platform.postReviewBatch({ batchId, reviews });

  const { techById, managerByPhone } = await rosterMaps();

  // Group sms-eligible created reviews by manager_phone.
  const byPhone = new Map();
  for (const c of batch.created || []) {
    if (!c.sms_eligible || !c.manager_phone) continue;
    if (!byPhone.has(c.manager_phone)) byPhone.set(c.manager_phone, []);
    byPhone.get(c.manager_phone).push(c);
  }

  let textedManagers = 0, textedReviews = 0;
  for (const [phone, created] of byPhone.entries()) {
    const reviewIds = created.map(c => c.review_id);
    const names = created.map(c => techById.get(c.technician_id) || c.technician_id);
    const original_count = reviewIds.length;

    const baseSession = {
      manager_phone: phone,
      company_id: process.env.COMPANY_ID || 'co_test',
      batch_id: batchId,
      pending_review_ids: reviewIds,
      current_review_id: null,
      pending_readiness: null,
      original_count,
      step: 'AWAITING_SELECTION',
    };

    if (original_count === 1) {
      baseSession.step = 'AWAITING_READINESS';
      baseSession.current_review_id = reviewIds[0];
      upsertSession(baseSession);
      const body = COPY.BATCH_SINGLE(names[0]);
      await sendOut(phone, body, 'startBatch.single');
    } else {
      upsertSession(baseSession);
      const body = COPY.BATCH_MULTI(original_count, names);
      await sendOut(phone, body, 'startBatch.multi');
    }
    textedManagers++;
    textedReviews += original_count;
  }

  return {
    batch_id: batchId,
    created: (batch.created || []).length,
    texted_managers: textedManagers,
    texted_reviews: textedReviews,
    app_only: (batch.created || []).filter(c => !c.sms_eligible).length,
  };
}

async function sendOut(phone, body, label) {
  await sendSMS(phone, body);
  logMessage({ phone, direction: 'out', body, parsed: null, stepBefore: null, stepAfter: label });
}

// Inbound handler — single entry point.
async function handleInbound({ from, body }) {
  let session = getSession(from);
  const stepBefore = session ? session.step : null;
  logMessage({ phone: from, direction: 'in', body, parsed: null, stepBefore, stepAfter: null });

  if (!session) {
    await sendOut(from, COPY.NO_SESSION, 'no-session');
    return;
  }

  const { techById } = await rosterMaps();

  // Always hydrate pending reviews from the platform (cross-channel skip on each turn).
  const pending = await hydratePending(session, techById);
  if (pending.length === 0) {
    // Everything was completed in the app between turns.
    deleteSession(from);
    const closer = session.original_count === 1
      ? COPY.SAVED_SINGLE(techById.get(session.current_review_id) || 'them')
      : COPY.BATCH_COMPLETE(session.original_count);
    await sendOut(from, closer, 'cross-channel-drain');
    return;
  }

  // current_review_id may have been completed in the app — drop it back to selection if so.
  if (session.current_review_id && !pending.find(p => p.review_id === session.current_review_id)) {
    session.current_review_id = null;
    session.pending_readiness = null;
    session.step = session.original_count === 1 ? 'AWAITING_READINESS' : 'AWAITING_SELECTION';
    if (session.step === 'AWAITING_READINESS' && pending.length === 1) {
      session.current_review_id = pending[0].review_id;
    }
  }

  const currentTech = session.current_review_id
    ? (pending.find(p => p.review_id === session.current_review_id) || null)
    : null;

  const pendingTechList = pending.map(p => ({ id: p.tech_id, name: p.tech_name }));
  const parsed = await parseReply({
    text: body,
    step: session.step,
    pending: pendingTechList,
    currentTech: currentTech ? { id: currentTech.tech_id, name: currentTech.tech_name } : null,
  });
  logMessage({ phone: from, direction: 'in', body: '(parsed)', parsed, stepBefore, stepAfter: null });

  if (parsed._help) { await sendOut(from, COPY.HELP, 'help'); return; }
  if (parsed._stop) { deleteSession(from); return; }  // Twilio Advanced Opt-Out handles the carrier-level ack.

  if (parsed.intent === 'done') {
    deleteSession(from);
    return;
  }

  // Branch on current step.
  if (session.step === 'AWAITING_SELECTION') {
    return handleSelection(session, from, parsed, pending, techById);
  }
  if (session.step === 'AWAITING_READINESS') {
    return handleReadiness(session, from, parsed, pending, techById);
  }
  if (session.step === 'AWAITING_NOTE') {
    return handleNote(session, from, parsed, body, pending, techById);
  }
  // Fallback — shouldn't happen.
  upsertSession(session);
}

async function handleSelection(session, from, parsed, pending, techById) {
  if (!parsed.tech_id) {
    await sendOut(from, COPY.UNCLEAR_SELECTION(pending.map(p => p.tech_name)), 'unclear-selection');
    upsertSession(session);
    return;
  }
  const match = pending.find(p => p.tech_id === parsed.tech_id);
  if (!match) {
    await sendOut(from, COPY.UNCLEAR_SELECTION(pending.map(p => p.tech_name)), 'unclear-selection');
    upsertSession(session);
    return;
  }

  session.current_review_id = match.review_id;

  // Compound: also carries a verdict?
  if (parsed.readiness) {
    session.pending_readiness = parsed.readiness;

    // Triple compound: also a note?
    if (parsed.note) {
      await writeAndAdvance(session, from, parsed.note, pending, techById);
      return;
    }

    session.step = 'AWAITING_NOTE';
    upsertSession(session);
    const copy = parsed.readiness === 'ready'
      ? COPY.ECHO_NOTE_READY(match.tech_name)
      : COPY.ECHO_NOTE_NOT_READY(match.tech_name);
    await sendOut(from, copy, 'echo+note (compound select)');
    return;
  }

  // Plain selection → ask readiness
  session.step = 'AWAITING_READINESS';
  upsertSession(session);
  await sendOut(from, COPY.READINESS_AFTER_SELECTION(match.tech_name), 'readiness-after-selection');
}

async function handleReadiness(session, from, parsed, pending, techById) {
  if (!parsed.readiness) {
    const t = pending.find(p => p.review_id === session.current_review_id);
    const name = t ? t.tech_name : 'them';
    await sendOut(from, COPY.UNCLEAR_VERDICT(name), 'unclear-verdict');
    upsertSession(session);
    return;
  }
  session.pending_readiness = parsed.readiness;

  // Compound: verdict + note → write now
  if (parsed.note) {
    await writeAndAdvance(session, from, parsed.note, pending, techById);
    return;
  }

  session.step = 'AWAITING_NOTE';
  upsertSession(session);
  const t = pending.find(p => p.review_id === session.current_review_id);
  const name = t ? t.tech_name : 'them';
  const copy = parsed.readiness === 'ready' ? COPY.ECHO_NOTE_READY(name) : COPY.ECHO_NOTE_NOT_READY(name);
  await sendOut(from, copy, 'echo+note');
}

async function handleNote(session, from, parsed, rawText, pending, techById) {
  // skip → null note; otherwise use parsed.note (if model extracted) else the raw text trimmed.
  let note;
  if (parsed.intent === 'skip') note = null;
  else if (parsed.note) note = parsed.note;
  else note = (rawText || '').trim() || null;

  await writeAndAdvance(session, from, note, pending, techById);
}

async function writeAndAdvance(session, from, note, pending, techById) {
  const reviewId = session.current_review_id;
  const finishedTech = pending.find(p => p.review_id === reviewId);
  const finishedName = finishedTech ? finishedTech.tech_name : 'them';

  try {
    await platform.postResult(reviewId, { readiness: session.pending_readiness, note });
  } catch (e) {
    if (e.status === 409) {
      // Already complete (cross-channel race). Treat as success; don't surface the error.
    } else {
      console.error('[result] platform error', e?.message || e, e?.body);
      throw e;
    }
  }

  // Remove from pending; refresh statuses again to catch any further cross-channel completions.
  session.pending_review_ids = session.pending_review_ids.filter(id => id !== reviewId);
  session.current_review_id = null;
  session.pending_readiness = null;

  const stillPending = await hydratePending(session, techById);

  if (stillPending.length === 0) {
    deleteSession(from);
    const closer = session.original_count === 1
      ? COPY.SAVED_SINGLE(finishedName)
      : COPY.BATCH_COMPLETE(session.original_count);
    await sendOut(from, closer, 'closer');
    return;
  }

  // More remain — back to selection
  session.step = 'AWAITING_SELECTION';
  upsertSession(session);
  await sendOut(from, COPY.SAVED_MORE(stillPending.map(p => p.tech_name)), 'saved-more');
}

module.exports = { startBatch, handleInbound };
