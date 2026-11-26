// ============================================================
//  Mono — Unified import engine  [Unified Import v1]  ── PUBLIC API
//  ------------------------------------------------------------
//  ONE entry point for every kind of import in the whole app:
//    • Google Sheets   (live, pull-only, structure-aware sync)
//    • CSV / TSV        (direct upload)
//    • XLSX             (direct upload, full fidelity)
//
//  Everything is normalised to a SheetImage, then either turned
//  into a fresh workbook (open/replace) or merged into the live
//  workbook (sync). The dashboard reads the resulting MonoWorkbook
//  via data/monoSource.js — so Sheets AND Dashboard share this one
//  pipeline. No more divergent import paths.
// ============================================================
import { imageToWorkbook, imageSheetToMonoSheet } from './sheetImage.js';
import { fetchGoogleSheetImage } from './gsImporter.js';
import { csvToImage } from './csvImporter.js';
import { readXlsxImage } from './xlsxImporter.js';
import { reconcileColumns, shiftCellMapCols } from './structuralSync.js';
import { mergeCells, sheetToCellMap, applyMergeToSheet, fingerprintMap } from './mergeImage.js';
import { normalizeRules } from '../features/conditionalFormat.js';
import { normalizeValidations } from '../model/workbook.js';

/* ---------- source importers → SheetImage ---------- */
// opts: { onProgress({done,total,phase,sheet}), concurrency, direct } — the
// Google pull is chunked, so a big workbook arrives over many requests.
export async function importGoogleSheetImage(execUrl, fetchImpl, opts) {
  return fetchGoogleSheetImage(execUrl, fetchImpl || fetch, opts || {});
}

// file: a File/Blob (browser). Detects CSV vs XLSX by name/magic.
export async function importFileImage(file) {
  const name = file.name || 'import';
  if (/\.xlsx$/i.test(name) || /\.xlsm$/i.test(name)) {
    const buf = await file.arrayBuffer();
    return readXlsxImage(buf, name);
  }
  if (/\.(csv|tsv|txt)$/i.test(name)) {
    const text = await file.text();
    return csvToImage(text, name);
  }
  // Fallback: sniff for the ZIP signature (PK) → treat as xlsx.
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return readXlsxImage(await file.arrayBuffer(), name);
  return csvToImage(await file.text(), name);
}

/* ---------- fresh open / replace ---------- */
export function workbookFromImage(image, name) {
  return imageToWorkbook(image, name);
}

// Append every sheet of an image into an existing workbook (used for CSV/XLSX
// "open" so the user keeps their current sheets). Returns the new sheet ids.
export function appendImageSheets(wb, image) {
  const ids = [];
  for (const imgSheet of image.sheets || []) {
    const sh = imageSheetToMonoSheet(imgSheet);
    // avoid name collisions
    let base = sh.name, i = 1;
    while (wb.sheets.some((x) => x.name === sh.name)) sh.name = base + ' (' + (++i) + ')';
    wb.sheets.push(sh);
    ids.push(sh.id);
  }
  if (ids.length) wb.activeSheetId = ids[ids.length - 1];
  return ids;
}

