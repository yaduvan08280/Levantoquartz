// ============================================================
//  Mono formula engine — engineering catalog (GS parity pass)
//  Number-base conversions with Excel's two's-complement widths
//  (BIN 10 bits, OCT 30 bits, HEX 40 bits), bitwise ops (48-bit),
//  DELTA/GESTEP, error functions, and complex-number arithmetic
//  on "a+bi" strings.
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { scalar, toNumber, toText, numToStr } from './values.js';
import { erf as erfFn } from './builtins_stats.js';

const reg = (def) => registry.register(def);
const num = (v) => toNumber(scalar(v));
const str = (v) => toText(scalar(v));

/* =========================================================
   BASE CONVERSIONS (two's complement, Excel widths)
   ========================================================= */
const BASES = { BIN: { radix: 2, digits: 10, bits: 10 }, OCT: { radix: 8, digits: 10, bits: 30 }, HEX: { radix: 16, digits: 10, bits: 40 } };
function fromBase(s, kind) {
  const { radix, digits, bits } = BASES[kind];
  const t = String(s).trim().toUpperCase();
  if (t === '') return 0;
  if (t.length > digits) return err(ERR.NUM);
  const valid = { 2: /^[01]+$/, 8: /^[0-7]+$/, 16: /^[0-9A-F]+$/ }[radix];
  if (!valid.test(t)) return err(ERR.NUM);
  let n = parseInt(t, radix);
  if (t.length === digits && n >= 2 ** (bits - 1)) n -= 2 ** bits;
  return n;
}
function toBase(n, kind, places) {
  const { radix, digits, bits } = BASES[kind];
  const k = Math.trunc(n);
  if (k < -(2 ** (bits - 1)) || k > 2 ** (bits - 1) - 1) return err(ERR.NUM);
  if (k < 0) return (k + 2 ** bits).toString(radix).toUpperCase(); // full width, no padding
  let s = k.toString(radix).toUpperCase();
  if (places != null) {
    const p = Math.trunc(places);
    if (p < s.length || p > digits) return err(ERR.NUM);
    while (s.length < p) s = '0' + s;
  }
  return s;
}
function convPair(from, to) {
  reg({ name: `${from}2${to}`, min: 1, max: from === 'DEC' ? 2 : 2, fn: (a) => {
    let n;
    if (from === 'DEC') { n = num(a[0]); if (isError(n)) return n; }
    else { const s = str(a[0]); if (isError(s)) return s; n = fromBase(s, from); if (isError(n)) return n; }
    if (to === 'DEC') return n;
    const places = a.length > 1 && a[1] != null ? num(a[1]) : null;
    if (isError(places)) return places;
    return toBase(n, to, places);
  }, help: { syntax: `${from}2${to}(value${to === 'DEC' ? '' : ', [places]'})` } });
}
for (const from of ['BIN', 'OCT', 'HEX', 'DEC']) for (const to of ['BIN', 'OCT', 'HEX', 'DEC']) if (from !== to) convPair(from, to);

/* =========================================================
   BITWISE (Excel: operands 0 … 2^48-1)
   ========================================================= */
const BIT_MAX = 2 ** 48 - 1;
function bit2(name, f) {
  reg({ name, min: 2, max: 2, fn: (a) => {
    const x = num(a[0]), y = num(a[1]);
    if (isError(x)) return x; if (isError(y)) return y;
    if (x < 0 || y < 0 || x > BIT_MAX || y > BIT_MAX || !Number.isInteger(x) || !Number.isInteger(y)) return err(ERR.NUM);
    return f(BigInt(x), BigInt(y));
  }, help: { syntax: `${name}(value1, value2)` } });
}
bit2('BITAND', (x, y) => Number(x & y));
bit2('BITOR', (x, y) => Number(x | y));
bit2('BITXOR', (x, y) => Number(x ^ y));
function shift(name, dir) {
  reg({ name, min: 2, max: 2, fn: (a) => {
    const x = num(a[0]), s0 = num(a[1]);
    if (isError(x)) return x; if (isError(s0)) return s0;
    const s = Math.trunc(s0) * dir;
    if (x < 0 || x > BIT_MAX || !Number.isInteger(x) || Math.abs(s) > 53) return err(ERR.NUM);
    const r = s >= 0 ? Number(BigInt(x) << BigInt(s)) : Number(BigInt(x) >> BigInt(-s));
    return r > BIT_MAX ? err(ERR.NUM) : r;
  } });
}
shift('BITLSHIFT', 1); shift('BITRSHIFT', -1);

