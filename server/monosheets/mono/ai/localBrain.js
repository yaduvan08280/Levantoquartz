// ============================================================
//  Mono — local brain (P13, +P21): deterministic NL → formula,
//  zero network. Backs the copilot's instant path: "sum of d2 to
//  d9 in d10" → =SUM(D2:D9) with an Apply button, no API key.
//
//  P21 upgrades: every query first passes through normalizer.js
//  (romanized Hinglish + Devanagari → canonical English tokens),
//  and the matcher set grew from 3 shapes (aggregate, conditional,
//  vlookup) to 10 (+ IF/agar-toh, percent, two-cell arithmetic,
//  text ops, duplicates, nth-largest, date constants) — the PDF
//  plan's "solve ~50% of queries offline" fast path.
//
//  Grounding: operation words resolve through knowledge.search
//  over the OKF bundle compiled from the real formula registry,
//  and a formula is only ever returned when registry.has(name) —
//  the brain cannot propose a function this engine doesn't have.
//  Anything it can't parse confidently returns {confidence: 0}
//  and copilot.js falls through to the LLM tiers (local Ollama →
//  API key → an honest "needs an API key" message).
// ============================================================
// Side-effect imports: populate the FULL function registry (all ~436
// catalog functions) so registry.has() gating and the token->function
// path see the same engine the grid runs. Order mirrors engine.js;
// arrayflags must be last.
import '../engine/builtins.js';
import '../engine/builtins_array.js';
import '../engine/builtins_math2.js';
import '../engine/builtins_stats.js';
import '../engine/builtins_text2.js';
import '../engine/builtins_datetime2.js';
import '../engine/builtins_financial.js';
import '../engine/builtins_engineering.js';
import '../engine/builtins_misc.js';
import '../engine/builtins_arrayflags.js';
import { registry } from '../engine/registry.js';
import { search } from './knowledge.js';
import { normalizeQuery } from './normalizer.js';
import { colToLetters, lettersToCol } from '../model/workbook.js';

/* ---------- A1 helpers ---------- */
const cellRefToRC = (letters, digits) => ({ r: parseInt(digits, 10) - 1, c: lettersToCol(letters) });
const CELL = '([a-z]{1,3})(\\d{1,7})';
// Natural connectors that join the two ends of a range: English + Hinglish.
// "d2 to d9", "d2 se d9", "d2 through d9", "d2 upto d9", "d2 tak d9".
const RANGE_JOINER = '(?::|to|through|thru|till|until|upto|up\\s*to|se|tak)';
// Words that introduce an explicit target cell: "in", "into", "at", "me", "mein", "par".
const TARGET_INTRO = '(?:in|into|at|inside|me|mein|par|pe)';

/* ---------- parsing ---------- */

/**
 * Pulls an explicit single-cell target ("in D10" / "into D10" / "d10 me")
 * out of the text. A range after the intro ("in C:C") is NOT a target —
 * hence the lookahead rejecting ':' or more digits.
 * @returns {{ target: {r,c}|null, rest: string }}
 */
function extractTarget(text) {
  // "in D10" / "into cell D10" / "at D10"
  const pre = new RegExp(`\\b${TARGET_INTRO}\\s+(?:cell\\s+)?${CELL}\\b(?![:\\d])`, 'ig');
  let target = null, match, last = null;
  while ((match = pre.exec(text))) last = match;
  if (last) {
    target = cellRefToRC(last[1], last[2]);
    return { target, rest: text.slice(0, last.index) + ' ' + text.slice(last.index + last[0].length) };
  }
  // Hinglish postfix: "D10 me" / "D10 mein" / "D10 par" — cell BEFORE the intro word
  const post = new RegExp(`\\b${CELL}\\s+(?:me|mein|par|pe)\\b`, 'ig');
  while ((match = post.exec(text))) {
    // "a1:a20 me" — that cell is the tail of a RANGE, not a target
    const before = text.slice(0, match.index).replace(/\s+$/, '');
    if (before.endsWith(':')) continue;
    last = match;
  }
  if (last) {
    target = cellRefToRC(last[1], last[2]);
    return { target, rest: text.slice(0, last.index) + ' ' + text.slice(last.index + last[0].length) };
  }
  return { target: null, rest: text };
}

