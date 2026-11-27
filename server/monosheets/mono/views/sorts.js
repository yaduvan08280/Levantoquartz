// ============================================================
//  Mono — View Sorts  (P8)
//  Pure function: applySorts(rows, sorts, engine, sid, headers) → rows
//
//  Each sort: { colId, dir }  where dir is 'asc' | 'desc'
//  Multi-column: sorts applied left-to-right (primary, secondary, …)
//  Empty/null cells always sort LAST regardless of direction.
//
//  Pure — never mutates input rows. Reusable by REST API (P17).
// ============================================================

/**
 * @param {object[]} rows      — MaterializedRow[]
 * @param {object[]} sorts     — SortSpec[]  (may be empty/null)
 * @param {object}   engine    — Engine instance
 * @param {string}   sid       — sheet id
 * @param {string[]} headers   — column header names (index → name)
 * @returns {object[]} sorted rows (new array, input untouched)
 */
export function applySorts(rows, sorts, engine, sid, headers) {
  if (!sorts || sorts.length === 0) return rows;

  // Pre-compute sort values for each row to avoid repeated lookups
  const withValues = rows.map((row) => ({
    row,
    keys: sorts.map((s) => {
      const colIdx = resolveColId(s.colId, headers);
      return colIdx === -1 ? null : engine.valueAt(sid, row.rowIndex, colIdx);
    }),
  }));

  withValues.sort((a, b) => {
    for (let i = 0; i < sorts.length; i++) {
      const dir = sorts[i].dir === 'desc' ? -1 : 1;
      const av = a.keys[i];
      const bv = b.keys[i];

      // Empty cells always last
      const aEmpty = av == null || av === '';
      const bEmpty = bv == null || bv === '';
      if (aEmpty && bEmpty) continue;
      if (aEmpty) return 1;
      if (bEmpty) return -1;

      const cmp = compareValues(av, bv);
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });

  return withValues.map((x) => x.row);
}

function resolveColId(colId, headers) {
  if (typeof colId === 'number') return colId;
  if (!headers) return -1;
  return headers.indexOf(colId);
}

function compareValues(a, b) {
  // Both numeric → numeric comparison
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  // Fallback: lexicographic
  const sa = String(a).toLowerCase(), sb = String(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
