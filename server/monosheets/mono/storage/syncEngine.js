// ============================================================
//  Mono — sync merge engine (v2 — cell-object-aware)
//  Cell-level three-way merge. Maps are { "sheet!r,c": cellObj }.
//  cellObj shape: { raw, st, nf, note }
//  policy: 'localWins' | 'remoteWins' | 'newestWins' | 'ask'
//
//  v2 changes:
//  • Compares full cell objects (not just raw strings).
//  • workbookToCells now serialises the complete cell object.
// ============================================================

// Compare two cell objects for equality
function cellsEqual(a, b) {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return false;
  // Fast path: compare raw first (most common change)
  if ((a.raw ?? '') !== (b.raw ?? '')) return false;
  if ((a.nf ?? '') !== (b.nf ?? '')) return false;
  if ((a.note ?? '') !== (b.note ?? '')) return false;
  // Style comparison
  const aSt = a.st || {};
  const bSt = b.st || {};
  const aKeys = Object.keys(aSt);
  const bKeys = Object.keys(bSt);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (aSt[k] !== bSt[k]) return false;
  }
  return true;
}

// Normalise a cell: if it has no meaningful content, return null
function normCell(c) {
  if (!c) return null;
  if (!c.raw && !c.st && !c.nf && !c.note) return null;
  return c;
}

export function threeWayMerge(base, local, remote, policy = 'ask') {
  base   = base   || {};
  local  = local  || {};
  remote = remote || {};

  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const merged = {};
  const conflicts = [];

  for (const k of keys) {
    const b = normCell(base[k]);
    const l = normCell(local[k]);
    const r = normCell(remote[k]);

    const lc = !cellsEqual(l, b);  // local changed vs base
    const rc = !cellsEqual(r, b);  // remote changed vs base

    if (lc && rc) {
      // Both sides changed
      if (cellsEqual(l, r)) {
        // Same change — no conflict
        if (l) merged[k] = { ...l };
      } else if (policy === 'localWins') {
        if (l) merged[k] = { ...l };
      } else if (policy === 'remoteWins') {
        if (r) merged[k] = { ...r };
      } else {
        // 'ask' / 'newestWins' — default keep local pending resolution
        conflicts.push({ key: k, local: l, remote: r, base: b });
        if (l) merged[k] = { ...l };
      }
    } else if (lc) {
      if (l) merged[k] = { ...l };
    } else if (rc) {
      if (r) merged[k] = { ...r };
    } else {
      // No change — keep whatever exists
      const keep = b || l || r;
      if (keep) merged[k] = { ...keep };
    }
  }

  // Remove empty/null entries
  for (const k of Object.keys(merged)) {
    if (!normCell(merged[k])) delete merged[k];
  }

  return { merged, conflicts };
}

// Flatten a workbook JSON to a cell map: "sheetName!r,c" -> { raw, st, nf, note }
export function workbookToCells(wb) {
  const out = {};
  for (const sh of (wb.sheets || [])) {
    for (const k of Object.keys(sh.cells || {})) {
      const cell = sh.cells[k];
      if (!cell) continue;
      // Build a clean cell object
      const obj = {};
      if (cell.raw != null && cell.raw !== '') obj.raw = cell.raw;
      if (cell.st && Object.keys(cell.st).length) obj.st = { ...cell.st };
      if (cell.nf) obj.nf = cell.nf;
      if (cell.note) obj.note = cell.note;
      if (obj.raw || obj.st || obj.nf || obj.note) {
        out[sh.name + '!' + k] = obj;
      }
    }
  }
  return out;
}
