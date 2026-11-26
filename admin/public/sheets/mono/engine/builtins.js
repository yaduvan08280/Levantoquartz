// ============================================================
//  Mono formula engine — Tier-1 built-in functions (Phase 2)
//  ~80 of the most-used Google Sheets functions. Registering this
//  module (side-effect import) populates the shared registry.
//  Per-category split + full ~480 catalog come in Phases 3-4/8.
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { formatValue, isDatePattern } from './numberFormat.js';
import {
  isArray, makeArray, scalar, flatten, toNumber, toText, toBool, compare, numToStr,
  dateToSerial, todaySerial, nowSerial, serialToParts, flatOf } from './values.js';
import { concreteRange, parseCell, lettersToCol } from './references.js';

const reg = (def) => registry.register(def);
const num = (v) => toNumber(scalar(v));
const str = (v) => toText(scalar(v));

/* ---------- gather helpers ---------- */
function gatherNumbers(args) {
  const out = [];
  for (const a of args) {
    if (isError(a)) return a;
    if (isArray(a)) { for (const row of a.data) for (const v of row) { if (isError(v)) return v; if (typeof v === 'number') out.push(v); else if (typeof v === 'boolean') out.push(v ? 1 : 0); } }
    else if (a == null) { /* skip blank */ }
    else if (typeof a === 'number') out.push(a);
    else if (typeof a === 'boolean') out.push(a ? 1 : 0);
    else { const n = toNumber(a); if (isError(n)) return n; out.push(n); }
  }
  return out;
}
const flatAll = (args) => { const o = []; for (const a of args) flatten(a, o); return o; };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/* ---------- criteria (COUNTIF/SUMIF/…) ---------- */
function wildcardEq(text, pattern) {
  let rx = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~') { const nx = pattern[++i]; rx += nx ? nx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''; }
    else if (ch === '*') rx += '.*';
    else if (ch === '?') rx += '.';
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + rx + '$', 'i').test(text);
}
// exported: builtins_stats.js (AVERAGEIFS/MAXIFS/MINIFS) and
// builtins_database.js (D-functions) reuse the same criteria semantics.
export function critTest(v, crit) {
  if (crit == null) crit = '';
  if (typeof crit === 'number' || typeof crit === 'boolean') return typeof v === 'number' ? v === Number(crit) : compare(v, crit) === 0;
  const m = /^(>=|<=|<>|>|<|=)?([\s\S]*)$/.exec(String(crit));
  const op = m[1] || '='; const rhs = m[2];
  const asNum = (rhs !== '' && !isNaN(Number(rhs))) ? Number(rhs) : null;
  if (op === '=' || op === '<>') {
    let eq;
    if (asNum !== null && typeof v === 'number') eq = v === asNum;
    else eq = wildcardEq(v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v), rhs);
    return op === '<>' ? !eq : eq;
  }
  const c = compare(v, asNum !== null ? asNum : rhs);
  return op === '>' ? c > 0 : op === '<' ? c < 0 : op === '>=' ? c >= 0 : c <= 0;
}

/* =========================================================
   MATH
   ========================================================= */
