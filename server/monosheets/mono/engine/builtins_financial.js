// ============================================================
//  Mono formula engine — financial catalog (GS parity pass)
//  Time-value-of-money (PMT/FV/PV/RATE/NPER + I/PPMT via exact
//  period simulation), cash flows (NPV/IRR/MIRR/XNPV/XIRR),
//  depreciation (SLN/SYD/DB/DDB), cumulative interest/principal,
//  rate conversions, dollar fractions, and T-bill/discount
//  security basics. Coupon-bond pricing (PRICE/YIELD/DURATION…)
//  is intentionally out of scope — documented in BUILD_LOG.
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { scalar, flatten, toNumber } from './values.js';
import { dval } from './builtins_datetime2.js';

const reg = (def) => registry.register(def);
const num = (v) => toNumber(scalar(v));

function numList(arg) {
  const out = [];
  for (const v of flatten(arg)) {
    if (isError(v)) return v;
    if (v == null || v === '') continue;
    if (typeof v === 'number') out.push(v);
  }
  return out;
}

/* =========================================================
   TVM core — Excel sign convention:
   pv·(1+r)^n + pmt·(1+r·type)·((1+r)^n − 1)/r + fv = 0
   ========================================================= */
const fvFactor = (r, n) => Math.pow(1 + r, n);
const annuity = (r, n) => (r === 0 ? n : (Math.pow(1 + r, n) - 1) / r);

function pmtOf(r, n, pv, fv, type) {
  if (n === 0) return NaN;
  if (r === 0) return -(pv + fv) / n;
  return -(pv * fvFactor(r, n) + fv) / ((1 + r * type) * annuity(r, n));
}
function tvmArgs(a, count, defaults) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i < a.length && a[i] != null) { const v = num(a[i]); if (isError(v)) return v; out.push(v); }
    else out.push(defaults[i] ?? 0);
  }
  return out;
}
reg({ name: 'PMT', min: 3, max: 5, fn: (a) => {
  const v = tvmArgs(a, 5, []); if (isError(v)) return v;
  const [r, n, pv, fv, type] = v;
  const p = pmtOf(r, n, pv, fv, type ? 1 : 0);
  return Number.isFinite(p) ? p : err(ERR.NUM);
}, help: { syntax: 'PMT(rate, number_of_periods, present_value, [future_value], [end_or_beginning])' } });
reg({ name: 'FV', min: 3, max: 5, fn: (a) => {
  const v = tvmArgs(a, 5, []); if (isError(v)) return v;
  const [r, n, pmt, pv, type] = v;
  return -(pv * fvFactor(r, n) + pmt * (1 + r * (type ? 1 : 0)) * annuity(r, n));
}, help: { syntax: 'FV(rate, number_of_periods, payment_amount, [present_value], [end_or_beginning])' } });
reg({ name: 'PV', min: 3, max: 5, fn: (a) => {
  const v = tvmArgs(a, 5, []); if (isError(v)) return v;
  const [r, n, pmt, fv, type] = v;
  return -(fv + pmt * (1 + r * (type ? 1 : 0)) * annuity(r, n)) / fvFactor(r, n);
}, help: { syntax: 'PV(rate, number_of_periods, payment_amount, [future_value], [end_or_beginning])' } });
reg({ name: 'NPER', min: 3, max: 5, fn: (a) => {
  const v = tvmArgs(a, 5, []); if (isError(v)) return v;
  const [r, pmt, pv, fv, type0] = v; const type = type0 ? 1 : 0;
  if (r === 0) return pmt === 0 ? err(ERR.NUM) : -(pv + fv) / pmt;
  const adj = pmt * (1 + r * type) / r;
  const top = -fv + adj, bottom = pv + adj;
  if (top / bottom <= 0) return err(ERR.NUM);
  return Math.log(top / bottom) / Math.log(1 + r);
}, help: { syntax: 'NPER(rate, payment_amount, present_value, [future_value], [end_or_beginning])' } });
reg({ name: 'RATE', min: 3, max: 6, fn: (a) => {
  const v = tvmArgs(a, 6, [0, 0, 0, 0, 0, 0.1]); if (isError(v)) return v;
  const [n, pmt, pv, fv, type0, guess] = v; const type = type0 ? 1 : 0;
  const f = (r) => (r === 0
    ? pv + pmt * n + fv
    : pv * fvFactor(r, n) + pmt * (1 + r * type) * annuity(r, n) + fv);
  // Newton with numeric derivative, bisection fallback
  let r = guess || 0.1;
  for (let i = 0; i < 60; i++) {
    const y = f(r), dy = (f(r + 1e-7) - y) / 1e-7;
    if (!Number.isFinite(dy) || dy === 0) break;
    const next = r - y / dy;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }
  let lo = -0.999999, hi = 10;
  if (f(lo) * f(hi) > 0) return err(ERR.NUM, 'RATE did not converge');
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}, help: { syntax: 'RATE(number_of_periods, payment_per_period, present_value, [future_value], [end_or_beginning], [rate_guess])' } });

