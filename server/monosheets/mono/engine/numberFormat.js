// ============================================================
//  Mono Sheets — number format engine (Phase 3)
//  formatValue(number, spec) -> display string.
//  spec is a preset key ('number','percent','currency','date',…)
//  or a pattern string ('#,##0.00', '0.00%', '₹#,##0', date tokens).
// ============================================================
import { numToStr, serialToParts } from './values.js';

const PRESET = {
  auto: null, plain: 'plain', text: 'plain',
  number: '#,##0.00', number0: '#,##0', integer: '#,##0',
  percent: '0.00%', percent0: '0%',
  currency: '₹#,##0.00', currencyUsd: '$#,##0.00', currencyEur: '€#,##0.00',
  scientific: 'sci', date: 'date', time: 'time', datetime: 'datetime',
};
export function resolveSpec(spec) { if (spec == null) return null; return PRESET[spec] !== undefined ? PRESET[spec] : spec; }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n, w = 2) => String(n).padStart(w, '0');
function timeParts(serial) { let f = serial - Math.floor(serial); if (f < 0) f += 1; const tot = Math.round(f * 86400); return { h: Math.floor(tot / 3600) % 24, mi: Math.floor(tot / 60) % 60, s: tot % 60 }; }
function fmtDate(serial, kind) {
  const d = serialToParts(serial), t = timeParts(serial);
  if (kind === 'time') return `${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`;
  if (kind === 'datetime') return `${pad(d.d)}/${pad(d.m)}/${d.y} ${pad(t.h)}:${pad(t.mi)}`;
  return `${pad(d.d)}/${pad(d.m)}/${d.y}`;
}
/* Excel's date tokens, walked left to right instead of run through a chain of
   .replace() calls. The chain could not be made correct:
     * it rewrote every "mm" to the MONTH before anything looked for minutes,
       so "hh:mm" on a 13:45 timestamp rendered "13:09" - the 09 was September;
     * it matched "mm" case-sensitively while Excel writes "dd/MM/yyyy", so
       that format came out literally as "01/MM/2026";
     * it had no "mmmm", so a full month name became "Sep9";
     * "dddd" produced the day of the month twice instead of a weekday.

   Excel's rule for the ambiguous "m": it means MINUTES when the nearest
   date/time token before it is an hour or the nearest one after it is
   seconds, and the MONTH everywhere else. Text in double quotes, and any
   character after a backslash, is literal. */
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
const BACKSLASH = String.fromCharCode(92);   // marks the next character literal
const weekdayOf = (serial) => new Date(SERIAL_EPOCH + Math.floor(serial) * 86400000).getUTCDay();

/** Split a pattern into literals and runs of y/m/d/h/s, plus AM/PM. */
function dateTokens(pat) {
  const toks = [];
  for (let i = 0; i < pat.length;) {
    const ch = pat[i];
    if (ch === '"') { const e = pat.indexOf('"', i + 1); toks.push({ lit: pat.slice(i + 1, e < 0 ? pat.length : e) }); i = e < 0 ? pat.length : e + 1; continue; }
    if (ch === BACKSLASH) { toks.push({ lit: pat[i + 1] ?? '' }); i += 2; continue; }
    const rest = pat.slice(i).toLowerCase();
    if (rest.startsWith('am/pm')) { toks.push({ k: 'ap', long: true }); i += 5; continue; }
    if (rest.startsWith('a/p')) { toks.push({ k: 'ap', long: false }); i += 3; continue; }
    const c = ch.toLowerCase();
    if (c === 'y' || c === 'm' || c === 'd' || c === 'h' || c === 's') {
      let n = 0; while (i + n < pat.length && pat[i + n].toLowerCase() === c) n++;
      toks.push({ k: c, n }); i += n; continue;
    }
    toks.push({ lit: ch }); i++;
  }
  return toks;
}
/* A pattern is a date/time pattern when it uses date letters and carries no
   numeric placeholders - "mmmm", "hh:mm", even a bare "m". Patterns that DO
   use placeholders are numeric, unless they also name a year, day or hour
   (a format like "yyyy#" is not real, but the older test stays honoured). */
