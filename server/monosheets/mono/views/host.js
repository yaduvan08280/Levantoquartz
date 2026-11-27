// ============================================================
//  Mono — host contract  (P9, upgraded by the Views-v3 pass)
//
//  makeHost(grid) → host
//
//  Every view renderer receives a `host` object, never a direct
//  MonoGrid reference (except the grid renderer which needs _grid
//  for its mechanical extraction pattern).
//
//  CONTRACT:
//  {
//    engine:      Engine       — read-only access to computed values
//    wb:          MonoWorkbook — read-only model access
//    sheetId:     string       — active sheet's id at time of render
//    spec:        ViewSpec|null — the active view spec (config lives here)
//    materialized: MaterializedView | null  — set by grid.render()
//    applyEdit(op) — the ONLY way to mutate data from a renderer
//    rowIndexById(rowId) → number|null — resolve stable id → CURRENT
//                  physical row (INV-V3-1: resolve at interaction time)
//    viewState(id) → object — per-view in-memory state that survives
//                  re-renders (calendar month, collapsed lanes, search…)
//    saveSpec()    — persist spec/config changes + re-render
//    selectRow(r)  — update grid selection without leaving the view
//    openRowInGrid(r) — switch to grid view and scroll to row r
//    _grid:       MonoGrid (private — ONLY the grid renderer uses this)
//  }
//
//  op shapes (all writes go through applyEdit → pushUndo, INV-V3-2):
//  { type:'setCell',   r, c, raw }
//  { type:'insertRow', afterR, cells?: [{c, raw}] }   // cells applied to the NEW row
//  { type:'deleteRow', r }
//  { type:'batch',     cells: [{r,c,raw}] }
// ============================================================
import { rowByRowId } from '../model/rowId.js';

/**
 * @param {MonoGrid} grid
 * @returns {host}
 */
export function makeHost(grid) {
  if (!grid._viewState) grid._viewState = {};
  return {
    engine:      grid.engine,
    wb:          grid.wb,
    sheetId:     grid.sid(),
    spec:        grid.activeViewSpec || null,
    materialized: null,     // set by grid.render() before calling renderer.render()
    _grid:       grid,      // private — grid renderer only

    applyEdit(op) {
      grid.pushUndo();
      if (op.type === 'setCell') {
        grid.engine.setRaw(grid.sid(), op.r, op.c, op.raw);
      } else if (op.type === 'insertRow') {
        // v3 fix: cells are written to the ROW JUST INSERTED. The old code
        // applied them at their own r (the form passed r:0 → submissions
        // overwrote the header row).
        const at = op.afterR + 1;
        grid.engine.insertRows(grid.sid(), at, 1);
        if (op.cells && op.cells.length) {
          grid.engine.setCellsBatch(grid.sid(), op.cells.map((cl) => ({ r: at, c: cl.c, raw: cl.raw })));
        }
      } else if (op.type === 'deleteRow') {
        grid.engine.deleteRows(grid.sid(), op.r, 1);
      } else if (op.type === 'batch') {
        grid.engine.setCellsBatch(grid.sid(), op.cells);
      }
      grid.save();
      grid.render();
    },

    // INV-V3-1: views hold rowIds; the physical index is resolved at the
    // moment of the write, so sorts/filters/inserts between render and
    // interaction can never redirect an edit to the wrong row.
    rowIndexById(rowId) {
      const sh = grid.wb.sheets.find((s) => s.id === grid.sid());
      if (!sh) return null;
      return rowByRowId(sh, rowId);
    },

    // Per-view UI state that must survive the full DOM rebuild grid.render()
    // performs after every edit (month shown, collapsed lanes, search text…).
    viewState(id) {
      const key = id || 'default';
      if (!grid._viewState[key]) grid._viewState[key] = {};
      return grid._viewState[key];
    },

    saveSpec() { grid.save(); grid.render(); },

    selectRow(r) {
      grid.active = { r, c: grid.active.c || 0 };
      grid.anchor = { ...grid.active };
      if (typeof grid.applySelection === 'function') grid.applySelection();
    },

    openRowInGrid(r) {
      grid.switchToViewKind('grid');
      if (typeof grid.select === 'function') grid.select(r, 0);
    },
  };
}