/** Exact amortization walk shared by IPMT/PPMT/CUMIPMT/CUMPRINC. */
function amortize(r, nper, pv, fv, type) {
  const pmt = pmtOf(r, nper, pv, fv, type);
  if (!Number.isFinite(pmt) || nper > 1e5) return null;
  const ip = [], pp = [];
  let bal = pv;
  for (let i = 1; i <= nper; i++) {
    if (type === 1 && i === 1) { ip.push(0); pp.push(pmt); bal = pv + pmt; continue; }
    const intr = bal * r;
    ip.push(-intr);
    pp.push(pmt + intr);
    bal = bal + intr + pmt;
  }
  return { pmt, ip, pp };
}
reg({ name: 'IPMT', min: 4, max: 6, fn: (a) => {
  const v = tvmArgs(a, 6, []); if (isError(v)) return v;
  const [r, per0, n, pv, fv, type] = v; const per = Math.floor(per0);
  if (per < 1 || per > n) return err(ERR.NUM);
  const am = amortize(r, Math.floor(n), pv, fv, type ? 1 : 0);
  return am ? am.ip[per - 1] : err(ERR.NUM);
}, help: { syntax: 'IPMT(rate, period, number_of_periods, present_value, [future_value], [end_or_beginning])' } });
reg({ name: 'PPMT', min: 4, max: 6, fn: (a) => {
  const v = tvmArgs(a, 6, []); if (isError(v)) return v;
  const [r, per0, n, pv, fv, type] = v; const per = Math.floor(per0);
  if (per < 1 || per > n) return err(ERR.NUM);
  const am = amortize(r, Math.floor(n), pv, fv, type ? 1 : 0);
  return am ? am.pp[per - 1] : err(ERR.NUM);
}, help: { syntax: 'PPMT(rate, period, number_of_periods, present_value, [future_value], [end_or_beginning])' } });
function cum(a, key) {
  const v = tvmArgs(a, 6, []); if (isError(v)) return v;
  const [r, n, pv, s0, e0, type] = v;
  const start = Math.floor(s0), end = Math.floor(e0);
  if (start < 1 || end < start || end > n || r <= 0 || n <= 0 || pv <= 0) return err(ERR.NUM);
  const am = amortize(r, Math.floor(n), pv, 0, type ? 1 : 0);
  if (!am) return err(ERR.NUM);
  let t = 0; for (let i = start; i <= end; i++) t += am[key][i - 1];
  return t;
}
reg({ name: 'CUMIPMT', min: 6, max: 6, fn: (a) => cum(a, 'ip'), help: { syntax: 'CUMIPMT(rate, number_of_periods, present_value, first_period, last_period, end_or_beginning)' } });
reg({ name: 'CUMPRINC', min: 6, max: 6, fn: (a) => cum(a, 'pp'), help: { syntax: 'CUMPRINC(rate, number_of_periods, present_value, first_period, last_period, end_or_beginning)' } });
reg({ name: 'ISPMT', min: 4, max: 4, fn: (a) => {
  const v = tvmArgs(a, 4, []); if (isError(v)) return v;
  const [r, per, n, pv] = v;
  if (n === 0) return err(ERR.DIV0);
  return -pv * r * (1 - per / n);
} });

/* =========================================================
   CASH FLOWS
   ========================================================= */
