// In-memory per-sender rate limiter.
// Single-process safe (Railway runs one instance); resets on restart which is acceptable.

const WINDOW_MS = 60 * 1000; // 1 minute rolling window
const MAX_PER_WINDOW = 10;   // max messages per sender per window

/** @type {Map<string, { count: number; windowStart: number }>} */
const buckets = new Map();

// Prune stale entries every 5 minutes to avoid unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of buckets.entries()) {
    if (now - val.windowStart > WINDOW_MS) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * Returns true if the sender is within limits, false if they've exceeded them.
 * @param {string} phone E.164 phone number
 */
function checkRateLimit(phone) {
  const now = Date.now();
  const bucket = buckets.get(phone);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(phone, { count: 1, windowStart: now });
    return true;
  }

  bucket.count += 1;
  if (bucket.count > MAX_PER_WINDOW) {
    console.warn(`[rate-limit] ${phone} exceeded ${MAX_PER_WINDOW} msgs/min (count=${bucket.count})`);
    return false;
  }
  return true;
}

module.exports = { checkRateLimit };
