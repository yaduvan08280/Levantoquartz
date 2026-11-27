// ============================================================
//  Mono Sheets — data model (Phase 1 + 3)
//  Workbook → Sheets → sparse cell store. Phase 3 adds per-cell
//  style (st) + number format (nf), sheet conditional formats,
//  and workbook named ranges. No DOM here (worker-portable).
// ============================================================
export function colToLetters(c) { let s = ''; c++; while (c) { s = String.fromCharCode(65 + (c - 1) % 26) + s; c = Math.floor((c - 1) / 26); } return s; }
export function lettersToCol(s) { let c = 0; for (const ch of String(s).replace(/\$/g, '').toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; }
export function cellKey(r, c) { return r + ',' + c; }
export function addrToA1(r, c) { return colToLetters(c) + (r + 1); }

export function isNumericRaw(raw) { if (raw == null || raw === '') return false; const s = String(raw).replace(/[,%\s₹$€£]/g, ''); return s !== '' && !Number.isNaN(Number(s)); }
export function displayValue(raw) { return raw == null ? '' : String(raw); }

import { activeJournal, warnUnjournalled } from './undoJournal.js';
import { trackCell } from './changeTracker.js';
import { normalizeRules } from '../features/conditionalFormat.js';
import { CellStore } from './columnStore.js';

/* ---------- style palette ----------
   A fully bordered sheet repeats the SAME style object on every single cell.
   Stored inline that was ~558 MB of JSON for a two-lakh-row workbook - past
   V8's max string length, so the workbook could not even be serialised, let
   alone saved. Hoisting the unique styles into a table and referencing them by
   index cuts it to ~107 MB, which gzips to single-digit MB on the wire.

   Interning on load is the other half: every cell sharing a style shares ONE
   object in memory instead of millions of copies. That is safe because styles
   are copy-on-write - MonoSheet.setStyle always builds a new object rather
   than writing into the existing one. */
const BORDER_SIDES = ['t', 'r', 'b', 'l'];

export function styleSignature(st) {
  if (!st) return '';
  let s = '';
  for (const k of Object.keys(st).sort()) {
    const v = st[k];
    if (v == null || v === '' || v === false || v === 0) continue;
    if (k === 'bd') {
      for (const side of BORDER_SIDES) {
        const e = v[side];
        if (e) s += '|bd' + side + ':' + (e.style || '') + ',' + (e.color || '');
      }
      continue;
    }
    s += '|' + k + ':' + v;
  }
  return s;
}

/* ---------- Sheet ---------- */
export class MonoSheet {
  constructor({ id, name, rows = 50, cols = 26, cells, styles, conditionalFormats, frozen, merges, validations, filter, hiddenRows, hiddenCols, protectedRanges, showFormulas, gridlines, zoom, colWidths, rowHeights, views, colTypes, rowIdMap, hidden, colMeta, tabColor } = {}) {
    this.id = id || ('sh_' + Math.random().toString(36).slice(2, 8));
    this.name = name || 'Sheet1';
    // Sheet-level visibility (Google Sheets "Hide sheet"): a hidden tab still
    // imports fully — it just renders collapsed/greyed rather than being dropped.
    this.hidden = !!hidden;
    // Tab colour (right-click tab → Change colour). Cosmetic, carried for parity.
    this.tabColor = tabColor || null;
    this.rows = rows; this.cols = cols;
    // CellStore is Map-shaped but switches to tiled typed arrays past
    // 200k entries: 9 B/cell instead of ~146, measured. Below that it wraps
    // a real Map, so small workbooks behave exactly as before.
    this.cells = new CellStore();        // "r,c" -> { raw?, st?, nf?, note?, cm? }
    // A caller that already built a CellStore hands it over as-is. The
    // streaming importer does: materialising its cells into a plain object
    // just so this constructor can loop Object.keys() back out of it is two
    // full copies of the sheet, and at 10 crore the plain object alone does
    // not finish. Style interning is the streamer's job in that case.
    if (cells instanceof CellStore) this.cells = cells;
    else if (cells) {
      // `styles` is the palette written by toJSON(); cells reference it as
      // `s: <index>`. Older saves carry an inline `st` instead - those are
      // interned here too, so an existing workbook also collapses to shared
      // style objects the first time it is loaded.
      const palette = Array.isArray(styles) ? styles : null;
      const pool = new Map();
      for (const k of Object.keys(cells)) {
        const v = cells[k];
        if (!v) continue;
        if (palette && v.s !== undefined) {
          const st = palette[v.s];
          delete v.s;
          if (st) v.st = st;              // palette entries are already shared
        } else if (v.st) {
          const sig = styleSignature(v.st);
          const canon = pool.get(sig);
          if (canon) v.st = canon; else pool.set(sig, v.st);
        }
        this.cells.set(k, v);
      }
    }
    // Normalised on the way in, so a workbook ALREADY saved with an imported
    // rule (flat r1/c1/r2/c2, no cond) heals itself on load instead of
    // crashing the grid render.
    this.conditionalFormats = normalizeRules(conditionalFormats);   // [{range,cond,style}]
    this.frozen = frozen || { rows: 0, cols: 0 };
    this.merges = merges || [];
    this.validations = normalizeValidations(validations);  // [{range,kind,values?}]
    this.filter = filter || null;          // {range,cols:{c:{hidden:[]}}}
    // Google-Sheets-parity additions (View/Format/Data/Insert menu equivalents):
    this.hiddenRows = hiddenRows || [];          // number[]
    this.hiddenCols = hiddenCols || [];          // number[]
    this.protectedRanges = protectedRanges || []; // [{r1,c1,r2,c2,reason?}]
    this.showFormulas = !!showFormulas;           // View → Show formulas [Ctrl+`]
    this.gridlines = gridlines !== false;         // View → Gridlines (default on)
    this.zoom = zoom || 100;                      // View → Zoom (%)
    // Mouse-driven column width / row height resize (right-click header →
    // Resize column/row, or drag the header's edge handle in grid.js).
    // Sparse: only columns/rows the user actually resized get an entry —
    // everything else keeps using the DEFAULT_COL_W/DEFAULT_ROW_H fallback.
    this.colWidths = colWidths ? { ...colWidths } : {};   // { [colIndex]: px }
    this.rowHeights = rowHeights ? { ...rowHeights } : {}; // { [rowIndex]: px }
    // P8 — View Layer: named view specs (grid/kanban/calendar/gallery/form/gantt/map)
    // Shape: { id, kind, name, config: { filters, sorts, groupBy, hiddenCols, rowHeight, ... } }
    // @see ROADMAP_P8_P19.md "ViewSpec Shape"
    this.views = views ? views.map((v) => ({ ...v })) : [];
    // P10 — Rich Cell Types: sparse map of column index → cellTypeId string.
    // Absent means default inferred behaviour (no declared type).
    this.colTypes = colTypes ? { ...colTypes } : {};     // { [colIndex]: cellTypeId }
    // P10 — Stable row identity: sparse map of physical row index → stable UUID.
    // Populated lazily on first access via rowId.js.
    this.rowIdMap = rowIdMap ? { ...rowIdMap } : {};     // { [rowIndex]: uuid }
    // Import/Sync — per-column stable identity for shift-resilient sync.
    // colMeta[c] = { id, header } where `id` comes from Google Sheets developer
    // metadata (survives column insert/move/delete) or, for CSV/XLSX, a hash of
    // the header. Used by structuralSync to detect inserts vs. edits so a column
    // added remotely shifts local data + formulas instead of clobbering them.
    this.colMeta = Array.isArray(colMeta) ? colMeta.map((m) => (m ? { ...m } : null)) : [];
  }
  getColMeta(c) { return this.colMeta[c] || null; }
  setColMeta(c, meta) { this.colMeta[c] = meta ? { ...meta } : null; }
  getColWidth(c) { const w = this.colWidths[c]; return w > 0 ? w : MonoSheet.DEFAULT_COL_W; }
  setColWidth(c, px) { const w = Math.max(24, Math.round(px)); if (w === MonoSheet.DEFAULT_COL_W) delete this.colWidths[c]; else this.colWidths[c] = w; }
  getRowHeight(r) { const h = this.rowHeights[r]; return h > 0 ? h : MonoSheet.DEFAULT_ROW_H; }
  setRowHeight(r, px) { const h = Math.max(16, Math.round(px)); if (h === MonoSheet.DEFAULT_ROW_H) delete this.rowHeights[r]; else this.rowHeights[r] = h; }
  _cell(k) { return this.cells.get(k); }
  // Every cell write funnels through here so delta undo can record the
  // previous value. One hook instead of instrumenting each mutator, and the
  // journal keeps only the FIRST value per cell per transaction.
  _touch(k) {
    const j = activeJournal();
    if (j && j.open) j.recordCell(this.id, k, this.cells.get(k));
    else warnUnjournalled(this.id, k);
    trackCell(this.id, k);   // and remember it for the next incremental save
  }
  // Writes the cell back, or drops it when nothing is left on it. The
  // write-back matters because cells is a CellStore, not a Map: a tiled
  // numeric cell is decoded into a FRESH object on get(), so mutating the
  // result is silently lost unless it is set() again. Every mutator below
  // either ends here or does its own set().
  _clean(k, cell) {
    if (!cell) return;
    if (!cell.raw && !cell.st && !cell.nf && !cell.note && !cell.cm) this.cells.delete(k);
    else this.cells.set(k, cell);
  }
  _grow(r, c) { if (r + 1 > this.rows) this.rows = r + 1; if (c + 1 > this.cols) this.cols = c + 1; }

  getRaw(r, c) { return this.cells.get(cellKey(r, c))?.raw ?? ''; }
  setRaw(r, c, raw) {
    const k = cellKey(r, c); this._touch(k); let cell = this.cells.get(k);
    if (raw === '' || raw == null) { if (cell) { delete cell.raw; this._clean(k, cell); } }
    else if (cell) { cell.raw = String(raw); this.cells.set(k, cell); }
    else this.cells.set(k, { raw: String(raw) });
    this._grow(r, c);
  }
  getStyle(r, c) { return this.cells.get(cellKey(r, c))?.st || null; }
  setStyle(r, c, patch) {
    const k = cellKey(r, c); this._touch(k); let cell = this.cells.get(k);
    if (!cell) { if (patch == null) return; cell = {}; this.cells.set(k, cell); }
    if (patch === null) delete cell.st;
    else { cell.st = Object.assign({}, cell.st, patch); for (const kk of Object.keys(cell.st)) { const v = cell.st[kk]; if (v === null || v === false || v === '' || v === undefined) delete cell.st[kk]; } if (!Object.keys(cell.st).length) delete cell.st; }
    this._clean(k, cell); this._grow(r, c);
  }
  getFormat(r, c) { return this.cells.get(cellKey(r, c))?.nf || null; }
  setFormat(r, c, nf) {
    const k = cellKey(r, c); this._touch(k); let cell = this.cells.get(k);
    if (!cell) { if (!nf) return; cell = {}; this.cells.set(k, cell); }
    if (nf) cell.nf = nf; else delete cell.nf;
    this._clean(k, cell); this._grow(r, c);
  }
  getCellObj(r, c) { const x = this.cells.get(cellKey(r, c)); return x ? { ...x } : null; }
  setCellObj(r, c, obj) { const k = cellKey(r, c); this._touch(k); if (!obj || (!obj.raw && !obj.st && !obj.nf && !obj.note && !obj.cm)) this.cells.delete(k); else this.cells.set(k, { ...obj }); this._grow(r, c); }

  // Note [Shift+F2] — a single private plain-text annotation on a cell.
  getNote(r, c) { return this.cells.get(cellKey(r, c))?.note || ''; }
  setNote(r, c, text) {
    const k = cellKey(r, c); this._touch(k); let cell = this.cells.get(k);
    if (!text) { if (cell) { delete cell.note; this._clean(k, cell); } return; }
    if (!cell) cell = {};
    cell.note = String(text); this.cells.set(k, cell); this._grow(r, c);
  }
  // Comment [Ctrl+Alt+M] — a small discussion thread (array of {text, ts}),
  // distinct from a Note: comments are meant to be an ongoing conversation.
  getComments(r, c) { return this.cells.get(cellKey(r, c))?.cm || []; }
  addComment(r, c, text) {
    const k = cellKey(r, c); this._touch(k); let cell = this.cells.get(k); if (!cell) { cell = {}; this.cells.set(k, cell); }
    cell.cm = cell.cm || []; cell.cm.push({ text: String(text), ts: Date.now() });
    this.cells.set(k, cell); this._grow(r, c);
  }
  clearComments(r, c) { const k = cellKey(r, c); this._touch(k); const cell = this.cells.get(k); if (cell) { delete cell.cm; this._clean(k, cell); } }
  clearNotesAndComments(r, c) { const k = cellKey(r, c); this._touch(k); const cell = this.cells.get(k); if (cell) { delete cell.note; delete cell.cm; this._clean(k, cell); } }

  // Hide/show rows+cols (View → Hide / Show).
  isRowHidden(r) { return this.hiddenRows.includes(r); }
  isColHidden(c) { return this.hiddenCols.includes(c); }
  hideRows(list) { const s = new Set(this.hiddenRows); for (const r of list) s.add(r); this.hiddenRows = [...s].sort((a, b) => a - b); }
  hideCols(list) { const s = new Set(this.hiddenCols); for (const c of list) s.add(c); this.hiddenCols = [...s].sort((a, b) => a - b); }
  showRows(list) { const rm = new Set(list); this.hiddenRows = this.hiddenRows.filter((r) => !rm.has(r)); }
  showCols(list) { const rm = new Set(list); this.hiddenCols = this.hiddenCols.filter((c) => !rm.has(c)); }
  showAllRows() { this.hiddenRows = []; }
  showAllCols() { this.hiddenCols = []; }

  // Protected ranges (Data → Protected ranges / Tools → Protect sheet-range).
  // Single-user local app: "protect" blocks edits until explicitly unprotected
  // rather than modelling collaborator permissions.
  isProtected(r, c) { return this.protectedRanges.some((p) => r >= p.r1 && r <= p.r2 && c >= p.c1 && c <= p.c2); }
  protectRange(range, reason) { this.protectedRanges.push({ ...range, reason: reason || '' }); }
  unprotectAt(r, c) { this.protectedRanges = this.protectedRanges.filter((p) => !(r >= p.r1 && r <= p.r2 && c >= p.c1 && c <= p.c2)); }

  addRows(n = 20) { this.rows += n; }
  addCols(n = 1) { this.cols += n; }
  toJSON() {
    // Hoist styles into a palette (see "style palette" above). Interning on
    // load means the byRef map almost always hits, so this stays O(1) per cell
    // rather than re-hashing a style object millions of times.
    const styles = [];
    const byRef = new Map();
    const bySig = new Map();
    const cells = {};
    for (const [k, v] of this.cells) {
      const st = v.st;
      if (!st) { cells[k] = v; continue; }
      let i = byRef.get(st);
      if (i === undefined) {
        const sig = styleSignature(st);
        i = bySig.get(sig);
        if (i === undefined) { i = styles.length; styles.push(st); bySig.set(sig, i); }
        byRef.set(st, i);
      }
      const out = { s: i };
      if (v.raw !== undefined) out.raw = v.raw;
      if (v.nf !== undefined) out.nf = v.nf;
      if (v.note !== undefined) out.note = v.note;
      if (v.cm !== undefined) out.cm = v.cm;
      cells[k] = out;
    }
    return { id: this.id, name: this.name, hidden: this.hidden, tabColor: this.tabColor, rows: this.rows, cols: this.cols, cells, styles, conditionalFormats: this.conditionalFormats, frozen: this.frozen, merges: this.merges, validations: this.validations, filter: this.filter, hiddenRows: this.hiddenRows, hiddenCols: this.hiddenCols, protectedRanges: this.protectedRanges, showFormulas: this.showFormulas, gridlines: this.gridlines, zoom: this.zoom, colWidths: this.colWidths, rowHeights: this.rowHeights, views: this.views.map((v) => ({ ...v })), colTypes: { ...this.colTypes }, rowIdMap: { ...this.rowIdMap }, colMeta: this.colMeta.map((m) => (m ? { ...m } : null)) };
  }
}
MonoSheet.DEFAULT_COL_W = 92;
MonoSheet.DEFAULT_ROW_H = 30;

/* ---------- validations ----------
   Exactly the same trap as conditional formats: the UI writes
   { range:{r1,c1,r2,c2}, kind, values } while EVERY importer writes the range
   flat. The grid reads `v.range.r1`, so one imported dropdown crashed the
   render of the whole sheet - and with it the app, which sat on
   "Loading workbook..." forever because build() never got to replace the
   spinner. Coerced here, at the one boundary every workbook passes through. */
export function normalizeValidations(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    let range = v.range;
    if (!range || range.r1 == null) {
      if (v.r1 == null || v.c1 == null) continue;        // cannot be placed
      range = { r1: v.r1, c1: v.c1, r2: v.r2 ?? v.r1, c2: v.c2 ?? v.c1 };
    }
    const n = { ...v, range };
    delete n.r1; delete n.c1; delete n.r2; delete n.c2;
    out.push(n);
  }
  return out;
}

