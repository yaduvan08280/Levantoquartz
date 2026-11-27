// ============================================================
//  Mono formula engine — math catalog expansion (GS parity pass)
//  Trigonometry, combinatorics, number bases, matrix math,
//  ceiling/floor variants, SUBTOTAL, and Google Sheets'
//  operator functions (ADD/MINUS/EQ/…/ISBETWEEN).
//  Side-effect import — registering populates the shared registry.
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { isArray, makeArray, scalar, flatten, toNumber, toText, compare } from './values.js';

const reg = (def) => registry.register(def);
const num = (v) => toNumber(scalar(v));
const str = (v) => toText(scalar(v));

/** Coerce every element of args (scalars + arrays) to numbers; first error wins. */
function nums(args) {
  const out = [];
  for (const v of flatten(args.length === 1 ? args[0] : { __array: true, rows: 1, cols: args.length, data: [args] })) {
    if (isError(v)) return v;
    if (v == null || v === '') continue;
    const n = toNumber(v);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}
/** Numbers from ALL args (each may be scalar or array). */
function numsAll(args) {
  const out = [];
  for (const a of args) {
    for (const v of flatten(a)) {
      if (isError(v)) return v;
      if (v == null || v === '') continue;
      const n = toNumber(v);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}
const mat = (v) => isArray(v) ? v.data : [[v]];

/* =========================================================
   TRIGONOMETRY & HYPERBOLICS
   ========================================================= */
const one = (name, f, guard) => reg({
  name, min: 1, max: 1,
  fn: (a) => { const n = num(a[0]); if (isError(n)) return n; if (guard && !guard(n)) return err(ERR.NUM); const r = f(n); return Number.isFinite(r) ? r : err(ERR.NUM); },
  help: { syntax: `${name}(value)` },
});
one('SIN', Math.sin); one('COS', Math.cos); one('TAN', Math.tan);
one('ASIN', Math.asin, (n) => n >= -1 && n <= 1);
one('ACOS', Math.acos, (n) => n >= -1 && n <= 1);
one('ATAN', Math.atan);
one('SINH', Math.sinh); one('COSH', Math.cosh); one('TANH', Math.tanh);
one('ASINH', Math.asinh); one('ACOSH', Math.acosh, (n) => n >= 1);
one('ATANH', Math.atanh, (n) => n > -1 && n < 1);
one('COT', (n) => 1 / Math.tan(n)); one('COTH', (n) => 1 / Math.tanh(n));
one('CSC', (n) => 1 / Math.sin(n)); one('CSCH', (n) => 1 / Math.sinh(n));
one('SEC', (n) => 1 / Math.cos(n)); one('SECH', (n) => 1 / Math.cosh(n));
one('ACOT', (n) => Math.PI / 2 - Math.atan(n));
one('ACOTH', (n) => Math.atanh(1 / n), (n) => Math.abs(n) > 1);
one('DEGREES', (n) => n * 180 / Math.PI);
one('RADIANS', (n) => n * Math.PI / 180);
one('SQRTPI', (n) => Math.sqrt(n * Math.PI), (n) => n >= 0);
reg({ name: 'ATAN2', min: 2, max: 2, fn: (a) => { const x = num(a[0]), y = num(a[1]); if (isError(x)) return x; if (isError(y)) return y; if (x === 0 && y === 0) return err(ERR.DIV0); return Math.atan2(y, x); }, help: { syntax: 'ATAN2(x, y)' } });

/* =========================================================
   COMBINATORICS / GAMMA
   ========================================================= */
// Lanczos ln-gamma — standard coefficients, |error| < 1e-13 for x > 0.
const LG = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function gammaln(x) {
  if (x <= 0) return NaN;
  let g = 0.99999999999980993;
  for (let i = 0; i < 8; i++) g += LG[i] / (x + i);
  const t = x + 6.5;
  return 0.5 * Math.log(2 * Math.PI) + (x - 0.5) * Math.log(t) - t + Math.log(g);
}
export function gammaFn(x) {
  if (x > 0) return Math.exp(gammaln(x));
  if (Number.isInteger(x)) return NaN; // poles at 0, -1, -2, …
  return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x)); // reflection
}
function factInt(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }

one('GAMMALN', gammaln, (n) => n > 0);
reg({ name: 'GAMMALN.PRECISE', aliases: [], min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; return n > 0 ? gammaln(n) : err(ERR.NUM); } });
reg({ name: 'GAMMA', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const r = gammaFn(n); return Number.isFinite(r) ? r : err(ERR.NUM); }, help: { syntax: 'GAMMA(value)' } });
reg({ name: 'FACT', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const k = Math.floor(n); if (k < 0 || k > 170) return err(ERR.NUM); return factInt(k); }, help: { syntax: 'FACT(value)' } });
reg({ name: 'FACTDOUBLE', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const k = Math.floor(n); if (k < -1 || k > 300) return err(ERR.NUM); let r = 1; for (let i = k; i > 1; i -= 2) r *= i; return r; } });
function combin(n, k) { if (k < 0 || n < 0 || k > n) return NaN; k = Math.min(k, n - k); let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); }
reg({ name: 'COMBIN', min: 2, max: 2, fn: (a) => { const n = num(a[0]), k = num(a[1]); if (isError(n)) return n; if (isError(k)) return k; const r = combin(Math.floor(n), Math.floor(k)); return Number.isFinite(r) ? r : err(ERR.NUM); }, help: { syntax: 'COMBIN(n, k)' } });
reg({ name: 'COMBINA', min: 2, max: 2, fn: (a) => { let n = num(a[0]), k = num(a[1]); if (isError(n)) return n; if (isError(k)) return k; n = Math.floor(n); k = Math.floor(k); if (n < 0 || k < 0) return err(ERR.NUM); if (n === 0 && k === 0) return 1; const r = combin(n + k - 1, k); return Number.isFinite(r) ? r : err(ERR.NUM); } });
reg({ name: 'PERMUT', min: 2, max: 2, fn: (a) => { let n = num(a[0]), k = num(a[1]); if (isError(n)) return n; if (isError(k)) return k; n = Math.floor(n); k = Math.floor(k); if (k < 0 || n < 0 || k > n) return err(ERR.NUM); let r = 1; for (let i = 0; i < k; i++) r *= (n - i); return r; }, help: { syntax: 'PERMUT(n, k)' } });
reg({ name: 'PERMUTATIONA', min: 2, max: 2, fn: (a) => { const n = num(a[0]), k = num(a[1]); if (isError(n)) return n; if (isError(k)) return k; if (n < 0 || k < 0) return err(ERR.NUM); return Math.pow(Math.floor(n), Math.floor(k)); } });
reg({ name: 'MULTINOMIAL', min: 1, fn: (a) => { const xs = numsAll(a); if (isError(xs)) return xs; let sum = 0, denom = 1; for (const x of xs) { const k = Math.floor(x); if (k < 0) return err(ERR.NUM); sum += k; denom *= factInt(k); } return Math.round(factInt(sum) / denom); } });