/**
 * Extracts the source range from the text.
 * Handles "d2:d9", "d2 to d9", "d2 se d9", "c:c", "column d".
 * @returns {{ range: string|null, rest: string }} range in A1 (uppercased)
 */
function extractRange(text) {
  const cellPair = new RegExp(`\\b${CELL}\\s*${RANGE_JOINER}\\s*${CELL}\\b`, 'i');
  let m = text.match(cellPair);
  if (m) {
    const a = `${m[1].toUpperCase()}${m[2]}`, b = `${m[3].toUpperCase()}${m[4]}`;
    return { range: `${a}:${b}`, rest: text.replace(m[0], ' ') };
  }
  const colPair = /\b([a-z]{1,3}):([a-z]{1,3})\b/i;
  m = text.match(colPair);
  if (m) return { range: `${m[1].toUpperCase()}:${m[2].toUpperCase()}`, rest: text.replace(m[0], ' ') };
  // Hinglish particles can trail "column" ("B column ka ausat") — never
  // treat them as the column letter; also accept the "<letter> column" order.
  const NOT_COLS = /^(?:ka|ki|ke|ko|se|me|na|par|pe|tak|aur|or|ho|to|of|in|at|is)$/i;
  const colWord = /\b(?:column|col|columns)\s+([a-z]{1,3})\b/i;
  m = text.match(colWord);
  if (m && !NOT_COLS.test(m[1])) { const L = m[1].toUpperCase(); return { range: `${L}:${L}`, rest: text.replace(m[0], ' ') }; }
  const colWordPre = /\b([a-z]{1,3})\s+(?:column|col)\b/i;
  m = text.match(colWordPre);
  if (m && !NOT_COLS.test(m[1])) { const L = m[1].toUpperCase(); return { range: `${L}:${L}`, rest: text.replace(m[0], ' ') }; }
  const single = new RegExp(`\\b${CELL}\\b`, 'i');
  m = text.match(single);
  if (m) return { range: `${m[1].toUpperCase()}${m[2]}`, rest: text.replace(m[0], ' ') };
  return { range: null, rest: text };
}

const STOPWORDS = new Set([
  'of', 'the', 'a', 'an', 'cell', 'cells', 'value', 'values', 'range', 'from', 'for', 'and',
  'please', 'me', 'my', 'give', 'put', 'show', 'get', 'what', 'whats', 'is', 'are', 'it',
  'calculate', 'compute', 'formula', 'in', 'into', 'all', 'this', 'that', 'to', 'want',
  'i', 'need', 'chahiye', 'chahta', 'chahti', 'hu', 'hoon', 'ka', 'ki', 'ke', 'ko', 'mujhe',
  'mera', 'meri', 'karo', 'kar', 'do', 'tell', 'result', 'answer',
  // P21: leftovers the normalizer doesn't drop (structural / filler)
  'se', 'tak', 'par', 'pe', 'aur', 'or', 'hai', 'hain', 'ho', 'na', 'ab', 'ye', 'yeh',
  'wo', 'woh', 'iska', 'uska', 'kaunsa', 'konsa', 'kaun', 'which', 'then', 'make', 'write',
]);
const opPhrase = (text) => text.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w && !STOPWORDS.has(w)).join(' ');

/* ---------- operation → function (grounded) ---------- */

// Direct synonym → function map. The strongest signal; every entry is
// still gated on registry.has() below so nothing unregistered escapes.
// English + Hinglish. Order matters only within specialCaseFn.
const SYNONYMS = {
  sum: 'SUM', add: 'SUM', 'add up': 'SUM', plus: 'SUM', total: 'SUM', totals: 'SUM',
  jod: 'SUM', jodo: 'SUM', addition: 'SUM', sumup: 'SUM',
  average: 'AVERAGE', avg: 'AVERAGE', mean: 'AVERAGE', averages: 'AVERAGE', ausat: 'AVERAGE',
  median: 'MEDIAN', mode: 'MODE',
  count: 'COUNT', counta: 'COUNTA', tally: 'COUNTA', ginti: 'COUNT', 'how many': 'COUNTA',
  min: 'MIN', minimum: 'MIN', smallest: 'MIN', lowest: 'MIN', least: 'MIN', 'sabse kam': 'MIN',
  max: 'MAX', maximum: 'MAX', largest: 'MAX', biggest: 'MAX', highest: 'MAX', greatest: 'MAX', 'sabse zyada': 'MAX',
  product: 'PRODUCT', multiply: 'PRODUCT',
  stdev: 'STDEV', 'standard deviation': 'STDEV', variance: 'VAR',
  'square root': 'SQRT', unique: 'COUNTUNIQUE', distinct: 'COUNTUNIQUE',
};

