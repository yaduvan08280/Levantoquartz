// ============================================================
//  Mono — local knowledge retrieval (P13)
//  Token-overlap search (BM25-lite: idf-weighted, field-boosted)
//  over the compiled OKF concept index. Pure JS, no ML, no
//  network; a full scan of ~150 short records runs in well under
//  a millisecond. Imported by both the browser (localBrain,
//  copilot) and Node (server-side LLM grounding, tests).
// ============================================================
import CONCEPTS from './knowledge.generated.js';

const NOISE = new Set(['the', 'a', 'an', 'is', 'are', 'can', 'you', 'it', 'of', 'in', 'to', 'for', 'my', 'do', 'does', 'how', 'there', 'possible', 'with', 'and', 'or', 'on', 'this', 'that']);
const tokenize = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !NOISE.has(t));

// Pre-index once at module init: per-concept token sets + document freq.
const N = CONCEPTS.length;
const df = new Map();
const INDEX = CONCEPTS.map((c) => {
  const title = new Set(tokenize(c.title));
  const tags = new Set((c.tags || []).flatMap(tokenize));
  const body = new Set(c.tokens || []);
  for (const t of new Set([...title, ...tags, ...body])) df.set(t, (df.get(t) || 0) + 1);
  return { concept: c, title, tags, body, titleLower: String(c.title).toLowerCase() };
});
// A token the index has never seen is maximally informative (df→1), so a
// query about an unknown thing ("gantt") scores LOW against everything —
// that's what keeps possibility answers honest instead of fuzzy-matching
// to the nearest feature.
const idf = (t) => Math.log(1 + N / (df.get(t) || 1));

/**
 * @param {string} query - free text ("sum", "count non-empty", "kanban board")
 * @param {{type?: string, k?: number}} [opts] - type filters by concept
 *   type ('Formula Function' | 'App Feature'); k caps results (default 5)
 * @returns {Array<{concept: object, score: number}>} best-first; score 0..1-ish
 */
export function search(query, { type, k = 5 } = {}) {
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qLower = String(query).trim().toLowerCase();

  const hits = [];
  for (const doc of INDEX) {
    if (type && doc.concept.type !== type) continue;
    let raw = 0;
    for (const t of qTokens) {
      if (doc.title.has(t)) raw += 5 * idf(t);
      else if (doc.tags.has(t)) raw += 2.5 * idf(t);
      else if (t.length >= 3 && [...doc.title].some((w) => w.startsWith(t))) raw += 2 * idf(t); // 'count' → COUNTA/COUNTIF
      else if (doc.body.has(t)) raw += 1 * idf(t);
    }
    if (raw === 0) continue;
    if (doc.titleLower === qLower) raw *= 1.5; // exact-title bonus
    // normalize by best-case score so thresholds are query-length independent
    const best = qTokens.reduce((a, t) => a + 5 * idf(t), 0);
    hits.push({ concept: doc.concept, score: raw / best });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

/** All concepts (for grounding-context assembly). */
export function allConcepts() { return CONCEPTS; }

