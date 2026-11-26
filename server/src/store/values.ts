/**
 * Cell values and how they are parsed, displayed and stored.
 *
 * The rules here are the ones Google Sheets applied to the "New Base"
 * workbook, because every reader of this data (the forms app, history,
 * duplicate checks) was written against them:
 *
 *   - a string that looks like a number is stored as a number
 *   - "14:30" is stored as a time of day
 *   - "25/11/2026" (day first, the workbook's en_GB locale) is stored as a date
 *   - everything else stays text
 *
 * In memory a cell is a string, number, boolean or Date. '' is an empty cell.
 * A time of day is a Date on 30/12/1899, which is how Sheets hands it to code.
 */

export type Cell = string | number | boolean | Date;

export const TIME_EPOCH_YEAR = 1899;

export function isEmpty(v: unknown): boolean {
  return v === '' || v === null || v === undefined;
}

export function isTimeOnly(d: Date): boolean {
  return d.getFullYear() <= 1900;
}

export function timeOfDay(h: number, m: number, s = 0): Date {
  return new Date(TIME_EPOCH_YEAR, 11, 30, h, m, s, 0);
}

/* ------------------------------------------------------------ storage -- */

export type StoredCell = string | number | boolean | null | { $d: number } | { $t: number };

export function encodeCell(v: Cell): StoredCell {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    if (isTimeOnly(v)) return { $t: v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds() };
    return { $d: v.getTime() };
  }
  if (typeof v === 'number' && !isFinite(v)) return '';
  return v === undefined || v === null ? '' : v;
}

export function decodeCell(v: StoredCell): Cell {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('$d' in v) return new Date(v.$d);
    if ('$t' in v) {
      const t = v.$t;
      return timeOfDay(Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60);
    }
    return '';
  }
  return v;
}

/* ------------------------------------------------- user-entered input -- */

const RE_NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const RE_NUM_GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const RE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const RE_DMY = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const RE_YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export interface Parsed {
  v: Cell;
  /** number format the cell takes when the value's type implies one */
  f?: string;
}

function validDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(y, mo - 1, d);
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d;
}

/**
 * What a cell holds after `value` is written into it — the equivalent of
 * typing it into the sheet, which is how SpreadsheetApp.setValue() behaves.
 */
export function parseEntered(value: unknown): Parsed {
  if (value === null || value === undefined) return { v: '' };
  if (value instanceof Date) return { v: value };
  if (typeof value === 'number') return { v: isFinite(value) ? value : '' };
  if (typeof value === 'boolean') return { v: value };
  if (typeof value !== 'string') return { v: String(value) };
  if (value === '') return { v: '' };

  const t = value.trim();
  if (t === '') return { v: value };

  if (RE_NUM.test(t)) {
    const n = Number(t);
    if (isFinite(n)) return { v: n };
  }
  if (RE_NUM_GROUPED.test(t)) {
    const n = Number(t.replace(/,/g, ''));
    if (isFinite(n)) return { v: n };
  }
  const up = t.toUpperCase();
  if (up === 'TRUE') return { v: true };
  if (up === 'FALSE') return { v: false };

  let m = RE_TIME.exec(t);
  if (m) {
    const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
    if (h < 24 && mi < 60 && s < 60) {
      return { v: timeOfDay(h, mi, s), f: m[3] ? 'HH:mm:ss' : 'HH:mm' };
    }
  }
  m = RE_DMY.exec(t);
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (validDate(y, mo, d)) {
      if (m[4] !== undefined) {
        const h = +m[4], mi = +m[5], s = m[6] ? +m[6] : 0;
        if (h < 24 && mi < 60 && s < 60) {
          return { v: new Date(y, mo - 1, d, h, mi, s), f: 'dd/MM/yyyy HH:mm:ss' };
        }
      } else {
        return { v: new Date(y, mo - 1, d), f: 'dd/MM/yyyy' };
      }
    }
  }
  m = RE_YMD.exec(t);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (validDate(y, mo, d)) {
      if (m[4] !== undefined) {
        const h = +m[4], mi = +m[5], s = m[6] ? +m[6] : 0;
        if (h < 24 && mi < 60 && s < 60) {
          return { v: new Date(y, mo - 1, d, h, mi, s), f: 'yyyy-MM-dd HH:mm:ss' };
        }
      } else {
        return { v: new Date(y, mo - 1, d), f: 'yyyy-MM-dd' };
      }
    }
  }
  return { v: value };
}

/* ------------------------------------------------------------ display -- */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(n: number, w: number): string {
  let s = String(Math.abs(n));
  while (s.length < w) s = '0' + s;
  return s;
}

/**
 * Java SimpleDateFormat subset — the pattern language of both
 * Utilities.formatDate() and the sheet's number formats as the app writes
 * them ('dd/MM/yyyy HH:mm:ss'). Quoted text ('T') is copied through.
 */