// Deterministic overrides where the surrounding phrase carries semantics.
// P21: word order is free ("count blank" / "blank cells how many" — the
// normalizer turns "khali cells kitne" into the latter).
function specialCaseFn(phrase) {
  const countish = /\b(?:count|how many|number)\b/.test(phrase);
  if (countish && /\bnon[- ]?empty\b|\bfilled(?:\s*in)?\b|\bnot\s+empty\b/.test(phrase)) return 'COUNTA';
  if (countish && /\b(?:blank|empty)\b/.test(phrase)) return 'COUNTBLANK';
  if (countish && /\b(?:unique|distinct)\b/.test(phrase)) return 'COUNTUNIQUE';
  return null;
}

/** Resolve an operation phrase to a registered function name, or null. */
function resolveFunction(phrase) {
  const special = specialCaseFn(phrase);
  if (special && registry.has(special)) return { name: special, score: 1 };
  if (!phrase) return null;
  // 1) exact synonym hit on any token (or 2-word synonym) — highest confidence
  const words = phrase.split(/\s+/);
  for (const w of words) if (SYNONYMS[w] && registry.has(SYNONYMS[w])) return { name: SYNONYMS[w], score: 1 };
  for (let i = 0; i < words.length - 1; i++) { const pair = words[i] + ' ' + words[i + 1]; if (SYNONYMS[pair] && registry.has(SYNONYMS[pair])) return { name: SYNONYMS[pair], score: 1 }; }
  // 2) a token that IS a registered function name (e.g. "roundup", "sqrt")
  for (const w of words) if (registry.has(w)) return { name: w.toUpperCase(), score: 0.9 };
  // 3) fall back to the knowledge index (grounded), never an unregistered name
  const [top] = search(phrase, { type: 'Formula Function', k: 1 });
  if (!top || top.score < 0.3) return null;
  if (!registry.has(top.concept.title)) return null;
  return { name: top.concept.title, score: top.score };
}

/** Find the sheet column (0-based) whose header text matches `name`. */
function columnByHeader(headers, name) {
  if (!Array.isArray(headers)) return -1;
  const want = String(name).trim().toLowerCase();
  let idx = headers.findIndex((h) => String(h).trim().toLowerCase() === want);
  if (idx === -1) idx = headers.findIndex((h) => String(h).trim().toLowerCase().includes(want)); // loose
  return idx;
}
/** Quote a criterion value for a formula string: numbers bare, text quoted. */
function critLiteral(v) {
  const t = String(v).trim();
  if (t === '' ) return '""';
  if (/^[<>=!]/.test(t)) return `"${t}"`;       // operator form: ">5", "<>x"
  return Number.isFinite(Number(t)) ? t : `"${t}"`;
}

/* ---------- public API ---------- */

/**
 * Deterministic NL → formula. Zero network, sub-millisecond.
 * @param {string} text - the user's request (English / Hinglish / Devanagari)
 * @param {{activeCell?: {r,c}, headers?: string[]}} [context]
 * @returns {{formula, targetCell, confidence, explanation} | {confidence: 0, reason}}
 */
