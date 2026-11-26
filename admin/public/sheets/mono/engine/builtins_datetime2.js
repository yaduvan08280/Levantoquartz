// ============================================================
//  Mono formula engine — date/time catalog (GS parity pass)
//  DATEDIF, DATEVALUE/TIMEVALUE/TIME, DAYS360, NETWORKDAYS(.INTL),
//  WORKDAY(.INTL), WEEKNUM/ISOWEEKNUM, YEARFRAC, EPOCHTODATE.
//  All built on the engine's serial-date system (epoch 1899-12-30).
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { scalar, flatten, toNumber, toText, dateToSerial, serialToParts } from './values.js';

const reg = (def) => registry.register(def);
const num = (v) => toNumber(scalar(v));
const str = (v) => toText(scalar(v));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
/* 1-12, or 0 for anything that is not a month. Matching on the first three
   letters alone accepted any word that merely STARTED with a month, so
   "Septemberish 1" parsed happily as September - the word has to be a real
   prefix of the month name. "Sep", "Sept" and "September" all still work. */
const monthFromName = (w) => {
  const s = String(w).toLowerCase();
  const i = MONTHS.indexOf(s.slice(0, 3));
  return (i >= 0 && MONTH_NAMES[i].startsWith(s)) ? i + 1 : 0;
};
/* A date written without a year means the CURRENT year, in both Excel and
   Sheets: DATEVALUE("September 1"), DATEVALUE("1-Sep"), DATEVALUE("9/1").
   Every pattern below used to demand a 4-digit year, so all three spellings
   returned #VALUE!. Wrapped in IFERROR - which is how they are nearly always
   written - that surfaced as an empty cell rather than an error:
     =IFERROR(CHAR(64+MONTH(DATEVALUE(B1&" 1"))),"")   with B1 = "September"
   just went blank. */
const currentYear = () => new Date().getFullYear();
function parseDateText(t) {
  const s = String(t).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);            // ISO
  if (m) return dateToSerial(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);               // m/d/y, m/d
  if (m) { const y = m[3] == null ? currentYear() : (+m[3] < 100 ? 2000 + +m[3] : +m[3]); return dateToSerial(y, +m[1], +m[2]); }
  m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,})(?:[-, ]+(\d{4}))?$/);          // 3-Jul-2026, 3-Jul
  if (m) { const mo = monthFromName(m[2]); if (mo) return dateToSerial(m[3] == null ? currentYear() : +m[3], mo, +m[1]); }
  m = s.match(/^([A-Za-z]{3,})[ ]+(\d{1,2})(?:,?[ ]+(\d{4}))?$/);          // July 3, 2026 / July 3
  if (m) { const mo = monthFromName(m[1]); if (mo) return dateToSerial(m[3] == null ? currentYear() : +m[3], mo, +m[2]); }
  return null;
}
/** Date-value coercion: serial numbers pass through, date text is parsed. */
function dval(v) {
  const s = scalar(v);
  if (isError(s)) return s;
  if (typeof s === 'number') return s;
  if (typeof s === 'string') { const d = parseDateText(s); if (d != null) return d; }
  const n = toNumber(s);
  return isError(n) ? err(ERR.VALUE, 'Not a date') : n;
}
function parseTimeText(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2], se = m[3] ? +m[3] : 0;
  const ap = m[4] ? m[4].toLowerCase() : '';
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (mi > 59 || se >= 60) return null;
  return ((h * 3600 + mi * 60 + se) / 86400) % 1;
}