/* =========================================================
   SUMS OF SQUARES / SERIES
   ========================================================= */
reg({ name: 'SUMSQ', min: 1, fn: (a) => { const xs = numsAll(a); if (isError(xs)) return xs; return xs.reduce((s, x) => s + x * x, 0); }, help: { syntax: 'SUMSQ(value1, [value2, …])' } });
function pairwise(a, f) {
  const xs = nums([a[0]]); const ys = nums([a[1]]);
  if (isError(xs)) return xs; if (isError(ys)) return ys;
  if (xs.length !== ys.length || !xs.length) return err(ERR.NA);
  let s = 0; for (let i = 0; i < xs.length; i++) s += f(xs[i], ys[i]);
  return s;
}
reg({ name: 'SUMX2MY2', min: 2, max: 2, fn: (a) => pairwise(a, (x, y) => x * x - y * y) });
reg({ name: 'SUMX2PY2', min: 2, max: 2, fn: (a) => pairwise(a, (x, y) => x * x + y * y) });
reg({ name: 'SUMXMY2', min: 2, max: 2, fn: (a) => pairwise(a, (x, y) => (x - y) * (x - y)) });
reg({ name: 'SERIESSUM', min: 4, max: 4, fn: (a) => {
  const x = num(a[0]), n = num(a[1]), m = num(a[2]);
  if (isError(x)) return x; if (isError(n)) return n; if (isError(m)) return m;
  const cs = nums([a[3]]); if (isError(cs)) return cs;
  let s = 0; for (let i = 0; i < cs.length; i++) s += cs[i] * Math.pow(x, n + i * m);
  return Number.isFinite(s) ? s : err(ERR.NUM);
} });
reg({ name: 'COUNTUNIQUE', min: 1, fn: (a) => {
  const seen = new Set();
  for (const arg of a) for (const v of flatten(arg)) { if (isError(v)) return v; if (v == null || v === '') continue; seen.add(typeof v + '|' + String(v).toLowerCase()); }
  return seen.size;
}, help: { syntax: 'COUNTUNIQUE(value1, [value2, …])' } });

