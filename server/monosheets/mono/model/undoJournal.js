// ============================================================
//  Mono — undo journal (delta undo)
//  ------------------------------------------------------------
//  Undo used to snapshot the WHOLE workbook on every mutation:
//      JSON.stringify(wb.toJSON())   x 60 deep
//  On a 155k-row sheet that is 80 MB and 4.2 SECONDS per keystroke,
//  and 4.7 GB of history — the cost of typing one character was the
//  size of the workbook, not the size of the edit.
//
//  This records how to REVERSE an operation instead.
//
//  The shape of the data is what makes it cheap. Of everything on a
//  sheet, only `cells` scales with cell count; frozen panes, merges,
//  validations, filters, conditional formats, column widths and the
//  rest are orders of magnitude smaller. So:
//
//    cells      -> journalled as deltas. MonoSheet's mutators record
//                  the previous value of each cell they touch, once
//                  per transaction. Typing in one cell costs ~100
//                  bytes regardless of how big the sheet is.
//    everything -> snapshotted wholesale at the start of the
//    else          transaction and kept only if it actually changed.
//                  Cheap because it does not scale with cells, and it
//                  means code that writes `sheet.frozen = {...}` or
//                  `sheet.conditionalFormats.push(...)` directly is
//                  covered without having to be rewritten.
//    structural -> insert/delete rows+cols rebuild the cell map
//                  wholesale, so they are recorded ANALYTICALLY: the
//                  inverse of "insert 3 rows at 5" is "shift back",
//                  no data needed. A delete also stores the band it
//                  removed, and any formula text that was rewritten
//                  is picked up by the ordinary cell journal.
//
//  A transaction is one user operation. `begin()` opens it, the
//  mutators record into it, `commit()` closes it and hands back an
//  inverse that `applyInverse()` can play onto the workbook.
//
//  CORRECTNESS: a missed hook does not throw — it silently makes one
//  operation un-undoable, which is the worst possible failure mode.
//  So `verify` mode keeps a real snapshot alongside the delta and
//  checks that applying the inverse reproduces it exactly, naming the
//  operation when it does not. See MonoGrid.verifyUndo.
// ============================================================

// Everything on a sheet EXCEPT `cells`. None of these scale with cell
// count, so snapshotting them per transaction is cheap.
export const META_KEYS = [
  'name', 'hidden', 'tabColor', 'rows', 'cols',
  'frozen', 'merges', 'validations', 'filter', 'conditionalFormats',
  'hiddenRows', 'hiddenCols', 'protectedRanges',
  'showFormulas', 'gridlines', 'zoom',
  'colWidths', 'rowHeights', 'views', 'colTypes', 'colMeta', 'rowIdMap',
];

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function snapshotMeta(sh) {
  const out = {};
  for (const k of META_KEYS) out[k] = clone(sh[k]);
  return out;
}

