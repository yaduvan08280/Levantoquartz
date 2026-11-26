// ============================================================
//  Mono formula engine — statistical catalog (GS parity pass)
//  Descriptive stats, order statistics, regression/correlation,
//  and the distribution family (normal/t/chi-sq/F/gamma/beta/
//  binomial/poisson/…) with both legacy (NORMDIST) and dotted
//  (NORM.DIST) names, matching Google Sheets.
//
//  Numeric kernels: Lanczos ln-gamma (imported), regularized
//  incomplete gamma P(s,x) (series + continued fraction),
//  regularized incomplete beta I_x(a,b) (Lentz continued
//  fraction), Acklam inverse normal. Inverse CDFs solved by
//  bisection on the forward CDF — slow-ish but exact enough
//  (1e-10) and immune to bad starting points.
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { isArray, makeArray, scalar, flatten, toNumber, flatOf} from './values.js';
import { critTest } from './builtins.js';
import { gammaln } from './builtins_math2.js';

const reg = (def) => registry.register(def);
const num = (v) => toNumber(scalar(v));

/** Numbers from all args; blanks/text-in-range skipped; first error wins. */
function nums(args) {
  const out = [];
  for (const a of args) {
    const fromRange = isArray(a);
    for (const v of flatten(a)) {
      if (isError(v)) return v;
      if (v == null || v === '') continue;
      if (fromRange && typeof v !== 'number') continue; // ranges: text/bools ignored (Sheets)
      const n = toNumber(v);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}
/** "A" variants: text counts as 0, booleans as 1/0, blanks skipped. */
function numsA(args) {
  const out = [];
  for (const a of args) for (const v of flatten(a)) {
    if (isError(v)) return v;
    if (v == null) continue;
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'boolean') out.push(v ? 1 : 0);
    else out.push(0);
  }
  return out;
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const ssdev = (xs) => { const m = mean(xs); return xs.reduce((s, x) => s + (x - m) * (x - m), 0); };
const varS = (xs) => ssdev(xs) / (xs.length - 1);
const varP = (xs) => ssdev(xs) / xs.length;

/* =========================================================
   DESCRIPTIVE
   ========================================================= */
function statReg(name, fnOnXs, minCount, help) {
  reg({ name, min: 1, fn: (a) => { const xs = nums(a); if (isError(xs)) return xs; if (xs.length < minCount) return err(ERR.DIV0); return fnOnXs(xs); }, help: help ? { syntax: help } : undefined });
}
function statRegA(name, fnOnXs, minCount) {
  reg({ name, min: 1, fn: (a) => { const xs = numsA(a); if (isError(xs)) return xs; if (xs.length < minCount) return err(ERR.DIV0); return fnOnXs(xs); } });
}
statReg('STDEV', (xs) => Math.sqrt(varS(xs)), 2, 'STDEV(value1, [value2, …])');
registry.register({ ...registry.get('STDEV'), name: 'STDEV.S' });
statReg('STDEVP', (xs) => Math.sqrt(varP(xs)), 1, 'STDEVP(value1, [value2, …])');
registry.register({ ...registry.get('STDEVP'), name: 'STDEV.P' });
statRegA('STDEVA', (xs) => Math.sqrt(varS(xs)), 2);
statRegA('STDEVPA', (xs) => Math.sqrt(varP(xs)), 1);
statReg('VAR', varS, 2, 'VAR(value1, [value2, …])');
registry.register({ ...registry.get('VAR'), name: 'VAR.S' });
statReg('VARP', varP, 1, 'VARP(value1, [value2, …])');
registry.register({ ...registry.get('VARP'), name: 'VAR.P' });
statRegA('VARA', varS, 2);
statRegA('VARPA', varP, 1);
statReg('AVEDEV', (xs) => { const m = mean(xs); return xs.reduce((s, x) => s + Math.abs(x - m), 0) / xs.length; }, 1);
statReg('DEVSQ', ssdev, 1);
statReg('GEOMEAN', (xs) => { if (xs.some((x) => x <= 0)) return err(ERR.NUM); return Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length); }, 1, 'GEOMEAN(value1, [value2, …])');
statReg('HARMEAN', (xs) => { if (xs.some((x) => x <= 0)) return err(ERR.NUM); return xs.length / xs.reduce((s, x) => s + 1 / x, 0); }, 1);
statRegA('AVERAGEA', mean, 1);
statRegA('MAXA', (xs) => Math.max(...xs), 1);
statRegA('MINA', (xs) => Math.min(...xs), 1);
reg({ name: 'TRIMMEAN', min: 2, max: 2, fn: (a) => {
  const xs = nums([a[0]]); if (isError(xs)) return xs;
  const p = num(a[1]); if (isError(p)) return p;
  if (p < 0 || p >= 1 || !xs.length) return err(ERR.NUM);
  const cut = Math.floor(xs.length * p / 2);
  const sorted = xs.slice().sort((x, y) => x - y).slice(cut, xs.length - cut);
  return sorted.length ? mean(sorted) : err(ERR.NUM);
}, help: { syntax: 'TRIMMEAN(data, exclude_proportion)' } });
reg({ name: 'MODE.MULT', min: 1, fn: (a) => {
  const xs = nums(a); if (isError(xs)) return xs;
  const cnt = new Map(); for (const x of xs) cnt.set(x, (cnt.get(x) || 0) + 1);
  let best = 0; for (const c of cnt.values()) best = Math.max(best, c);
  if (best < 2) return err(ERR.NA);
  const modes = [...cnt.entries()].filter(([, c]) => c === best).map(([x]) => [x]);
  return makeArray(modes);
} });

/* ---- multi-criteria aggregates (reuse SUMIFS criteria semantics) ---- */
function ifsAggregate(a, fold, empty) {
  const first = isArray(a[0]) ? flatOf(a[0]) : [scalar(a[0])];
  let acc = null, n = 0;
  for (let i = 0; i < first.length; i++) {
    let ok = true;
    for (let p = 1; p < a.length; p += 2) {
      const rng = isArray(a[p]) ? flatOf(a[p]) : [scalar(a[p])];
      if (!critTest(rng[i], a[p + 1])) { ok = false; break; }
    }
    if (ok && typeof first[i] === 'number') { acc = acc === null ? first[i] : fold(acc, first[i]); n++; }
  }
  return { acc, n, empty };
}
reg({ name: 'AVERAGEIFS', min: 3, fn: (a) => { const first = isArray(a[0]) ? flatOf(a[0]) : [scalar(a[0])]; let t = 0, n = 0; for (let i = 0; i < first.length; i++) { let ok = true; for (let p = 1; p < a.length; p += 2) { const rng = isArray(a[p]) ? flatOf(a[p]) : [scalar(a[p])]; if (!critTest(rng[i], a[p + 1])) { ok = false; break; } } if (ok && typeof first[i] === 'number') { t += first[i]; n++; } } return n ? t / n : err(ERR.DIV0); }, help: { syntax: 'AVERAGEIFS(average_range, criteria_range1, criterion1, …)' } });
reg({ name: 'MAXIFS', min: 3, fn: (a) => { const { acc } = ifsAggregate(a, Math.max); return acc === null ? 0 : acc; }, help: { syntax: 'MAXIFS(range, criteria_range1, criterion1, …)' } });
reg({ name: 'MINIFS', min: 3, fn: (a) => { const { acc } = ifsAggregate(a, Math.min); return acc === null ? 0 : acc; }, help: { syntax: 'MINIFS(range, criteria_range1, criterion1, …)' } });

/* =========================================================
   ORDER STATISTICS
   ========================================================= */
function percentileInc(xs, k) {
  if (k < 0 || k > 1 || !xs.length) return err(ERR.NUM);
  const s = xs.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * k, lo = Math.floor(pos), frac = pos - lo;
  return lo + 1 < s.length ? s[lo] + frac * (s[lo + 1] - s[lo]) : s[lo];
}
function percentileExc(xs, k) {
  const n = xs.length;
  if (!n || k <= 0 || k >= 1) return err(ERR.NUM);
  const s = xs.slice().sort((a, b) => a - b);
  const pos = k * (n + 1);
  if (pos < 1 || pos > n) return err(ERR.NUM);
  const lo = Math.floor(pos), frac = pos - lo;
  return lo < n ? s[lo - 1] + frac * ((s[lo] ?? s[lo - 1]) - s[lo - 1]) : s[n - 1];
}
reg({ name: 'PERCENTILE', aliases: ['PERCENTILE.INC'], min: 2, max: 2, fn: (a) => { const xs = nums([a[0]]); if (isError(xs)) return xs; const k = num(a[1]); if (isError(k)) return k; return percentileInc(xs, k); }, help: { syntax: 'PERCENTILE(data, percentile)' } });
reg({ name: 'PERCENTILE.EXC', min: 2, max: 2, fn: (a) => { const xs = nums([a[0]]); if (isError(xs)) return xs; const k = num(a[1]); if (isError(k)) return k; return percentileExc(xs, k); } });
reg({ name: 'QUARTILE', aliases: ['QUARTILE.INC'], min: 2, max: 2, fn: (a) => { const xs = nums([a[0]]); if (isError(xs)) return xs; const q = num(a[1]); if (isError(q)) return q; const k = Math.floor(q); if (k < 0 || k > 4) return err(ERR.NUM); return percentileInc(xs, k / 4); }, help: { syntax: 'QUARTILE(data, quartile_number)' } });
reg({ name: 'QUARTILE.EXC', min: 2, max: 2, fn: (a) => { const xs = nums([a[0]]); if (isError(xs)) return xs; const q = num(a[1]); if (isError(q)) return q; const k = Math.floor(q); if (k < 1 || k > 3) return err(ERR.NUM); return percentileExc(xs, k / 4); } });
function rankOf(x, xs, ascending) {
  const s = xs.slice().sort((a, b) => (ascending ? a - b : b - a));
  const i = s.findIndex((v) => v === x);
  return i === -1 ? err(ERR.NA) : i + 1;
}
reg({ name: 'RANK', aliases: ['RANK.EQ'], min: 2, max: 3, fn: (a) => { const x = num(a[0]); if (isError(x)) return x; const xs = nums([a[1]]); if (isError(xs)) return xs; const asc = a.length > 2 ? !!scalar(a[2]) : false; return rankOf(x, xs, asc); }, help: { syntax: 'RANK(value, data, [is_ascending])' } });
reg({ name: 'RANK.AVG', min: 2, max: 3, fn: (a) => {
  const x = num(a[0]); if (isError(x)) return x;
  const xs = nums([a[1]]); if (isError(xs)) return xs;
  const asc = a.length > 2 ? !!scalar(a[2]) : false;
  const s = xs.slice().sort((p, q) => (asc ? p - q : q - p));
  const idx = []; s.forEach((v, i) => { if (v === x) idx.push(i + 1); });
  return idx.length ? idx.reduce((p, q) => p + q, 0) / idx.length : err(ERR.NA);
} });
reg({ name: 'PERCENTRANK', aliases: ['PERCENTRANK.INC'], min: 2, max: 3, fn: (a) => {
  const xs = nums([a[0]]); if (isError(xs)) return xs;
  const x = num(a[1]); if (isError(x)) return x;
  const digits = a.length > 2 ? num(a[2]) : 3; if (isError(digits)) return digits;
  const s = xs.slice().sort((p, q) => p - q);
  if (!s.length || x < s[0] || x > s[s.length - 1]) return err(ERR.NA);
  let below = 0; while (below < s.length && s[below] < x) below++;
  let r;
  if (s[below] === x) r = below / (s.length - 1);
  else { const lo = s[below - 1], hi = s[below]; r = ((below - 1) + (x - lo) / (hi - lo)) / (s.length - 1); }
  const f = 10 ** Math.floor(digits);
  return Math.floor(r * f) / f;
} });
reg({ name: 'FREQUENCY', min: 2, max: 2, fn: (a) => {
  const data = nums([a[0]]); if (isError(data)) return data;
  const bins = nums([a[1]]); if (isError(bins)) return bins;
  const sorted = bins.slice().sort((x, y) => x - y);
  const counts = new Array(sorted.length + 1).fill(0);
  for (const x of data) {
    let placed = false;
    for (let i = 0; i < sorted.length; i++) if (x <= sorted[i] && (i === 0 || x > sorted[i - 1])) { counts[i]++; placed = true; break; }
    if (!placed) counts[sorted.length]++;
  }
  return makeArray(counts.map((c) => [c]));
}, help: { syntax: 'FREQUENCY(data, classes)' } });

/* =========================================================
   RELATIONSHIP / REGRESSION
   ========================================================= */
function pairs(a0, a1) {
  const xs = nums([a0]); if (isError(xs)) return xs;
  const ys = nums([a1]); if (isError(ys)) return ys;
  if (xs.length !== ys.length || xs.length < 2) return err(ERR.NA);
  return { xs, ys };
}
function covar(xs, ys, pop) { const mx = mean(xs), my = mean(ys); let s = 0; for (let i = 0; i < xs.length; i++) s += (xs[i] - mx) * (ys[i] - my); return s / (pop ? xs.length : xs.length - 1); }
function correl(xs, ys) { const c = covar(xs, ys, true); const sx = Math.sqrt(varP(xs)), sy = Math.sqrt(varP(ys)); return sx && sy ? c / (sx * sy) : err(ERR.DIV0); }
// NOTE: Sheets' CORREL(data_y, data_x) — symmetric, order irrelevant.
reg({ name: 'CORREL', aliases: ['PEARSON'], min: 2, max: 2, fn: (a) => { const p = pairs(a[0], a[1]); return isError(p) ? p : correl(p.xs, p.ys); }, help: { syntax: 'CORREL(data_y, data_x)' } });
reg({ name: 'RSQ', min: 2, max: 2, fn: (a) => { const p = pairs(a[0], a[1]); if (isError(p)) return p; const r = correl(p.xs, p.ys); return isError(r) ? r : r * r; } });
reg({ name: 'COVAR', aliases: ['COVARIANCE.P'], min: 2, max: 2, fn: (a) => { const p = pairs(a[0], a[1]); return isError(p) ? p : covar(p.xs, p.ys, true); } });
reg({ name: 'COVARIANCE.S', min: 2, max: 2, fn: (a) => { const p = pairs(a[0], a[1]); return isError(p) ? p : covar(p.xs, p.ys, false); } });
// SLOPE/INTERCEPT take (data_y, data_x) — y FIRST, matching Sheets/Excel.
function slopeIntercept(a) {
  const p = pairs(a[1], a[0]); if (isError(p)) return p; // p.xs = x data, p.ys = y data
  const sxx = ssdev(p.xs); if (!sxx) return err(ERR.DIV0);
  const slope = covar(p.xs, p.ys, true) * p.xs.length / sxx;
  return { slope, intercept: mean(p.ys) - slope * mean(p.xs), xs: p.xs, ys: p.ys };
}
reg({ name: 'SLOPE', min: 2, max: 2, fn: (a) => { const r = slopeIntercept(a); return isError(r) ? r : r.slope; }, help: { syntax: 'SLOPE(data_y, data_x)' } });
reg({ name: 'INTERCEPT', min: 2, max: 2, fn: (a) => { const r = slopeIntercept(a); return isError(r) ? r : r.intercept; }, help: { syntax: 'INTERCEPT(data_y, data_x)' } });
reg({ name: 'FORECAST', aliases: ['FORECAST.LINEAR'], min: 3, max: 3, fn: (a) => { const x = num(a[0]); if (isError(x)) return x; const r = slopeIntercept([a[1], a[2]]); return isError(r) ? r : r.intercept + r.slope * x; }, help: { syntax: 'FORECAST(x, data_y, data_x)' } });
reg({ name: 'STEYX', min: 2, max: 2, fn: (a) => {
  const r = slopeIntercept(a); if (isError(r)) return r;
  const n = r.xs.length; if (n < 3) return err(ERR.DIV0);
  let sse = 0; for (let i = 0; i < n; i++) { const e = r.ys[i] - (r.intercept + r.slope * r.xs[i]); sse += e * e; }
  return Math.sqrt(sse / (n - 2));
} });
reg({ name: 'TREND', min: 1, max: 3, fn: (a) => {
  const ys = nums([a[0]]); if (isError(ys)) return ys;
  const xs = a.length > 1 && a[1] != null ? nums([a[1]]) : ys.map((_, i) => i + 1);
  if (isError(xs)) return xs;
  const r = slopeIntercept([a[0], a.length > 1 && a[1] != null ? a[1] : makeArray([xs])]);
  if (isError(r)) return r;
  const newX = a.length > 2 ? nums([a[2]]) : xs;
  if (isError(newX)) return newX;
  return makeArray(newX.map((x) => [r.intercept + r.slope * x]));
} });
reg({ name: 'FISHER', min: 1, max: 1, fn: (a) => { const x = num(a[0]); if (isError(x)) return x; if (x <= -1 || x >= 1) return err(ERR.NUM); return Math.atanh(x); } });
reg({ name: 'FISHERINV', min: 1, max: 1, fn: (a) => { const x = num(a[0]); return isError(x) ? x : Math.tanh(x); } });
reg({ name: 'STANDARDIZE', min: 3, max: 3, fn: (a) => { const x = num(a[0]), m = num(a[1]), s = num(a[2]); if (isError(x)) return x; if (isError(m)) return m; if (isError(s)) return s; return s > 0 ? (x - m) / s : err(ERR.NUM); } });
reg({ name: 'SKEW', min: 1, fn: (a) => { const xs = nums(a); if (isError(xs)) return xs; const n = xs.length; if (n < 3) return err(ERR.DIV0); const s = Math.sqrt(varS(xs)); if (!s) return err(ERR.DIV0); const m = mean(xs); return n / ((n - 1) * (n - 2)) * xs.reduce((t, x) => t + ((x - m) / s) ** 3, 0); } });
reg({ name: 'SKEW.P', min: 1, fn: (a) => { const xs = nums(a); if (isError(xs)) return xs; const n = xs.length; if (n < 1) return err(ERR.DIV0); const s = Math.sqrt(varP(xs)); if (!s) return err(ERR.DIV0); const m = mean(xs); return xs.reduce((t, x) => t + ((x - m) / s) ** 3, 0) / n; } });
reg({ name: 'KURT', min: 1, fn: (a) => {
  const xs = nums(a); if (isError(xs)) return xs;
  const n = xs.length; if (n < 4) return err(ERR.DIV0);
  const s = Math.sqrt(varS(xs)); if (!s) return err(ERR.DIV0);
  const m = mean(xs);
  const s4 = xs.reduce((t, x) => t + ((x - m) / s) ** 4, 0);
  return (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * s4 - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
} });
reg({ name: 'PROB', min: 3, max: 4, fn: (a) => {
  const xs = nums([a[0]]); if (isError(xs)) return xs;
  const ps = nums([a[1]]); if (isError(ps)) return ps;
  if (xs.length !== ps.length) return err(ERR.NA);
  if (ps.some((p) => p < 0 || p > 1) || Math.abs(ps.reduce((s, p) => s + p, 0) - 1) > 1e-9) return err(ERR.NUM);
  const lo = num(a[2]); if (isError(lo)) return lo;
  const hi = a.length > 3 ? num(a[3]) : lo; if (isError(hi)) return hi;
  let t = 0; for (let i = 0; i < xs.length; i++) if (xs[i] >= lo && xs[i] <= hi) t += ps[i];
  return t;
} });

/* =========================================================
   NUMERIC KERNELS for distributions
   ========================================================= */
/** Regularized lower incomplete gamma P(s, x). */
export function gammaincP(s, x) {
  if (x < 0 || s <= 0) return NaN;
  if (x === 0) return 0;
  if (x < s + 1) {
    // series
    let sum = 1 / s, term = sum, k = s;
    for (let i = 0; i < 500; i++) { k += 1; term *= x / k; sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-15) break; }
    return sum * Math.exp(-x + s * Math.log(x) - gammaln(s));
  }
  // continued fraction for Q, then P = 1 - Q (Lentz)
  let b = x + 1 - s, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  const q = Math.exp(-x + s * Math.log(x) - gammaln(s)) * h;
  return 1 - q;
}
/** Regularized incomplete beta I_x(a, b). */
export function betainc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = gammaln(a) + gammaln(b) - gammaln(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  // Lentz continued fraction
  const cf = (x2, a2, b2) => {
    let c = 1, d = 1 - (a2 + b2) * x2 / (a2 + 1);
    if (Math.abs(d) < 1e-300) d = 1e-300;
    d = 1 / d; let h = d;
    for (let m = 1; m <= 400; m++) {
      const m2 = 2 * m;
      let aa = m * (b2 - m) * x2 / ((a2 + m2 - 1) * (a2 + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; h *= d * c;
      aa = -(a2 + m) * (a2 + b2 + m) * x2 / ((a2 + m2) * (a2 + m2 + 1));
      d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return h;
  };
  if (x < (a + 1) / (a + b + 2)) return front * cf(x, a, b) / a;
  return 1 - Math.exp(b * Math.log(1 - x) + a * Math.log(x) - lbeta) * cf(1 - x, b, a) / b;
}
export const erf = (x) => (x < 0 ? -1 : 1) * gammaincP(0.5, x * x);
/** Standard normal CDF / PDF / inverse (Acklam). */
export const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const normPdf = (z) => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
export function normInv(p) {
  if (p <= 0 || p >= 1) return NaN;
  const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q, r, x;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1); }
  else if (p <= 1 - pl) { q = p - 0.5; r = q * q; x = (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1); }
  else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1); }
  // one Halley refinement step
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}
/** Invert a monotone CDF by bisection on [lo, hi]. */
function invertCdf(cdf, p, lo, hi) {
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ---- distribution CDFs/PDFs ---- */
const chisqCdf = (x, df) => (x <= 0 ? 0 : gammaincP(df / 2, x / 2));
const tCdf = (t, df) => { const x = df / (df + t * t); const half = 0.5 * betainc(x, df / 2, 0.5); return t > 0 ? 1 - half : half; };
const fCdf = (x, d1, d2) => (x <= 0 ? 0 : betainc(d1 * x / (d1 * x + d2), d1 / 2, d2 / 2));
const gammaCdf = (x, alpha, beta) => (x <= 0 ? 0 : gammaincP(alpha, x / beta));
const gammaPdf = (x, alpha, beta) => (x < 0 ? 0 : Math.exp((alpha - 1) * Math.log(x) - x / beta - gammaln(alpha) - alpha * Math.log(beta)));
const binomPmf = (k, n, p) => Math.exp(gammaln(n + 1) - gammaln(k + 1) - gammaln(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p));

/* =========================================================
   DISTRIBUTIONS (legacy + dotted names, per Google Sheets)
   ========================================================= */
const args3 = (a, n) => { const out = []; for (let i = 0; i < n; i++) { const v = num(a[i]); if (isError(v)) return v; out.push(v); } return out; };

reg({ name: 'NORM.DIST', aliases: ['NORMDIST'], min: 4, max: 4, fn: (a) => {
  const v = args3(a, 3); if (isError(v)) return v; const [x, m, s] = v;
  if (s <= 0) return err(ERR.NUM);
  const cumulative = !!scalar(a[3]);
  return cumulative ? normCdf((x - m) / s) : normPdf((x - m) / s) / s;
}, help: { syntax: 'NORM.DIST(x, mean, standard_deviation, cumulative)' } });
reg({ name: 'NORM.INV', aliases: ['NORMINV'], min: 3, max: 3, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [p, m, s] = v; if (p <= 0 || p >= 1 || s <= 0) return err(ERR.NUM); return m + s * normInv(p); }, help: { syntax: 'NORM.INV(probability, mean, standard_deviation)' } });
reg({ name: 'NORM.S.DIST', aliases: ['NORMSDIST'], min: 1, max: 2, fn: (a) => { const z = num(a[0]); if (isError(z)) return z; const cumulative = a.length > 1 ? !!scalar(a[1]) : true; return cumulative ? normCdf(z) : normPdf(z); } });
reg({ name: 'NORM.S.INV', aliases: ['NORMSINV'], min: 1, max: 1, fn: (a) => { const p = num(a[0]); if (isError(p)) return p; if (p <= 0 || p >= 1) return err(ERR.NUM); return normInv(p); } });
reg({ name: 'LOGNORM.DIST', aliases: ['LOGNORMDIST'], min: 3, max: 4, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [x, m, s] = v; if (x <= 0 || s <= 0) return err(ERR.NUM); const cumulative = a.length > 3 ? !!scalar(a[3]) : true; return cumulative ? normCdf((Math.log(x) - m) / s) : normPdf((Math.log(x) - m) / s) / (x * s); } });
reg({ name: 'LOGNORM.INV', aliases: ['LOGINV'], min: 3, max: 3, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [p, m, s] = v; if (p <= 0 || p >= 1 || s <= 0) return err(ERR.NUM); return Math.exp(m + s * normInv(p)); } });
reg({ name: 'EXPON.DIST', aliases: ['EXPONDIST'], min: 3, max: 3, fn: (a) => { const x = num(a[0]), l = num(a[1]); if (isError(x)) return x; if (isError(l)) return l; if (x < 0 || l <= 0) return err(ERR.NUM); return scalar(a[2]) ? 1 - Math.exp(-l * x) : l * Math.exp(-l * x); } });
reg({ name: 'POISSON.DIST', aliases: ['POISSON'], min: 3, max: 3, fn: (a) => {
  const x0 = num(a[0]), m = num(a[1]); if (isError(x0)) return x0; if (isError(m)) return m;
  const k = Math.floor(x0); if (k < 0 || m < 0) return err(ERR.NUM);
  const pmf = (i) => Math.exp(-m + i * Math.log(m) - gammaln(i + 1));
  if (!scalar(a[2])) return pmf(k);
  let s = 0; for (let i = 0; i <= k; i++) s += pmf(i); return Math.min(1, s);
}, help: { syntax: 'POISSON.DIST(x, mean, cumulative)' } });
reg({ name: 'BINOM.DIST', aliases: ['BINOMDIST'], min: 4, max: 4, fn: (a) => {
  const v = args3(a, 3); if (isError(v)) return v;
  const k = Math.floor(v[0]), n = Math.floor(v[1]), p = v[2];
  if (k < 0 || n < 0 || k > n || p < 0 || p > 1) return err(ERR.NUM);
  if (!scalar(a[3])) return binomPmf(k, n, p);
  let s = 0; for (let i = 0; i <= k; i++) s += binomPmf(i, n, p); return Math.min(1, s);
}, help: { syntax: 'BINOM.DIST(num_successes, num_trials, prob_success, cumulative)' } });
reg({ name: 'BINOM.INV', aliases: ['CRITBINOM'], min: 3, max: 3, fn: (a) => {
  const v = args3(a, 3); if (isError(v)) return v;
  const n = Math.floor(v[0]), p = v[1], alpha = v[2];
  if (n < 0 || p < 0 || p > 1 || alpha <= 0 || alpha >= 1) return err(ERR.NUM);
  let cum = 0; for (let k = 0; k <= n; k++) { cum += binomPmf(k, n, p); if (cum >= alpha) return k; }
  return n;
} });
reg({ name: 'NEGBINOM.DIST', aliases: ['NEGBINOMDIST'], min: 3, max: 4, fn: (a) => {
  const v = args3(a, 3); if (isError(v)) return v;
  const f = Math.floor(v[0]), s = Math.floor(v[1]), p = v[2];
  if (f < 0 || s < 1 || p <= 0 || p > 1) return err(ERR.NUM);
  const pmf = (k) => Math.exp(gammaln(k + s) - gammaln(k + 1) - gammaln(s)) * Math.pow(p, s) * Math.pow(1 - p, k);
  const cumulative = a.length > 3 ? !!scalar(a[3]) : false;
  if (!cumulative) return pmf(f);
  let t = 0; for (let k = 0; k <= f; k++) t += pmf(k); return Math.min(1, t);
} });
reg({ name: 'HYPGEOM.DIST', aliases: ['HYPGEOMDIST'], min: 4, max: 5, fn: (a) => {
  const v = args3(a, 4); if (isError(v)) return v;
  const k = Math.floor(v[0]), n = Math.floor(v[1]), K = Math.floor(v[2]), N = Math.floor(v[3]);
  if (k < 0 || n < 0 || K < 0 || N < 1 || n > N || K > N || k > n || k > K || n - k > N - K) return err(ERR.NUM);
  const lnC = (a2, b2) => gammaln(a2 + 1) - gammaln(b2 + 1) - gammaln(a2 - b2 + 1);
  const pmf = (i) => Math.exp(lnC(K, i) + lnC(N - K, n - i) - lnC(N, n));
  const cumulative = a.length > 4 ? !!scalar(a[4]) : false;
  if (!cumulative) return pmf(k);
  let t = 0; for (let i = Math.max(0, n - (N - K)); i <= k; i++) t += pmf(i); return Math.min(1, t);
} });
reg({ name: 'WEIBULL.DIST', aliases: ['WEIBULL'], min: 4, max: 4, fn: (a) => {
  const v = args3(a, 3); if (isError(v)) return v; const [x, k, l] = v;
  if (x < 0 || k <= 0 || l <= 0) return err(ERR.NUM);
  return scalar(a[3]) ? 1 - Math.exp(-Math.pow(x / l, k)) : (k / l) * Math.pow(x / l, k - 1) * Math.exp(-Math.pow(x / l, k));
} });
reg({ name: 'GAMMA.DIST', aliases: ['GAMMADIST'], min: 4, max: 4, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [x, al, be] = v; if (x < 0 || al <= 0 || be <= 0) return err(ERR.NUM); return scalar(a[3]) ? gammaCdf(x, al, be) : gammaPdf(x, al, be); }, help: { syntax: 'GAMMA.DIST(x, alpha, beta, cumulative)' } });
reg({ name: 'GAMMA.INV', aliases: ['GAMMAINV'], min: 3, max: 3, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [p, al, be] = v; if (p < 0 || p >= 1 || al <= 0 || be <= 0) return err(ERR.NUM); if (p === 0) return 0; return invertCdf((x) => gammaCdf(x, al, be), p, 0, al * be + 20 * Math.sqrt(al) * be + 20); } });
reg({ name: 'BETA.DIST', aliases: ['BETADIST'], min: 3, max: 6, fn: (a) => {
  const v = args3(a, 3); if (isError(v)) return v; let [x, al, be] = v;
  if (al <= 0 || be <= 0) return err(ERR.NUM);
  // legacy BETADIST(x, a, b, [A], [B]) is always cumulative with optional bounds;
  // BETA.DIST(x, a, b, cumulative, [A], [B]) has the flag in slot 4.
  let cumulative = true, lo = 0, hi = 1, rest = a.slice(3);
  if (rest.length && typeof scalar(rest[0]) === 'boolean') { cumulative = !!scalar(rest[0]); rest = rest.slice(1); }
  if (rest.length) { const L = num(rest[0]); if (isError(L)) return L; lo = L; }
  if (rest.length > 1) { const H = num(rest[1]); if (isError(H)) return H; hi = H; }
  if (hi <= lo || x < lo || x > hi) return err(ERR.NUM);
  const t = (x - lo) / (hi - lo);
  if (cumulative) return betainc(t, al, be);
  return Math.exp((al - 1) * Math.log(t) + (be - 1) * Math.log(1 - t) - (gammaln(al) + gammaln(be) - gammaln(al + be))) / (hi - lo);
} });
reg({ name: 'BETA.INV', aliases: ['BETAINV'], min: 3, max: 5, fn: (a) => {
  const v = args3(a, 3); if (isError(v)) return v; const [p, al, be] = v;
  if (p <= 0 || p >= 1 || al <= 0 || be <= 0) return err(ERR.NUM);
  let lo = 0, hi = 1;
  if (a.length > 3) { const L = num(a[3]); if (isError(L)) return L; lo = L; }
  if (a.length > 4) { const H = num(a[4]); if (isError(H)) return H; hi = H; }
  const t = invertCdf((x) => betainc(x, al, be), p, 0, 1);
  return lo + t * (hi - lo);
} });
reg({ name: 'CHISQ.DIST', min: 3, max: 3, fn: (a) => { const x = num(a[0]), df = num(a[1]); if (isError(x)) return x; if (isError(df)) return df; if (df < 1) return err(ERR.NUM); if (scalar(a[2])) return chisqCdf(x, df); return x <= 0 ? 0 : Math.exp((df / 2 - 1) * Math.log(x) - x / 2 - gammaln(df / 2) - (df / 2) * Math.LN2); } });
reg({ name: 'CHISQ.DIST.RT', aliases: ['CHIDIST'], min: 2, max: 2, fn: (a) => { const x = num(a[0]), df = num(a[1]); if (isError(x)) return x; if (isError(df)) return df; if (df < 1) return err(ERR.NUM); return 1 - chisqCdf(x, df); }, help: { syntax: 'CHIDIST(x, degrees_freedom)' } });
reg({ name: 'CHISQ.INV', min: 2, max: 2, fn: (a) => { const p = num(a[0]), df = num(a[1]); if (isError(p)) return p; if (isError(df)) return df; if (p < 0 || p >= 1 || df < 1) return err(ERR.NUM); if (p === 0) return 0; return invertCdf((x) => chisqCdf(x, df), p, 0, df + 40 * Math.sqrt(df) + 40); } });
reg({ name: 'CHISQ.INV.RT', aliases: ['CHIINV'], min: 2, max: 2, fn: (a) => { const p = num(a[0]), df = num(a[1]); if (isError(p)) return p; if (isError(df)) return df; if (p <= 0 || p > 1 || df < 1) return err(ERR.NUM); return invertCdf((x) => chisqCdf(x, df), 1 - p, 0, df + 40 * Math.sqrt(df) + 40); } });
reg({ name: 'CHISQ.TEST', aliases: ['CHITEST'], min: 2, max: 2, fn: (a) => {
  const obs = isArray(a[0]) ? a[0] : makeArray([[scalar(a[0])]]);
  const exp2 = isArray(a[1]) ? a[1] : makeArray([[scalar(a[1])]]);
  if (obs.rows !== exp2.rows || obs.cols !== exp2.cols) return err(ERR.NA);
  let chi = 0;
  for (let r = 0; r < obs.rows; r++) for (let c = 0; c < obs.cols; c++) {
    const o = toNumber(obs.data[r][c]), e = toNumber(exp2.data[r][c]);
    if (isError(o)) return o; if (isError(e)) return e; if (e <= 0) return err(ERR.DIV0);
    chi += (o - e) * (o - e) / e;
  }
  const df = obs.rows > 1 && obs.cols > 1 ? (obs.rows - 1) * (obs.cols - 1) : obs.rows * obs.cols - 1;
  return 1 - chisqCdf(chi, df);
} });
reg({ name: 'T.DIST', min: 3, max: 3, fn: (a) => { const t = num(a[0]), df = num(a[1]); if (isError(t)) return t; if (isError(df)) return df; if (df < 1) return err(ERR.NUM); if (scalar(a[2])) return tCdf(t, df); return Math.exp(gammaln((df + 1) / 2) - gammaln(df / 2)) / Math.sqrt(df * Math.PI) * Math.pow(1 + t * t / df, -(df + 1) / 2); } });
reg({ name: 'T.DIST.RT', min: 2, max: 2, fn: (a) => { const t = num(a[0]), df = num(a[1]); if (isError(t)) return t; if (isError(df)) return df; if (df < 1) return err(ERR.NUM); return 1 - tCdf(t, df); } });
reg({ name: 'T.DIST.2T', aliases: ['TDIST'], min: 2, max: 3, fn: (a) => {
  const t = num(a[0]), df = num(a[1]); if (isError(t)) return t; if (isError(df)) return df;
  if (df < 1 || t < 0) return err(ERR.NUM);
  const tails = a.length > 2 ? Math.floor(num(a[2])) : 2;
  if (isError(tails)) return tails;
  const rt = 1 - tCdf(t, df);
  return tails === 1 ? rt : 2 * rt;
}, help: { syntax: 'TDIST(x, degrees_freedom, tails)' } });
reg({ name: 'T.INV', min: 2, max: 2, fn: (a) => { const p = num(a[0]), df = num(a[1]); if (isError(p)) return p; if (isError(df)) return df; if (p <= 0 || p >= 1 || df < 1) return err(ERR.NUM); return invertCdf((t) => tCdf(t, df), p, -1e4, 1e4); } });
reg({ name: 'T.INV.2T', aliases: ['TINV'], min: 2, max: 2, fn: (a) => { const p = num(a[0]), df = num(a[1]); if (isError(p)) return p; if (isError(df)) return df; if (p <= 0 || p > 1 || df < 1) return err(ERR.NUM); return invertCdf((t) => tCdf(t, df), 1 - p / 2, 0, 1e4); }, help: { syntax: 'TINV(probability, degrees_freedom)' } });
reg({ name: 'F.DIST', min: 4, max: 4, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [x, d1, d2] = v; if (d1 < 1 || d2 < 1) return err(ERR.NUM); if (scalar(a[3])) return fCdf(x, d1, d2); if (x < 0) return 0; const lb = gammaln(d1 / 2) + gammaln(d2 / 2) - gammaln((d1 + d2) / 2); return Math.exp((d1 / 2) * Math.log(d1 / d2) + (d1 / 2 - 1) * Math.log(x) - ((d1 + d2) / 2) * Math.log(1 + d1 * x / d2) - lb); } });
reg({ name: 'F.DIST.RT', aliases: ['FDIST'], min: 3, max: 3, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [x, d1, d2] = v; if (x < 0 || d1 < 1 || d2 < 1) return err(ERR.NUM); return 1 - fCdf(x, d1, d2); }, help: { syntax: 'FDIST(x, degrees_freedom1, degrees_freedom2)' } });
reg({ name: 'F.INV', min: 3, max: 3, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [p, d1, d2] = v; if (p <= 0 || p >= 1 || d1 < 1 || d2 < 1) return err(ERR.NUM); return invertCdf((x) => fCdf(x, d1, d2), p, 0, 1e6); } });
reg({ name: 'F.INV.RT', aliases: ['FINV'], min: 3, max: 3, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [p, d1, d2] = v; if (p <= 0 || p > 1 || d1 < 1 || d2 < 1) return err(ERR.NUM); return invertCdf((x) => fCdf(x, d1, d2), 1 - p, 0, 1e6); } });
reg({ name: 'T.TEST', aliases: ['TTEST'], min: 4, max: 4, fn: (a) => {
  const xs = nums([a[0]]); if (isError(xs)) return xs;
  const ys = nums([a[1]]); if (isError(ys)) return ys;
  const tails = Math.floor(num(a[2])); if (isError(tails)) return tails;
  const type = Math.floor(num(a[3])); if (isError(type)) return type;
  if (tails < 1 || tails > 2 || type < 1 || type > 3) return err(ERR.NUM);
  let t, df;
  if (type === 1) { // paired
    if (xs.length !== ys.length || xs.length < 2) return err(ERR.NA);
    const d = xs.map((x, i) => x - ys[i]);
    const sd = Math.sqrt(varS(d)); if (!sd) return err(ERR.DIV0);
    t = mean(d) / (sd / Math.sqrt(d.length)); df = d.length - 1;
  } else {
    const v1 = varS(xs), v2 = varS(ys), n1 = xs.length, n2 = ys.length;
    if (n1 < 2 || n2 < 2) return err(ERR.DIV0);
    if (type === 2) { // equal variance (pooled)
      const sp = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
      t = (mean(xs) - mean(ys)) / Math.sqrt(sp * (1 / n1 + 1 / n2)); df = n1 + n2 - 2;
    } else { // Welch
      const se = v1 / n1 + v2 / n2;
      t = (mean(xs) - mean(ys)) / Math.sqrt(se);
      df = se * se / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
    }
  }
  const rt = 1 - tCdf(Math.abs(t), df);
  return tails === 1 ? rt : 2 * rt;
} });
reg({ name: 'F.TEST', aliases: ['FTEST'], min: 2, max: 2, fn: (a) => {
  const xs = nums([a[0]]); if (isError(xs)) return xs;
  const ys = nums([a[1]]); if (isError(ys)) return ys;
  if (xs.length < 2 || ys.length < 2) return err(ERR.DIV0);
  const v1 = varS(xs), v2 = varS(ys); if (!v1 || !v2) return err(ERR.DIV0);
  const f = v1 > v2 ? v1 / v2 : v2 / v1;
  const d1 = v1 > v2 ? xs.length - 1 : ys.length - 1;
  const d2 = v1 > v2 ? ys.length - 1 : xs.length - 1;
  return 2 * (1 - fCdf(f, d1, d2));
} });
reg({ name: 'Z.TEST', aliases: ['ZTEST'], min: 2, max: 3, fn: (a) => {
  const xs = nums([a[0]]); if (isError(xs)) return xs;
  const mu = num(a[1]); if (isError(mu)) return mu;
  if (xs.length < 1) return err(ERR.NA);
  let sigma = a.length > 2 ? num(a[2]) : Math.sqrt(varS(xs));
  if (isError(sigma)) return sigma;
  if (!sigma) return err(ERR.DIV0);
  return 1 - normCdf((mean(xs) - mu) / (sigma / Math.sqrt(xs.length)));
} });
reg({ name: 'CONFIDENCE', aliases: ['CONFIDENCE.NORM'], min: 3, max: 3, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [alpha, sd, n0] = v; const n = Math.floor(n0); if (alpha <= 0 || alpha >= 1 || sd <= 0 || n < 1) return err(ERR.NUM); return normInv(1 - alpha / 2) * sd / Math.sqrt(n); }, help: { syntax: 'CONFIDENCE(alpha, standard_deviation, pop_size)' } });
reg({ name: 'CONFIDENCE.T', min: 3, max: 3, fn: (a) => { const v = args3(a, 3); if (isError(v)) return v; const [alpha, sd, n0] = v; const n = Math.floor(n0); if (alpha <= 0 || alpha >= 1 || sd <= 0 || n < 2) return err(ERR.NUM); const t = invertCdf((x) => tCdf(x, n - 1), 1 - alpha / 2, 0, 1e4); return t * sd / Math.sqrt(n); } });
