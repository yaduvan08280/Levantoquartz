// ============================================================
//  Mono — incremental save patch builder
//  ------------------------------------------------------------
//  Turns "what changed since the last save" into the smallest body
//  that will bring the server up to date.
//
//  A full save of a two-lakh-row workbook is ~100 MB of JSON and
//  several seconds of work, whether you typed one character or
//  rewrote everything. A patch carries the changed cells plus the
//  (small) metadata of the sheets it touches.
//
//  It refuses rather than guesses. Returning null means "no patch
//  describes this — send the whole workbook":
//    - the tracker lost confidence (sheets added/removed/reordered)
//    - a sheet was never seen before
//    - too many cells changed for a patch to be worth it
//  A structural op is a middle case: that ONE sheet goes whole,
//  while the rest of the workbook is still spared.
//
//  Cells in a patch carry their style INLINE rather than as a palette
//  index, because the server's stored palette belongs to the last
//  full save and a patch must not have to reason about it. MonoSheet
//  reads both forms, so a stored workbook may mix them; the next full
//  save re-packs everything into a palette.
// ============================================================
import { META_KEYS } from './undoJournal.js';
import { PATCH_CELL_LIMIT } from './changeTracker.js';

function metaOf(sh) {
  const out = {};
  for (const k of META_KEYS) out[k] = sh[k];
  return out;
}

/** Stable fingerprint of a sheet's non-cell state. Cheap: none of it scales
 *  with cell count. Used to notice a change no cell write would reveal, such
 *  as freezing a pane or hiding a column. */
export function metaFingerprint(sh) {
  return JSON.stringify(metaOf(sh));
}

export function metaFingerprints(wb) {
  const out = new Map();
  for (const sh of wb.sheets) out.set(sh.id, metaFingerprint(sh));
  return out;
}

/**
 * @param wb        MonoWorkbook
 * @param taken     the change set from changeTracker.take()
 * @param prevMeta  Map(sid -> fingerprint) from the last successful save
 * @param prevIds   sheet ids as of the last successful save
 * @param limit     cells beyond which a patch is not worth building
 * @returns {{patch, cells, replacedSheets}|null}  null => send everything
 */
export function buildWorkbookPatch(wb, taken, prevMeta, prevIds, limit = PATCH_CELL_LIMIT) {
  if (!taken || taken.full) return null;
  if (!prevMeta || !prevIds) return null;

  const ids = wb.sheets.map((s) => s.id);
  // Any change to which sheets exist, or their order, is a full save: the
  // patch format deliberately cannot express it.
  if (ids.length !== prevIds.length || ids.some((id, i) => id !== prevIds[i])) return null;

  const byId = new Map(wb.sheets.map((s) => [s.id, s]));
  const sheets = {};
  let cells = 0;
  let replacedSheets = 0;

  for (const [sid, set] of taken.sheets) {
    const sh = byId.get(sid);
    if (!sh) return null;                       // a sheet vanished mid-flight
    if (set === 'full') {
      // a structural op relabelled this sheet - send it whole, but only it
      sheets[sid] = { replace: sh.toJSON() };
      replacedSheets += 1;
      continue;
    }
    const out = {};
    for (const k of set) {
      const cell = sh.cells.get(k);
      out[k] = cell ? { ...cell } : null;       // null means "delete this cell"
      cells += 1;
      if (cells > limit) return null;
    }
    sheets[sid] = { cells: out, meta: metaOf(sh) };
  }

  // A sheet can change without any cell being touched - freezing a pane,
  // hiding a column, adding a conditional format. The fingerprint catches it.
  for (const sh of wb.sheets) {
    if (sheets[sh.id]) continue;
    if (metaFingerprint(sh) !== prevMeta.get(sh.id)) sheets[sh.id] = { meta: metaOf(sh) };
  }

  if (!Object.keys(sheets).length) {
    // nothing about the sheets moved; a name or selection change may still need saving
    return { patch: { sheets: {}, name: wb.name, activeSheetId: wb.activeSheetId, namedRanges: wb.namedRanges }, cells: 0, replacedSheets: 0 };
  }

  return {
    patch: { sheets, name: wb.name, activeSheetId: wb.activeSheetId, namedRanges: wb.namedRanges },
    cells,
    replacedSheets,
  };
}