/* ---------- canonical form (undo verification) ----------
   Two workbooks can hold identical data yet serialise differently, because a
   Map remembers insertion order: undoing a row delete puts the rows back at
   the END of the cell map rather than in the middle. Nothing reads cells in
   order, so that is cosmetic - but it means toJSON() is the wrong yardstick
   for "did undo restore the previous state". This produces a form that
   depends only on MEANING: cells sorted by coordinate, styles compared by
   signature rather than by palette index. */
export function canonicalJson(wb) {
  const sheets = (wb.sheets || []).map((sh) => {
    const keys = [...sh.cells.keys()].sort((a, b) => {
      const ai = a.indexOf(','), bi = b.indexOf(',');
      return (+a.slice(0, ai) - +b.slice(0, bi)) || (+a.slice(ai + 1) - +b.slice(bi + 1));
    });
    const cells = keys.map((k) => {
      const v = sh.cells.get(k) || {};
      return [k, v.raw ?? null, v.nf ?? null, v.note ?? null, v.cm ?? null, v.st ? styleSignature(v.st) : null];
    });
    const meta = {};
    for (const key of CANON_META) meta[key] = sh[key] ?? null;
    return { id: sh.id, meta, cells };
  });
  return JSON.stringify({ name: wb.name, activeSheetId: wb.activeSheetId, namedRanges: wb.namedRanges || {}, sheets });
}

