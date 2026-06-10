// Thin client against PLATFORM_BASE_URL — mirrors the API contract the mock
// implements. The mock has no service auth; when this gets pointed at the real
// platform, add a service token + the signed iframe context token here.
//
// TODO(real-platform): Authorization header with service token; pass-through of
// the signed iframe context token for caller-scoped reads.

const BASE = () => (process.env.PLATFORM_BASE_URL || '').replace(/\/$/, '');
const COMPANY = () => process.env.COMPANY_ID || 'co_test';

async function call(method, path, { query, body } = {}) {
  const url = new URL(BASE() + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = new Error(`Platform ${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.body = json ?? text;
    throw err;
  }
  return json;
}

async function getRoster() {
  return call('GET', '/api/ride-along/roster', { query: { company_id: COMPANY() } });
}

async function postReviewBatch({ batchId, reviews }) {
  return call('POST', '/api/ride-along/review-batch', {
    body: { company_id: COMPANY(), batch_id: batchId, reviews },
  });
}

async function getReview(reviewId) {
  return call('GET', `/api/ride-along/reviews/${encodeURIComponent(reviewId)}`);
}

async function postResult(reviewId, { readiness, note }) {
  return call('POST', `/api/ride-along/reviews/${encodeURIComponent(reviewId)}/result`, {
    body: {
      company_id: COMPANY(),
      readiness,
      note: note ?? null,
      channel: 'sms',
      completed_at: new Date().toISOString(),
    },
  });
}

module.exports = { getRoster, postReviewBatch, getReview, postResult };