reg({ name: 'SUM', min: 1, fn: (a) => { const n = gatherNumbers(a); return isError(n) ? n : sum(n); }, help: { syntax: 'SUM(value1, [value2, …])' } });
reg({ name: 'PRODUCT', min: 1, fn: (a) => { const n = gatherNumbers(a); return isError(n) ? n : n.reduce((x, y) => x * y, 1); } });
reg({ name: 'ABS', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : Math.abs(n); } });
reg({ name: 'SIGN', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : Math.sign(n); } });
reg({ name: 'SQRT', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; return n < 0 ? err(ERR.NUM) : Math.sqrt(n); } });
reg({ name: 'POWER', min: 2, max: 2, fn: (a) => { const x = num(a[0]), y = num(a[1]); if (isError(x)) return x; if (isError(y)) return y; const r = Math.pow(x, y); return Number.isFinite(r) ? r : err(ERR.NUM); } });
reg({ name: 'EXP', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : Math.exp(n); } });
reg({ name: 'LN', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; return n <= 0 ? err(ERR.NUM) : Math.log(n); } });
reg({ name: 'LOG10', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; return n <= 0 ? err(ERR.NUM) : Math.log10(n); } });
reg({ name: 'LOG', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const b = a.length > 1 ? num(a[1]) : 10; if (isError(b)) return b; return n <= 0 ? err(ERR.NUM) : Math.log(n) / Math.log(b); } });
reg({ name: 'MOD', min: 2, max: 2, fn: (a) => { const n = num(a[0]), d = num(a[1]); if (isError(n)) return n; if (isError(d)) return d; return d === 0 ? err(ERR.DIV0) : n - d * Math.floor(n / d); } });
reg({ name: 'QUOTIENT', min: 2, max: 2, fn: (a) => { const n = num(a[0]), d = num(a[1]); if (isError(n)) return n; if (isError(d)) return d; return d === 0 ? err(ERR.DIV0) : Math.trunc(n / d); } });
reg({ name: 'INT', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : Math.floor(n); } });
reg({ name: 'TRUNC', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const d = a.length > 1 ? num(a[1]) : 0; if (isError(d)) return d; const f = 10 ** d; return Math.trunc(n * f) / f; } });
function roundTo(n, d, mode) { const f = 10 ** d; const x = n * f; let r; if (mode === 'up') r = x >= 0 ? Math.ceil(x) : Math.floor(x); else if (mode === 'down') r = x >= 0 ? Math.floor(x) : Math.ceil(x); else r = x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5); return r / f; }
reg({ name: 'ROUND', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const d = a.length > 1 ? num(a[1]) : 0; return isError(d) ? d : roundTo(n, d, 'half'); } });
reg({ name: 'ROUNDUP', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const d = a.length > 1 ? num(a[1]) : 0; return isError(d) ? d : roundTo(n, d, 'up'); } });
reg({ name: 'ROUNDDOWN', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const d = a.length > 1 ? num(a[1]) : 0; return isError(d) ? d : roundTo(n, d, 'down'); } });
reg({ name: 'CEILING', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const s = a.length > 1 ? num(a[1]) : 1; if (isError(s)) return s; return s === 0 ? 0 : Math.ceil(n / s) * s; } });
reg({ name: 'FLOOR', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const s = a.length > 1 ? num(a[1]) : 1; if (isError(s)) return s; return s === 0 ? 0 : Math.floor(n / s) * s; } });
reg({ name: 'MROUND', min: 2, max: 2, fn: (a) => { const n = num(a[0]), m = num(a[1]); if (isError(n)) return n; if (isError(m)) return m; return m === 0 ? 0 : Math.round(n / m) * m; } });
reg({ name: 'EVEN', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const r = Math.ceil(Math.abs(n) / 2) * 2; return n < 0 ? -r : r; } });
reg({ name: 'ODD', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; let r = Math.ceil(Math.abs(n)); if (r % 2 === 0) r += 1; return n < 0 ? -r : r; } });
reg({ name: 'GCD', min: 1, fn: (a) => { const n = gatherNumbers(a); if (isError(n)) return n; const g = (x, y) => y ? g(y, x % y) : x; return n.map((x) => Math.abs(Math.trunc(x))).reduce((x, y) => g(x, y), 0); } });
reg({ name: 'LCM', min: 1, fn: (a) => { const n = gatherNumbers(a); if (isError(n)) return n; const g = (x, y) => y ? g(y, x % y) : x; return n.map((x) => Math.abs(Math.trunc(x))).reduce((x, y) => (x && y ? x / g(x, y) * y : 0)); } });
reg({ name: 'PI', min: 0, max: 0, fn: () => Math.PI });
reg({ name: 'RAND', min: 0, max: 0, volatile: true, fn: () => Math.random() });
reg({ name: 'RANDBETWEEN', min: 2, max: 2, volatile: true, fn: (a) => { const lo = num(a[0]), hi = num(a[1]); if (isError(lo)) return lo; if (isError(hi)) return hi; return Math.floor(Math.random() * (Math.floor(hi) - Math.ceil(lo) + 1)) + Math.ceil(lo); } });
reg({ name: 'SUMPRODUCT', min: 1, fn: (a) => { const arrs = a.map((x) => isArray(x) ? flatOf(x) : [scalar(x)]); const len = Math.max(...arrs.map((x) => x.length)); let total = 0; for (let i = 0; i < len; i++) { let p = 1; for (const arr of arrs) { const v = arr[i]; if (isError(v)) return v; p *= (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : (v == null ? 0 : (isNaN(Number(v)) ? 0 : Number(v)))); } total += p; } return total; } });