const CANON_META = [
  'name', 'hidden', 'tabColor', 'rows', 'cols',
  'frozen', 'merges', 'validations', 'filter', 'conditionalFormats',
  'hiddenRows', 'hiddenCols', 'protectedRanges',
  'showFormulas', 'gridlines', 'zoom',
  'colWidths', 'rowHeights', 'views', 'colTypes', 'colMeta', 'rowIdMap',
];

/* ---------- Workbook ---------- */
export class MonoWorkbook {
  constructor({ id, name, sheets, activeSheetId, namedRanges, scripts, aiLog } = {}) {
    this.schema = 2;
    this.id = id || ('wb_' + Math.random().toString(36).slice(2, 8));
    this.name = name || 'Untitled workbook';
    this.sheets = (sheets && sheets.length) ? sheets.map((s) => (s instanceof MonoSheet ? s : new MonoSheet(s))) : [new MonoSheet({ name: 'Sheet1' })];
    this.activeSheetId = activeSheetId && this.sheets.some((s) => s.id === activeSheetId) ? activeSheetId : this.sheets[0].id;
    this.namedRanges = namedRanges || {};   // name -> { sid, r1, c1, r2, c2 }
    this.scripts = scripts || { files: [], props: { script: {}, document: {} } };
    this.aiLog = aiLog || [];
  }
  get active() { return this.sheets.find((s) => s.id === this.activeSheetId) || this.sheets[0]; }
  setActive(id) { if (this.sheets.some((s) => s.id === id)) this.activeSheetId = id; }
  addSheet(name) {
    const used = new Set(this.sheets.map((s) => s.name));
    let n = name || ('Sheet' + (this.sheets.length + 1)), i = this.sheets.length + 1;
    while (used.has(n)) n = 'Sheet' + (++i);
    const s = new MonoSheet({ name: n }); this.sheets.push(s); this.activeSheetId = s.id; return s;
  }
  removeSheet(id) { if (this.sheets.length <= 1) return false; this.sheets = this.sheets.filter((s) => s.id !== id); if (this.activeSheetId === id) this.activeSheetId = this.sheets[0].id; return true; }
  renameSheet(id, name) { const s = this.sheets.find((x) => x.id === id); if (s && name) s.name = name; }

  getNamedRange(name) { return this.namedRanges[String(name).toLowerCase()] || null; }
  addNamedRange(name, spec) { this.namedRanges[String(name).toLowerCase()] = spec; }
  removeNamedRange(name) { delete this.namedRanges[String(name).toLowerCase()]; }

  /** P8 — return the views array for a sheet, initialising it if absent */
  ensureViews(sheetId) {
    const sh = this.sheets.find((s) => s.id === sheetId);
    if (!sh) return [];
    if (!sh.views) sh.views = [];
    return sh.views;
  }

  toJSON() { return { schema: this.schema, id: this.id, name: this.name, activeSheetId: this.activeSheetId, namedRanges: this.namedRanges, scripts: this.scripts, aiLog: this.aiLog, sheets: this.sheets.map((s) => s.toJSON()) }; }
  static fromJSON(o) { if (!o) return new MonoWorkbook(); return new MonoWorkbook({ id: o.id, name: o.name, activeSheetId: o.activeSheetId, namedRanges: o.namedRanges, scripts: o.scripts, aiLog: o.aiLog, sheets: (o.sheets || []).map((s) => new MonoSheet(s)) }); }
}
export default MonoWorkbook;