export function formatDate(d: Date, pattern: string): string {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  let out = '';
  let i = 0;
  const hasAmPm = /a|AM\/PM|am\/pm/.test(pattern.replace(/'[^']*'/g, ''));
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "'") {
      const end = pattern.indexOf("'", i + 1);
      if (end === -1) { out += pattern.slice(i + 1); break; }
      out += end === i + 1 ? "'" : pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (pattern.startsWith('AM/PM', i) || pattern.startsWith('am/pm', i)) {
      out += d.getHours() < 12 ? 'AM' : 'PM';
      i += 5;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let n = 1;
      while (pattern[i + n] === ch) n++;
      i += n;
      switch (ch) {
        case 'y': out += n === 2 ? pad(d.getFullYear() % 100, 2) : pad(d.getFullYear(), Math.max(n, 4)); break;
        case 'M':
          if (n >= 4) out += MONTHS[d.getMonth()];
          else if (n === 3) out += MONTHS[d.getMonth()].slice(0, 3);
          else out += pad(d.getMonth() + 1, n);
          break;
        case 'd': out += pad(d.getDate(), n); break;
        case 'E': out += n >= 4 ? DAYS[d.getDay()] : DAYS[d.getDay()].slice(0, 3); break;
        case 'H': out += pad(d.getHours(), n); break;
        case 'h': {
          if (hasAmPm) { const h = d.getHours() % 12; out += pad(h === 0 ? 12 : h, n); }
          else out += pad(d.getHours(), n);
          break;
        }
        case 'm': out += pad(d.getMinutes(), n); break;
        case 's': out += pad(d.getSeconds(), n); break;
        case 'S': out += pad(d.getMilliseconds(), 3).slice(0, n); break;
        case 'a': out += d.getHours() < 12 ? 'AM' : 'PM'; break;
        case 'Z': {
          const off = -d.getTimezoneOffset();
          out += (off < 0 ? '-' : '+') + pad(Math.floor(Math.abs(off) / 60), 2) + pad(Math.abs(off) % 60, 2);
          break;
        }
        default: out += ch.repeat(n);
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * A spreadsheet number format as exported in an .xlsx ("dd/mm/yyyy hh:mm:ss",
 * where mm means month or minute depending on its neighbours) rewritten in
 * the unambiguous pattern language used everywhere else here.
 */
export function normaliseDateFormat(fmt: string): string {
  if (!fmt) return fmt;
  let f = fmt.replace(/\[\$-[0-9A-Fa-f]+\]/g, '').replace(/\\/g, '').replace(/;@$/, '').replace(/"([^"]*)"/g, "'$1'");
  if (/^general$/i.test(f)) return '';
  const hasAmPm = /am\/pm|a\/p/i.test(f);
  const tokens = f.match(/'[^']*'|am\/pm|a\/p|y+|m+|d+|h+|s+|./gi) || [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const lower = tk.toLowerCase();
    if (/^m+$/.test(lower)) {
      // minutes when the nearest letter token before is hours, or after is seconds
      let prev = '', next = '';
      for (let j = i - 1; j >= 0; j--) if (/^[a-z]+$/i.test(tokens[j])) { prev = tokens[j].toLowerCase(); break; }
      for (let j = i + 1; j < tokens.length; j++) if (/^[a-z]+$/i.test(tokens[j])) { next = tokens[j].toLowerCase(); break; }
      const isMinute = /^h+$/.test(prev) || /^s+$/.test(next);
      out.push(isMinute ? 'm'.repeat(tk.length) : 'M'.repeat(tk.length));
    } else if (/^h+$/.test(lower)) {
      out.push((hasAmPm ? 'h' : 'H').repeat(tk.length));
    } else if (/^d+$/.test(lower)) {
      out.push(tk.length >= 4 ? 'EEEE' : tk.length === 3 ? 'EEE' : 'd'.repeat(tk.length));
    } else if (/^y+$/.test(lower)) {
      out.push(tk.length <= 2 ? 'yy' : 'yyyy');
    } else if (/^s+$/.test(lower)) {
      out.push('s'.repeat(tk.length));
    } else if (lower === 'am/pm' || lower === 'a/p') {
      out.push('a');
    } else {
      out.push(tk);
    }
  }
  return out.join('');
}

export function isDateFormat(fmt: string | undefined): boolean {
  if (!fmt) return false;
  const bare = fmt.replace(/'[^']*'/g, '');
  return /[yMdHhs]/.test(bare) && !/[0#]/.test(bare);
}

function general(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const r = Number(n.toPrecision(15));
  return String(r);
}

function formatNumber(n: number, fmt: string): string {
  if (!fmt || /^general$/i.test(fmt) || fmt === '@') return general(n);
  const section = fmt.split(';')[0];
  const pct = section.includes('%');
  const m = /([#0,]*)(?:\.([0#]+))?/.exec(section.replace(/[^#0,.%]/g, ''));
  if (!m || (!m[1] && !m[2])) return general(n);
  const decimals = m[2] ? m[2].length : 0;
  const grouped = m[1].includes(',');
  let val = pct ? n * 100 : n;
  let s = Math.abs(val).toFixed(decimals);
  if (m[2] && /#/.test(m[2])) {
    // optional trailing digits
    const minDec = (m[2].match(/0/g) || []).length;
    let [ip, dp = ''] = s.split('.');
    while (dp.length > minDec && dp.endsWith('0')) dp = dp.slice(0, -1);
    s = dp ? ip + '.' + dp : ip;
  }
  if (grouped) {
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    s = parts.join('.');
  }
  return (val < 0 ? '-' : '') + s + (pct ? '%' : '');
}

/** What the sheet shows for a cell — getDisplayValues(). */
export function displayValue(v: Cell, fmt?: string): string {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v, fmt || '');
  if (v instanceof Date) {
    if (fmt && isDateFormat(fmt)) return formatDate(v, fmt);
    if (isTimeOnly(v)) return formatDate(v, v.getSeconds() ? 'HH:mm:ss' : 'HH:mm');
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return formatDate(v, hasTime ? 'dd/MM/yyyy HH:mm:ss' : 'dd/MM/yyyy');
  }
  return String(v);
}

/** Text an editor shows for a cell, which parseEntered() reads back unchanged. */
export function editValue(v: Cell): string {
  if (v instanceof Date) {
    if (isTimeOnly(v)) return formatDate(v, 'HH:mm:ss');
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return formatDate(v, hasTime ? 'dd/MM/yyyy HH:mm:ss' : 'dd/MM/yyyy');
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return general(v);
  return v === null || v === undefined ? '' : String(v);
}

export function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
