// Calls into the Next.js Logbook app's /api/internal/* routes (shared
// SYNC_SECRET, same as the startup roster sync). The Logbook app owns the
// technicians table and the invite email, so the SMS flow asks it to act.

function base() {
  const url = process.env.NEXTJS_URL;
  return url ? url.replace(/\/$/, '') : null;
}

async function call(path, body) {
  const root = base();
  if (!root) return { ok: false, status: 0, data: { error: 'NEXTJS_URL not set' } };
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.SYNC_SECRET) headers['Authorization'] = `Bearer ${process.env.SYNC_SECRET}`;
  try {
    const res = await fetch(`${root}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

/** → { ok, technicianId } | { ok: false, code: 'email_taken' | 'manager_not_found' | 'error' } */
async function createTechnician({ managerPhone, name, email }) {
  const r = await call('/api/internal/technicians', { manager_phone: managerPhone, name, email: email || null });
  if (r.ok && r.data.technician_id) return { ok: true, technicianId: r.data.technician_id };
  if (r.status === 409) return { ok: false, code: 'email_taken' };
  if (r.status === 404) return { ok: false, code: 'manager_not_found' };
  console.error('[logbook-api] create technician failed', r.status, r.data?.error);
  return { ok: false, code: 'error' };
}

async function inviteTechnician({ managerPhone, technicianId }) {
  const r = await call(`/api/internal/technicians/${encodeURIComponent(technicianId)}/invite`, { manager_phone: managerPhone });
  if (!r.ok) console.error('[logbook-api] invite failed', r.status, r.data?.error);
  return { ok: r.ok };
}

/** PRD-436: email the technician their course link. → { ok, emailed } */
async function emailCourseAssignment({ managerPhone, technicianId, courseName, courseLink }) {
  const r = await call('/api/internal/course-assignments', {
    manager_phone: managerPhone,
    technician_id: technicianId,
    course_name: courseName,
    course_link: courseLink,
  });
  if (!r.ok) console.error('[logbook-api] course email failed', r.status, r.data?.error);
  return { ok: r.ok, emailed: r.ok && r.data.emailed === true };
}

module.exports = { createTechnician, inviteTechnician, emailCourseAssignment };
