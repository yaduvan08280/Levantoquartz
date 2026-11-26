// ============================================================
//  Mono — View Filters  (P8)
//  Pure function: applyFilters(rows, filters, engine, sid) → rows
//
//  Each filter: { colId, op, value }
//  Supported ops: eq, neq, gt, lt, gte, lte, contains, startsWith,
//                 endsWith, isEmpty, isNotEmpty
//
//  "rows" shape: [{ rowId, cells: [value, ...], rowIndex }]
//  Uses engine.getValue (computed) not raw, so formulas are filtered
//  on their results — consistent with what users see.
//
//  Pure — never mutates input rows. Reusable by REST API (P17).
// ============================================================

/**
 * @param {object[]} rows      — MaterializedRow[]
 * @param {object[]} filters   — FilterSpec[]  (may be empty/null)
 * @param {object}   engine    — Engine instance
 * @param {string}   sid       — sheet id
 * @param {string[]} headers   — column header names (index → name)
 * @returns {object[]} filtered rows (new array, input untouched)
 */
export function applyFilters(rows, filters, engine, sid, headers) {
  if (!filters || filters.length === 0) return rows;

  return rows.filter((row) => {
    for (const filter of filters) {
      if (!matchesFilter(row, filter, engine, sid, headers)) return false;
    }
    return true;
  });
}

function matchesFilter(row, filter, engine, sid, headers) {
  const { colId, op, value } = filter;

  // Resolve colId to a column index
  const colIdx = resolveColId(colId, headers);
  if (colIdx === -1) return true;  // unknown column — don't filter

  // Get the computed cell value
  const cellVal = engine.valueAt(sid, row.rowIndex, colIdx);
  const cellStr = cellVal == null ? '' : String(cellVal);
  const filterStr = value == null ? '' : String(value);

  switch (op) {
    case 'eq':
      return looslyEqual(cellVal, value);
    case 'neq':
      return !looslyEqual(cellVal, value);
    case 'gt':
      return toNum(cellVal) > toNum(value);
    case 'lt':
      return toNum(cellVal) < toNum(value);
    case 'gte':
      return toNum(cellVal) >= toNum(value);
    case 'lte':
      return toNum(cellVal) <= toNum(value);
    case 'contains':
      return cellStr.toLowerCase().includes(filterStr.toLowerCase());
    case 'startsWith':
      return cellStr.toLowerCase().startsWith(filterStr.toLowerCase());
    case 'endsWith':
      return cellStr.toLowerCase().endsWith(filterStr.toLowerCase());
    case 'isEmpty':
      return cellVal == null || cellVal === '';
    case 'isNotEmpty':
      return cellVal != null && cellVal !== '';
    default:
      return true;
  }
}

/** Resolve a colId (column name string or 0-based index) to an index */
function resolveColId(colId, headers) {
  if (typeof colId === 'number') return colId;
  if (!headers) return -1;
  const idx = headers.indexOf(colId);
  return idx;
}

function looslyEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  // Numeric comparison when both coerce to numbers
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function toNum(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}