export function localFormula(text, context = {}) {
  // P21: Hinglish (romanized + Devanagari) → canonical English pre-pass.
  const raw = normalizeQuery(text).text;
  if (!raw) return { confidence: 0, reason: 'empty request' };
  const { target: explicitTarget, rest: afterTarget } = extractTarget(raw);
  const targetOr = (c) => explicitTarget || c || context.activeCell || null;
  const explainTarget = (tc) => tc ? `, result in ${colToLetters(tc.c)}${tc.r + 1}` : '';
  const withTarget = (hit) => ({ formula: hit.formula, targetCell: targetOr(null), confidence: hit.confidence, explanation: hit.explanation });

  // ---- conditional aggregates: "count/sum/average <col> where <col> = <val>" ----
  const cond = matchConditional(raw, context.headers);
  if (cond) {
    if (cond.error) return { confidence: 0, reason: cond.error };
    return withTarget(cond);
  }

  // ---- P21 deterministic matchers (each returns null when its shape
  //      doesn't apply; order: most-specific first) ----
  const hit =
    matchIf(afterTarget, context.headers) ||
    matchPercent(afterTarget) ||
    matchArithmetic(afterTarget) ||
    matchTextOp(afterTarget) ||
    matchDuplicates(afterTarget) ||
    matchNth(afterTarget) ||
    matchDateConst(afterTarget);
  if (hit) return withTarget(hit);

  // If target extraction ate the only cell ("characters in a2" — that "in
  // a2" was the SOURCE), retry the source-centric matchers on the full
  // text; the result lands in the active cell.
  if (explicitTarget) {
    const retry = matchTextOp(raw) || matchPercent(raw) || matchArithmetic(raw);
    if (retry) return { ...retry, targetCell: context.activeCell || null };
  }

  // ---- VLOOKUP: "look up <key> in <range> return column <n>" ----
  const vl = matchVlookup(raw);
  if (vl) return withTarget(vl);

  // ---- single-range aggregate (the SUM family) ----
  const { range, rest: afterRange } = extractRange(afterTarget);
  if (!range) return { confidence: 0, reason: 'no source range found (expected e.g. D2:D9, "d2 to d9", or "column D")' };

  const phrase = opPhrase(afterRange);
  const fn = resolveFunction(phrase);
  if (!fn) return { confidence: 0, reason: `no registered function matches "${phrase || raw}"` };

  const def = registry.get(fn.name);
  if ((def.min ?? 0) > 1) return { confidence: 0, reason: `${fn.name} needs ${def.min}+ arguments — too ambiguous to build locally` };

  // "sum d2:d9 rounded to 2" → =ROUND(SUM(D2:D9),2)
  const wrap = afterRange.match(/\bround(?:ed)?\s*(?:off\s*)?(?:to|upto|up\s*to)?\s*(\d+)\b/i);
  const body = `${fn.name}(${range})`;
  const formula = wrap && registry.has('ROUND') && fn.name !== 'ROUND'
    ? `=ROUND(${body},${wrap[1]})` : `=${body}`;

  const targetCell = targetOr(null);
  const confidence = Math.min(0.95, (explicitTarget ? 0.55 : 0.4) + 0.4 * fn.score);
  return {
    formula,
    targetCell,
    confidence,
    explanation: `${fn.name} over ${range}${wrap ? `, rounded to ${wrap[1]} digits` : ''}${explainTarget(targetCell)}.`,
  };
}

/**
 * Detects conditional-aggregate requests and builds COUNTIF/SUMIF/AVERAGEIF.
 * Needs sheet headers to resolve column names. Returns null if the shape
 * doesn't match, or {error} if it matches but a header is missing.
 */