/* ---------- TIME ---------- */
reg({ name: 'TIME', min: 3, max: 3, fn: (a) => {
  const h = num(a[0]), mi = num(a[1]), s = num(a[2]);
  if (isError(h)) return h; if (isError(mi)) return mi; if (isError(s)) return s;
  const total = Math.floor(h) * 3600 + Math.floor(mi) * 60 + Math.floor(s);
  if (total < 0) return err(ERR.NUM);
  return (total % 86400) / 86400;
}, help: { syntax: 'TIME(hour, minute, second)' } });
reg({ name: 'DATEVALUE', min: 1, max: 1, fn: (a) => {
  const t = str(a[0]); if (isError(t)) return t;
  const d = parseDateText(t);
  return d == null ? err(ERR.VALUE, 'Cannot parse date') : d;
}, help: { syntax: 'DATEVALUE(date_string)' } });
reg({ name: 'TIMEVALUE', min: 1, max: 1, fn: (a) => {
  const t = str(a[0]); if (isError(t)) return t;
  const f = parseTimeText(t);
  return f == null ? err(ERR.VALUE, 'Cannot parse time') : f;
}, help: { syntax: 'TIMEVALUE(time_string)' } });

/* ---------- DATEDIF ---------- */
reg({ name: 'DATEDIF', min: 3, max: 3, fn: (a) => {
  const s0 = dval(a[0]); if (isError(s0)) return s0;
  const e0 = dval(a[1]); if (isError(e0)) return e0;
  const unit = str(a[2]); if (isError(unit)) return unit;
  const start = Math.floor(s0), end = Math.floor(e0);
  if (end < start) return err(ERR.NUM, 'Start date after end date');
  const sp = serialToParts(start), ep = serialToParts(end);
  const fullMonths = () => {
    let m = (ep.y - sp.y) * 12 + (ep.m - sp.m);
    if (ep.d < sp.d) m -= 1;
    return m;
  };
  switch (String(unit).toUpperCase()) {
    case 'D': return end - start;
    case 'M': return fullMonths();
    case 'Y': return Math.floor(fullMonths() / 12);
    case 'YM': return fullMonths() % 12;
    case 'MD': {
      // days ignoring months and years: borrow from the month before end
      if (ep.d >= sp.d) return ep.d - sp.d;
      const prevMonthDays = ep.m === 1 ? 31 : (dateToSerial(ep.y, ep.m, 1) - dateToSerial(ep.y, ep.m - 1, 1));
      return prevMonthDays - sp.d + ep.d;
    }
    case 'YD': {
      // days ignoring years: from the last anniversary of start before end
      let anniv = dateToSerial(ep.y, sp.m, sp.d);
      if (anniv > end) anniv = dateToSerial(ep.y - 1, sp.m, sp.d);
      return end - anniv;
    }
    default: return err(ERR.NUM, 'Unknown unit');
  }
}, help: { syntax: 'DATEDIF(start_date, end_date, unit)', desc: 'Days/months/years between two dates. Units: Y, M, D, MD, YM, YD.' } });

