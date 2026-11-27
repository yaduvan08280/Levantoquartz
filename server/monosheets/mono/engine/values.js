// ============================================================
//  Mono formula engine — value system + coercion (Phase 2)
//  Value = number | string | boolean | MonoError | MonoArray | null(blank)
//  (Consolidates the plan's values.js + coerce.js for now.)
// ============================================================
import { ERR, err, isError } from './errors.js';

/* ---------- arrays (ranges + array literals) ---------- */
export const isArray = (v) => v != null && v.__array === true;
export function makeArray(data) {
  const rows = data.length, cols = rows ? data[0].length : 0;
  return { __array: true, rows, cols, data };
}
/* Flatten an array value to a 1-D row, memoised per value object.
   COUNTIF/SUMIF/COUNTIFS and friends called `.data.flat()` on every
   invocation — and COUNTIFS/SUMIFS/AVERAGEIFS did it INSIDE their row loop,
   so a criteria range was rebuilt once per row. Under vectorize() a
   duplicate check like COUNTIF($C$2:$C$3124, C2:C3124) runs the base once
   per probe, which meant 3,123 flattens of a 3,123-element array: 9.7M
   allocations, 6.9 s.

   A WeakMap, not a property on the value: an added field would show up in
   JSON.stringify and deepEqual, which tests and the undo journal compare.

   The cached row is shared, so callers must treat it as read-only — every
   current caller only indexes and iterates it. */
const FLAT = new WeakMap();
export function flatOf(arr) {
  let f = FLAT.get(arr);
  if (f === undefined) { f = arr.data.flat(); FLAT.set(arr, f); }
  return f;
}

// Reduce a value to a single scalar (implicit-intersection-ish for Phase 2):
// a 1x1 array -> its cell; a larger array in scalar context -> #VALUE!.
export function scalar(v) {
  if (isArray(v)) { if (v.rows === 1 && v.cols === 1) return v.data[0][0]; return err(ERR.VALUE); }
  return v;
}
// Flatten an array/scalar into a list of scalar values (for SUM, COUNT, ...).
export function flatten(v, out = []) {
  if (isArray(v)) { for (const row of v.data) for (const x of row) out.push(x); }
  else out.push(v);
  return out;
}

/* ---------- type predicates ---------- */
export const isNum = (v) => typeof v === 'number';
export const isStr = (v) => typeof v === 'string';
export const isBool = (v) => typeof v === 'boolean';
export const isBlank = (v) => v == null;

/* ---------- coercion ---------- */
export function toNumber(v) {
  if (isError(v)) return v;
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    let s = v.trim();
    if (s === '') return 0;
    let mult = 1;
    if (/%$/.test(s)) { mult = 0.01; s = s.slice(0, -1); }
    s = s.replace(/[,₹$€£\s]/g, '');
    if (s === '' || s === '-' || s === '.') return err(ERR.VALUE);
    const n = Number(s);
    return Number.isFinite(n) ? n * mult : err(ERR.VALUE);
  }
  return err(ERR.VALUE);
}
export function toText(v) {
  if (isError(v)) return v;
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numToStr(v);
  return String(v);
}
export function toBool(v) {
  if (isError(v)) return v;
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false' || s === '') return false;
    const n = Number(s);
    if (!Number.isNaN(n)) return n !== 0;
    return err(ERR.VALUE);
  }
  return err(ERR.VALUE);
}

export function numToStr(n) {
  if (!Number.isFinite(n)) return ERR.NUM;
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-9 && n !== 0)) return String(n);
  return String(parseFloat(n.toPrecision(12)));
}

/* ---------- comparison (Sheets ordering) ---------- */
function rank(v) { if (typeof v === 'number') return 1; if (typeof v === 'string') return 2; if (typeof v === 'boolean') return 3; return 1; }
export function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) a = typeof b === 'number' ? 0 : typeof b === 'boolean' ? false : '';
  if (b == null) b = typeof a === 'number' ? 0 : typeof a === 'boolean' ? false : '';
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 1) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 3) return a === b ? 0 : (a ? 1 : -1);
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/* ---------- date serials (epoch 1899-12-30; day 1 = 1900-01-01) ---------- */
const EPOCH = Date.UTC(1899, 11, 30);
export function dateToSerial(y, m, d) { return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000); }
export function todaySerial() { const n = new Date(); return Math.round((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - EPOCH) / 86400000); }
export function nowSerial() {
  const n = new Date();
  const days = (Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - EPOCH) / 86400000;
  return days + (n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) / 86400;
}
export function serialToParts(s) {
  const d = new Date(EPOCH + Math.floor(s) * 86400000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
}