function npvOf(rate, values) { let t = 0; for (let i = 0; i < values.length; i++) t += values[i] / Math.pow(1 + rate, i + 1); return t; }
reg({ name: 'NPV', min: 2, fn: (a) => {
  const r = num(a[0]); if (isError(r)) return r;
  const vals = [];
  for (const arg of a.slice(1)) { const xs = numList(arg); if (isError(xs)) return xs; vals.push(...xs); }
  if (r <= -1) return err(ERR.NUM);
  return npvOf(r, vals);
}, help: { syntax: 'NPV(discount, cashflow1, [cashflow2, …])' } });
function solveRate(f, guess) {
  let r = guess;
  for (let i = 0; i < 60; i++) {
    const y = f(r), dy = (f(r + 1e-7) - y) / 1e-7;
    if (!Number.isFinite(dy) || dy === 0) break;
    const next = r - y / dy;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }
  // scan for a sign change, then bisect
  let prev = -0.999999, prevY = f(prev);
  for (let x = -0.95; x <= 10.0001; x += 0.05) {
    const y = f(x);
    if (Number.isFinite(prevY) && Number.isFinite(y) && prevY * y <= 0) {
      let lo = prev, hi = x;
      for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
      return (lo + hi) / 2;
    }
    prev = x; prevY = y;
  }
  return null;
}
reg({ name: 'IRR', min: 1, max: 2, fn: (a) => {
  const vals = numList(a[0]); if (isError(vals)) return vals;
  if (!vals.some((v) => v > 0) || !vals.some((v) => v < 0)) return err(ERR.NUM, 'Needs both signs');
  const guess = a.length > 1 ? num(a[1]) : 0.1; if (isError(guess)) return guess;
  // IRR discounts from period 0 (unlike NPV's period 1)
  const f = (r) => { let t = 0; for (let i = 0; i < vals.length; i++) t += vals[i] / Math.pow(1 + r, i); return t; };
  const r = solveRate(f, guess || 0.1);
  return r == null ? err(ERR.NUM, 'IRR did not converge') : r;
}, help: { syntax: 'IRR(cashflow_amounts, [rate_guess])' } });
reg({ name: 'MIRR', min: 3, max: 3, fn: (a) => {
  const vals = numList(a[0]); if (isError(vals)) return vals;
  const fin = num(a[1]), rein = num(a[2]);
  if (isError(fin)) return fin; if (isError(rein)) return rein;
  const n = vals.length;
  let pvNeg = 0, fvPos = 0;
  for (let i = 0; i < n; i++) {
    if (vals[i] < 0) pvNeg += vals[i] / Math.pow(1 + fin, i);
    else fvPos += vals[i] * Math.pow(1 + rein, n - 1 - i);
  }
  if (!pvNeg || !fvPos) return err(ERR.DIV0);
  return Math.pow(-fvPos / pvNeg, 1 / (n - 1)) - 1;
}, help: { syntax: 'MIRR(cashflow_amounts, financing_rate, reinvestment_return_rate)' } });
function xflows(a0, a1) {
  const vals = numList(a0); if (isError(vals)) return vals;
  const dates = [];
  for (const v of flatten(a1)) { if (v == null || v === '') continue; const d = dval(v); if (isError(d)) return d; dates.push(Math.floor(d)); }
  if (vals.length !== dates.length || !vals.length) return err(ERR.NUM);
  return { vals, dates };
}
const xnpvOf = (r, vals, dates) => { const d0 = dates[0]; let t = 0; for (let i = 0; i < vals.length; i++) t += vals[i] / Math.pow(1 + r, (dates[i] - d0) / 365); return t; };
reg({ name: 'XNPV', min: 3, max: 3, fn: (a) => {
  const r = num(a[0]); if (isError(r)) return r;
  const fl = xflows(a[1], a[2]); if (isError(fl)) return fl;
  if (r <= -1) return err(ERR.NUM);
  return xnpvOf(r, fl.vals, fl.dates);
}, help: { syntax: 'XNPV(discount, cashflow_amounts, cashflow_dates)' } });
reg({ name: 'XIRR', min: 2, max: 3, fn: (a) => {
  const fl = xflows(a[0], a[1]); if (isError(fl)) return fl;
  if (!fl.vals.some((v) => v > 0) || !fl.vals.some((v) => v < 0)) return err(ERR.NUM, 'Needs both signs');
  const guess = a.length > 2 ? num(a[2]) : 0.1; if (isError(guess)) return guess;
  const r = solveRate((x) => xnpvOf(x, fl.vals, fl.dates), guess || 0.1);
  return r == null ? err(ERR.NUM, 'XIRR did not converge') : r;
}, help: { syntax: 'XIRR(cashflow_amounts, cashflow_dates, [rate_guess])' } });

/* =========================================================
   DEPRECIATION
   ========================================================= */