/* =========================================================
   CEILING / FLOOR VARIANTS
   ========================================================= */
function ceilTo(n, sig) { if (sig === 0) return 0; return Math.ceil(n / sig) * sig; }
function floorTo(n, sig) { if (sig === 0) return 0; return Math.floor(n / sig) * sig; }
reg({ name: 'CEILING.MATH', min: 1, max: 3, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; let sig = a.length > 1 ? num(a[1]) : 1; if (isError(sig)) return sig; sig = Math.abs(sig) || 1; const mode = a.length > 2 ? num(a[2]) : 0; if (isError(mode)) return mode; if (n < 0 && mode) return -ceilTo(-n, sig); return ceilTo(n, sig); } });
reg({ name: 'CEILING.PRECISE', aliases: ['ISO.CEILING'], min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; let sig = a.length > 1 ? num(a[1]) : 1; if (isError(sig)) return sig; return ceilTo(n, Math.abs(sig) || 1); } });
reg({ name: 'FLOOR.MATH', min: 1, max: 3, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; let sig = a.length > 1 ? num(a[1]) : 1; if (isError(sig)) return sig; sig = Math.abs(sig) || 1; const mode = a.length > 2 ? num(a[2]) : 0; if (isError(mode)) return mode; if (n < 0 && mode) return -floorTo(-n, sig); return floorTo(n, sig); } });
reg({ name: 'FLOOR.PRECISE', min: 1, max: 2, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; let sig = a.length > 1 ? num(a[1]) : 1; if (isError(sig)) return sig; return floorTo(n, Math.abs(sig) || 1); } });

/* =========================================================
   NUMBER BASES / ROMAN
   ========================================================= */
reg({ name: 'BASE', min: 2, max: 3, fn: (a) => {
  const n = num(a[0]), b = num(a[1]); if (isError(n)) return n; if (isError(b)) return b;
  const base = Math.floor(b); if (base < 2 || base > 36 || n < 0) return err(ERR.NUM);
  let s = Math.floor(n).toString(base).toUpperCase();
  const minLen = a.length > 2 ? num(a[2]) : 0; if (isError(minLen)) return minLen;
  while (s.length < minLen) s = '0' + s;
  return s;
}, help: { syntax: 'BASE(value, base, [min_length])' } });
reg({ name: 'DECIMAL', min: 2, max: 2, fn: (a) => {
  const s = str(a[0]); if (isError(s)) return s;
  const b = num(a[1]); if (isError(b)) return b;
  const base = Math.floor(b); if (base < 2 || base > 36) return err(ERR.NUM);
  const n = parseInt(String(s).trim(), base);
  if (!Number.isFinite(n) || String(s).trim() === '') return err(ERR.NUM);
  // reject digits outside the base (parseInt stops silently)
  if (!new RegExp(`^[0-9a-z]{1,}$`, 'i').test(String(s).trim()) || Math.floor(n).toString(base).toUpperCase() !== String(s).trim().toUpperCase().replace(/^0+(?=.)/, '')) return err(ERR.NUM);
  return n;
}, help: { syntax: 'DECIMAL(value, base)' } });
const ROMAN_MAP = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
reg({ name: 'ROMAN', min: 1, max: 2, fn: (a) => { let n = num(a[0]); if (isError(n)) return n; n = Math.floor(n); if (n < 1 || n > 3999) return err(ERR.VALUE); let out = ''; for (const [v, sym] of ROMAN_MAP) while (n >= v) { out += sym; n -= v; } return out; }, help: { syntax: 'ROMAN(value)' } });
reg({ name: 'ARABIC', min: 1, max: 1, fn: (a) => {
  const s = str(a[0]); if (isError(s)) return s;
  const t = String(s).trim().toUpperCase(); if (!/^-?[MDCLXVI]*$/.test(t)) return err(ERR.VALUE);
  const neg = t.startsWith('-'); const body = neg ? t.slice(1) : t;
  const V = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0; for (let i = 0; i < body.length; i++) { const cur = V[body[i]], nxt = V[body[i + 1]] || 0; total += cur < nxt ? -cur : cur; }
  return neg ? -total : total;
} });