function matchConditional(raw, headers) {
  const t = raw.toLowerCase();
  // Must express a "where <col> <op> <val>" condition to be a conditional aggregate.
  const where = t.match(/(?:where|with|have|has|jaha|jahan|jinka|jinke|jiska|jiski|whose|having)\s+([a-z0-9 _-]+?)\s*(==?|!=|<>|>=|<=|>|<|is|equals?|=|barabar)\s*["']?([^"']+?)["']?\s*$/i);
  let condColName, opRaw, rhs, whereIdx;
  if (where) {
    condColName = where[1].trim();
    opRaw = where[2].trim().toLowerCase();
    rhs = where[3].trim();
    whereIdx = where.index;
  } else {
    // Operator-less Hinglish: "kitne rows jinka status done (hai)" — the
    // copula was dropped by the normalizer, leaving <col> <val> bare.
    const loose = t.match(/(?:jinka|jinke|jiska|jiski|jaha|jahan|whose)\s+([a-z0-9 _-]+?)\s+([a-z0-9._-]+)\s*$/i);
    if (!loose || !headers || columnByHeader(headers, loose[1].trim()) === -1) return null;
    condColName = loose[1].trim();
    opRaw = 'is';
    rhs = loose[2].trim();
    whereIdx = loose.index;
  }
  const op = { 'is': '', 'equals': '', 'equal': '', '=': '', '==': '', 'barabar': '', '!=': '<>', '<>': '<>', '>=': '>=', '<=': '<=', '>': '>', '<': '<' }[opRaw] ?? '';
  const condCol = columnByHeader(headers, condColName);
  if (condCol === -1) return { error: `no column header matches "${condColName}"` };
  const condL = colToLetters(condCol);
  const crit = op ? `"${op}${rhs}"` : critLiteral(rhs);

  // Which aggregate? Look at the leading verb / value column.
  const head = t.slice(0, whereIdx);
  // "sum <col> where…" / "average <col> where…" name a VALUE column.
  const sumMatch = head.match(/\b(sum|total|add up|add)\s+(?:of\s+|the\s+)?([a-z0-9 _-]+?)\s*$/);
  const avgMatch = head.match(/\b(average|avg|mean)\s+(?:of\s+|the\s+)?([a-z0-9 _-]+?)\s*$/);
  if ((sumMatch || avgMatch) && headers) {
    const isAvg = !!avgMatch;
    const valName = (isAvg ? avgMatch[2] : sumMatch[2]).trim();
    const valCol = columnByHeader(headers, valName);
    if (valCol === -1) return { error: `no column header matches "${valName}"` };
    const valL = colToLetters(valCol);
    const fn = isAvg ? 'AVERAGEIF' : 'SUMIF';
    if (!registry.has(fn)) return { error: `${fn} is not available` };
    return {
      formula: `=${fn}(${condL}:${condL}, ${crit}, ${valL}:${valL})`,
      confidence: 0.8,
      explanation: `${isAvg ? 'Averages' : 'Sums'} ${headers[valCol]} where ${headers[condCol]} ${op || '='} ${rhs}.`,
    };
  }
  // otherwise it's a COUNT: "how many … where status = done", "count where …"
  if (!registry.has('COUNTIF')) return { error: 'COUNTIF is not available' };
  return {
    formula: `=COUNTIF(${condL}:${condL}, ${crit})`,
    confidence: 0.8,
    explanation: `Counts rows where ${headers[condCol]} ${op || '='} ${rhs} (column ${condL}).`,
  };
}

/* ================== P21 deterministic matchers ==================
   Each returns { formula, confidence, explanation } or null. All
   consume NORMALIZED text (Hinglish already canonicalized), and
   every function name is gated on registry.has(). */

const NUM_RE = '(-?\\d+(?:\\.\\d+)?)';

/**
 * "if <ref> > 5000 then X else Y" and the Hinglish postfix order
 * "if <ref> 5000 se upar then X else Y" ("agar/toh/warna" arrives
 * canonicalized as if/then/else). <ref> is a cell or a header name
 * (resolved to row 2, the first data row). "10%"-style values become
 * <ref>*10/100 — "agar sales 5000 se upar toh bonus 10% warna 0" →
 * =IF(E2>5000,E2*10/100,0).
 */