function sameMeta(a, b) {
  for (const k of META_KEYS) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

const cellKeyOf = (sid, k) => sid + '|' + k;

/* ---------- the active transaction ----------
   A module singleton rather than a reference threaded through every sheet:
   only one user operation is ever in flight, and it removes any chance of a
   sheet being constructed without its journal wired up (which would silently
   drop it out of undo). The grid sets this around its own transaction. */
// Held on globalThis, not in a module variable. If this module is ever
// evaluated twice (a cache-busting query string on one import is enough), two
// module-local copies would each have their own `_active`, the mutators would
// see null, and NOTHING would be journalled - undo would silently do nothing
// at all. A shared slot makes duplicate instances harmless.
const SLOT = '__monoUndoState';
const state = globalThis[SLOT] || (globalThis[SLOT] = { active: null, strict: false });

export function setActiveJournal(j) { state.active = j; }
export function activeJournal() { return state.active; }

/** Dev-only: complain the moment a cell is changed outside a transaction,
 *  because such a change is silently un-undoable. Off in production. */
export function setStrictJournal(on) { state.strict = !!on; }
export function warnUnjournalled(sid, k) {
  if (!state.strict) return;
  // eslint-disable-next-line no-console
  console.warn('[undo] cell ' + sid + '!' + k + ' changed outside a transaction - this edit cannot be undone', new Error().stack);
}

export class UndoJournal {
  constructor() {
    this.tx = null;
    this.depth = 0;
  }

  get open() { return this.tx !== null; }

  /** Open a transaction. Nested begins are ref-counted, not stacked. */
  begin(wb, label) {
    if (this.tx) { this.depth += 1; return this.tx; }
    this.depth = 1;
    this.tx = {
      label: label || '',
      meta: new Map(),          // sid -> meta snapshot taken BEFORE the op
      cells: new Map(),         // "sid|r,c" -> previous cell object (or null)
      struct: [],               // structural ops, in the order they happened
      sheetIds: wb.sheets.map((s) => s.id),
      activeSheetId: wb.activeSheetId,
      wbName: wb.name,
      namedRanges: clone(wb.namedRanges),
      removedSheets: [],        // { index, json } for sheets deleted in this tx
    };
    for (const sh of wb.sheets) this.tx.meta.set(sh.id, snapshotMeta(sh));
    return this.tx;
  }

  /** Record a cell's value BEFORE it is changed. First write in a
   *  transaction wins — later ones are already covered by it. */
  recordCell(sid, k, before) {
    if (!this.tx) return;
    const key = cellKeyOf(sid, k);
    if (this.tx.cells.has(key)) return;
    this.tx.cells.set(key, before ? { ...before } : null);
  }

  /** Record a structural op. `removed` carries the data an insert does
   *  not need and a delete cannot reconstruct. */
  recordStruct(op) {
    if (!this.tx) return;
    this.tx.struct.push(op);
  }

  recordRemovedSheet(index, json) {
    if (!this.tx) return;
    this.tx.removedSheets.push({ index, json });
  }

  /** Close the transaction. Returns an inverse, or null when nothing
   *  actually changed (so a no-op operation does not eat an undo slot). */
  commit(wb) {
    if (!this.tx) return null;
    this.depth -= 1;
    if (this.depth > 0) return null;
    const tx = this.tx;
    this.tx = null;

    // keep only the metadata that really moved
    const meta = new Map();
    for (const sh of wb.sheets) {
      const before = tx.meta.get(sh.id);
      if (!before) continue;                       // sheet added in this tx
      if (!sameMeta(before, sh)) meta.set(sh.id, before);
    }
    // a sheet that no longer exists must be restorable
    for (const [sid, before] of tx.meta) {
      if (!wb.sheets.some((s) => s.id === sid)) meta.set(sid, before);
    }
    tx.meta = meta;

    const sheetsMoved = tx.sheetIds.length !== wb.sheets.length
      || tx.sheetIds.some((id, i) => wb.sheets[i] && wb.sheets[i].id !== id);
    const namedMoved = JSON.stringify(tx.namedRanges) !== JSON.stringify(wb.namedRanges);

    if (!tx.cells.size && !tx.struct.length && !meta.size && !sheetsMoved
        && !namedMoved && tx.wbName === wb.name && tx.activeSheetId === wb.activeSheetId) {
      return null;
    }
    tx.sheetsMoved = sheetsMoved;
    return tx;
  }

  /** Throw away an open transaction (used when a snapshot is taken instead). */
  abort() { this.tx = null; this.depth = 0; }
}

/* ============================================================
 *  Applying an inverse
 * ==========================================================*/
// `makeSheet` builds a MonoSheet from JSON - injected so this module stays
// free of a circular import back into workbook.js.
//
// `journal`, when an open transaction is passed, makes this record what it is
// about to change. That is what gives redo for free: undo is "apply the
// inverse while journalling", and the transaction that falls out is the
// inverse of the inverse. Undo and redo are then the same code path.
export function applyInverse(wb, tx, makeSheet, journal) {
  if (!tx) return;
  const rec = journal && journal.open ? journal : null;

  // 1. sheets that were deleted come back, at their old position
  for (let i = tx.removedSheets.length - 1; i >= 0; i--) {
    const { index, json } = tx.removedSheets[i];
    if (!wb.sheets.some((s) => s.id === json.id)) {
      wb.sheets.splice(Math.min(index, wb.sheets.length), 0, makeSheet(json));
    }
  }
  // sheets added in this transaction go away again
  if (tx.sheetIds.length) {
    for (const sh of wb.sheets) {
      if (!tx.sheetIds.includes(sh.id) && rec) rec.recordRemovedSheet(wb.sheets.indexOf(sh), sh.toJSON());
    }
    wb.sheets = wb.sheets.filter((s) => tx.sheetIds.includes(s.id));
    const pos = new Map(tx.sheetIds.map((id, i) => [id, i]));
    wb.sheets.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  }

  const byId = new Map(wb.sheets.map((s) => [s.id, s]));

  const doStruct = () => {
    // newest first - pure relabelling, no cell data needed
    for (let i = tx.struct.length - 1; i >= 0; i--) {
      const op = tx.struct[i];
      const sh = byId.get(op.sid);
      if (!sh) continue;
      const mirror = undoStruct(sh, op);
      if (rec && mirror) rec.recordStruct(mirror);
    }
  };
  const doCells = () => {
    for (const [key, before] of tx.cells) {
      const sep = key.indexOf('|');
      const sh = byId.get(key.slice(0, sep));
      if (!sh) continue;
      const k = key.slice(sep + 1);
      if (rec) rec.recordCell(sh.id, k, sh.cells.get(k));
      if (before) sh.cells.set(k, before); else sh.cells.delete(k);
    }
  };

  // ORDER MATTERS, and it flips by direction. A structural op relabels the
  // whole cell map, so cell keys only mean something in one of the two
  // coordinate spaces. A transaction recorded going forwards holds keys from
  // BEFORE the op (that is when _shiftAllFormulas saw them), so the
  // relabelling has to happen first. A transaction recorded while UNDOING
  // holds keys captured after that relabelling, so it has to run the other way
  // round. `cellsAfterStruct` remembers which, and flips each time it is
  // applied - which is what keeps undo/redo/undo... consistent forever.
  if (tx.cellsAfterStruct) { doCells(); doStruct(); }
  else { doStruct(); doCells(); }
  if (rec && rec.tx) rec.tx.cellsAfterStruct = !tx.cellsAfterStruct;

  // 4. sheet metadata (the journal's own begin() snapshot covers the reverse)
  for (const [sid, before] of tx.meta) {
    const sh = byId.get(sid);
    if (!sh) continue;
    for (const k of META_KEYS) sh[k] = clone(before[k]);
  }

  // 5. workbook-level
  wb.name = tx.wbName;
  wb.namedRanges = clone(tx.namedRanges);
  if (wb.sheets.some((s) => s.id === tx.activeSheetId)) wb.activeSheetId = tx.activeSheetId;
}

// Reverse one structural op by relabelling the cell map, and return the op
// that would reverse THIS reversal (so redo works). `rows`/`cols` themselves
// come back from the metadata snapshot, so they are not touched here.
function undoStruct(sh, op) {
  const { kind, sid, at, count } = op;
  const next = new Map();

  if (kind === 'insertRows' || kind === 'insertCols') {
    const isRow = kind === 'insertRows';
    const removed = {};
    for (const [k, cell] of sh.cells) {
      const i = k.indexOf(',');
      let r = +k.slice(0, i), c = +k.slice(i + 1);
      const axis = isRow ? r : c;
      if (axis >= at && axis < at + count) { removed[k] = cell; continue; }   // the inserted band
      if (axis >= at + count) { if (isRow) r -= count; else c -= count; }
      next.set(r + ',' + c, cell);
    }
    sh.cells = next;
    // reversing THIS is a re-insert, i.e. undoing a delete
    return { kind: isRow ? 'deleteRows' : 'deleteCols', sid, at, count, removed };
  }

  if (kind === 'deleteRows' || kind === 'deleteCols') {
    const isRow = kind === 'deleteRows';
    for (const [k, cell] of sh.cells) {
      const i = k.indexOf(',');
      let r = +k.slice(0, i), c = +k.slice(i + 1);
      const axis = isRow ? r : c;
      if (axis >= at) { if (isRow) r += count; else c += count; }
      next.set(r + ',' + c, cell);
    }
    for (const k of Object.keys(op.removed || {})) next.set(k, op.removed[k]);
    sh.cells = next;
    return { kind: isRow ? 'insertRows' : 'insertCols', sid, at, count };
  }
  return null;
}

