// Thin Supabase REST client for the SMS miniapp.
// Uses service role key — server-side only, never exposed to clients.
// All functions return silently when env vars are absent so the app
// degrades gracefully if Supabase is not configured in dev.

const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

function configured() {
  return !!(SUPABASE_URL() && SUPABASE_KEY());
}

function authHeaders() {
  const key = SUPABASE_KEY();
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
  };
}

// Upsert one or many rows into `table`. Existing rows (matched by primary key)
// are updated; new rows are inserted. Non-blocking — caller does not await.
async function upsert(table, rows) {
  if (!configured()) return;
  const payload = Array.isArray(rows) ? rows : [rows];
  if (!payload.length) return;
  try {
    const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[supabase] upsert ${table} failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error(`[supabase] upsert ${table} error: ${err.message}`);
  }
}

// Fetch all rows from `table`, ordered by `order` (PostgREST syntax, e.g. "created_at.asc").
// Returns [] when Supabase is not configured or on error.
async function select(table, { order, limit } = {}) {
  if (!configured()) return [];
  const params = new URLSearchParams({ select: '*' });
  if (order) params.set('order', order);
  if (limit) params.set('limit', String(limit));
  try {
    const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${params}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[supabase] select ${table} failed: ${res.status} ${text}`);
      return [];
    }
    return await res.json();
  } catch (err) {
    console.error(`[supabase] select ${table} error: ${err.message}`);
    return [];
  }
}

module.exports = { upsert, select, configured };