/* =========================================================
   MATRIX MATH
   ========================================================= */
function numMatrix(v) {
  const m = mat(v); const out = [];
  for (const row of m) { const r = []; for (const x of row) { const n = toNumber(x); if (isError(n)) return n; r.push(n); } out.push(r); }
  return out;
}
reg({ name: 'MMULT', min: 2, max: 2, fn: (a) => {
  const A = numMatrix(a[0]); if (isError(A)) return A;
  const B = numMatrix(a[1]); if (isError(B)) return B;
  const n = A.length, k = A[0]?.length || 0, m = B[0]?.length || 0;
  if (k !== B.length || !n || !k || !m) return err(ERR.VALUE);
  const out = [];
  for (let i = 0; i < n; i++) { const row = []; for (let j = 0; j < m; j++) { let s = 0; for (let t = 0; t < k; t++) s += A[i][t] * B[t][j]; row.push(s); } out.push(row); }
  return makeArray(out);
}, help: { syntax: 'MMULT(matrix1, matrix2)' } });
function luDecompose(M) {
  // returns { LU, perm, parity } or null if singular — partial pivoting
  const n = M.length; const A = M.map((r) => r.slice()); const perm = [...Array(n).keys()]; let parity = 1;
  for (let col = 0; col < n; col++) {
    let best = col; for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[best][col])) best = r;
    if (Math.abs(A[best][col]) < 1e-12) return null;
    if (best !== col) { [A[best], A[col]] = [A[col], A[best]]; [perm[best], perm[col]] = [perm[col], perm[best]]; parity = -parity; }
    for (let r = col + 1; r < n; r++) { A[r][col] /= A[col][col]; for (let c2 = col + 1; c2 < n; c2++) A[r][c2] -= A[r][col] * A[col][c2]; }
  }
  return { LU: A, perm, parity };
}
reg({ name: 'MDETERM', min: 1, max: 1, fn: (a) => {
  const M = numMatrix(a[0]); if (isError(M)) return M;
  const n = M.length; if (!n || M[0].length !== n) return err(ERR.VALUE);
  const lu = luDecompose(M); if (!lu) return 0;
  let d = lu.parity; for (let i = 0; i < n; i++) d *= lu.LU[i][i];
  return d;
} });
reg({ name: 'MINVERSE', min: 1, max: 1, fn: (a) => {
  const M = numMatrix(a[0]); if (isError(M)) return M;
  const n = M.length; if (!n || M[0].length !== n) return err(ERR.VALUE);
  const lu = luDecompose(M); if (!lu) return err(ERR.NUM);
  const inv = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let col = 0; col < n; col++) {
    const b = new Array(n).fill(0); b[lu.perm.indexOf(col)] = 1;
    // forward substitution (L, unit diagonal)
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let j = 0; j < i; j++) s -= lu.LU[i][j] * y[j]; y[i] = s; }
    // back substitution (U)
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < n; j++) s -= lu.LU[i][j] * inv[j][col]; inv[i][col] = s / lu.LU[i][i]; }
  }
  return makeArray(inv);
} });
reg({ name: 'MUNIT', min: 1, max: 1, fn: (a) => { const n = num(a[0]); if (isError(n)) return n; const k = Math.floor(n); if (k < 1 || k > 512) return err(ERR.NUM); return makeArray(Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)))); } });

/* =========================================================
   SUBTOTAL (codes 1-11; 101-111 treated the same — the engine
   has no per-call visibility of hidden rows)
   ========================================================= */
