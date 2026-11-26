// ============================================================
//  Mono formula engine — lookup/info/database catalog + external
//  service stubs (GS parity pass, final batch)
//
//  OFFSET is volatile by design: its reads aren't visible to the
//  static dependency graph (same treatment as INDIRECT).
//  External-service functions (GOOGLEFINANCE, IMPORTHTML, …)
//  register as clear #N/A explanations instead of #NAME? noise.
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { isArray, makeArray, scalar, flatten, toNumber, toText, compare } from './values.js';
import { critTest } from './builtins.js';
import { colToLetters } from '../model/workbook.js';

const reg = (def) => registry.register(def);
const num = (v) => toNumber(scalar(v));
const str = (v) => toText(scalar(v));

/** ref/range AST node → {sid, r1, c1, r2, c2} (same shape ROW/COLUMN use). */
function refDescriptor(node, ctx) {
  if (!node) return null;
  if (node.type === 'ref') { const sid = node.sheet ? ctx.resolveSheetId(node.sheet) : ctx.sheetId; return { sid, r1: node.row, c1: node.col, r2: node.row, c2: node.col }; }
  if (node.type === 'range') {
    const sid = node.sheet ? ctx.resolveSheetId(node.sheet) : ctx.sheetId;
    const d = ctx.sheetDims(sid);
    const r1 = node.kind === 'cols' ? 0 : Math.min(node.r1, node.r2);
    const r2 = node.kind === 'cols' ? d.rows - 1 : Math.max(node.r1, node.r2);
    const c1 = node.kind === 'rows' ? 0 : Math.min(node.c1, node.c2);
    const c2 = node.kind === 'rows' ? d.cols - 1 : Math.max(node.c1, node.c2);
    return { sid, r1, c1, r2, c2 };
  }
  return null;
}
function readRect(ctx, sid, r1, c1, r2, c2) {
  if (r1 === r2 && c1 === c2) return ctx.readCell(sid, r1, c1);
  const data = [];
  for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(ctx.readCell(sid, r, c)); data.push(row); }
  return makeArray(data);
}

/* =========================================================
   LOOKUP
   ========================================================= */
reg({ name: 'OFFSET', min: 3, max: 5, volatile: true, lazy: true, fn: (args, ctx, ev) => {
  const d = refDescriptor(args[0], ctx);
  if (!d) return err(ERR.VALUE, 'OFFSET needs a range reference');
  const dr = num(ev(args[1])), dc = num(ev(args[2]));
  if (isError(dr)) return dr; if (isError(dc)) return dc;
  const h0 = args.length > 3 ? num(ev(args[3])) : d.r2 - d.r1 + 1;
  if (isError(h0)) return h0;
  const w0 = args.length > 4 ? num(ev(args[4])) : d.c2 - d.c1 + 1;
  if (isError(w0)) return w0;
  const h = Math.trunc(h0), w = Math.trunc(w0);
  const r1 = d.r1 + Math.trunc(dr), c1 = d.c1 + Math.trunc(dc);
  if (r1 < 0 || c1 < 0 || h < 1 || w < 1) return err(ERR.REF);
  return readRect(ctx, d.sid, r1, c1, r1 + h - 1, c1 + w - 1);
}, help: { syntax: 'OFFSET(cell_reference, offset_rows, offset_columns, [height], [width])' } });
reg({ name: 'LOOKUP', min: 2, max: 3, fn: (a) => {
  const key = scalar(a[0]); if (isError(key)) return key;
  const searchVals = flatten(a[1]);
  const resultVals = a.length > 2 ? flatten(a[2]) : searchVals;
  // largest value ≤ key (assumes ascending, like Sheets)
  let best = -1;
  for (let i = 0; i < searchVals.length; i++) {
    const v = searchVals[i];
    if (v == null || isError(v)) continue;
    if (compare(v, key) <= 0) best = i; else break;
  }
  if (best === -1) return err(ERR.NA, 'Not found');
  return best < resultVals.length ? resultVals[best] : err(ERR.NA);
}, help: { syntax: 'LOOKUP(search_key, search_range, [result_range])' } });
reg({ name: 'XMATCH', min: 2, max: 4, fn: (a) => {
  const key = scalar(a[0]); if (isError(key)) return key;
  const vals = flatten(a[1]);
  const mode = a.length > 2 ? Math.trunc(num(a[2])) : 0;
  if (isError(mode)) return mode;
  const dir = a.length > 3 ? Math.trunc(num(a[3])) : 1;
  if (isError(dir)) return dir;
  const idxs = [...vals.keys()];
  if (dir === -1 || dir === -2) idxs.reverse();
  let bestIdx = -1, bestVal = null;
  for (const i of idxs) {
    const v = vals[i];
    if (v == null || isError(v)) continue;
    if (mode === 2) { // wildcard
      if (critTest(v, key)) return i + 1;
      continue;
    }
    const c = compare(v, key);
    if (c === 0) return i + 1;
    if (mode === -1 && c < 0 && (bestIdx === -1 || compare(v, bestVal) > 0)) { bestIdx = i; bestVal = v; }
    if (mode === 1 && c > 0 && (bestIdx === -1 || compare(v, bestVal) < 0)) { bestIdx = i; bestVal = v; }
  }
  return bestIdx === -1 ? err(ERR.NA, 'Not found') : bestIdx + 1;
}, help: { syntax: 'XMATCH(search_key, lookup_range, [match_mode], [search_mode])' } });
reg({ name: 'ADDRESS', min: 2, max: 5, fn: (a) => {
  const r = Math.trunc(num(a[0])), c = Math.trunc(num(a[1]));
  if (isError(r)) return r; if (isError(c)) return c;
  if (r < 1 || c < 1) return err(ERR.VALUE);
  const absMode = a.length > 2 ? Math.trunc(num(a[2])) : 1;
  if (isError(absMode)) return absMode;
  const a1Style = a.length > 3 ? !!scalar(a[3]) : true;
  const sheet = a.length > 4 ? str(a[4]) : '';
  if (isError(sheet)) return sheet;
  let body;
  if (a1Style) {
    const cAbs = absMode === 1 || absMode === 3 ? '$' : '';
    const rAbs = absMode === 1 || absMode === 2 ? '$' : '';
    body = cAbs + colToLetters(c - 1) + rAbs + r;
  } else {
    const rr = absMode === 1 || absMode === 2 ? `R${r}` : `R[${r}]`;
    const cc = absMode === 1 || absMode === 3 ? `C${c}` : `C[${c}]`;
    body = rr + cc;
  }
  return sheet ? `'${sheet}'!${body}` : body;
}, help: { syntax: 'ADDRESS(row, column, [absolute_relative_mode], [use_a1_notation], [sheet])' } });
reg({ name: 'FORMULATEXT', min: 1, max: 1, lazy: true, fn: (args, ctx) => {
  const d = refDescriptor(args[0], ctx);
  if (!d) return err(ERR.VALUE, 'Needs a cell reference');
  const raw = ctx.getRaw ? ctx.getRaw(d.sid, d.r1, d.c1) : '';
  return raw && raw[0] === '=' ? raw : err(ERR.NA, 'Not a formula');
}, help: { syntax: 'FORMULATEXT(cell)' } });

