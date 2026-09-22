// Outbound broadcast sending.
//
// The HTTP route creates the broadcast rows and returns immediately; this
// module drains the queued recipients in the background, one at a time. A
// synchronous send loop inside the request would blow the dashboard's server
// action timeout on any list of real size, and would leave no record of how
// far it got when it died.
//
// Single Express instance is assumed (same assumption the in-memory rate
// limiter already makes), so the in-flight guard below is enough to prevent a
// double drain.

const { sendSMS } = require('./twilio');
const {
  getBroadcast, getQueuedRecipients, markRecipientSent, markRecipientFailed,
  completeBroadcast, logMessage, findInterruptedBroadcasts, recordOptOut,
} = require('../db');

// Twilio's per-number throughput is roughly 1 msg/sec on a long code; the
// messaging service queues above that, but pacing keeps us off the ceiling
// and keeps a large send from monopolising the event loop.
const SEND_INTERVAL_MS = Number(process.env.BROADCAST_SEND_INTERVAL_MS || 250);

// Twilio error 21610 = the recipient has opted out at the carrier level.
const TWILIO_OPTED_OUT = 21610;

const OPT_OUT_FOOTER = 'Reply STOP to opt out.';

const draining = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Appended server-side rather than validated in the composer — a required
// footer that can be edited away isn't required.
function withOptOutFooter(body) {
  const trimmed = String(body || '').trim();
  if (/\bSTOP\b/.test(trimmed)) return trimmed;
  return `${trimmed}\n\n${OPT_OUT_FOOTER}`;
}

async function drainBroadcast(broadcastId) {
  if (draining.has(broadcastId)) return;
  draining.add(broadcastId);

  try {
    const broadcast = getBroadcast(broadcastId);
    if (!broadcast) {
      console.error(`[broadcast ${broadcastId}] not found — nothing to drain`);
      return;
    }

    const queued = getQueuedRecipients(broadcastId);
    console.log(`[broadcast ${broadcastId}] draining ${queued.length} recipient(s)`);

    for (const recipient of queued) {
      try {
        const message = await sendSMS(recipient.phone, broadcast.body);
        const messageLogId = logMessage({
          phone: recipient.phone,
          direction: 'out',
          body: broadcast.body,
          parsed: null,
          stepBefore: null,
          stepAfter: 'broadcast',
        });
        markRecipientSent(recipient.id, {
          twilioSid: message?.sid ?? null,
          messageLogId: Number(messageLogId),
        });
      } catch (err) {
        const code = err?.code ?? err?.status ?? 'unknown';
        markRecipientFailed(recipient.id, code);
        console.error(`[broadcast ${broadcastId}] ${recipient.phone} failed: ${code} — ${err?.message}`);
        // Carrier-level opt-out we hadn't recorded (Twilio's Advanced Opt-Out
        // can intercept STOP before our webhook sees it). Record it so the
        // next broadcast excludes them before we spend another message.
        if (Number(code) === TWILIO_OPTED_OUT) {
          recordOptOut(recipient.phone, 'twilio_21610');
        }
      }
      await sleep(SEND_INTERVAL_MS);
    }

    completeBroadcast(broadcastId);
    console.log(`[broadcast ${broadcastId}] complete`);
  } catch (err) {
    console.error(`[broadcast ${broadcastId}] drain aborted:`, err);
  } finally {
    draining.delete(broadcastId);
  }
}

// Called at boot. Anything still 'sending' was cut off by a container restart;
// its queued recipients have not been sent to, so they are safe to resume.
function resumeInterruptedBroadcasts() {
  const ids = findInterruptedBroadcasts();
  if (!ids.length) return;
  console.log(`[broadcast] resuming ${ids.length} interrupted broadcast(s)`);
  for (const id of ids) {
    drainBroadcast(id).catch(err => console.error('[broadcast] resume failed', err));
  }
}

module.exports = { drainBroadcast, resumeInterruptedBroadcasts, withOptOutFooter, OPT_OUT_FOOTER };