/* ---------- DAYS360 / YEARFRAC ---------- */
function days360(start, end, european) {
  const s = serialToParts(start), e = serialToParts(end);
  let d1 = s.d, d2 = e.d;
  if (european) { if (d1 === 31) d1 = 30; if (d2 === 31) d2 = 30; }
  else {
    const sEnd = serialToParts(dateToSerial(s.y, s.m + 1, 1) - 1); // last day of start month
    if (d1 === sEnd.d) d1 = 30; // US: end-of-month start counts as 30 (covers Feb too)
    if (d2 === 31 && d1 === 30) d2 = 30;
  }
  return (e.y - s.y) * 360 + (e.m - s.m) * 30 + (d2 - d1);
}
reg({ name: 'DAYS360', min: 2, max: 3, fn: (a) => {
  const s = dval(a[0]); if (isError(s)) return s;
  const e = dval(a[1]); if (isError(e)) return e;
  const eur = a.length > 2 ? !!scalar(a[2]) : false;
  return days360(Math.floor(s), Math.floor(e), eur);
}, help: { syntax: 'DAYS360(start_date, end_date, [method])' } });
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** Year fraction between two serials for day-count basis 0–4 (exported: builtins_financial.js). */
export function yearFracSerial(s, e, basis) {
  if (s > e) [s, e] = [e, s];
  switch (basis) {
    case 0: return days360(s, e, false) / 360;
    case 4: return days360(s, e, true) / 360;
    case 2: return (e - s) / 360;
    case 3: return (e - s) / 365;
    case 1: {
      // actual/actual: denominator = average year length across the span
      const sp = serialToParts(s), ep = serialToParts(e);
      if (sp.y === ep.y) return (e - s) / (isLeap(sp.y) ? 366 : 365);
      let days = 0, years = 0;
      for (let y = sp.y; y <= ep.y; y++) { days += isLeap(y) ? 366 : 365; years++; }
      return (e - s) / (days / years);
    }
    default: return null;
  }
}
/** Exported for builtins_financial.js — serial-or-date-text coercion. */
export { dval };
reg({ name: 'YEARFRAC', min: 2, max: 3, fn: (a) => {
  const s = dval(a[0]); if (isError(s)) return s;
  const e = dval(a[1]); if (isError(e)) return e;
  const basis = a.length > 2 ? Math.floor(num(a[2])) : 0;
  if (isError(basis)) return basis;
  const yf = yearFracSerial(Math.floor(s), Math.floor(e), basis);
  return yf == null ? err(ERR.NUM, 'basis 0-4') : yf;
}, help: { syntax: 'YEARFRAC(start_date, end_date, [day_count_convention])' } });

/* ---------- weekend helpers (NETWORKDAYS.INTL / WORKDAY.INTL) ---------- */
function weekendSet(spec) {
  // returns Set of JS weekdays (0=Sun..6=Sat) or null if invalid
  if (spec == null) return new Set([0, 6]);
  if (typeof spec === 'string') {
    if (!/^[01]{7}$/.test(spec)) return null;
    const set = new Set(); // string is Mon..Sun
    for (let i = 0; i < 7; i++) if (spec[i] === '1') set.add((i + 1) % 7);
    return set;
  }
  const n = Math.floor(spec);
  if (n >= 1 && n <= 7) { const sat = [6, 0, 1, 2, 3, 4, 5][n - 1]; return new Set([sat, (sat + 1) % 7]); }
  if (n >= 11 && n <= 17) return new Set([(n - 10) % 7]);
  return null;
}
function holidaySet(arg) {
  const set = new Set();
  if (arg == null) return set;
  for (const v of flatten(arg)) {
    if (v == null || v === '') continue;
    const d = dval(v);
    if (isError(d)) return d;
    set.add(Math.floor(d));
  }
  return set;
}
function networkdays(start, end, weekend, holidays) {
  let sign = 1;
  if (start > end) { [start, end] = [end, start]; sign = -1; }
  let count = 0;
  for (let d = start; d <= end; d++) {
    const wd = serialToParts(d).wd;
    if (!weekend.has(wd) && !holidays.has(d)) count++;
  }
  return sign * count;
}
function workday(start, days, weekend, holidays) {
  if (weekend.size >= 7) return err(ERR.VALUE, 'All days are weekend');
  const step = days >= 0 ? 1 : -1;
  let d = start, left = Math.abs(days);
  while (left > 0) {
    d += step;
    const wd = serialToParts(d).wd;
    if (!weekend.has(wd) && !holidays.has(d)) left--;
  }
  return d;
}
reg({ name: 'NETWORKDAYS', min: 2, max: 3, fn: (a) => {
  const s = dval(a[0]); if (isError(s)) return s;
  const e = dval(a[1]); if (isError(e)) return e;
  const hol = holidaySet(a.length > 2 ? a[2] : null); if (isError(hol)) return hol;
  return networkdays(Math.floor(s), Math.floor(e), new Set([0, 6]), hol);
}, help: { syntax: 'NETWORKDAYS(start_date, end_date, [holidays])' } });
reg({ name: 'NETWORKDAYS.INTL', min: 2, max: 4, fn: (a) => {
  const s = dval(a[0]); if (isError(s)) return s;
  const e = dval(a[1]); if (isError(e)) return e;
  const w = weekendSet(a.length > 2 ? scalar(a[2]) : null); if (!w) return err(ERR.NUM, 'Bad weekend spec');
  const hol = holidaySet(a.length > 3 ? a[3] : null); if (isError(hol)) return hol;
  return networkdays(Math.floor(s), Math.floor(e), w, hol);
} });
reg({ name: 'WORKDAY', min: 2, max: 3, fn: (a) => {
  const s = dval(a[0]); if (isError(s)) return s;
  const d = num(a[1]); if (isError(d)) return d;
  const hol = holidaySet(a.length > 2 ? a[2] : null); if (isError(hol)) return hol;
  return workday(Math.floor(s), Math.trunc(d), new Set([0, 6]), hol);
}, help: { syntax: 'WORKDAY(start_date, num_days, [holidays])' } });
reg({ name: 'WORKDAY.INTL', min: 2, max: 4, fn: (a) => {
  const s = dval(a[0]); if (isError(s)) return s;
  const d = num(a[1]); if (isError(d)) return d;
  const w = weekendSet(a.length > 2 ? scalar(a[2]) : null); if (!w) return err(ERR.NUM, 'Bad weekend spec');
  const hol = holidaySet(a.length > 3 ? a[3] : null); if (isError(hol)) return hol;
  return workday(Math.floor(s), Math.trunc(d), w, hol);
} });

