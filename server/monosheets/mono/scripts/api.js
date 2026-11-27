// ============================================================
//  Mono Scripts — Apps-Script-style API (Phase 5)
//  buildApi(host, rt) returns the globals injected into a script:
//  SpreadsheetApp, Logger, console, Utilities, PropertiesService.
//  Operates on the live engine/workbook via `host`. No DOM.
// ============================================================
import { parseCell, colToLetters } from '../engine/references.js';

const a1 = (r, c) => colToLetters(c) + (r + 1);
function parseA1(s) {
  const parts = String(s).split(':'); const A = parseCell(parts[0].toUpperCase()); if (!A) return { r1: 0, c1: 0, r2: 0, c2: 0 };
  if (parts.length === 1) return { r1: A.row, c1: A.col, r2: A.row, c2: A.col };
  const B = parseCell(parts[1].toUpperCase()) || A;
  return { r1: Math.min(A.row, B.row), c1: Math.min(A.col, B.col), r2: Math.max(A.row, B.row), c2: Math.max(A.col, B.col) };
}
const fmt = (x) => (x && typeof x === 'object') ? JSON.stringify(x) : String(x);

export function buildApi(host, rt) {
  const eng = host.engine;
  const sheetOf = (sid) => eng.wb.sheets.find((s) => s.id === sid);
  const toRaw = (v) => v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  const outVal = (v) => v == null ? '' : (v && v.__error ? v.type : v);
  const lastRow = (sid) => { const sh = sheetOf(sid); let last = 0; for (let r = 0; r < sh.rows; r++) { for (let c = 0; c < sh.cols; c++) if (eng.getRaw(sid, r, c) !== '') { last = r + 1; break; } } return last; };
  const lastCol = (sid) => { const sh = sheetOf(sid); let last = 0; for (let c = 0; c < sh.cols; c++) { for (let r = 0; r < sh.rows; r++) if (eng.getRaw(sid, r, c) !== '') { last = c + 1; break; } } return last; };

  function Range(sid, r1, c1, r2, c2) {
    const sh = () => sheetOf(sid);
    const each = (fn) => { for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) fn(r, c); };
    const self = {
      getValue: () => outVal(eng.getValue(sid, r1, c1)),
      getValues: () => { const o = []; for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(outVal(eng.getValue(sid, r, c))); o.push(row); } return o; },
      getDisplayValue: () => eng.getDisplay(sid, r1, c1),
      getDisplayValues: () => { const o = []; for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(eng.getDisplay(sid, r, c)); o.push(row); } return o; },
      setValue: (v) => { each((r, c) => eng.setRaw(sid, r, c, toRaw(v))); host.refresh(); return self; },
      setValues: (vals) => { const list = []; for (let r = 0; r < vals.length; r++) for (let c = 0; c < (vals[r] || []).length; c++) list.push({ r: r1 + r, c: c1 + c, raw: toRaw(vals[r][c]) }); eng.setCellsBatch(sid, list); host.refresh(); return self; },
      setFormula: (f) => { eng.setRaw(sid, r1, c1, String(f)); host.refresh(); return self; },
      getFormula: () => { const raw = eng.getRaw(sid, r1, c1); return raw && raw[0] === '=' ? raw : ''; },
      clearContent: () => { const list = []; each((r, c) => { if (eng.getRaw(sid, r, c) !== '') list.push({ r, c, raw: '' }); }); if (list.length) eng.setCellsBatch(sid, list); host.refresh(); return self; },
      getA1Notation: () => a1(r1, c1) + ((r1 === r2 && c1 === c2) ? '' : ':' + a1(r2, c2)),
      getRow: () => r1 + 1, getColumn: () => c1 + 1, getNumRows: () => r2 - r1 + 1, getNumColumns: () => c2 - c1 + 1,
      getSheet: () => Sheet(sid),
      offset: (dr, dc, nr, nc) => Range(sid, r1 + dr, c1 + dc, r1 + dr + ((nr == null ? (r2 - r1 + 1) : nr) - 1), c1 + dc + ((nc == null ? (c2 - c1 + 1) : nc) - 1)),
      setBackground: (col) => { each((r, c) => sh().setStyle(r, c, { bg: col })); host.refresh(); return self; },
      setFontColor: (col) => { each((r, c) => sh().setStyle(r, c, { fg: col })); host.refresh(); return self; },
      setFontWeight: (w) => { each((r, c) => sh().setStyle(r, c, { b: w === 'bold' ? 1 : false })); host.refresh(); return self; },
      setNumberFormat: (nf) => { each((r, c) => sh().setFormat(r, c, nf)); host.refresh(); return self; },
      merge: () => { sh().merges.push({ r1, c1, r2, c2 }); host.refresh(); return self; },
    };
    return self;
  }
  function Sheet(sid) {
    const sh = () => sheetOf(sid);
    return {
      getName: () => sh().name, setName: (n) => { eng.wb.renameSheet(sid, n); host.refresh(); },
      getSheetId: () => sid,
      getRange: (a, b, nr, nc) => { if (typeof a === 'string') { const rg = parseA1(a); return Range(sid, rg.r1, rg.c1, rg.r2, rg.c2); } const r = a - 1, c = b - 1; return Range(sid, r, c, r + ((nr || 1) - 1), c + ((nc || 1) - 1)); },
      getDataRange: () => Range(sid, 0, 0, Math.max(0, lastRow(sid) - 1), Math.max(0, lastCol(sid) - 1)),
      getLastRow: () => lastRow(sid), getLastColumn: () => lastCol(sid), getMaxRows: () => sh().rows, getMaxColumns: () => sh().cols,
      appendRow: (arr) => { const r = lastRow(sid); const list = (arr || []).map((v, i) => ({ r, c: i, raw: toRaw(v) })); eng.setCellsBatch(sid, list); host.refresh(); },
      insertRowAfter: (r) => { eng.insertRows(sid, r, 1); host.refresh(); },
      clearContents: () => { const list = []; for (const k of [...sh().cells.keys()]) { const [r, c] = k.split(',').map(Number); list.push({ r, c, raw: '' }); } if (list.length) eng.setCellsBatch(sid, list); host.refresh(); },
      getCharts: () => [],
    };
  }
  function Spreadsheet() {
    return {
      getName: () => eng.wb.name, rename: (n) => { eng.wb.name = String(n); host.refresh(); }, getId: () => eng.wb.id,
      getSheets: () => eng.wb.sheets.map((s) => Sheet(s.id)), getNumSheets: () => eng.wb.sheets.length,
      getSheetByName: (n) => { const s = eng.wb.sheets.find((x) => x.name.toLowerCase() === String(n).toLowerCase()); return s ? Sheet(s.id) : null; },
      getActiveSheet: () => Sheet(host.activeSheetId()),
      setActiveSheet: (s) => { if (s && s.getSheetId) { eng.wb.setActive(s.getSheetId()); host.refresh(); } },
      insertSheet: (n) => { const s = eng.wb.addSheet(typeof n === 'string' ? n : undefined); host.refresh(); return Sheet(s.id); },
      deleteSheet: (s) => { if (s && s.getSheetId) { eng.wb.removeSheet(s.getSheetId()); host.refresh(); } },
      getRange: (s) => { const sid = host.activeSheetId(); const rg = parseA1(s); return Range(sid, rg.r1, rg.c1, rg.r2, rg.c2); },
      getActiveRange: () => { const a = host.activeRange(); return Range(a.sid, a.r1, a.c1, a.r2, a.c2); },
      getActiveCell: () => { const a = host.activeRange(); return Range(a.sid, a.r1, a.c1, a.r1, a.c1); },
      toast: (msg) => host.ui.toast(String(msg)),
    };
  }
  function Ui() {
    return {
      createMenu: (name) => { const items = []; const b = { addItem: (label, fn) => { items.push({ label: String(label), fn: String(fn) }); return b; }, addSeparator: () => { items.push('sep'); return b; }, addSubMenu: () => b, addToUi: () => { rt.menus.push({ name: String(name), items }); } }; return b; },
      alert: (msg) => host.ui.alert(String(msg)), prompt: (msg) => host.ui.prompt(String(msg)),
    };
  }
  const SpreadsheetApp = {
    getActiveSpreadsheet: () => Spreadsheet(), getActive: () => Spreadsheet(),
    getActiveSheet: () => Sheet(host.activeSheetId()),
    getActiveRange: () => { const a = host.activeRange(); return Range(a.sid, a.r1, a.c1, a.r2, a.c2); },
    openById: () => Spreadsheet(), getUi: () => Ui(), flush: () => host.refresh(),
  };
  const Logger = { log: (...a) => rt.logs.push(a.map(fmt).join(' ')), clear: () => { rt.logs = []; }, getLog: () => rt.logs.join('\n') };
  const console = { log: (...a) => rt.logs.push(a.map(fmt).join(' ')), info: (...a) => rt.logs.push(a.map(fmt).join(' ')), warn: (...a) => rt.logs.push('⚠ ' + a.map(fmt).join(' ')), error: (...a) => rt.logs.push('✕ ' + a.map(fmt).join(' ')) };
  const Utilities = {
    getUuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }),
    sleep: () => {}, formatString: (t, ...a) => { let i = 0; return String(t).replace(/%s/g, () => String(a[i++])); }, formatDate: (d) => String(d),
    base64Encode: (s) => (typeof btoa !== 'undefined' ? btoa(String(s)) : (typeof Buffer !== 'undefined' ? Buffer.from(String(s)).toString('base64') : String(s))),
  };
  function store(kind) { const o = host.props[kind] || (host.props[kind] = {}); const api = { getProperty: (k) => (k in o ? o[k] : null), setProperty: (k, v) => { o[k] = String(v); host.save && host.save(); return api; }, deleteProperty: (k) => { delete o[k]; host.save && host.save(); return api; }, getProperties: () => Object.assign({}, o), setProperties: (m) => { Object.assign(o, m); host.save && host.save(); return api; } }; return api; }
  const PropertiesService = { getScriptProperties: () => store('script'), getDocumentProperties: () => store('document'), getUserProperties: () => store('script') };
  return { SpreadsheetApp, Logger, console, Utilities, PropertiesService };
}
