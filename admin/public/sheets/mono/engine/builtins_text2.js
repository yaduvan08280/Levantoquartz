// ============================================================
//  Mono formula engine — text catalog expansion (GS parity pass)
//  Regex trio (REGEXMATCH/EXTRACT/REPLACE), SPLIT/JOIN, CLEAN,
//  DOLLAR/FIXED, unicode helpers, NUMBERVALUE, TO_* conversions,
//  and the *B byte-variants (treated as character-based — this
//  engine has no SJIS byte semantics; documented in BUILD_LOG).
//
//  Regex note: Google Sheets uses RE2. This engine uses JS RegExp,
//  a superset (backreferences, lookaround work here but not in
//  Sheets). Patterns valid in Sheets behave identically.
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { isArray, makeArray, scalar, flatten, toNumber, toText } from './values.js';

const reg = (def) => registry.register(def);
const num = (v) => toNumber(scalar(v));
const str = (v) => toText(scalar(v));

function compileRe(pattern, flags) {
  try { return new RegExp(pattern, flags); } catch { return null; }
}

/* =========================================================
   REGEX
   ========================================================= */
reg({ name: 'REGEXMATCH', min: 2, max: 2, fn: (a) => {
  const t = str(a[0]); if (isError(t)) return t;
  const p = str(a[1]); if (isError(p)) return p;
  const re = compileRe(p, ''); if (!re) return err(ERR.VALUE, 'Invalid regular expression');
  return re.test(t);
}, help: { syntax: 'REGEXMATCH(text, regular_expression)', desc: 'Whether a piece of text matches a regular expression.' } });
reg({ name: 'REGEXEXTRACT', min: 2, max: 2, fn: (a) => {
  const t = str(a[0]); if (isError(t)) return t;
  const p = str(a[1]); if (isError(p)) return p;
  const re = compileRe(p, ''); if (!re) return err(ERR.VALUE, 'Invalid regular expression');
  const m = re.exec(t);
  if (!m) return err(ERR.NA, 'No match');
  return m.length > 1 ? m[1] : m[0]; // first capture group if present, else whole match
}, help: { syntax: 'REGEXEXTRACT(text, regular_expression)', desc: 'Extracts the first matching substring (or first capture group).' } });
reg({ name: 'REGEXREPLACE', min: 3, max: 3, fn: (a) => {
  const t = str(a[0]); if (isError(t)) return t;
  const p = str(a[1]); if (isError(p)) return p;
  const r = str(a[2]); if (isError(r)) return r;
  const re = compileRe(p, 'g'); if (!re) return err(ERR.VALUE, 'Invalid regular expression');
  return t.replace(re, r);
}, help: { syntax: 'REGEXREPLACE(text, regular_expression, replacement)', desc: 'Replaces every match of a regular expression.' } });

/* =========================================================
   SPLIT / JOIN
   ========================================================= */
reg({ name: 'SPLIT', min: 2, max: 4, fn: (a) => {
  const t = str(a[0]); if (isError(t)) return t;
  const d = str(a[1]); if (isError(d)) return d;
  if (d === '') return err(ERR.VALUE, 'Empty delimiter');
  const byEach = a.length > 2 ? !!scalar(a[2]) : true;
  const removeEmpty = a.length > 3 ? !!scalar(a[3]) : true;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = byEach ? new RegExp('[' + d.split('').map(esc).join('') + ']') : d;
  let parts = t.split(re);
  if (removeEmpty) parts = parts.filter((x) => x !== '');
  if (!parts.length) parts = [''];
  // numbers come back as numbers, like Sheets
  const coerced = parts.map((x) => { const n = Number(x); return x.trim() !== '' && Number.isFinite(n) ? n : x; });
  return makeArray([coerced]);
}, help: { syntax: 'SPLIT(text, delimiter, [split_by_each], [remove_empty_text])' } });
reg({ name: 'JOIN', min: 2, fn: (a) => {
  const d = str(a[0]); if (isError(d)) return d;
  const parts = [];
  for (const arg of a.slice(1)) for (const v of flatten(arg)) { if (isError(v)) return v; parts.push(toText(v)); }
  return parts.join(d);
}, help: { syntax: 'JOIN(delimiter, value_or_array1, [value_or_array2, …])' } });

/* =========================================================
   FORMATTING / CLEANUP
   ========================================================= */