reg({ name: 'SLN', min: 3, max: 3, fn: (a) => { const v = tvmArgs(a, 3, []); if (isError(v)) return v; const [c, s, l] = v; return l === 0 ? err(ERR.DIV0) : (c - s) / l; }, help: { syntax: 'SLN(cost, salvage, life)' } });
reg({ name: 'SYD', min: 4, max: 4, fn: (a) => { const v = tvmArgs(a, 4, []); if (isError(v)) return v; const [c, s, l, p] = v; if (p < 1 || p > l || l <= 0) return err(ERR.NUM); return (c - s) * (l - p + 1) * 2 / (l * (l + 1)); }, help: { syntax: 'SYD(cost, salvage, life, period)' } });
reg({ name: 'DDB', min: 4, max: 5, fn: (a) => {
  const v = tvmArgs(a, 5, [0, 0, 0, 0, 2]); if (isError(v)) return v;
  const [c, s, l, p0, factor] = v; const p = Math.floor(p0);
  if (c < 0 || s < 0 || l <= 0 || p < 1 || p > l || factor <= 0) return err(ERR.NUM);
  let book = c, dep = 0;
  for (let i = 1; i <= p; i++) {
    dep = Math.min(book * factor / l, Math.max(0, book - s));
    book -= dep;
  }
  return dep;
}, help: { syntax: 'DDB(cost, salvage, life, period, [factor])' } });
reg({ name: 'DB', min: 4, max: 5, fn: (a) => {
  const v = tvmArgs(a, 5, [0, 0, 0, 0, 12]); if (isError(v)) return v;
  const [c, s, l, p0, month0] = v; const p = Math.floor(p0), month = Math.floor(month0);
  if (c < 0 || s < 0 || l <= 0 || p < 1 || month < 1 || month > 12 || p > l + 1) return err(ERR.NUM);
  const rate = Math.round((1 - Math.pow(s / c, 1 / l)) * 1000) / 1000;
  let dep = c * rate * month / 12, accum = dep;
  if (p === 1) return dep;
  for (let i = 2; i <= p; i++) {
    if (i === l + 1) dep = (c - accum) * rate * (12 - month) / 12; // stub final year
    else dep = (c - accum) * rate;
    accum += dep;
  }
  return dep;
}, help: { syntax: 'DB(cost, salvage, life, period, [month])' } });

/* =========================================================
   RATE CONVERSIONS / DOLLAR FRACTIONS / MISC
   ========================================================= */
reg({ name: 'EFFECT', min: 2, max: 2, fn: (a) => { const r = num(a[0]), n0 = num(a[1]); if (isError(r)) return r; if (isError(n0)) return n0; const n = Math.floor(n0); if (r <= 0 || n < 1) return err(ERR.NUM); return Math.pow(1 + r / n, n) - 1; }, help: { syntax: 'EFFECT(nominal_rate, periods_per_year)' } });
reg({ name: 'NOMINAL', min: 2, max: 2, fn: (a) => { const r = num(a[0]), n0 = num(a[1]); if (isError(r)) return r; if (isError(n0)) return n0; const n = Math.floor(n0); if (r <= 0 || n < 1) return err(ERR.NUM); return n * (Math.pow(1 + r, 1 / n) - 1); }, help: { syntax: 'NOMINAL(effective_rate, periods_per_year)' } });
reg({ name: 'RRI', min: 3, max: 3, fn: (a) => { const v = tvmArgs(a, 3, []); if (isError(v)) return v; const [n, pv, fv] = v; if (n <= 0 || pv === 0 || fv / pv < 0) return err(ERR.NUM); return Math.pow(fv / pv, 1 / n) - 1; } });
reg({ name: 'PDURATION', min: 3, max: 3, fn: (a) => { const v = tvmArgs(a, 3, []); if (isError(v)) return v; const [r, pv, fv] = v; if (r <= 0 || pv <= 0 || fv <= 0) return err(ERR.NUM); return (Math.log(fv) - Math.log(pv)) / Math.log(1 + r); } });
reg({ name: 'DOLLARDE', min: 2, max: 2, fn: (a) => {
  const d = num(a[0]), f0 = num(a[1]); if (isError(d)) return d; if (isError(f0)) return f0;
  const frac = Math.floor(f0); if (frac < 0) return err(ERR.NUM); if (frac === 0) return err(ERR.DIV0);
  const digits = Math.ceil(Math.log10(frac));
  const int = Math.trunc(d);
  return int + (d - int) * Math.pow(10, digits) / frac;
}, help: { syntax: 'DOLLARDE(fractional_price, unit)' } });
reg({ name: 'DOLLARFR', min: 2, max: 2, fn: (a) => {
  const d = num(a[0]), f0 = num(a[1]); if (isError(d)) return d; if (isError(f0)) return f0;
  const frac = Math.floor(f0); if (frac < 0) return err(ERR.NUM); if (frac === 0) return err(ERR.DIV0);
  const digits = Math.ceil(Math.log10(frac));
  const int = Math.trunc(d);
  return int + (d - int) * frac / Math.pow(10, digits);
}, help: { syntax: 'DOLLARFR(decimal_price, unit)' } });
reg({ name: 'FVSCHEDULE', min: 2, max: 2, fn: (a) => {
  let p = num(a[0]); if (isError(p)) return p;
  for (const v of flatten(a[1])) { if (isError(v)) return v; if (v == null || v === '') continue; const r = toNumber(v); if (isError(r)) return r; p *= 1 + r; }
  return p;
}, help: { syntax: 'FVSCHEDULE(principal, rate_schedule)' } });

