// ============================================================
//  Mono Scripts — sandbox (Phase 5B)
//  Defense-in-depth for user scripts:
//   • compileFunctions(): shadows dangerous host globals (DOM,
//     network, storage, eval, Function, timers…) so scripts can't
//     reach them by name.  [Not a VM — constructor-chain escape is
//     the known limit; true isolation = QuickJS-in-a-Worker (5C).]
//   • snapshotApi(): a SpreadsheetApp-style API over a read-only
//     snapshot that records writes to an op-log (for the Web Worker
//     runner, which can be killed on timeout).
//   • applyOps(): replays a worker op-log onto the live engine.
// ============================================================
import { parseCell, colToLetters } from '../engine/references.js';

export const DANGEROUS = ['window', 'document', 'globalThis', 'self', 'top', 'parent', 'frames', 'location', 'navigator', 'history', 'screen', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'Worker', 'SharedWorker', 'importScripts', 'Function', 'require', 'module', 'exports', 'process', 'postMessage', 'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame', 'crypto', 'Proxy', 'Reflect', 'WebAssembly', 'Deno', 'Bun'];

const fnNames = (source) => [...new Set(Array.from(source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)).map((m) => m[1]))];

// Compile source with dangerous globals shadowed to undefined; return {name: fn}.
export function compileFunctions(source, api) {
  const apiNames = Object.keys(api);
  const shadow = DANGEROUS.filter((n) => !apiNames.includes(n));
  const names = fnNames(source);
  const ret = '\n;return {' + names.map((n) => JSON.stringify(n) + ':(typeof ' + n + '==="function"?' + n + ':undefined)').join(',') + '};';
  const f = new Function(...apiNames, ...shadow, '"use strict";\n' + source + ret);
  return f(...apiNames.map((k) => api[k]), ...shadow.map(() => undefined)) || {};
}

const a1 = (r, c) => colToLetters(c) + (r + 1);
function pa1(s) { const p = String(s).split(':'); const A = parseCell(p[0].toUpperCase()) || { row: 0, col: 0 }; if (p.length === 1) return { r1: A.row, c1: A.col, r2: A.row, c2: A.col }; const B = parseCell(p[1].toUpperCase()) || A; return { r1: Math.min(A.row, B.row), c1: Math.min(A.col, B.col), r2: Math.max(A.row, B.row), c2: Math.max(A.col, B.col) }; }
const coerce = (s) => { if (s == null || s === '') return ''; const n = Number(String(s).replace(/[,%\s₹$€£]/g, '')); return (!Number.isNaN(n) && String(s).trim() !== '') ? n : s; };
const toRaw = (v) => v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
const fmt = (x) => (x && typeof x === 'object') ? JSON.stringify(x) : String(x);