/* =========================================================
   INFO
   ========================================================= */
reg({ name: 'N', min: 1, max: 1, passErrors: true, fn: (a) => {
  const v = scalar(a[0]);
  if (isError(v)) return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}, help: { syntax: 'N(value)' } });
reg({ name: 'TYPE', min: 1, max: 1, passErrors: true, fn: (a) => {
  const raw = a[0];
  if (isArray(raw)) return 64;
  const v = scalar(raw);
  if (isError(v)) return 16;
  if (typeof v === 'boolean') return 4;
  if (typeof v === 'string') return 2;
  return 1; // numbers and blanks
} });
const ERROR_CODES = { '#NULL!': 1, '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4, '#NAME?': 5, '#NUM!': 6, '#N/A': 7, '#ERROR!': 8, '#CYCLE!': 8, '#SPILL!': 8 };
reg({ name: 'ERROR.TYPE', min: 1, max: 1, passErrors: true, fn: (a) => {
  const v = scalar(a[0]);
  if (!isError(v)) return err(ERR.NA);
  return ERROR_CODES[v.type] ?? 8;
}, help: { syntax: 'ERROR.TYPE(reference)' } });
reg({ name: 'ISFORMULA', min: 1, max: 1, lazy: true, fn: (args, ctx) => {
  const d = refDescriptor(args[0], ctx);
  if (!d) return err(ERR.VALUE, 'Needs a cell reference');
  const raw = ctx.getRaw ? ctx.getRaw(d.sid, d.r1, d.c1) : '';
  return Boolean(raw && raw[0] === '=');
} });
reg({ name: 'ISREF', min: 1, max: 1, lazy: true, fn: (args, ctx) => Boolean(refDescriptor(args[0], ctx)) });
reg({ name: 'ISDATE', min: 1, max: 1, fn: (a) => {
  const v = scalar(a[0]);
  if (isError(v)) return false;
  if (typeof v === 'number') return true; // any serial is a date in a format-free model
  if (typeof v !== 'string') return false;
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(v.trim()) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v.trim());
} });
reg({ name: 'ISEMAIL', min: 1, max: 1, fn: (a) => { const t = str(a[0]); if (isError(t)) return false; return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(t).trim()); } });
reg({ name: 'ISURL', min: 1, max: 1, fn: (a) => { const t = str(a[0]); if (isError(t)) return false; return /^(https?:\/\/)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?(\/\S*)?$/.test(String(t).trim()); } });
reg({ name: 'CELL', min: 2, max: 2, lazy: true, fn: (args, ctx, ev) => {
  const info = str(ev(args[0])); if (isError(info)) return info;
  const d = refDescriptor(args[1], ctx);
  if (!d) return err(ERR.VALUE, 'Needs a cell reference');
  switch (String(info).toLowerCase()) {
    case 'row': return d.r1 + 1;
    case 'col': return d.c1 + 1;
    case 'address': return '$' + colToLetters(d.c1) + '$' + (d.r1 + 1);
    case 'contents': return ctx.readCell(d.sid, d.r1, d.c1);
    case 'type': { const v = ctx.readCell(d.sid, d.r1, d.c1); return v == null ? 'b' : typeof v === 'string' ? 'l' : 'v'; }
    default: return err(ERR.VALUE, 'Supported: row, col, address, contents, type');
  }
}, help: { syntax: 'CELL(info_type, reference)' } });