/* =========================================================
   DELTA / GESTEP / ERROR FUNCTIONS
   ========================================================= */
reg({ name: 'DELTA', min: 1, max: 2, fn: (a) => { const x = num(a[0]); if (isError(x)) return x; const y = a.length > 1 ? num(a[1]) : 0; if (isError(y)) return y; return x === y ? 1 : 0; } });
reg({ name: 'GESTEP', min: 1, max: 2, fn: (a) => { const x = num(a[0]); if (isError(x)) return x; const y = a.length > 1 ? num(a[1]) : 0; if (isError(y)) return y; return x >= y ? 1 : 0; } });
reg({ name: 'ERF', aliases: ['ERF.PRECISE'], min: 1, max: 2, fn: (a) => {
  const lo = num(a[0]); if (isError(lo)) return lo;
  if (a.length > 1) { const hi = num(a[1]); if (isError(hi)) return hi; return erfFn(hi) - erfFn(lo); }
  return erfFn(lo);
}, help: { syntax: 'ERF(lower_bound, [upper_bound])' } });
reg({ name: 'ERFC', aliases: ['ERFC.PRECISE'], min: 1, max: 1, fn: (a) => { const x = num(a[0]); if (isError(x)) return x; return 1 - erfFn(x); } });

/* =========================================================
   COMPLEX NUMBERS ("a+bi" strings, i or j suffix)
   ========================================================= */
