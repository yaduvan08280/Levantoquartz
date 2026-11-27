// ============================================================
//  Mono — Unified import IR ("SheetImage")  [Unified Import v1]
//  ------------------------------------------------------------
//  Every importer (Google Sheets, CSV, XLSX) produces ONE shape:
//  a SheetImage. The rest of the pipeline (fresh replace, merge,
//  structural sync, dashboard) only ever speaks SheetImage — so
//  there is a single code path regardless of where data came from.
//
//  SheetImage = {
//    schema: 3,
//    source: { kind:'gsheet'|'csv'|'xlsx', name, id?, url? },
//    sheets: [ ImageSheet ],
//    timestamp
//  }
//
//  ImageSheet = {
//    name, index, hidden, tabColor,
//    rows, cols,
//    frozen:      { rows, cols },
//    merges:      [ {r1,c1,r2,c2} ],
//    hiddenRows:  [ r ],  hiddenCols: [ c ],
//    colWidths:   { [c]: px },  rowHeights: { [r]: px },
//    colMeta:     [ { id, header } ],   // per-column stable identity
//    validations: [ {r1,c1,r2,c2, kind, values, allowInvalid} ],
//    conditionalFormats: [ {r1,c1,r2,c2, type, ...rule, style} ],
//    cells:       { "r,c": Cell }
//  }
//
//  Cell = { raw?, dv?, st?, nf?, note? }
//    raw : formula (leading '=') or literal value, as a string
//    dv  : display value the source computed for a formula (optional)
//    nf  : number format string
//    st  : style object (see STYLE_KEYS)
//    note: plain-text note
//
//  Style keys (compact so the cell store stays small):
//    b  bold          i  italic        u  underline     s  strikethrough
//    fg font colour   bg background    ff font family   fs font size (pt)
//    ha halign left|center|right   va valign top|middle|bottom  wrap 0|1
//    bd borders { t?, r?, b?, l? }  each { style, color }
// ============================================================
import { MonoWorkbook, MonoSheet } from '../model/workbook.js';
import { CellStore } from '../model/columnStore.js';

export const IMAGE_SCHEMA = 3;
// 'fc' is the OLD name for font colour. The app has always called it 'fg'
// (grid applyColor, scripts setFontColor, conditional-format rules), so the
// importer wrote a key nothing rendered. Both are listed: 'fg' is what is
// written now, 'fc' so normStyle does not strip it out of already-saved
// workbooks before grid.js can heal them.
export const STYLE_KEYS = ['b', 'i', 'u', 's', 'fg', 'fc', 'bg', 'ff', 'fs', 'ha', 'va', 'wrap', 'bd'];

/* ---------- constructors ---------- */
export function emptyImage(source = {}) {
  return { schema: IMAGE_SCHEMA, source: { kind: source.kind || 'unknown', name: source.name || '', ...source }, sheets: [], timestamp: new Date().toISOString() };
}

export function emptySheetImage(name, index = 0) {
  return {
    name: name || ('Sheet' + (index + 1)), index, hidden: false, tabColor: null,
    rows: 50, cols: 26,
    frozen: { rows: 0, cols: 0 },
    merges: [], hiddenRows: [], hiddenCols: [],
    colWidths: {}, rowHeights: {},
    colMeta: [], validations: [], conditionalFormats: [],
    cells: {},
  };
}

