let _cache = [];
let _cacheTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

// Public Supabase project for content.skillcathub.com — anon key is already
// embedded in the public JS bundle at that domain.
const SUPABASE_URL = 'https://mdiulditosmnaqhimcdh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kaXVsZGl0b3NtbmFxaGltY2RoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg2MzI5ODksImV4cCI6MjA3NDIwODk4OX0.qMpOcSP80rE8KB6Mfpmax41yW7pST0Mflta6K3qb-f0';

async function fetchFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/courses?select=course_name,course_category&course_status=eq.Live&order=course_name.asc&limit=500`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  const rows = await res.json();
  return rows
    .filter(r => r.course_name)
    .map(r => ({
      name: r.course_name,
      category: r.course_category || '',
    }));
}

async function getCatalog() {
  if (_cache.length && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  try {
    const courses = await fetchFromSupabase();
    if (courses.length > 0) {
      _cache = courses;
      _cacheTime = Date.now();
      console.log(`[catalog] loaded ${courses.length} courses from Supabase`);
    }
  } catch (e) {
    console.error('[catalog] fetch failed', e.message);
  }
  return _cache;
}

function searchCatalog(catalog, query) {
  if (!query || !catalog.length) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (!terms.length) return [];

  const scored = catalog.map(course => {
    const text = (course.name + ' ' + course.category).toLowerCase();
    const score = terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
    return { course, score };
  });

  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.course);
}

// Returns all courses whose names fuzzy-match `name` at the highest score.
// Returns [] if no overlap, [single] if unambiguous, [multiple] if ambiguous.
function fuzzyMatchCourse(catalog, name) {
  if (!name || !catalog.length) return [];
  const lower = name.toLowerCase().trim();

  // Exact match wins immediately
  const exact = catalog.filter(c => c.name.toLowerCase() === lower);
  if (exact.length === 1) return exact;

  const terms = lower.split(/\s+/).filter(t => t.length > 2);
  if (!terms.length) return [];

  const scored = catalog.map(course => {
    const cName = course.name.toLowerCase();
    const score = terms.reduce((s, t) => s + (cName.includes(t) ? 1 : 0), 0);
    return { course, score };
  });

  const best = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (!best.length) return [];

  const topScore = best[0].score;
  return best.filter(x => x.score === topScore).map(x => x.course);
}

module.exports = { getCatalog, searchCatalog, fuzzyMatchCourse };