/* SUMIF / SUMIFS / AVERAGEIF */
reg({ name: 'SUMIF', min: 2, max: 3, fn: (a) => {
  const rng = isArray(a[0]) ? flatOf(a[0]) : [scalar(a[0])];
  const sumR = a.length > 2 ? (isArray(a[2]) ? flatOf(a[2]) : [scalar(a[2])]) : rng;
  let t = 0; for (let i = 0; i < rng.length; i++) if (critTest(rng[i], a[1] != null && isArray(a[1]) ? scalar(a[1]) : a[1])) { const v = sumR[i]; if (typeof v === 'number') t += v; else if (typeof v === 'boolean') t += v ? 1 : 0; }
  return t;
} });
reg({ name: 'SUMIFS', min: 3, fn: (a) => {
  const sumR = isArray(a[0]) ? flatOf(a[0]) : [scalar(a[0])];
  let t = 0;
  for (let i = 0; i < sumR.length; i++) { let ok = true; for (let p = 1; p < a.length; p += 2) { const rng = isArray(a[p]) ? flatOf(a[p]) : [scalar(a[p])]; if (!critTest(rng[i], a[p + 1])) { ok = false; break; } } if (ok) { const v = sumR[i]; if (typeof v === 'number') t += v; } }
  return t;
} });
reg({ name: 'AVERAGEIF', min: 2, max: 3, fn: (a) => {
  const rng = isArray(a[0]) ? flatOf(a[0]) : [scalar(a[0])];
  const avgR = a.length > 2 ? (isArray(a[2]) ? flatOf(a[2]) : [scalar(a[2])]) : rng;
  let t = 0, n = 0; for (let i = 0; i < rng.length; i++) if (critTest(rng[i], a[1])) { const v = avgR[i]; if (typeof v === 'number') { t += v; n++; } }
  return n ? t / n : err(ERR.DIV0);
} });

/* =========================================================
   STATISTICAL
   ========================================================= */
reg({ name: 'AVERAGE', min: 1, fn: (a) => { const n = gatherNumbers(a); if (isError(n)) return n; return n.length ? sum(n) / n.length : err(ERR.DIV0); } });
reg({ name: 'COUNT', min: 1, fn: (a) => flatAll(a).filter((v) => typeof v === 'number').length });
reg({ name: 'COUNTA', min: 1, fn: (a) => flatAll(a).filter((v) => v != null && v !== '').length });
reg({ name: 'COUNTBLANK', min: 1, max: 1, fn: (a) => flatAll(a).filter((v) => v == null || v === '').length });
reg({ name: 'COUNTIF', min: 2, max: 2, fn: (a) => { const rng = isArray(a[0]) ? flatOf(a[0]) : [scalar(a[0])]; let n = 0; for (const v of rng) if (critTest(v, a[1])) n++; return n; } });
reg({ name: 'COUNTIFS', min: 2, fn: (a) => {
  const first = isArray(a[0]) ? flatOf(a[0]) : [scalar(a[0])]; let n = 0;
  for (let i = 0; i < first.length; i++) { let ok = true; for (let p = 0; p < a.length; p += 2) { const rng = isArray(a[p]) ? flatOf(a[p]) : [scalar(a[p])]; if (!critTest(rng[i], a[p + 1])) { ok = false; break; } } if (ok) n++; }
  return n;
} });
reg({ name: 'MAX', min: 1, fn: (a) => { const n = gatherNumbers(a); if (isError(n)) return n; return n.length ? Math.max(...n) : 0; } });
reg({ name: 'MIN', min: 1, fn: (a) => { const n = gatherNumbers(a); if (isError(n)) return n; return n.length ? Math.min(...n) : 0; } });
reg({ name: 'MEDIAN', min: 1, fn: (a) => { const n = gatherNumbers(a); if (isError(n)) return n; if (!n.length) return err(ERR.NUM); const s = [...n].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; } });
reg({ name: 'LARGE', min: 2, max: 2, fn: (a) => { const n = gatherNumbers([a[0]]); if (isError(n)) return n; const k = num(a[1]); if (isError(k)) return k; const s = [...n].sort((x, y) => y - x); return k >= 1 && k <= s.length ? s[k - 1] : err(ERR.NUM); } });
reg({ name: 'SMALL', min: 2, max: 2, fn: (a) => { const n = gatherNumbers([a[0]]); if (isError(n)) return n; const k = num(a[1]); if (isError(k)) return k; const s = [...n].sort((x, y) => x - y); return k >= 1 && k <= s.length ? s[k - 1] : err(ERR.NUM); } });
reg({ name: 'MODE', aliases: ['MODE.SNGL'], min: 1, fn: (a) => { const n = gatherNumbers(a); if (isError(n)) return n; const cnt = new Map(); let best = null, bc = 0; for (const x of n) { const c = (cnt.get(x) || 0) + 1; cnt.set(x, c); if (c > bc) { bc = c; best = x; } } return bc > 1 ? best : err(ERR.NA); } });

/* =========================================================
   LOGICAL
   ========================================================= */