/* =========================================================
   T-BILLS / DISCOUNT SECURITIES (actual/360 like Sheets)
   ========================================================= */
function settleMaturity(a0, a1) {
  const s = dval(a0); if (isError(s)) return s;
  const m = dval(a1); if (isError(m)) return m;
  const settle = Math.floor(s), mat = Math.floor(m);
  if (mat <= settle) return err(ERR.NUM, 'maturity must follow settlement');
  return { settle, mat, dsm: mat - settle };
}
reg({ name: 'TBILLPRICE', min: 3, max: 3, fn: (a) => {
  const sm = settleMaturity(a[0], a[1]); if (isError(sm)) return sm;
  const disc = num(a[2]); if (isError(disc)) return disc;
  if (disc <= 0 || sm.dsm > 366) return err(ERR.NUM);
  const p = 100 * (1 - disc * sm.dsm / 360);
  return p <= 0 ? err(ERR.NUM) : p;
}, help: { syntax: 'TBILLPRICE(settlement, maturity, discount)' } });
reg({ name: 'TBILLYIELD', min: 3, max: 3, fn: (a) => {
  const sm = settleMaturity(a[0], a[1]); if (isError(sm)) return sm;
  const price = num(a[2]); if (isError(price)) return price;
  if (price <= 0 || sm.dsm > 366) return err(ERR.NUM);
  return (100 - price) / price * 360 / sm.dsm;
}, help: { syntax: 'TBILLYIELD(settlement, maturity, price)' } });
reg({ name: 'TBILLEQ', min: 3, max: 3, fn: (a) => {
  const sm = settleMaturity(a[0], a[1]); if (isError(sm)) return sm;
  const disc = num(a[2]); if (isError(disc)) return disc;
  if (disc <= 0 || sm.dsm > 366) return err(ERR.NUM);
  const denom = 360 - disc * sm.dsm;
  return denom <= 0 ? err(ERR.NUM) : 365 * disc / denom;
} });
reg({ name: 'DISC', min: 4, max: 5, fn: (a) => {
  const sm = settleMaturity(a[0], a[1]); if (isError(sm)) return sm;
  const price = num(a[2]), red = num(a[3]);
  if (isError(price)) return price; if (isError(red)) return red;
  if (price <= 0 || red <= 0) return err(ERR.NUM);
  return (red - price) / red * 360 / sm.dsm; // actual/360 default basis
}, help: { syntax: 'DISC(settlement, maturity, price, redemption, [day_count_convention])' } });
reg({ name: 'INTRATE', min: 4, max: 5, fn: (a) => {
  const sm = settleMaturity(a[0], a[1]); if (isError(sm)) return sm;
  const inv = num(a[2]), red = num(a[3]);
  if (isError(inv)) return inv; if (isError(red)) return red;
  if (inv <= 0 || red <= 0) return err(ERR.NUM);
  return (red - inv) / inv * 360 / sm.dsm;
} });
reg({ name: 'RECEIVED', min: 4, max: 5, fn: (a) => {
  const sm = settleMaturity(a[0], a[1]); if (isError(sm)) return sm;
  const inv = num(a[2]), disc = num(a[3]);
  if (isError(inv)) return inv; if (isError(disc)) return disc;
  const denom = 1 - disc * sm.dsm / 360;
  if (inv <= 0 || denom <= 0) return err(ERR.NUM);
  return inv / denom;
} });