/* ---------- live sync (pull-only, structure-aware) ---------- */
// Sync a remote SheetImage into the live workbook.
//   wb      : MonoWorkbook
//   engine  : Engine (for structural insert/delete + formula transposition)
//   image   : fresh SheetImage from Google
//   base    : { [sheetName]: { "r,c": fingerprint } }  last-synced remote
//             snapshot. Fingerprints, not cells: base is only ever compared
//             for equality, and at two lakh rows the full-cell version was
//             hundreds of MB that no browser would store.
// Returns { base: newBase, stats, structural }.
//   opts.adopt : the caller already streamed the cells into the workbook as
//                they arrived (progressive load), so skip the cell merge and
//                just record the base and apply formatting. Without this the
//                final pass would rewrite every cell it had just been given.
export function syncImageIntoWorkbook(wb, engine, image, base, opts) {
  base = base || {};
  const adopt = !!(opts && opts.adopt);
  const newBase = {};
  const totals = { updated: 0, added: 0, cleared: 0, protected: 0, untouched: 0 };
  const structural = [];

  for (const imgSheet of image.sheets || []) {
    let sh = wb.sheets.find((s) => s.name === imgSheet.name);
    const isNew = !sh;
    if (!sh) {
      // brand-new remote sheet → materialise it wholesale
      sh = imageSheetToMonoSheet(imgSheet);
      wb.sheets.push(sh);
    }

    // No defensive clone: mergeCells never mutates `remote`, and copying a
    // multi-million-cell map here just to throw it away doubled peak memory.
    const remoteMap = imgSheet.cells || {};

    if (isNew || adopt) {
      newBase[imgSheet.name] = fingerprintMap(remoteMap);
      applySheetMeta(sh, imgSheet);
      if (adopt && !isNew) sh.colMeta = (imgSheet.colMeta || []).map((m) => (m ? { ...m } : null));
      continue;
    }

    // 1) Reconcile column structure: replay remote inserts/deletes locally so
    //    the user's own columns shift and their formulas auto-adjust.
    const { ops } = reconcileColumns(engine, sh.id, imgSheet.colMeta);
    if (ops.length) structural.push({ sheet: imgSheet.name, ops });

    // 2) Bring the stored base into the new column layout too, so the merge
    //    stays coordinate-accurate after the structural shift.
    let baseMap = base[imgSheet.name] || {};
    if (ops.length) baseMap = shiftCellMapCols(baseMap, ops);

    // 3) Pull-only anti-clobber cell merge.
    const localMap = sheetToCellMap(sh);
    const result = mergeCells(baseMap, localMap, remoteMap);
    applyMergeToSheet(sh, result);
    for (const k in totals) totals[k] += result.stats[k] || 0;

    // 4) Format-level metadata is remote-driven (source of truth for formatting).
    applySheetMeta(sh, imgSheet);
    sh.colMeta = imgSheet.colMeta.map((m) => (m ? { ...m } : null));

    newBase[imgSheet.name] = fingerprintMap(remoteMap);
  }

  // Local-only sheets (the user's own tabs not in Google) are preserved as-is;
  // keep their previous base entry so a later re-add doesn't nuke them.
  for (const name of Object.keys(base)) if (!(name in newBase) && wb.sheets.some((s) => s.name === name)) newBase[name] = base[name];

  return { base: newBase, stats: totals, structural };
}

// Apply remote formatting/structure metadata to a local sheet (grow only —
// never shrink the grid below what the user already has).
function applySheetMeta(sh, imgSheet) {
  if (imgSheet.rows > sh.rows) sh.rows = imgSheet.rows;
  if (imgSheet.cols > sh.cols) sh.cols = imgSheet.cols;
  if (imgSheet.frozen) sh.frozen = { ...imgSheet.frozen };
  if (imgSheet.merges) sh.merges = imgSheet.merges.map((m) => ({ ...m }));
  if (imgSheet.hiddenRows) sh.hiddenRows = [...imgSheet.hiddenRows];
  if (imgSheet.hiddenCols) sh.hiddenCols = [...imgSheet.hiddenCols];
  if (imgSheet.colWidths) sh.colWidths = { ...imgSheet.colWidths };
  if (imgSheet.rowHeights) sh.rowHeights = { ...imgSheet.rowHeights };
  if (imgSheet.validations) sh.validations = normalizeValidations(imgSheet.validations);
  if (imgSheet.conditionalFormats) sh.conditionalFormats = normalizeRules(imgSheet.conditionalFormats);
  sh.hidden = !!imgSheet.hidden;
  if (imgSheet.tabColor) sh.tabColor = imgSheet.tabColor;
}

