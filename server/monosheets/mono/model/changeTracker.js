// ============================================================
//  Mono — change tracker (incremental save)
//  ------------------------------------------------------------
//  Saving used to serialise the WHOLE workbook every time: on a
//  two-lakh-row workbook that is ~100 MB of JSON and several seconds
//  of work to persist a single typed character.
//
//  This records WHICH cells changed since the last successful save,
//  so a routine save can send just those. It hangs off the same
//  MonoSheet._touch hook the undo journal uses, which means it sees
//  every mutation regardless of who made it — a user edit, a Google
//  sync, an AI patch, an undo — rather than only the paths someone
//  remembered to instrument.
//
//  What it deliberately does NOT try to be clever about:
//   - structural ops (insert/delete rows or columns) relabel the
//     whole cell map, so the sheet is flagged for a FULL save;
//   - adding, removing or reordering sheets flags the workbook;
//   - a change set past a sane size is not worth patching.
//  In each of those cases the caller falls back to a full save. A
//  patch is an optimisation; correctness never depends on it.
//
//  Sheet METADATA (frozen panes, merges, filters, widths...) is not
//  tracked here. None of it scales with cell count, so a patch simply
//  carries the whole of it for any sheet it touches — which also
//  covers code that writes `sheet.frozen = {...}` directly.
// ============================================================

// Shared through globalThis for the same reason the undo journal is: if this
// module were ever evaluated twice, two module-local copies would each track
// half the changes and saves would silently lose data.
const SLOT = '__monoChangeTracker';
const state = globalThis[SLOT] || (globalThis[SLOT] = { sheets: new Map(), full: false, on: true });

/** Cells beyond this in one save: just send the whole thing. */
export const PATCH_CELL_LIMIT = 200000;

export function trackCell(sid, k) {
  if (!state.on || state.full) return;
  let set = state.sheets.get(sid);
  if (set === 'full') return;      // whole sheet is going anyway (e.g. a row was inserted)
  if (!set) { set = new Set(); state.sheets.set(sid, set); }
  set.add(k);
}

/** A structural op relabels every cell below it — no patch can express that. */
export function trackSheetRebuilt(sid) {
  if (!state.on) return;
  state.sheets.set(sid, 'full');
}


/** Take the pending changes for ONE workbook's sheets and start collecting
 *  fresh ones. Scoping by sheet id matters: the tracker is global, so a
 *  workbook-wide take() would swallow another open workbook's pending edits
 *  and drop them when this save succeeded.
 *
 *  The caller must hand the result back with `restore()` if the save does not
 *  land, otherwise the edits it describes would never be written. */
export function take(sheetIds) {
  const taken = { sheets: new Map(), full: state.full };
  if (!sheetIds) {
    taken.sheets = state.sheets;
    state.sheets = new Map();
  } else {
    const want = new Set(sheetIds);
    for (const [sid, set] of state.sheets) {
      if (!want.has(sid)) continue;
      taken.sheets.set(sid, set);
      state.sheets.delete(sid);
    }
  }
  state.full = false;
  return taken;
}

/** Forget pending changes for these sheets. Used when a workbook is replaced
 *  wholesale (reload, import): its old pending edits are meaningless, but
 *  other open workbooks must keep theirs. */
export function dropSheets(sheetIds) {
  for (const sid of sheetIds || []) state.sheets.delete(sid);
}

/** Put an un-saved change set back, merged with anything since. */
export function restore(taken) {
  if (!taken) return;
  if (taken.full) state.full = true;
  for (const [sid, set] of taken.sheets) {
    const cur = state.sheets.get(sid);
    if (cur === 'full' || set === 'full') { state.sheets.set(sid, 'full'); continue; }
    if (!cur) { state.sheets.set(sid, set); continue; }
    for (const k of set) cur.add(k);
  }
}

/** The edits not sent yet, read-only: Map(sid -> Set|'full'). Live
 *  collaboration uses it to leave those cells alone when someone else's
 *  older write to them arrives. */
export function pending() { return state.sheets; }

/** Forget everything (after a full save, or when a workbook is replaced). */
export function reset() {
  state.sheets = new Map();
  state.full = false;
}

export function pendingCellCount() {
  let n = 0;
  for (const set of state.sheets.values()) { if (set === 'full') return Infinity; n += set.size; }
  return n;
}

export default { trackCell, trackSheetRebuilt, take, restore, reset, dropSheets, pending, pendingCellCount, PATCH_CELL_LIMIT };