reg({ name: 'TRUE', min: 0, max: 0, fn: () => true });
reg({ name: 'FALSE', min: 0, max: 0, fn: () => false });
reg({ name: 'NOT', min: 1, max: 1, fn: (a) => { const b = toBool(scalar(a[0])); return isError(b) ? b : !b; } });
reg({ name: 'AND', min: 1, fn: (a) => { let any = false; for (const v of flatAll(a)) { if (isError(v)) return v; if (v == null || v === '') continue; if (typeof v === 'string' && isNaN(Number(v))) continue; const b = toBool(v); if (isError(b)) return b; any = true; if (!b) return false; } return any ? true : err(ERR.VALUE); } });
reg({ name: 'OR', min: 1, fn: (a) => { let any = false; for (const v of flatAll(a)) { if (isError(v)) return v; if (v == null || v === '') continue; if (typeof v === 'string' && isNaN(Number(v))) continue; const b = toBool(v); if (isError(b)) return b; any = true; if (b) return true; } return any ? false : err(ERR.VALUE); } });
reg({ name: 'XOR', min: 1, fn: (a) => { let c = 0; for (const v of flatAll(a)) { if (isError(v)) return v; if (v == null || v === '') continue; const b = toBool(v); if (isError(b)) return b; if (b) c++; } return c % 2 === 1; } });
/* ---- arrayMode helpers for lazy conditionals ---- */
const bAt = (v, r, c) => isArray(v) ? v.data[v.rows === 1 ? 0 : r]?.[v.cols === 1 ? 0 : c] : v;
const isMulti = (v) => isArray(v) && (v.rows > 1 || v.cols > 1);
const dimsOf = (vs) => ({ rows: Math.max(...vs.map((v) => isArray(v) ? v.rows : 1)), cols: Math.max(...vs.map((v) => isArray(v) ? v.cols : 1)) });
reg({ name: 'IF', min: 2, max: 3, lazy: true, fn: (args, ctx, ev) => {
  const cond = ev(args[0]);
  if (ctx.arrayMode && isMulti(cond)) {
    const t = ev(args[1]); const f = args.length > 2 ? ev(args[2]) : false;
    const { rows, cols } = dimsOf([cond, t, f]);
    const data = [];
    for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) { const cv = bAt(cond, r, c); if (isError(cv)) { row.push(cv); continue; } const b = toBool(cv); row.push(isError(b) ? b : (b ? bAt(t, r, c) : bAt(f, r, c))); } data.push(row); }
    return makeArray(data);
  }
  const c = toBool(scalar(cond)); if (isError(c)) return c; if (c) return ev(args[1]); return args.length > 2 ? ev(args[2]) : false;
} });
reg({ name: 'IFS', min: 2, lazy: true, fn: (args, ctx, ev) => {
  if (ctx.arrayMode) {
    const vals = args.map((n) => ev(n));
    if (vals.some(isMulti)) {
      const { rows, cols } = dimsOf(vals);
      const data = [];
      for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) { let out = err(ERR.NA); for (let i = 0; i + 1 < vals.length; i += 2) { const cv = bAt(vals[i], r, c); if (isError(cv)) { out = cv; break; } const b = toBool(cv); if (isError(b)) { out = b; break; } if (b) { out = bAt(vals[i + 1], r, c); break; } } row.push(out); } data.push(row); }
      return makeArray(data);
    }
  }
  for (let i = 0; i + 1 < args.length; i += 2) { const c = toBool(scalar(ev(args[i]))); if (isError(c)) return c; if (c) return ev(args[i + 1]); }
  return err(ERR.NA);
} });
reg({ name: 'IFERROR', min: 1, max: 2, lazy: true, fn: (args, ctx, ev) => {
  const v = ev(args[0]);
  if (ctx.arrayMode && isMulti(v)) {
    if (!v.data.some((row) => row.some(isError))) return v;
    const fb = args.length > 1 ? ev(args[1]) : '';
    return makeArray(v.data.map((row, r) => row.map((x, c) => isError(x) ? bAt(fb, r, c) : x)));
  }
  return isError(v) ? (args.length > 1 ? ev(args[1]) : '') : v;
} });
reg({ name: 'IFNA', min: 2, max: 2, lazy: true, fn: (args, ctx, ev) => {
  const v = ev(args[0]);
  if (ctx.arrayMode && isMulti(v)) {
    if (!v.data.some((row) => row.some((x) => isError(x) && x.type === ERR.NA))) return v;
    const fb = ev(args[1]);
    return makeArray(v.data.map((row, r) => row.map((x, c) => (isError(x) && x.type === ERR.NA) ? bAt(fb, r, c) : x)));
  }
  return (isError(v) && v.type === ERR.NA) ? ev(args[1]) : v;
} });
reg({ name: 'SWITCH', min: 3, lazy: true, fn: (args, ctx, ev) => {
  const subj = ev(args[0]);
  if (ctx.arrayMode && isMulti(subj)) {
    const rest = args.slice(1).map((n) => ev(n));
    const { rows, cols } = dimsOf([subj, ...rest]);
    const hasDefault = rest.length % 2 === 1;
    const data = [];
    for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) {
      const s = bAt(subj, r, c); if (isError(s)) { row.push(s); continue; }
      let out = hasDefault ? bAt(rest[rest.length - 1], r, c) : err(ERR.NA);
      for (let i = 0; i + 1 < rest.length; i += 2) { const cse = bAt(rest[i], r, c); if (isError(cse)) { out = cse; break; } if (compare(s, cse) === 0) { out = bAt(rest[i + 1], r, c); break; } }
      row.push(out);
    } data.push(row); }
    return makeArray(data);
  }
  const subject = scalar(subj); if (isError(subject)) return subject;
  let i = 1; for (; i + 1 < args.length; i += 2) { const cse = scalar(ev(args[i])); if (isError(cse)) return cse; if (compare(subject, cse) === 0) return ev(args[i + 1]); }
  return i < args.length ? ev(args[i]) : err(ERR.NA);
} });