/* =========================================================
   DATABASE FUNCTIONS (D*)
   ========================================================= */
function dbParse(dbArg, fieldArg, critArg) {
  if (!isArray(dbArg) || dbArg.rows < 2) return err(ERR.VALUE, 'database needs headers + rows');
  const headers = dbArg.data[0].map((h) => String(toText(h)).trim().toLowerCase());
  const rows = dbArg.data.slice(1);
  // field: 1-based index, header name, or null (only DCOUNT/DCOUNTA allow omission upstream)
  let fieldIdx = null;
  if (fieldArg !== undefined) {
    const f = scalar(fieldArg);
    if (isError(f)) return f;
    if (typeof f === 'number') fieldIdx = Math.trunc(f) - 1;
    else fieldIdx = headers.indexOf(String(toText(f)).trim().toLowerCase());
    if (fieldIdx == null || fieldIdx < 0 || fieldIdx >= headers.length) return err(ERR.VALUE, 'bad field');
  }
  if (!isArray(critArg) || critArg.rows < 2) return err(ERR.VALUE, 'criteria needs headers + rows');
  const critHeaders = critArg.data[0].map((h) => String(toText(h)).trim().toLowerCase());
  const critCols = critHeaders.map((h) => headers.indexOf(h));
  if (critCols.some((c) => c === -1)) return err(ERR.VALUE, 'criteria header not in database');
  const matches = (row) => critArg.data.slice(1).some((critRow) =>   // OR across criteria rows
    critRow.every((crit, i) => crit == null || crit === '' || critTest(row[critCols[i]], crit))); // AND across columns
  const selected = rows.filter(matches);
  return { selected, fieldIdx };
}
function dfun(name, foldNums, opts = {}) {
  reg({ name, min: 3, max: 3, fn: (a) => {
    const p = dbParse(a[0], a[1], a[2]);
    if (isError(p)) return p;
    const cells = p.selected.map((r) => r[p.fieldIdx]);
    if (opts.raw) return opts.raw(cells);
    const xs = cells.filter((v) => typeof v === 'number');
    return foldNums(xs);
  }, help: { syntax: `${name}(database, field, criteria)` } });
}
const meanOf = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
dfun('DSUM', (xs) => xs.reduce((s, x) => s + x, 0));
dfun('DAVERAGE', (xs) => (xs.length ? meanOf(xs) : err(ERR.DIV0)));
dfun('DCOUNT', (xs) => xs.length);
dfun('DCOUNTA', null, { raw: (cells) => cells.filter((v) => v != null && v !== '').length });
dfun('DMAX', (xs) => (xs.length ? Math.max(...xs) : 0));
dfun('DMIN', (xs) => (xs.length ? Math.min(...xs) : 0));
dfun('DPRODUCT', (xs) => xs.reduce((s, x) => s * x, 1));
dfun('DSTDEV', (xs) => (xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - meanOf(xs)) ** 2, 0) / (xs.length - 1)) : err(ERR.DIV0)));
dfun('DSTDEVP', (xs) => (xs.length ? Math.sqrt(xs.reduce((s, x) => s + (x - meanOf(xs)) ** 2, 0) / xs.length) : err(ERR.DIV0)));
dfun('DVAR', (xs) => (xs.length > 1 ? xs.reduce((s, x) => s + (x - meanOf(xs)) ** 2, 0) / (xs.length - 1) : err(ERR.DIV0)));
dfun('DVARP', (xs) => (xs.length ? xs.reduce((s, x) => s + (x - meanOf(xs)) ** 2, 0) / xs.length : err(ERR.DIV0)));
dfun('DGET', null, { raw: (cells) => (cells.length === 0 ? err(ERR.VALUE, 'No match') : cells.length > 1 ? err(ERR.NUM, 'Multiple matches') : cells[0]) });

/* =========================================================
   WEB / EXTERNAL-SERVICE STUBS — these need Google's servers;
   a clear message beats #NAME?.
   ========================================================= */
const EXTERNAL = ['GOOGLEFINANCE', 'GOOGLETRANSLATE', 'DETECTLANGUAGE', 'SPARKLINE', 'IMAGE', 'IMPORTDATA', 'IMPORTHTML', 'IMPORTXML', 'IMPORTFEED', 'GETPIVOTDATA'];
for (const name of EXTERNAL) {
  reg({ name, min: 0, fn: () => err(ERR.NA, `${name} needs external Google services and is not available in Mono Sheets`), help: { syntax: `${name}(…)`, desc: `Not available offline — ${name} depends on external Google services.` } });
}
reg({ name: 'ENCODEURL', min: 1, max: 1, fn: (a) => { const t = str(a[0]); if (isError(t)) return t; return encodeURIComponent(t); }, help: { syntax: 'ENCODEURL(text)' } });