function parseComplex(v) {
  const s0 = scalar(v);
  if (isError(s0)) return s0;
  if (typeof s0 === 'number') return { re: s0, im: 0, sfx: 'i' };
  if (s0 == null || s0 === '') return { re: 0, im: 0, sfx: 'i' };
  let t = String(s0).trim().replace(/\s+/g, '');
  const last = t[t.length - 1];
  if (last === 'i' || last === 'j') {
    let body = t.slice(0, -1);
    if (body === '' || body === '+') body = '+1';
    if (body === '-') body = '-1';
    // normalize "3+i" / "3-i" → coefficient 1
    if (/[+-]$/.test(body)) body += '1';
    const m = body.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)?([+-](?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)?$/);
    if (!m || (m[1] == null && m[2] == null)) return err(ERR.NUM, 'Bad complex number');
    if (m[2] != null) return { re: Number(m[1] ?? 0), im: Number(m[2]), sfx: last };
    return { re: 0, im: Number(m[1]), sfx: last };
  }
  const n = Number(t);
  return Number.isFinite(n) ? { re: n, im: 0, sfx: 'i' } : err(ERR.NUM, 'Bad complex number');
}
function fmtComplex(re, im, sfx = 'i') {
  if (!Number.isFinite(re) || !Number.isFinite(im)) return err(ERR.NUM);
  const r = Math.abs(re) < 1e-13 ? 0 : re;
  const i = Math.abs(im) < 1e-13 ? 0 : im;
  if (i === 0) return numToStr(r);
  const imMag = Math.abs(i) === 1 ? '' : numToStr(Math.abs(i));
  const imPart = (i < 0 ? '-' : r === 0 ? '' : '+') + imMag + sfx;
  return (r === 0 ? '' : numToStr(r)) + imPart;
}
reg({ name: 'COMPLEX', min: 2, max: 3, fn: (a) => {
  const re = num(a[0]), im = num(a[1]);
  if (isError(re)) return re; if (isError(im)) return im;
  const sfx = a.length > 2 ? str(a[2]) : 'i';
  if (isError(sfx)) return sfx;
  if (sfx !== 'i' && sfx !== 'j') return err(ERR.VALUE);
  return fmtComplex(re, im, sfx);
}, help: { syntax: 'COMPLEX(real_part, imaginary_part, [suffix])' } });
const im1 = (name, f) => reg({ name, min: 1, max: 1, fn: (a) => { const z = parseComplex(a[0]); if (isError(z)) return z; return f(z); } });
im1('IMREAL', (z) => z.re);
im1('IMAGINARY', (z) => z.im);
im1('IMABS', (z) => Math.hypot(z.re, z.im));
im1('IMARGUMENT', (z) => (z.re === 0 && z.im === 0 ? err(ERR.DIV0) : Math.atan2(z.im, z.re)));
im1('IMCONJUGATE', (z) => fmtComplex(z.re, -z.im, z.sfx));
const cMul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cExp = (z) => ({ re: Math.exp(z.re) * Math.cos(z.im), im: Math.exp(z.re) * Math.sin(z.im) });
const cLn = (z) => (z.re === 0 && z.im === 0 ? null : { re: Math.log(Math.hypot(z.re, z.im)), im: Math.atan2(z.im, z.re) });
reg({ name: 'IMSUM', min: 1, fn: (a) => {
  let re = 0, im = 0, sfx = 'i';
  for (const arg of a) { const z = parseComplex(arg); if (isError(z)) return z; re += z.re; im += z.im; if (z.sfx === 'j') sfx = 'j'; }
  return fmtComplex(re, im, sfx);
}, help: { syntax: 'IMSUM(value1, [value2, …])' } });
reg({ name: 'IMSUB', min: 2, max: 2, fn: (a) => {
  const x = parseComplex(a[0]); if (isError(x)) return x;
  const y = parseComplex(a[1]); if (isError(y)) return y;
  return fmtComplex(x.re - y.re, x.im - y.im, x.sfx);
} });
reg({ name: 'IMPRODUCT', min: 1, fn: (a) => {
  let acc = { re: 1, im: 0 }; let sfx = 'i';
  for (const arg of a) { const z = parseComplex(arg); if (isError(z)) return z; acc = cMul(acc, z); if (z.sfx === 'j') sfx = 'j'; }
  return fmtComplex(acc.re, acc.im, sfx);
} });
reg({ name: 'IMDIV', min: 2, max: 2, fn: (a) => {
  const x = parseComplex(a[0]); if (isError(x)) return x;
  const y = parseComplex(a[1]); if (isError(y)) return y;
  const d = y.re * y.re + y.im * y.im;
  if (d === 0) return err(ERR.DIV0);
  return fmtComplex((x.re * y.re + x.im * y.im) / d, (x.im * y.re - x.re * y.im) / d, x.sfx);
} });
reg({ name: 'IMPOWER', min: 2, max: 2, fn: (a) => {
  const z = parseComplex(a[0]); if (isError(z)) return z;
  const p = num(a[1]); if (isError(p)) return p;
  const r = Math.hypot(z.re, z.im), th = Math.atan2(z.im, z.re);
  if (r === 0 && p <= 0) return err(ERR.NUM);
  const rp = Math.pow(r, p);
  return fmtComplex(rp * Math.cos(p * th), rp * Math.sin(p * th), z.sfx);
} });
im1('IMSQRT', (z) => { const r = Math.sqrt(Math.hypot(z.re, z.im)), th = Math.atan2(z.im, z.re) / 2; return fmtComplex(r * Math.cos(th), r * Math.sin(th), z.sfx); });
im1('IMEXP', (z) => { const e = cExp(z); return fmtComplex(e.re, e.im, z.sfx); });
im1('IMLN', (z) => { const l = cLn(z); return l ? fmtComplex(l.re, l.im, z.sfx) : err(ERR.NUM); });
im1('IMLOG10', (z) => { const l = cLn(z); return l ? fmtComplex(l.re / Math.LN10, l.im / Math.LN10, z.sfx) : err(ERR.NUM); });
im1('IMLOG2', (z) => { const l = cLn(z); return l ? fmtComplex(l.re / Math.LN2, l.im / Math.LN2, z.sfx) : err(ERR.NUM); });
im1('IMSIN', (z) => fmtComplex(Math.sin(z.re) * Math.cosh(z.im), Math.cos(z.re) * Math.sinh(z.im), z.sfx));
im1('IMCOS', (z) => fmtComplex(Math.cos(z.re) * Math.cosh(z.im), -Math.sin(z.re) * Math.sinh(z.im), z.sfx));
im1('IMTAN', (z) => {
  const d = Math.cos(2 * z.re) + Math.cosh(2 * z.im);
  if (d === 0) return err(ERR.NUM);
  return fmtComplex(Math.sin(2 * z.re) / d, Math.sinh(2 * z.im) / d, z.sfx);
});
im1('IMSINH', (z) => fmtComplex(Math.sinh(z.re) * Math.cos(z.im), Math.cosh(z.re) * Math.sin(z.im), z.sfx));
im1('IMCOSH', (z) => fmtComplex(Math.cosh(z.re) * Math.cos(z.im), Math.sinh(z.re) * Math.sin(z.im), z.sfx));
