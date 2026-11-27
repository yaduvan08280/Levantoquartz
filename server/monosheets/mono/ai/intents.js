// ============================================================
//  Mono — AI Intent Classification & OKF Parsing (P13, +P21)
//  Deterministic pre-pass: keyword/regex classification so the
//  common cases (formula requests, explain, analyze, capability
//  questions) never need an LLM round-trip.
//
//  P21: every entry point normalizes through normalizer.js first
//  (romanized Hinglish + Devanagari → canonical English tokens),
//  so "mujhe d2 se d9 ka jod chahiye", "जोड़ दो D2 से D9 तक" and
//  "give me the sum of d2:d9" all classify identically.
// ============================================================
import { normalizeQuery } from './normalizer.js';

// Operation words that imply a formula. Matched as whole words
// anywhere in the prompt (English + common Hinglish — Hinglish
// entries kept as belt-and-braces even though the normalizer
// canonicalizes most of them before we get here).
const FORMULA_WORDS = [
  'sum', 'total', 'add', 'adding', 'plus', 'subtotal', 'aggregate', 'jod', 'jodo',
  'average', 'avg', 'mean', 'median', 'mode',
  'count', 'counta', 'countif', 'tally', 'ginti', 'kitne', 'kitni',
  'min', 'minimum', 'smallest', 'lowest', 'least',
  'max', 'maximum', 'largest', 'biggest', 'highest', 'greatest',
  'product', 'multiply', 'concatenate', 'concat', 'join',
  'lookup', 'vlookup', 'xlookup', 'find',
  'stdev', 'variance', 'var', 'percentile', 'rank', 'correl',
  'round', 'roundup', 'rounddown', 'abs', 'sqrt', 'power',
  'subtract', 'minus', 'difference', 'divide', 'divided', 'times',
  'percent', 'percentage', 'unique', 'distinct', 'duplicate', 'duplicates',
  'len', 'length', 'uppercase', 'lowercase', 'trim', 'today',
];
const FORMULA_RE = new RegExp(`\\b(${FORMULA_WORDS.join('|')})\\b`, 'i');
// Phrases that also imply a formula even without a keyword above.
const FORMULA_PHRASE_RE = /\b(how many|how much|kitna|kitne|total of|formula (for|to)|calculate|compute|count of|number of|greater than|less than|percent of|ka (sum|total|jod)|se (upar|zyada|jyada|kam|neeche|niche)|round(ed)? (off )?to|square root|extra spaces|upper case|lower case|current (date|time))\b/i;
// A cell or A1 range anywhere ("d10", "d2:d9", "column d", "d se d9").
const CELLREF_RE = /\b[a-z]{1,3}\d{1,7}\b|\b[a-z]{1,3}\s*:\s*[a-z]{1,3}\b|\bcolumn\s+[a-z]{1,3}\b/i;

const EXPLAIN_RE = /\b(explain|what does|break down|meaning|matlab|समझा|samjha)\b/i;
const ANALYZE_RE = /\b(what'?s weird|weird|unusual|outlier|analyze|analyse|anomal|summ?ari[sz]e|any issues|anything wrong)\b/i;
const PATCH_RE = /^(?:please\s+|now\s+)?(standardize|standardise|clean|fix|format|change|make|remove|replace|split|merge|apply|put|write|insert|delete|sort|rename|set|highlight|color|colour|bold|unmerge|freeze|unfreeze|hide|unhide|move|copy|fill|convert|update)\b/i;
const QUESTION_RE = /\b(can (i|you|it)|is it possible|is there|are there|how (do|can) i|does (mono|it|this|the app)|what can)\b/i;

/** True if the prompt names any cell or range. Hinglish/Devanagari-safe. */
export function hasCellRef(prompt) { return CELLREF_RE.test(normalizeQuery(prompt).text); }
/** True if the prompt looks like a formula request (keyword or phrase). */
export function looksLikeFormula(prompt) {
  const p = normalizeQuery(prompt).text;
  return FORMULA_RE.test(p) || FORMULA_PHRASE_RE.test(p);
}

/**
 * Deterministic pre-pass classifier. Useful when offline.
 * Input is normalized (Hinglish → canonical English) before matching.
 * @returns {'explain'|'analyze'|'question'|'formula'|'patch'|'unknown'}
 */
export function classifyLocalIntent(prompt) {
  const p = normalizeQuery(prompt).text;
  if (EXPLAIN_RE.test(p)) return 'explain';
  if (ANALYZE_RE.test(p)) return 'analyze';
  // A formula request that also names a cell/range is a formula, even if
  // it's phrased as a question ("can you sum d2:d9?") — the local brain
  // can answer it, so don't divert it to the capability-question path.
  if (looksLikeFormula(p) && hasCellRef(p)) return 'formula';
  if (QUESTION_RE.test(p)) return 'question';
  if (looksLikeFormula(p)) return 'formula';
  if (PATCH_RE.test(p)) return 'patch';
  return 'unknown';
}

/**
 * Parses an OKF (Open Knowledge Format) response from the LLM.
 * The LLM is instructed to return JSON matching this schema:
 * {
 *   intent: "plan",
 *   plan: "markdown implementation plan",
 *   ops: [{...}] // optional, patch operations to execute
 *   formula: "=..." // optional, formula to insert
 * }
 */
export function parseOKF(responseString) {
  try {
    const data = JSON.parse(responseString);
    return {
      intent: data.intent || 'plan',
      plan: data.plan || '',
      ops: Array.isArray(data.ops) ? data.ops : [],
      formula: data.formula || '',
      reply: data.reply || ''
    };
  } catch (e) {
    return { intent: 'error', plan: 'Failed to parse OKF format from LLM.', ops: [] };
  }
}