function thousands(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function roundPlaces(n, places) { const f = 10 ** places; return Math.round(n * f) / f; }
reg({ name: 'CLEAN', min: 1, max: 1, fn: (a) => { const t = str(a[0]); if (isError(t)) return t; return t.replace(/[\x00-\x1F\x7F]/g, ''); }, help: { syntax: 'CLEAN(text)' } });
reg({ name: 'DOLLAR', min: 1, max: 2, fn: (a) => {
  const n = num(a[0]); if (isError(n)) return n;
  const places = a.length > 1 ? Math.floor(num(a[1])) : 2; if (isError(places)) return places;
  const r = roundPlaces(n, places);
  const abs = Math.abs(r);
  const fixed = places > 0 ? abs.toFixed(places) : String(Math.round(abs / 10 ** -places) * 10 ** -places);
  const [i, dec] = fixed.split('.');
  const body = '$' + thousands(i) + (dec ? '.' + dec : '');
  return r < 0 ? '(' + body + ')' : body;
}, help: { syntax: 'DOLLAR(number, [number_of_places])' } });
reg({ name: 'FIXED', min: 1, max: 3, fn: (a) => {
  const n = num(a[0]); if (isError(n)) return n;
  const places = a.length > 1 ? Math.floor(num(a[1])) : 2; if (isError(places)) return places;
  const noCommas = a.length > 2 ? !!scalar(a[2]) : false;
  const r = roundPlaces(n, places);
  const abs = Math.abs(r);
  const fixed = places > 0 ? abs.toFixed(places) : String(Math.round(abs / 10 ** -places) * 10 ** -places);
  const [i, dec] = fixed.split('.');
  const body = (noCommas ? i : thousands(i)) + (dec ? '.' + dec : '');
  return (r < 0 ? '-' : '') + body;
}, help: { syntax: 'FIXED(number, [number_of_places], [suppress_separator])' } });

/* =========================================================
   UNICODE
   ========================================================= */
reg({ name: 'UNICHAR', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const cp = Math.floor(n); if (cp < 1 || cp > 0x10FFFF) return err(ERR.VALUE); try { return String.fromCodePoint(cp); } catch { return err(ERR.VALUE); } }, help: { syntax: 'UNICHAR(number)' } });
reg({ name: 'UNICODE', min: 1, max: 1, fn: (a) => { const t = str(a[0]); if (isError(t)) return t; if (!t.length) return err(ERR.VALUE); return t.codePointAt(0); }, help: { syntax: 'UNICODE(text)' } });
reg({ name: 'ASC', min: 1, max: 1, fn: (a) => {
  const t = str(a[0]); if (isError(t)) return t;
  // full-width ASCII forms → half-width; ideographic space → space
  return t.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
} });

/* =========================================================
   NUMBER PARSING / TO_* CONVERSIONS
   ========================================================= */
reg({ name: 'NUMBERVALUE', min: 1, max: 3, fn: (a) => {
  let t = str(a[0]); if (isError(t)) return t;
  const dec = a.length > 1 ? str(a[1]) : '.'; if (isError(dec)) return dec;
  const grp = a.length > 2 ? str(a[2]) : ','; if (isError(grp)) return grp;
  t = t.trim(); if (t === '') return 0;
  let pct = 0; while (t.endsWith('%')) { pct++; t = t.slice(0, -1); }
  if (grp) t = t.split(grp[0]).join('');
  if (dec) t = t.split(dec[0]).join('.');
  const n = Number(t);
  if (!Number.isFinite(n)) return err(ERR.VALUE);
  return n / 100 ** pct;
}, help: { syntax: 'NUMBERVALUE(text, [decimal_separator], [group_separator])' } });
reg({ name: 'TO_TEXT', min: 1, max: 1, fn: (a) => { const v = scalar(a[0]); if (isError(v)) return v; return toText(v); } });
reg({ name: 'TO_PURE_NUMBER', min: 1, max: 1, fn: (a) => { const v = scalar(a[0]); if (isError(v)) return v; if (typeof v === 'number') return v; const n = toNumber(v); return isError(n) ? v : n; } });
// TO_DOLLARS / TO_PERCENT / TO_DATE change display format in Sheets; values
// here are format-free numbers, so they validate + pass the number through.
const passNum = (name) => reg({ name, min: 1, max: 1, fn: (a) => { const v = scalar(a[0]); if (isError(v)) return v; if (typeof v === 'number') return v; const n = toNumber(v); return isError(n) ? v : n; } });
passNum('TO_DOLLARS'); passNum('TO_PERCENT'); passNum('TO_DATE');

/* =========================================================
   *B BYTE VARIANTS — this engine treats text as UTF-16 characters
   (no SJIS double-byte semantics), so these alias the char versions.
   ========================================================= */
reg({ name: 'LENB', min: 1, max: 1, fn: (a) => { const t = str(a[0]); return isError(t) ? t : t.length; } });
const aliasTo = (bName, baseName) => { const base = registry.get(baseName); if (base) registry.register({ ...base, name: bName, aliases: [] }); };
aliasTo('LEFTB', 'LEFT'); aliasTo('RIGHTB', 'RIGHT'); aliasTo('MIDB', 'MID');
aliasTo('FINDB', 'FIND'); aliasTo('SEARCHB', 'SEARCH'); aliasTo('REPLACEB', 'REPLACE');