/* =========================================================
   TEXT
   ========================================================= */
reg({ name: 'CONCAT', aliases: ['CONCATENATE'], min: 1, fn: (a) => { let s = ''; for (const v of flatAll(a)) { if (isError(v)) return v; s += toText(v); } return s; } });
reg({ name: 'TEXTJOIN', min: 3, fn: (a) => { const delim = str(a[0]); const skip = toBool(scalar(a[1])); const parts = []; for (const v of flatAll(a.slice(2))) { if (isError(v)) return v; if (skip && (v == null || v === '')) continue; parts.push(toText(v)); } return parts.join(delim); } });
reg({ name: 'LEN', min: 1, max: 1, fn: (a) => { const s = str(a[0]); return isError(s) ? s : s.length; } });
reg({ name: 'LEFT', min: 1, max: 2, fn: (a) => { const s = str(a[0]); if (isError(s)) return s; const n = a.length > 1 ? num(a[1]) : 1; return isError(n) ? n : s.slice(0, Math.max(0, n)); } });
reg({ name: 'RIGHT', min: 1, max: 2, fn: (a) => { const s = str(a[0]); if (isError(s)) return s; const n = a.length > 1 ? num(a[1]) : 1; if (isError(n)) return n; return n <= 0 ? '' : s.slice(-n); } });
reg({ name: 'MID', min: 3, max: 3, fn: (a) => { const s = str(a[0]); if (isError(s)) return s; const start = num(a[1]), len = num(a[2]); if (isError(start)) return start; if (isError(len)) return len; return s.substr(Math.max(0, start - 1), Math.max(0, len)); } });
reg({ name: 'LOWER', min: 1, max: 1, fn: (a) => { const s = str(a[0]); return isError(s) ? s : s.toLowerCase(); } });
reg({ name: 'UPPER', min: 1, max: 1, fn: (a) => { const s = str(a[0]); return isError(s) ? s : s.toUpperCase(); } });
reg({ name: 'PROPER', min: 1, max: 1, fn: (a) => { const s = str(a[0]); return isError(s) ? s : s.replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\B\w/g, (m) => m.toLowerCase()); } });
reg({ name: 'TRIM', min: 1, max: 1, fn: (a) => { const s = str(a[0]); return isError(s) ? s : s.replace(/\s+/g, ' ').trim(); } });
reg({ name: 'REPT', min: 2, max: 2, fn: (a) => { const s = str(a[0]); if (isError(s)) return s; const n = num(a[1]); if (isError(n)) return n; return n > 0 ? s.repeat(Math.floor(n)) : ''; } });
// Insert link [Ctrl+K] on the toolbar builds one of these — display text
// falls back to the URL itself when no label is given, matching Sheets.
reg({ name: 'HYPERLINK', min: 1, max: 2, fn: (a) => { const url = str(a[0]); if (isError(url)) return url; const label = a.length > 1 ? str(a[1]) : url; return isError(label) ? label : (label === '' ? url : label); }, help: { syntax: 'HYPERLINK(url, [label])' } });
reg({ name: 'EXACT', min: 2, max: 2, fn: (a) => { const x = str(a[0]), y = str(a[1]); if (isError(x)) return x; if (isError(y)) return y; return x === y; } });
reg({ name: 'FIND', min: 2, max: 3, fn: (a) => { const find = str(a[0]), within = str(a[1]); if (isError(find)) return find; if (isError(within)) return within; const start = a.length > 2 ? num(a[2]) : 1; const idx = within.indexOf(find, Math.max(0, start - 1)); return idx < 0 ? err(ERR.VALUE) : idx + 1; } });
reg({ name: 'SEARCH', min: 2, max: 3, fn: (a) => { const find = str(a[0]).toLowerCase(), within = str(a[1]).toLowerCase(); const start = a.length > 2 ? num(a[2]) : 1; const idx = within.indexOf(find, Math.max(0, start - 1)); return idx < 0 ? err(ERR.VALUE) : idx + 1; } });
reg({ name: 'SUBSTITUTE', min: 3, max: 4, fn: (a) => { let s = str(a[0]); const oldT = str(a[1]), newT = str(a[2]); if (isError(s)) return s; if (oldT === '') return s; if (a.length > 3) { const which = num(a[3]); let i = 0, from = 0, pos; while ((pos = s.indexOf(oldT, from)) >= 0) { i++; if (i === which) return s.slice(0, pos) + newT + s.slice(pos + oldT.length); from = pos + oldT.length; } return s; } return s.split(oldT).join(newT); } });
reg({ name: 'REPLACE', min: 4, max: 4, fn: (a) => { const s = str(a[0]); const start = num(a[1]), len = num(a[2]), nt = str(a[3]); if (isError(s)) return s; return s.slice(0, start - 1) + nt + s.slice(start - 1 + len); } });
reg({ name: 'VALUE', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return n; } });
reg({ name: 'T', min: 1, max: 1, fn: (a) => { const v = scalar(a[0]); return typeof v === 'string' ? v : ''; } });
reg({ name: 'CHAR', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : String.fromCharCode(n); } });
reg({ name: 'CODE', min: 1, max: 1, fn: (a) => { const s = str(a[0]); if (isError(s)) return s; return s.length ? s.charCodeAt(0) : err(ERR.VALUE); } });
function textFormat(v, fmt) {
  const n = toNumber(scalar(v)); if (isError(n)) return toText(v);
  fmt = String(fmt);
  /* Date and time patterns are the number-format engine's job. TEXT ignored
     them completely and fell through to the numeric path, which handed back
     the raw serial - TEXT(A1,"mmmm") rendered 46266 instead of "September",
     and a Google Sheets column built on TEXT(date,"mmmm") imported as a
     column of five-digit numbers. */
  if (isDatePattern(fmt)) return formatValue(n, fmt);
  if (/%/.test(fmt)) { const dec = (fmt.split('.')[1] || '').match(/0/g)?.length || 0; return (n * 100).toFixed(dec) + '%'; }
  let dec = 0; const dot = fmt.indexOf('.'); if (dot >= 0) dec = (fmt.slice(dot + 1).match(/0/g) || []).length;
  let s = dec > 0 ? n.toFixed(dec) : String(Math.round(n));
  if (/,/.test(fmt)) { const p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); }
  return s;
}
reg({ name: 'TEXT', min: 2, max: 2, fn: (a) => textFormat(a[0], str(a[1])) });