// SpreadsheetApp-style API over a snapshot; records writes into sink.ops.
// snapshot = { activeId, sheets:[{id,name,rows,cols,cells:{'r,c':display}}] }
// sink = { ops:[], logs:[], menus:[] }
export function snapshotApi(snap, sink) {
  const sheetOf = (id) => snap.sheets.find((s) => s.id === id);
  const get = (sid, r, c) => { const s = sheetOf(sid); const v = s && s.cells[r + ',' + c]; return v == null ? '' : v; };
  const setLocal = (sid, r, c, raw) => { const s = sheetOf(sid); if (s) { if (raw === '') delete s.cells[r + ',' + c]; else s.cells[r + ',' + c] = raw; } };
  function Range(sid, r1, c1, r2, c2) {
    const each = (fn) => { for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) fn(r, c); };
    const self = {
      getValue: () => coerce(get(sid, r1, c1)),
      getValues: () => { const o = []; for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(coerce(get(sid, r, c))); o.push(row); } return o; },
      getDisplayValue: () => get(sid, r1, c1),
      setValue: (v) => { each((r, c) => { sink.ops.push({ op: 'setRaw', sid, r, c, raw: toRaw(v) }); setLocal(sid, r, c, toRaw(v)); }); return self; },
      setValues: (vals) => { for (let r = 0; r < vals.length; r++) for (let c = 0; c < (vals[r] || []).length; c++) { const rr = r1 + r, cc = c1 + c; sink.ops.push({ op: 'setRaw', sid, r: rr, c: cc, raw: toRaw(vals[r][c]) }); setLocal(sid, rr, cc, toRaw(vals[r][c])); } return self; },
      setFormula: (f) => { sink.ops.push({ op: 'setRaw', sid, r: r1, c: c1, raw: String(f) }); setLocal(sid, r1, c1, String(f)); return self; },
      clearContent: () => { each((r, c) => { sink.ops.push({ op: 'setRaw', sid, r, c, raw: '' }); setLocal(sid, r, c, ''); }); return self; },
      setBackground: (col) => { each((r, c) => sink.ops.push({ op: 'setStyle', sid, r, c, patch: { bg: col } })); return self; },
      setFontColor: (col) => { each((r, c) => sink.ops.push({ op: 'setStyle', sid, r, c, patch: { fg: col } })); return self; },
      setFontWeight: (w) => { each((r, c) => sink.ops.push({ op: 'setStyle', sid, r, c, patch: { b: w === 'bold' ? 1 : false } })); return self; },
      setNumberFormat: (nf) => { each((r, c) => sink.ops.push({ op: 'setFormat', sid, r, c, nf })); return self; },
      getA1Notation: () => a1(r1, c1) + ((r1 === r2 && c1 === c2) ? '' : ':' + a1(r2, c2)),
      getRow: () => r1 + 1, getColumn: () => c1 + 1, getNumRows: () => r2 - r1 + 1, getNumColumns: () => c2 - c1 + 1,
      getSheet: () => Sheet(sid),
      offset: (dr, dc, nr, nc) => Range(sid, r1 + dr, c1 + dc, r1 + dr + ((nr == null ? r2 - r1 + 1 : nr) - 1), c1 + dc + ((nc == null ? c2 - c1 + 1 : nc) - 1)),
    };
    return self;
  }
  const lastRow = (sid) => { const s = sheetOf(sid); let m = 0; Object.keys(s ? s.cells : {}).forEach((k) => { const r = +k.split(',')[0]; if (r + 1 > m) m = r + 1; }); return m; };
  const lastCol = (sid) => { const s = sheetOf(sid); let m = 0; Object.keys(s ? s.cells : {}).forEach((k) => { const c = +k.split(',')[1]; if (c + 1 > m) m = c + 1; }); return m; };
  function Sheet(sid) {
    const s = () => sheetOf(sid);
    return {
      getName: () => s().name, getSheetId: () => sid,
      getRange: (a, b, nr, nc) => { if (typeof a === 'string') { const rg = pa1(a); return Range(sid, rg.r1, rg.c1, rg.r2, rg.c2); } const r = a - 1, c = b - 1; return Range(sid, r, c, r + ((nr || 1) - 1), c + ((nc || 1) - 1)); },
      getDataRange: () => Range(sid, 0, 0, Math.max(0, lastRow(sid) - 1), Math.max(0, lastCol(sid) - 1)),
      getLastRow: () => lastRow(sid), getLastColumn: () => lastCol(sid), getMaxRows: () => s().rows, getMaxColumns: () => s().cols,
      appendRow: (arr) => { const r = lastRow(sid); (arr || []).forEach((v, i) => { sink.ops.push({ op: 'setRaw', sid, r, c: i, raw: toRaw(v) }); setLocal(sid, r, i, toRaw(v)); }); },
    };
  }
  const Spreadsheet = () => ({
    getName: () => snap.name || 'Workbook',
    getSheets: () => snap.sheets.map((x) => Sheet(x.id)),
    getSheetByName: (n) => { const x = snap.sheets.find((y) => y.name.toLowerCase() === String(n).toLowerCase()); return x ? Sheet(x.id) : null; },
    getActiveSheet: () => Sheet(snap.activeId),
    getRange: (s) => { const rg = pa1(s); return Range(snap.activeId, rg.r1, rg.c1, rg.r2, rg.c2); },
    toast: (m) => sink.logs.push('toast: ' + String(m)),
  });
  const Ui = () => ({ createMenu: (name) => { const items = []; const b = { addItem: (label, fn) => { items.push({ label: String(label), fn: String(fn) }); return b; }, addSeparator: () => { items.push('sep'); return b; }, addToUi: () => sink.menus.push({ name: String(name), items }) }; return b; }, alert: (m) => sink.logs.push('alert: ' + String(m)) });
  const SpreadsheetApp = { getActiveSpreadsheet: Spreadsheet, getActive: Spreadsheet, getActiveSheet: () => Sheet(snap.activeId), getUi: Ui, flush: () => {} };
  const Logger = { log: (...a) => sink.logs.push(a.map(fmt).join(' ')) };
  const console = { log: (...a) => sink.logs.push(a.map(fmt).join(' ')), warn: (...a) => sink.logs.push('⚠ ' + a.map(fmt).join(' ')), error: (...a) => sink.logs.push('✕ ' + a.map(fmt).join(' ')) };
  const Utilities = { getUuid: () => 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)), sleep: () => {}, formatString: (t, ...a) => { let i = 0; return String(t).replace(/%s/g, () => String(a[i++])); } };
  return { SpreadsheetApp, Logger, console, Utilities };
}

// Replay a worker op-log onto the live engine (main thread).
export function applyOps(engine, ops) {
  const batch = {};
  for (const o of ops) {
    if (o.op === 'setRaw') { (batch[o.sid] = batch[o.sid] || []).push({ r: o.r, c: o.c, raw: o.raw }); }
    else if (o.op === 'setStyle') { const sh = engine.wb.sheets.find((s) => s.id === o.sid); if (sh) sh.setStyle(o.r, o.c, o.patch); }
    else if (o.op === 'setFormat') { const sh = engine.wb.sheets.find((s) => s.id === o.sid); if (sh) sh.setFormat(o.r, o.c, o.nf); }
  }
  for (const sid of Object.keys(batch)) engine.setCellsBatch(sid, batch[sid]);
}
