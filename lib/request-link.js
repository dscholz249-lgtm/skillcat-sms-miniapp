const crypto = require('crypto');

// Signed "Mark complete" link for Slack notifications. Opens the request page
// in the Logbook dashboard; the signature lets SkillCat staff in
// the Slack channel complete or ignore that one request without signing in.
// The dashboard verifies it with the same shared secret (its
// EXPRESS_API_SECRET == our API_SECRET) — keep the message format in sync with
// lib/request-link.ts there.

const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

function signRequestLink(id, exp, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`queue-link:v1:${id}:${exp}`)
    .digest('base64url');
}

// LOGBOOK_PUBLIC_URL is the address staff actually sign in at (the custom
// domain). Dashboard sessions are per-domain, so linking to the Railway URL
// would make signed-in staff look signed out. NEXTJS_URL stays the Railway
// URL for server-to-server calls (roster sync, emails) and is only a fallback
// here.
// Returns null when no dashboard URL or secret is configured, so the Slack
// message simply goes out without the link.
function requestLinkUrl(id) {
  const raw = process.env.LOGBOOK_PUBLIC_URL || process.env.NEXTJS_URL;
  const base = raw ? raw.replace(/\/$/, '') : null;
  const secret = process.env.API_SECRET;
  if (!base || !secret || !id) return null;
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const sig = signRequestLink(id, exp, secret);
  return `${base}/requests/${id}?exp=${exp}&sig=${sig}`;
}

module.exports = { requestLinkUrl, signRequestLink };