/* =========================================================
   LOOKUP / REFERENCE
   ========================================================= */
function asArray(v) { return isArray(v) ? v : makeArray([[scalar(v)]]); }
reg({ name: 'VLOOKUP', min: 3, max: 4, fn: (a) => {
  const key = scalar(a[0]); const tbl = asArray(a[1]); const idx = num(a[2]);
  if (isError(idx)) return idx; const approx = a.length > 3 ? toBool(scalar(a[3])) : true;
  if (idx < 1 || idx > tbl.cols) return err(ERR.REF);
  if (!approx) { for (const row of tbl.data) if (compare(row[0], key) === 0) return row[idx - 1]; return err(ERR.NA); }
  let best = null; for (const row of tbl.data) { if (compare(row[0], key) <= 0) best = row; else break; } return best ? best[idx - 1] : err(ERR.NA);
} });
reg({ name: 'HLOOKUP', min: 3, max: 4, fn: (a) => {
  const key = scalar(a[0]); const tbl = asArray(a[1]); const idx = num(a[2]);
  if (isError(idx)) return idx; const approx = a.length > 3 ? toBool(scalar(a[3])) : true;
  if (idx < 1 || idx > tbl.rows) return err(ERR.REF);
  const head = tbl.data[0];
  if (!approx) { for (let c = 0; c < head.length; c++) if (compare(head[c], key) === 0) return tbl.data[idx - 1][c]; return err(ERR.NA); }
  let bestC = -1; for (let c = 0; c < head.length; c++) { if (compare(head[c], key) <= 0) bestC = c; else break; } return bestC >= 0 ? tbl.data[idx - 1][bestC] : err(ERR.NA);
} });
reg({ name: 'INDEX', min: 2, max: 3, fn: (a) => {
  const arr = asArray(a[0]); const r = num(a[1]); if (isError(r)) return r; const c = a.length > 2 ? num(a[2]) : null; if (isError(c)) return c;
  if (c == null) { if (arr.rows === 1) return arr.data[0][r - 1] ?? err(ERR.REF); if (arr.cols === 1) return (arr.data[r - 1] || [])[0] ?? err(ERR.REF); return err(ERR.REF); }
  const row = arr.data[r - 1]; if (!row) return err(ERR.REF); return row[c - 1] ?? err(ERR.REF);
} });
reg({ name: 'MATCH', min: 2, max: 3, fn: (a) => {
  const key = scalar(a[0]); const arr = flatOf(asArray(a[1])); const type = a.length > 2 ? num(a[2]) : 1;
  if (type === 0) { for (let i = 0; i < arr.length; i++) if (compare(arr[i], key) === 0) return i + 1; return err(ERR.NA); }
  if (type === 1) { let pos = -1; for (let i = 0; i < arr.length; i++) { if (compare(arr[i], key) <= 0) pos = i; else break; } return pos >= 0 ? pos + 1 : err(ERR.NA); }
  let pos = -1; for (let i = 0; i < arr.length; i++) { if (compare(arr[i], key) >= 0) pos = i; else break; } return pos >= 0 ? pos + 1 : err(ERR.NA);
} });
reg({ name: 'CHOOSE', min: 2, lazy: true, fn: (args, ctx, ev) => {
  const idxV = ev(args[0]);
  if (ctx.arrayMode && isMulti(idxV)) {
    const choices = args.slice(1).map((n) => ev(n));
    const { rows, cols } = dimsOf([idxV, ...choices]);
    const data = [];
    for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) {
      const n = toNumber(bAt(idxV, r, c)); if (isError(n)) { row.push(n); continue; }
      const i = Math.trunc(n);
      row.push((i >= 1 && i <= choices.length) ? bAt(choices[i - 1], r, c) : err(ERR.VALUE));
    } data.push(row); }
    return makeArray(data);
  }
  const idx = toNumber(scalar(idxV)); if (isError(idx)) return idx; const i = Math.trunc(idx);
  return (i >= 1 && i < args.length) ? ev(args[i]) : err(ERR.VALUE);
} });