export function isDatePattern(pat) {
  if (/[ymdhs]/i.test(pat) && !/[#0]/.test(pat)) return true;
  return /[yd]/i.test(pat) || /h{1,2}/i.test(pat) || /h:?mm/i.test(pat);
}
function fmtDatePattern(serial, pat) {
  const d = serialToParts(serial), t = timeParts(serial), wd = weekdayOf(serial);
  const toks = dateTokens(pat);
  const twelve = toks.some((x) => x.k === 'ap');
  const neighbour = (from, step) => {
    for (let j = from + step; j >= 0 && j < toks.length; j += step) {
      if (toks[j].k && toks[j].k !== 'ap') return toks[j].k;
    }
    return null;
  };
  let out = '';
  toks.forEach((tk, idx) => {
    if (tk.lit !== undefined) { out += tk.lit; return; }
    switch (tk.k) {
      case 'y': out += tk.n <= 2 ? String(d.y).slice(-2) : String(d.y); break;
      case 'd': out += tk.n >= 4 ? DAYS_FULL[wd] : tk.n === 3 ? DAYS_ABBR[wd] : tk.n === 2 ? pad(d.d) : String(d.d); break;
      case 'h': { const hv = twelve ? ((t.h % 12) || 12) : t.h; out += tk.n >= 2 ? pad(hv) : String(hv); break; }
      case 's': out += tk.n >= 2 ? pad(t.s) : String(t.s); break;
      case 'ap': out += tk.long ? (t.h < 12 ? 'AM' : 'PM') : (t.h < 12 ? 'A' : 'P'); break;
      case 'm': {
        const minutes = neighbour(idx, -1) === 'h' || neighbour(idx, 1) === 's';
        if (minutes) { out += tk.n >= 2 ? pad(t.mi) : String(t.mi); break; }
        out += tk.n >= 4 ? MONTHS_FULL[d.m - 1] : tk.n === 3 ? MONTHS[d.m - 1] : tk.n === 2 ? pad(d.m) : String(d.m);
        break;
      }
      default: break;
    }
  });
  return out;
}
function fmtNumberPattern(v, pat) {
  let neg = v < 0, val = Math.abs(v), prefix = '', suffix = '';
  const pm = /^[₹$€£]/.exec(pat); if (pm) { prefix = pm[0]; pat = pat.slice(1); }
  if (/%$/.test(pat)) { val *= 100; suffix = '%'; pat = pat.slice(0, -1); }
  const intPart = pat.split('.')[0];
  const thou = /,/.test(intPart);
  const dot = pat.indexOf('.'); const dec = dot >= 0 ? (pat.slice(dot + 1).match(/0/g) || []).length : 0;
  let s = val.toFixed(dec);
  if (thou) { const p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); }
  return (neg ? '-' : '') + prefix + s + suffix;
}
export function formatValue(value, spec) {
  if (typeof value !== 'number') return numToStr(value);
  const pat = resolveSpec(spec);
  if (pat == null || pat === 'plain') return numToStr(value);
  if (pat === 'sci') return value.toExponential(2).toUpperCase().replace('E', 'E+').replace('E+-', 'E-');
  if (pat === 'date' || pat === 'time' || pat === 'datetime') return fmtDate(value, pat);
  if (isDatePattern(pat)) return fmtDatePattern(value, pat);
  return fmtNumberPattern(value, pat);
}
// Increase/decrease decimal places, returning a new pattern.
export function withDecimals(spec, delta) {
  let pat = resolveSpec(spec); if (pat == null || pat === 'plain' || pat === 'date' || pat === 'time' || pat === 'datetime' || pat === 'sci') pat = '#,##0';
  let suffix = ''; if (/%$/.test(pat)) { suffix = '%'; pat = pat.slice(0, -1); }
  let prefix = ''; const pm = /^[₹$€£]/.exec(pat); if (pm) { prefix = pm[0]; pat = pat.slice(1); }
  const dot = pat.indexOf('.'); let dec = dot >= 0 ? (pat.slice(dot + 1).match(/0/g) || []).length : 0;
  dec = Math.max(0, Math.min(10, dec + delta));
  const intp = pat.split('.')[0];
  return prefix + intp + (dec > 0 ? '.' + '0'.repeat(dec) : '') + suffix;
}