/* ---------- week numbers ---------- */
function isoWeek(serial) {
  const p = serialToParts(serial);
  // ISO: week containing the year's first Thursday is week 1
  const wd = (p.wd + 6) % 7; // 0=Mon..6=Sun
  const thursday = serial - wd + 3;
  const tp = serialToParts(thursday);
  const jan1 = dateToSerial(tp.y, 1, 1);
  return Math.floor((thursday - jan1) / 7) + 1;
}
reg({ name: 'WEEKNUM', min: 1, max: 2, fn: (a) => {
  const s0 = dval(a[0]); if (isError(s0)) return s0;
  const s = Math.floor(s0);
  const type = a.length > 1 ? Math.floor(num(a[1])) : 1;
  if (isError(type)) return type;
  if (type === 21) return isoWeek(s);
  // type → week start weekday (JS 0=Sun..6=Sat)
  const startMap = { 1: 0, 2: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 0 };
  if (!(type in startMap)) return err(ERR.NUM);
  const startWd = startMap[type];
  const p = serialToParts(s);
  const jan1 = dateToSerial(p.y, 1, 1);
  const jan1Wd = serialToParts(jan1).wd;
  const offset = (jan1Wd - startWd + 7) % 7;
  return Math.floor((s - jan1 + offset) / 7) + 1;
}, help: { syntax: 'WEEKNUM(date, [type])' } });
reg({ name: 'ISOWEEKNUM', min: 1, max: 1, fn: (a) => { const s = dval(a[0]); if (isError(s)) return s; return isoWeek(Math.floor(s)); }, help: { syntax: 'ISOWEEKNUM(date)' } });

/* ---------- EPOCHTODATE ---------- */
const UNIX_EPOCH_SERIAL = 25569; // DATE(1970,1,1)
reg({ name: 'EPOCHTODATE', min: 1, max: 2, fn: (a) => {
  const t = num(a[0]); if (isError(t)) return t;
  const unit = a.length > 1 ? Math.floor(num(a[1])) : 1;
  if (isError(unit)) return unit;
  const div = unit === 1 ? 86400 : unit === 2 ? 86400000 : unit === 3 ? 86400000000 : null;
  if (!div) return err(ERR.NUM, 'unit 1 (s), 2 (ms) or 3 (µs)');
  return UNIX_EPOCH_SERIAL + t / div;
}, help: { syntax: 'EPOCHTODATE(timestamp, [unit])', desc: 'Converts a Unix epoch timestamp to a date serial.' } });