function refDescriptor(node, ctx) {
  if (!node) return null;
  if (node.type === 'ref') { const sid = node.sheet ? ctx.resolveSheetId(node.sheet) : ctx.sheetId; return { sid, r1: node.row, c1: node.col, r2: node.row, c2: node.col }; }
  if (node.type === 'range') { const sid = node.sheet ? ctx.resolveSheetId(node.sheet) : ctx.sheetId; const d = ctx.sheetDims(sid); const cr = concreteRange(node, d.rows, d.cols); return { sid, ...cr }; }
  return null;
}
reg({ name: 'ROW', min: 0, max: 1, lazy: true, fn: (args, ctx) => { if (!args.length) return ctx.r + 1; const d = refDescriptor(args[0], ctx); return d ? d.r1 + 1 : err(ERR.VALUE); } });
reg({ name: 'COLUMN', min: 0, max: 1, lazy: true, fn: (args, ctx) => { if (!args.length) return ctx.c + 1; const d = refDescriptor(args[0], ctx); return d ? d.c1 + 1 : err(ERR.VALUE); } });
reg({ name: 'ROWS', min: 1, max: 1, lazy: true, fn: (args, ctx) => { const d = refDescriptor(args[0], ctx); return d ? d.r2 - d.r1 + 1 : err(ERR.VALUE); } });
reg({ name: 'COLUMNS', min: 1, max: 1, lazy: true, fn: (args, ctx) => { const d = refDescriptor(args[0], ctx); return d ? d.c2 - d.c1 + 1 : err(ERR.VALUE); } });
reg({ name: 'INDIRECT', min: 1, max: 2, volatile: true, fn: (a, ctx) => {
  const text = str(a[0]); if (isError(text)) return text;
  let sheet = null, body = text; const bang = text.indexOf('!'); if (bang >= 0) { sheet = text.slice(0, bang).replace(/^'|'$/g, ''); body = text.slice(bang + 1); }
  const sid = sheet ? ctx.resolveSheetId(sheet) : ctx.sheetId; if (sid == null) return err(ERR.REF);
  const parts = body.split(':');
  const c0 = parseCell(parts[0].toUpperCase()); if (!c0) return err(ERR.REF);
  if (parts.length === 1) return ctx.readCell(sid, c0.row, c0.col);
  const c1 = parseCell(parts[1].toUpperCase()); if (!c1) return err(ERR.REF);
  const data = []; for (let r = Math.min(c0.row, c1.row); r <= Math.max(c0.row, c1.row); r++) { const row = []; for (let c = Math.min(c0.col, c1.col); c <= Math.max(c0.col, c1.col); c++) row.push(ctx.readCell(sid, r, c)); data.push(row); }
  return makeArray(data);
} });

