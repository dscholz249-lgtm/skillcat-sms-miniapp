// Opt-out notification.
//
// When someone texts STOP we can no longer reach them by SMS, so the only
// channel left is email — and for technicians without an email on file, the
// dashboard modal is the only channel at all.
//
// Twilio's Advanced Opt-Out may intercept STOP before our webhook sees it. In
// that case the opt-out is discovered later, when a send fails with error
// 21610, and this runs then instead. Delayed is acceptable; silent is not.

const { getEmployeeByPhone, getOptOut, markOptOutEmailSent } = require('../db');

async function notifyOptOut(phone) {
  const optOut = getOptOut(phone);
  if (!optOut) return;
  // Already notified for this opt-out event. email_sent_at is reset by
  // clearOptOut(), so opting out again later does send a fresh email.
  if (optOut.email_sent_at) return;

  const employee = getEmployeeByPhone(phone);
  if (!employee?.email) {
    // Nothing to send to — the dashboard modal is the fallback. Mark it so we
    // don't re-look-up on every subsequent failed send.
    markOptOutEmailSent(phone);
    console.log(`[opt-out] ${phone} has no email on file — dashboard modal only`);
    return;
  }

  const nextjsUrl = process.env.NEXTJS_URL?.replace(/\/$/, '');
  if (!nextjsUrl) {
    console.warn('[opt-out] NEXTJS_URL unset — cannot send opt-out email');
    return;
  }

  const syncSecret = process.env.SYNC_SECRET;
  try {
    const res = await fetch(`${nextjsUrl}/api/internal/opt-out-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(syncSecret ? { Authorization: `Bearer ${syncSecret}` } : {}),
      },
      body: JSON.stringify({
        email: employee.email,
        employeeName: employee.name,
        phone: optOut.phone,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`[opt-out] email send failed: HTTP ${res.status}`);
      return; // leave email_sent_at null so a later attempt can retry
    }
    markOptOutEmailSent(phone);
    console.log(`[opt-out] notified ${employee.email}`);
  } catch (e) {
    console.error('[opt-out] email send failed', e.message);
  }
}

module.exports = { notifyOptOut };
