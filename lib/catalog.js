let _cache = [];
let _cacheTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

const CATALOG_URL = 'https://content.skillcathub.com/public/courses';

function stripHtml(s) {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function parseTable(html) {
  const courses = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let isFirst = true;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const rowHtml = m[1];
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRegex.exec(rowHtml)) !== null) {
      cells.push(stripHtml(cm[1]));
    }
    if (cells.length < 2) continue;
    if (isFirst) {
      isFirst = false;
      const first = cells[0].toLowerCase();
      if (first.includes('name') || first.includes('course') || first === '') continue;
    }
    if (!cells[0]) continue;
    courses.push({
      name: cells[0],
      hours: cells[1] || '',
      category: cells[3] || '',
    });
  }
  return courses;
}

async function getCatalog() {
  if (_cache.length && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  try {
    const res = await fetch(CATALOG_URL, {
      headers: { 'User-Agent': 'SkillCat-SMS/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parsed = parseTable(html);
    if (parsed.length > 0) {
      _cache = parsed;
      _cacheTime = Date.now();
      console.log(`[catalog] loaded ${parsed.length} courses`);
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

// Returns all courses whose names match query with the highest overlap score.
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
