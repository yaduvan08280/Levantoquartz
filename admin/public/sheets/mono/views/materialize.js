// ============================================================
//  Mono — materialize()  (P8 core)
//
//  materialize(engine, sheetId, spec) → MaterializedView
//
//  Pure, zero side effects, zero DOM. The central pipeline:
//    1. Read all non-hidden rows from the sheet
//    2. Apply filters  (views/filters.js)
//    3. Apply sorts    (views/sorts.js)
//    4. Apply grouping (views/grouping.js)
//    5. Shape the output
//
//  CONTRACT (locked):
//  - engine and spec are never mutated
//  - MonoSheet.cells are never mutated
//  - Filtering is view-only: dashboard reads engine directly
//
//  Row identity: rowId = stable UUID (P10, via rowId.js).
//
//  MaterializedView shape:
//  {
//    headers: string[],
//    rows: MaterializedRow[],       // filtered + sorted
//    groups: GroupedRows[],         // grouped (or single catch-all)
//    totalRows: number,             // row count BEFORE filtering
//    appliedFilters: FilterSpec[],
//    appliedSorts: SortSpec[],
//  }
//
//  MaterializedRow shape:
//  {
//    rowId: number,       // @temporary physical row index
//    rowIndex: number,    // physical row index (always)
//    cells: any[],        // computed values, one per header column
//  }
// ============================================================
import { applyFilters } from './filters.js';
import { applySorts } from './sorts.js';
import { applyGrouping } from './grouping.js';
import { rowIdAt } from '../model/rowId.js';

/**
 * @param {Engine}  engine
 * @param {string}  sheetId
 * @param {ViewSpec} spec   — may be empty ({}) for raw grid
 * @returns {MaterializedView}
 */
export function materialize(engine, sheetId, spec = {}) {
  const sh = engine.wb.sheets.find((s) => s.id === sheetId);
  if (!sh) {
    return { headers: [], rows: [], groups: [], totalRows: 0, appliedFilters: [], appliedSorts: [] };
  }

  const config = spec.config || {};
  const filters = config.filters || [];
  const sorts = config.sorts || [];
  const groupBy = config.groupBy || null;
  const hiddenCols = new Set(config.hiddenCols || []);

  // ── 1. Headers: row 0 values treated as headers ──────────────
  // Compute effective max column = highest column with any content
  let effectiveCols = 0;
  for (const key of sh.cells.keys()) {
    const c = parseInt(key.split(',')[1], 10);
    if (c + 1 > effectiveCols) effectiveCols = c + 1;
  }
  // Also check any spill cells the engine knows about
  effectiveCols = Math.max(effectiveCols, 1);

  const headers = [];
  const colIndices = [];   // maps header position → sheet column index
  for (let c = 0; c < effectiveCols; c++) {
    if (hiddenCols.has(c)) continue;
    const raw = sh.getRaw(0, c);
    headers.push(raw !== '' ? raw : '');
    colIndices.push(c);
  }

  // ── 2. Build MaterializedRow[] from rows 1..N ────────────────
  const allRows = [];
  for (let r = 1; r < sh.rows; r++) {
    // Skip rows that have no data at all (sparse sheet may have many)
    let hasData = false;
    for (const c of colIndices) {
      if (sh.getRaw(r, c) !== '' || engine.valueAt(sheetId, r, c) != null) {
        hasData = true; break;
      }
    }
    if (!hasData) continue;

    const cells = colIndices.map((c) => engine.valueAt(sheetId, r, c));
    allRows.push({
      rowId: rowIdAt(sh, r),   // P10: stable UUID (replaces @temporary physical index)
      rowIndex: r,
      cells,
    });
  }

  const totalRows = allRows.length;

  // ── 3. Filter ────────────────────────────────────────────────
  const filtered = applyFilters(allRows, filters, engine, sheetId, headers);

  // ── 4. Sort ──────────────────────────────────────────────────
  const sorted = applySorts(filtered, sorts, engine, sheetId, headers);

  // ── 5. Group ─────────────────────────────────────────────────
  const groups = applyGrouping(sorted, groupBy, headers);

  return {
    headers,
    colIndices,
    rows: sorted,
    groups,
    totalRows,
    appliedFilters: filters,
    appliedSorts: sorts,
  };
}
