// ============================================================
//  Mono — Stable row identity  (P10)
//
//  Replaces the @temporary physical-index row IDs used in P8/P9.
//  UUIDs are assigned lazily on first access so pre-P10 workbooks
//  need no migration pass.
//
//  Persisted as  sheet.rowIdMap: { [physicalRowIndex]: uuid }
//
//  API:
//    ensureRowIds(sheet)                — called by engine after every
//                                         insertRows / deleteRows
//    rowIdAt(sheet, r) → uuid           — lazily assigns if absent
//    rowByRowId(sheet, id) → number|null — reverse lookup (physical idx)
//
//  The map is sparse: rows that have never been touched have no entry.
//  ensureRowIds() fixes the map after a structural edit (shift or drop).
// ============================================================

const _uuid = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

/**
 * Ensure sheet.rowIdMap exists.  Does NOT assign UUIDs to every row —
 * call rowIdAt() for lazy assignment.
 * @param {MonoSheet} sheet
 */
export function ensureRowIds(sheet) {
  if (!sheet.rowIdMap) sheet.rowIdMap = {};
}

/**
 * Return the stable UUID for physical row `r`, assigning one if absent.
 * @param {MonoSheet} sheet
 * @param {number}    r  — physical row index (0-based, row 0 = header)
 * @returns {string}
 */
export function rowIdAt(sheet, r) {
  ensureRowIds(sheet);
  if (!sheet.rowIdMap[r]) {
    sheet.rowIdMap[r] = _uuid();
  }
  return sheet.rowIdMap[r];
}

/**
 * Reverse-lookup: given a stable UUID, return the current physical row index.
 * Returns null if the id is not found (row was deleted).
 * @param {MonoSheet} sheet
 * @param {string}    id
 * @returns {number|null}
 */
export function rowByRowId(sheet, id) {
  if (!sheet.rowIdMap) return null;
  for (const [r, uid] of Object.entries(sheet.rowIdMap)) {
    if (uid === id) return Number(r);
  }
  return null;
}

/**
 * Called by engine.insertRows(sid, at, count).
 * Shifts all entries at index >= at up by count.
 * @param {MonoSheet} sheet
 * @param {number}    at     — first inserted row index
 * @param {number}    count  — number of rows inserted
 */
export function shiftRowIdsInsert(sheet, at, count) {
  ensureRowIds(sheet);
  const map = sheet.rowIdMap;
  // Collect entries to shift (iterate in reverse to avoid collision)
  const toShift = Object.keys(map)
    .map(Number)
    .filter((r) => r >= at)
    .sort((a, b) => b - a); // descending — shift highest first
  for (const r of toShift) {
    map[r + count] = map[r];
    delete map[r];
  }
  // Inserted rows get fresh UUIDs on first access (lazy), nothing to do now.
}

/**
 * Called by engine.deleteRows(sid, at, count).
 * Removes deleted entries; shifts surviving entries down.
 * @param {MonoSheet} sheet
 * @param {number}    at     — first deleted row index
 * @param {number}    count  — number of rows deleted
 */
export function shiftRowIdsDelete(sheet, at, count) {
  ensureRowIds(sheet);
  const map = sheet.rowIdMap;
  const end = at + count;
  for (const key of Object.keys(map)) {
    const r = Number(key);
    if (r >= at && r < end) {
      delete map[key]; // deleted rows lose their ID
    } else if (r >= end) {
      map[r - count] = map[key];
      delete map[key];
    }
  }
}