/* =========================================================
   DATE & TIME
   ========================================================= */
reg({ name: 'TODAY', min: 0, max: 0, volatile: true, fn: () => todaySerial() });
reg({ name: 'NOW', min: 0, max: 0, volatile: true, fn: () => nowSerial() });
reg({ name: 'DATE', min: 3, max: 3, fn: (a) => { const y = num(a[0]), m = num(a[1]), d = num(a[2]); if (isError(y)) return y; if (isError(m)) return m; if (isError(d)) return d; return dateToSerial(y, m, d); } });
reg({ name: 'YEAR', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : serialToParts(n).y; } });
reg({ name: 'MONTH', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : serialToParts(n).m; } });
reg({ name: 'DAY', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : serialToParts(n).d; } });
reg({ name: 'WEEKDAY', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const wd = serialToParts(n).wd; const type = a.length > 1 ? num(a[1]) : 1; if (type === 2) return wd === 0 ? 7 : wd; if (type === 3) return (wd + 6) % 7; return wd + 1; } });
reg({ name: 'DAYS', min: 2, max: 2, fn: (a) => { const e = num(a[0]), s = num(a[1]); if (isError(e)) return e; if (isError(s)) return s; return Math.trunc(e) - Math.trunc(s); } });
reg({ name: 'HOUR', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const f = n - Math.floor(n); return Math.floor(f * 24); } });
reg({ name: 'MINUTE', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const f = n - Math.floor(n); return Math.floor((f * 24 * 60) % 60); } });
reg({ name: 'SECOND', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const f = n - Math.floor(n); return Math.round((f * 86400) % 60); } });
reg({ name: 'EDATE', min: 2, max: 2, fn: (a) => { const s = num(a[0]), mo = num(a[1]); if (isError(s)) return s; if (isError(mo)) return mo; const p = serialToParts(s); return dateToSerial(p.y, p.m + Math.trunc(mo), p.d); } });
reg({ name: 'EOMONTH', min: 2, max: 2, fn: (a) => { const s = num(a[0]), mo = num(a[1]); if (isError(s)) return s; if (isError(mo)) return mo; const p = serialToParts(s); return dateToSerial(p.y, p.m + Math.trunc(mo) + 1, 0); } });

/* =========================================================
   INFO / IS-functions  (passErrors so they can inspect errors)
   ========================================================= */
reg({ name: 'ISBLANK', min: 1, max: 1, passErrors: true, fn: (a) => { const v = scalar(a[0]); return v == null || v === ''; } });
reg({ name: 'ISNUMBER', min: 1, max: 1, passErrors: true, fn: (a) => typeof scalar(a[0]) === 'number' });
reg({ name: 'ISTEXT', min: 1, max: 1, passErrors: true, fn: (a) => typeof scalar(a[0]) === 'string' });
reg({ name: 'ISNONTEXT', min: 1, max: 1, passErrors: true, fn: (a) => typeof scalar(a[0]) !== 'string' });
reg({ name: 'ISLOGICAL', min: 1, max: 1, passErrors: true, fn: (a) => typeof scalar(a[0]) === 'boolean' });
reg({ name: 'ISERROR', min: 1, max: 1, passErrors: true, fn: (a) => isError(scalar(a[0])) });
reg({ name: 'ISERR', min: 1, max: 1, passErrors: true, fn: (a) => { const v = scalar(a[0]); return isError(v) && v.type !== ERR.NA; } });
reg({ name: 'ISNA', min: 1, max: 1, passErrors: true, fn: (a) => { const v = scalar(a[0]); return isError(v) && v.type === ERR.NA; } });
reg({ name: 'ISEVEN', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : Math.trunc(n) % 2 === 0; } });
reg({ name: 'ISODD', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : Math.abs(Math.trunc(n) % 2) === 1; } });
reg({ name: 'NA', min: 0, max: 0, fn: () => err(ERR.NA) });

/* =========================================================
   WEB / IMPORT  (cross-workbook; resolved via ctx.importRange)
   ========================================================= */
reg({ name: 'IMPORTRANGE', min: 2, max: 2, volatile: true, fn: (a, ctx) => {
  const key = str(a[0]); if (isError(key)) return key;
  const rng = str(a[1]); if (isError(rng)) return rng;
  return ctx.importRange ? ctx.importRange(key, rng) : err(ERR.REF);
}, help: { syntax: 'IMPORTRANGE(source_key, "Sheet!A1:B2")', desc: 'Pull a range from another Mono workbook.' } });


export default registry;