reg({ name: 'SUBTOTAL', min: 2, fn: (a) => {
  const code0 = num(a[0]); if (isError(code0)) return code0;
  const code = Math.floor(code0) % 100;
  const xs = numsAll(a.slice(1)); if (isError(xs)) return xs;
  const n = xs.length;
  const mean = () => xs.reduce((s, x) => s + x, 0) / n;
  const variance = (pop) => { const m = mean(); return xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (pop ? n : n - 1); };
  switch (code) {
    case 1: return n ? mean() : err(ERR.DIV0);
    case 2: return n;
    case 3: { let c = 0; for (const arg of a.slice(1)) for (const v of flatten(arg)) if (v != null && v !== '') c++; return c; }
    case 4: return n ? Math.max(...xs) : 0;
    case 5: return n ? Math.min(...xs) : 0;
    case 6: return xs.reduce((s, x) => s * x, 1);
    case 7: return n > 1 ? Math.sqrt(variance(false)) : err(ERR.DIV0);
    case 8: return n ? Math.sqrt(variance(true)) : err(ERR.DIV0);
    case 9: return xs.reduce((s, x) => s + x, 0);
    case 10: return n > 1 ? variance(false) : err(ERR.DIV0);
    case 11: return n ? variance(true) : err(ERR.DIV0);
    default: return err(ERR.VALUE);
  }
}, help: { syntax: 'SUBTOTAL(function_code, range1, [range2, …])' } });

/* =========================================================
   OPERATOR FUNCTIONS (Google Sheets exposes every operator
   as a function)
   ========================================================= */
const binNum = (name, f, syntax) => reg({ name, min: 2, max: 2, fn: (a) => { const x = num(a[0]), y = num(a[1]); if (isError(x)) return x; if (isError(y)) return y; const r = f(x, y); return Number.isFinite(r) ? r : (r === Infinity || r === -Infinity || Number.isNaN(r)) && y === 0 ? err(ERR.DIV0) : err(ERR.NUM); }, help: { syntax } });
binNum('ADD', (x, y) => x + y, 'ADD(value1, value2)');
binNum('MINUS', (x, y) => x - y, 'MINUS(value1, value2)');
binNum('MULTIPLY', (x, y) => x * y, 'MULTIPLY(factor1, factor2)');
reg({ name: 'DIVIDE', min: 2, max: 2, fn: (a) => { const x = num(a[0]), y = num(a[1]); if (isError(x)) return x; if (isError(y)) return y; return y === 0 ? err(ERR.DIV0) : x / y; }, help: { syntax: 'DIVIDE(dividend, divisor)' } });
binNum('POW', (x, y) => Math.pow(x, y), 'POW(base, exponent)');
reg({ name: 'UMINUS', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : -n; } });
reg({ name: 'UPLUS', min: 1, max: 1, fn: (a) => scalar(a[0]) });
reg({ name: 'UNARY_PERCENT', min: 1, max: 1, fn: (a) => { const n = num(a[0]); return isError(n) ? n : n / 100; } });
const cmp = (name, f, syntax) => reg({ name, min: 2, max: 2, fn: (a) => { const x = scalar(a[0]), y = scalar(a[1]); if (isError(x)) return x; if (isError(y)) return y; return f(compare(x, y)); }, help: { syntax } });
cmp('EQ', (c) => c === 0, 'EQ(value1, value2)');
cmp('NE', (c) => c !== 0, 'NE(value1, value2)');
cmp('GT', (c) => c > 0, 'GT(value1, value2)');
cmp('GTE', (c) => c >= 0, 'GTE(value1, value2)');
cmp('LT', (c) => c < 0, 'LT(value1, value2)');
cmp('LTE', (c) => c <= 0, 'LTE(value1, value2)');
reg({ name: 'ISBETWEEN', min: 3, max: 5, fn: (a) => {
  const v = num(a[0]), lo = num(a[1]), hi = num(a[2]);
  if (isError(v)) return v; if (isError(lo)) return lo; if (isError(hi)) return hi;
  const incLo = a.length > 3 ? scalar(a[3]) !== false : true;
  const incHi = a.length > 4 ? scalar(a[4]) !== false : true;
  return (incLo ? v >= lo : v > lo) && (incHi ? v <= hi : v < hi);
}, help: { syntax: 'ISBETWEEN(value, low, high, [low_inclusive], [high_inclusive])' } });