function matchIf(text, headers) {
  const t = String(text).toLowerCase();
  if (!/\bif\b/.test(t) || !registry.has('IF')) return null;
  const REF = '([a-z]{1,3}\\d{1,7}|[a-z][a-z0-9 _-]*?)';
  const OP = '(>=|<=|<>|!=|=|>|<|greater than or equal to|less than or equal to|greater than|more than|bigger than|above|over|less than|smaller than|below|under|equals?(?: to)?|is)';
  let ref, opRaw, num;
  let m = t.match(new RegExp(`\\bif\\s+${REF}\\s+(?:is\\s+)?${OP}\\s*${NUM_RE}`));
  if (m) { [, ref, opRaw, num] = m; }
  else {
    m = t.match(new RegExp(`\\bif\\s+${REF}\\s+${NUM_RE}\\s+se\\s+(upar|zyada|jyada|adhik|bada|badi|kam|neeche|niche|chota|choti)\\b`));
    if (!m) return null;
    ref = m[1]; num = m[2];
    opRaw = /kam|neeche|niche|chota|choti/.test(m[3]) ? '<' : '>';
  }
  const OPMAP = {
    '>=': '>=', '<=': '<=', '<>': '<>', '!=': '<>', '>': '>', '<': '<', '=': '=',
    'greater than or equal to': '>=', 'less than or equal to': '<=',
    'greater than': '>', 'more than': '>', 'bigger than': '>', 'above': '>', 'over': '>',
    'less than': '<', 'smaller than': '<', 'below': '<', 'under': '<',
    'equals': '=', 'equals to': '=', 'equal': '=', 'equal to': '=', 'is': '=',
  };
  const op = OPMAP[opRaw.trim()] || '=';
  let refA1;
  if (/^[a-z]{1,3}\d{1,7}$/.test(ref.trim())) refA1 = ref.trim().toUpperCase();
  else {
    const col = columnByHeader(headers, ref.trim());
    if (col === -1) return null;               // unknown header — let an LLM tier try
    refA1 = `${colToLetters(col)}2`;           // first data row
  }
  const tail = t.slice(m.index + m[0].length);
  const tm = tail.match(/\b(?:then|toh|to)\b\s+(.+?)(?:\s+\b(?:else|otherwise|warna)\b\s+(.+))?\s*$/);
  if (!tm) return null;
  const val = (v) => {
    const s = String(v).trim().replace(/^["']|["']$/g, '');
    const pct = s.match(/(-?\d+(?:\.\d+)?)\s*(?:%|percent)/);
    if (pct) return `${refA1}*${pct[1]}/100`;
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return s;
    if (/^[a-z]{1,3}\d{1,7}$/i.test(s)) return s.toUpperCase();
    const lastNum = s.match(/-?\d+(?:\.\d+)?$/);   // "bonus 500" → 500
    if (lastNum) return lastNum[0];
    return `"${s}"`;
  };
  const a = val(tm[1]);
  const b = tm[2] != null ? val(tm[2]) : (/^-?\d|\*/.test(a) ? '0' : '""');
  return {
    formula: `=IF(${refA1}${op}${num},${a},${b})`,
    confidence: 0.72,
    explanation: `IF ${refA1} ${op} ${num} → ${a}, otherwise ${b}.`,
  };
}

/** "10% of d2" / "d2 ka 10%" / "15 percent of d2:d9" → =D2*10/100 / =SUM(D2:D9)*15/100 */
function matchPercent(text) {
  const t = String(text).toLowerCase();
  const REF = '([a-z]{1,3}\\d{1,7}(?:\\s*:\\s*[a-z]{1,3}\\d{1,7})?)';
  let n, ref;
  let m = t.match(new RegExp(`${NUM_RE}\\s*(?:%|percent)\\s+(?:of\\s+)?${REF}\\b`));
  if (m) { n = m[1]; ref = m[2]; }
  else {
    m = t.match(new RegExp(`${REF}\\s+k[aie]\\s+${NUM_RE}\\s*(?:%|percent)`));
    if (!m) return null;
    ref = m[1]; n = m[2];
  }
  ref = ref.replace(/\s+/g, '').toUpperCase();
  const isRange = ref.includes(':');
  if (isRange && !registry.has('SUM')) return null;
  const expr = isRange ? `SUM(${ref})` : ref;
  return { formula: `=${expr}*${n}/100`, confidence: 0.8, explanation: `${n}% of ${isRange ? `the total of ${ref}` : ref}.` };
}

const arith = (a, sym, b) => ({
  formula: `=${a}${sym}${b}`,
  confidence: 0.85,
  explanation: `Computes ${a} ${sym} ${b}.`,
});

/**
 * Two-operand arithmetic: "a2 plus b2", "a2 - 5", "subtract b2 from a2",
 * "difference of a2 and b2", "sum a2 and b2", "a2 se b2 subtract"
 * ("a2 se b2 ghatao"). Runs before the aggregate path so MINUS/DIVIDE
 * never get declined as "needs 2+ arguments".
 */
function matchArithmetic(text) {
  const t = String(text).toLowerCase();
  const C = '([a-z]{1,3}\\d{1,7})';
  const V = '([a-z]{1,3}\\d{1,7}|-?\\d+(?:\\.\\d+)?)';
  const up = (x) => /^[a-z]/i.test(x) ? x.toUpperCase() : x;
  let m;
  if ((m = t.match(new RegExp(`\\bsubtract\\s+${V}\\s+from\\s+${C}\\b`))))
    return arith(up(m[2]), '-', up(m[1]));
  if ((m = t.match(new RegExp(`${C}\\s+(?:me\\s+)?se\\s+${V}\\s+subtract`))))
    return arith(up(m[1]), '-', up(m[2]));
  if ((m = t.match(new RegExp(`\\b(?:difference|gap)\\s+(?:of|between)\\s+${C}\\s+(?:and|aur)\\s+${V}`))))
    return arith(up(m[1]), '-', up(m[2]));
  if ((m = t.match(new RegExp(`\\b(?:sum|add|total)\\b\\s+(?:of\\s+)?${C}\\s+(?:and|aur|\\+)\\s*${C}\\b(?!\\s*[:\\d])`))))
    return arith(up(m[1]), '+', up(m[2]));
  if ((m = t.match(new RegExp(`${C}\\s+(?:and|aur)\\s+${C}\\s+(?:ka\\s+)?(?:sum|total)`))))
    return arith(up(m[1]), '+', up(m[2]));
  const OPS = [
    ['\\+|plus', '+'],
    ['-|minus', '-'],
    ['\\*|×|x|times|multiplied\\s+by|multiply\\s+by', '*'],
    ['/|÷|divided\\s+by|divide\\s+by|upon', '/'],
  ];
  for (const [pat, sym] of OPS) {
    m = t.match(new RegExp(`${C}\\s*(?:${pat})\\s*${V}\\b`));
    if (m) return arith(up(m[1]), sym, up(m[2]));
  }
  return null;
}

/** UPPER/LOWER/PROPER/TRIM/LEN on a single cell, CONCATENATE on two. */
function matchTextOp(text) {
  const t = String(text).toLowerCase();
  const C = '([a-z]{1,3}\\d{1,7})';
  const cell = (s) => s.toUpperCase();
  let m;
  if ((m = t.match(new RegExp(`\\b(?:concat(?:enate)?|combine|join)\\b.*?${C}\\s+(?:and|aur|with|,)\\s*${C}`)))
      || (m = t.match(new RegExp(`${C}\\s+(?:and|aur|with)\\s+${C}\\s+(?:ka\\s+)?(?:concat(?:enate)?|combine|join)`)))) {
    if (registry.has('CONCATENATE')) return { formula: `=CONCATENATE(${cell(m[1])},${cell(m[2])})`, confidence: 0.75, explanation: `Joins the text of ${cell(m[1])} and ${cell(m[2])}.` };
    return { formula: `=${cell(m[1])}&${cell(m[2])}`, confidence: 0.7, explanation: `Joins ${cell(m[1])} and ${cell(m[2])}.` };
  }
  const single = (re, fn, what) => {
    if (!re.test(t) || !registry.has(fn)) return null;
    const c = t.match(new RegExp(`\\b${C}\\b`));
    if (!c) return null;
    return { formula: `=${fn}(${cell(c[1])})`, confidence: 0.78, explanation: `${what} of ${cell(c[1])}.` };
  };
  return single(/\b(?:uppercase|upper\s*case|capitals?|capitalize)\b/, 'UPPER', 'Uppercase text')
      || single(/\b(?:lowercase|lower\s*case|small\s+letters?)\b/, 'LOWER', 'Lowercase text')
      || single(/\b(?:proper\s*case|title\s*case)\b/, 'PROPER', 'Title-case text')
      || single(/\b(?:trim\b|extra\s+spaces?|whitespace)/, 'TRIM', 'Trimmed text')
      || single(/\b(?:length|len\b|characters?\b)/, 'LEN', 'Character count')
      || null;
}

/** "count duplicates in a:a" → =COUNTA(A:A)-COUNTUNIQUE(A:A) */
function matchDuplicates(text) {
  const t = String(text).toLowerCase();
  if (!/\bduplicates?\b/.test(t) || !/\b(?:count|how many|number)\b/.test(t)) return null;
  if (!registry.has('COUNTA') || !registry.has('COUNTUNIQUE')) return null;
  const { range } = extractRange(t);
  if (!range || !range.includes(':')) return null;
  return {
    formula: `=COUNTA(${range})-COUNTUNIQUE(${range})`,
    confidence: 0.7,
    explanation: `Counts duplicate entries in ${range} (total minus unique).`,
  };
}

/** "3rd largest in a1:a20" → =LARGE(A1:A20,3); smallest → SMALL. */
function matchNth(text) {
  const t = String(text).toLowerCase();
  const m = t.match(/\b(?:(\d+)(?:st|nd|rd|th)?|second|third)\s+(largest|biggest|highest|smallest|lowest)\b/);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : (/second/.test(m[0]) ? 2 : 3);
  if (!n || n < 1) return null;
  const fn = /largest|biggest|highest/.test(m[2]) ? 'LARGE' : 'SMALL';
  if (!registry.has(fn)) return null;
  const { range } = extractRange(t.replace(m[0], ' '));
  if (!range) return null;
  const ord = n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  return {
    formula: `=${fn}(${range},${n})`,
    confidence: 0.75,
    explanation: `${ord} ${fn === 'LARGE' ? 'largest' : 'smallest'} value in ${range}.`,
  };
}

/** "aaj ki date" / "today's date" → =TODAY(); "current time" → =NOW(). */
function matchDateConst(text) {
  const t = String(text).toLowerCase().trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (registry.has('TODAY') && (/\btoday'?s?\s+(?:ki\s+)?date\b|\bcurrent\s+date\b|\bdate\s+today\b/.test(t) || (words.length <= 3 && /\btoday\b/.test(t))))
    return { formula: '=TODAY()', confidence: 0.7, explanation: `Today's date (updates automatically).` };
  if (registry.has('NOW') && (/\bcurrent\s+time\b|\btime\s+now\b|\bnow\s+ka\s+time\b|\bdate\s+and\s+time\b/.test(t) || (words.length <= 2 && /\bnow\b/.test(t))))
    return { formula: '=NOW()', confidence: 0.7, explanation: 'Current date & time (updates automatically).' };
  return null;
}

/**
 * Detects "look up <key> in <range> return column <n>" and builds VLOOKUP.
 * The key can be a quoted string, a bare word, or a cell ref.
 */
function matchVlookup(raw) {
  const m = raw.match(/(?:look\s?up|vlookup|find|search)\s+["']?([a-z0-9._-]+)["']?\s+(?:in|from|inside)\s+([a-z]{1,3}\d{1,7}\s*:\s*[a-z]{1,3}\d{1,7})\s*(?:.*?(?:return|get|give|column|col)\s+(?:column\s+)?(\d+))?/i);
  if (!m) return null;
  if (!registry.has('VLOOKUP')) return null;
  const key = m[1];
  const range = m[2].replace(/\s+/g, '').toUpperCase();
  const colIdx = m[3] ? parseInt(m[3], 10) : 2; // default to 2nd column
  const keyLit = /^[a-z]{1,3}\d{1,7}$/i.test(key) ? key.toUpperCase() : (Number.isFinite(Number(key)) ? key : `"${key}"`);
  return {
    formula: `=VLOOKUP(${keyLit}, ${range}, ${colIdx}, FALSE)`,
    confidence: m[3] ? 0.75 : 0.62,
    explanation: `Looks up ${keyLit} in ${range} and returns column ${colIdx} (exact match).`,
  };
}

/**
 * Answers "is X possible / can I X / how do I X" questions straight from
 * the OKF knowledge bundle. Returns null when the text isn't a capability
 * question or when nothing matches confidently — never fabricates a feature.
 * @returns {{answer: string, confidence: number, concept: object} | null}
 */
export function answerPossibility(text) {
  // Normalize first: "kya main merge kar sakta hun" → "can i merge is it possible".
  const t = normalizeQuery(text).text.toLowerCase();
  if (!/\b(can i|can you|can it|is it possible|is there|does (?:mono|it|this|the app) (?:support|have|do)|how do i|how can i)\b/.test(t)) return null;
  // Real matches score 0.7–1.0 (idf-normalized); partial matches where a
  // key term is unknown to the index ("gantt") land near 0.3 — 0.4 splits
  // them cleanly, and below it we say so rather than guess.
  const [top] = search(t, { k: 3 });
  if (!top || top.score < 0.4) return null;
  const c = top.concept;
  const what = c.type === 'Formula Function' ? `the ${c.title} function` : c.title;
  return {
    answer: `Yes — ${what}: ${c.description} (see ${c.resource})`,
    confidence: top.score,
    concept: c,
  };
}

