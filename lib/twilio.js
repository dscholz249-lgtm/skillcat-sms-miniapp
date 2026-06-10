const twilio = require('twilio');

function client() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSMS(to, body) {
  if (!process.env.TWILIO_MESSAGING_SERVICE_SID) {
    // Useful when running locally without Twilio configured — log and no-op.
    console.log(`[sms→${to}] ${body}`);
    return { sid: 'local-noop', noop: true };
  }
  return client().messages.create({
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    to,
    body,
  });
}

// Express middleware: validates X-Twilio-Signature against the configured
// PUBLIC_BASE_URL (Railway's proxy rewrites Host/protocol, so we cannot trust req).
function validateSignature(req, res, next) {
  // Local dev / smoke test: if no auth token, skip validation but mark request.
  if (!process.env.TWILIO_AUTH_TOKEN) {
    req.twilioUnverified = true;
    return next();
  }
  const signature = req.header('X-Twilio-Signature') || '';
  const url = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/twilio/inbound';
  const ok = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body || {},
  );
  if (!ok) return res.status(403).send('invalid twilio signature');
  next();
}

module.exports = { sendSMS, validateSignature };
