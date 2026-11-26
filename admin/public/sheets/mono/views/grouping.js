// ============================================================
//  Mono — View Grouping  (P8)
//  Pure function: applyGrouping(rows, groupBy, headers) → GroupedRows
//
//  GroupedRows: [{ groupKey, groupValue, rows: MaterializedRow[] }]
//  When groupBy is null/undefined returns a single group with all rows.
//
//  Pure — never mutates input rows.
// ============================================================

/**
 * @param {object[]} rows      — MaterializedRow[]
 * @param {string|number|null} groupBy — colId (name or 0-based index) or null
 * @param {string[]} headers   — column header names (index → name)
 * @returns {GroupedRows[]}
 */
export function applyGrouping(rows, groupBy, headers) {
  if (groupBy == null) {
    return [{ groupKey: null, groupValue: null, rows }];
  }

  const colIdx = resolveColId(groupBy, headers);
  if (colIdx === -1) {
    return [{ groupKey: null, groupValue: null, rows }];
  }

  // Preserve insertion order of group keys
  const groups = new Map();
  for (const row of rows) {
    const val = row.cells[colIdx];
    const key = val == null ? '' : String(val);
    if (!groups.has(key)) groups.set(key, { groupKey: key, groupValue: val, rows: [] });
    groups.get(key).rows.push(row);
  }

  return [...groups.values()];
}

function resolveColId(colId, headers) {
  if (typeof colId === 'number') return colId;
  if (!headers) return -1;
  return headers.indexOf(colId);
}