/* ---------- style normalisation ---------- */
// Strip a style object down to only the meaningful keys with truthy values.
// Keeps the cell store lean and makes cell-equality comparisons cheap.
export function normStyle(st) {
  if (!st || typeof st !== 'object') return null;
  const out = {};
  for (const k of STYLE_KEYS) {
    const v = st[k];
    if (v == null || v === '' || v === false || v === 0) continue;
    if (k === 'bd') {
      const bd = normBorders(v);
      if (bd) out.bd = bd;
    } else {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

function normBorders(bd) {
  if (!bd || typeof bd !== 'object') return null;
  const out = {};
  for (const side of ['t', 'r', 'b', 'l']) {
    const e = bd[side];
    if (!e) continue;
    if (typeof e === 'string') { out[side] = { style: e }; continue; }
    const style = e.style || 'solid';
    const color = e.color || '#000000';
    if (style && style !== 'none') out[side] = { style, color };
  }
  return Object.keys(out).length ? out : null;
}

// Build a lean Cell, dropping empty pieces. Returns null if nothing meaningful.
export function normCellImage(src) {
  if (!src) return null;
  const cell = {};
  if (src.raw != null && src.raw !== '') cell.raw = String(src.raw);
  if (src.dv != null && src.dv !== '') cell.dv = String(src.dv);
  const st = normStyle(src.st);
  if (st) cell.st = st;
  if (src.nf && src.nf !== 'General' && src.nf !== '@') cell.nf = src.nf;
  if (src.note) cell.note = String(src.note);
  if (cell.raw != null || cell.st || cell.nf || cell.note) return cell;
  return null;
}

/* ---------- IR -> MonoSheet ---------- */
// Convert one ImageSheet into a MonoSheet (fresh — used on first import/replace).
export function imageSheetToMonoSheet(imgSheet) {
  let cells;
  if (imgSheet.cells instanceof CellStore) {
    // Streaming import already normalised each cell as it arrived and built
    // the store directly. Pass it straight to MonoSheet, which adopts it.
    cells = imgSheet.cells;
  } else {
    cells = {};
    for (const k of Object.keys(imgSheet.cells || {})) {
      const c = normCellImage(imgSheet.cells[k]);
      if (c) {
        // Persist only what the model stores on a cell: raw/st/nf/note (dv is a
        // source hint, recomputed locally by the engine so we don't keep it).
        const { dv, ...keep } = c; // eslint-disable-line no-unused-vars
        cells[k] = keep;
      }
    }
  }
  const sh = new MonoSheet({
    name: imgSheet.name,
    hidden: imgSheet.hidden,
    tabColor: imgSheet.tabColor,
    rows: Math.max(imgSheet.rows || 50, 1),
    cols: Math.max(imgSheet.cols || 26, 1),
    cells,
    frozen: imgSheet.frozen || { rows: 0, cols: 0 },
    merges: (imgSheet.merges || []).map((m) => ({ ...m })),
    hiddenRows: [...(imgSheet.hiddenRows || [])],
    hiddenCols: [...(imgSheet.hiddenCols || [])],
    colWidths: { ...(imgSheet.colWidths || {}) },
    rowHeights: { ...(imgSheet.rowHeights || {}) },
    validations: (imgSheet.validations || []).map((v) => ({ ...v })),
    conditionalFormats: (imgSheet.conditionalFormats || []).map((c) => ({ ...c })),
    colMeta: (imgSheet.colMeta || []).map((m) => (m ? { ...m } : null)),
  });
  return sh;
}

// Convert a whole SheetImage into a fresh MonoWorkbook (replace mode).
export function imageToWorkbook(image, name) {
  const sheets = (image.sheets || []).map((s) => imageSheetToMonoSheet(s));
  if (!sheets.length) sheets.push(new MonoSheet({ name: 'Sheet1' }));
  return new MonoWorkbook({ name: name || image.source?.name || 'Imported workbook', sheets });
}

/* ---------- IR helpers ---------- */
// Flatten an ImageSheet.cells map into { "sheetName!r,c": Cell } across the image.
export function imageToCellMap(image) {
  const out = {};
  for (const s of image.sheets || []) {
    for (const k of Object.keys(s.cells || {})) {
      const c = normCellImage(s.cells[k]);
      if (c) out[s.name + '!' + k] = c;
    }
  }
  return out;
}

// Last used (row,col) in an ImageSheet.cells map — for sizing / column diffing.
export function imageSheetExtent(imgSheet) {
  let lastR = -1, lastC = -1;
  for (const k of Object.keys(imgSheet.cells || {})) {
    const [r, c] = k.split(',').map(Number);
    if (r > lastR) lastR = r;
    if (c > lastC) lastC = c;
  }
  // colMeta may extend past the last non-empty cell (header-only columns)
  if ((imgSheet.colMeta || []).length - 1 > lastC) lastC = imgSheet.colMeta.length - 1;
  return { rows: lastR + 1, cols: lastC + 1 };
}

