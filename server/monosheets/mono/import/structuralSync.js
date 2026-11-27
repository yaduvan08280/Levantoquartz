// ============================================================
//  Mono — Structural sync  [Unified Import v1]
//  ------------------------------------------------------------
//  The "smart" part of Google Sheets sync: when the remote sheet's
//  COLUMN LAYOUT changes (someone inserts / deletes / moves a
//  column upstream) we must NOT treat it as thousands of edited
//  cells. Instead we detect the structural change by matching
//  per-column identities, then replay the *same* insert/delete on
//  the LOCAL sheet via the engine — which shifts the user's own
//  extra columns AND rewrites every local formula automatically.
//
//  Column identity:
//   • Google Sheets  → developer-metadata id (survives insert/move/
//                       delete natively). Emitted per column by
//                       MonoBridge.gs as colMeta[c].id.
//   • CSV / XLSX      → derived from the header text (deriveIds).
//
//  Worst-case handling:
//   • insert in the middle  → engine.insertCols shifts data+formulas
//   • delete a column        → engine.deleteCols; refs become #REF!
//                              (matching Google's own behaviour) and
//                              the user's right-hand columns slide left
//   • append at the right    → insert at end, nothing clobbered
//   • reorder                → expressed as delete+insert by the diff
// ============================================================

// Derive a stable-ish id per column from header text when no metadata id
// exists (CSV/XLSX, or a Google sheet synced before ids were stamped).
// Falls back to a positional id so empty headers still line up.
export function deriveIds(colMeta, headers, cols) {
  const n = Math.max(cols || 0, (colMeta || []).length, (headers || []).length);
  const seen = Object.create(null);
  const ids = [];
  for (let c = 0; c < n; c++) {
    const m = colMeta && colMeta[c];
    if (m && m.id) { ids.push(String(m.id)); continue; }
    let h = headers && headers[c] != null ? String(headers[c]).trim() : '';
    let id = h ? 'h:' + h.toLowerCase() : 'pos:' + c;
    // de-duplicate identical headers so they remain distinct identities
    if (seen[id] != null) { seen[id]++; id += '#' + seen[id]; } else seen[id] = 0;
    ids.push(id);
  }
  return ids;
}

/* ---------- LCS diff on id sequences ---------- */
// Longest common subsequence backtrack → an edit script of
// { type:'keep'|'del'|'ins', id }. Deterministic and O(n·m).
function lcsScript(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const script = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { script.push({ type: 'keep', id: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { script.push({ type: 'del', id: a[i] }); i++; }
    else { script.push({ type: 'ins', id: b[j] }); j++; }
  }
  while (i < n) { script.push({ type: 'del', id: a[i] }); i++; }
  while (j < m) { script.push({ type: 'ins', id: b[j] }); j++; }
  return script;
}

// Turn the edit script into ordered single-column ops expressed in the
// *evolving local index space* (so they can be applied left-to-right).
// baseIds = local's current column identities, newIds = fresh remote.
export function columnOps(baseIds, newIds) {
  const script = lcsScript(baseIds, newIds);
  const ops = [];
  let li = 0; // cursor in the (evolving) local column space
  for (const step of script) {
    if (step.type === 'keep') { li++; }
    else if (step.type === 'del') { ops.push({ op: 'delete', at: li, id: step.id }); /* next col slides into li */ }
    else { ops.push({ op: 'insert', at: li, id: step.id }); li++; }
  }
  return ops;
}

/* ---------- apply column ops to a live workbook ---------- */
// Replays inserts/deletes on the LOCAL sheet through the engine so that:
//   • the user's own extra columns shift with their neighbours, and
//   • every local formula is transposed (engine._shiftAllFormulas).
// Also keeps sheet.colMeta aligned. Returns the list of ops applied.
export function applyColumnOps(engine, sid, ops) {
  const sh = engine.sheetById ? engine.sheetById(sid) : null;
  for (const o of ops) {
    if (o.op === 'insert') {
      engine.insertCols(sid, o.at, 1);
      if (sh) { sh.colMeta.splice(o.at, 0, o.id ? { id: o.id } : null); }
    } else {
      engine.deleteCols(sid, o.at, 1);
      if (sh) { sh.colMeta.splice(o.at, 1); }
    }
  }
  return ops;
}

// Shift a plain "r,c"->cell base map through the same column ops (coordinate
// only — used to keep the stored sync base aligned to the new layout so the
// three-way merge stays coordinate-accurate).
export function shiftCellMapCols(map, ops) {
  let cur = map;
  for (const o of ops) {
    const next = {};
    for (const k of Object.keys(cur)) {
      const ci = k.indexOf(',');
      const r = k.slice(0, ci);
      let c = Number(k.slice(ci + 1));
      if (o.op === 'insert') { if (c >= o.at) c += 1; }
      else { if (c === o.at) continue; if (c > o.at) c -= 1; }
      next[r + ',' + c] = cur[k];
    }
    cur = next;
  }
  return cur;
}

// Detect + apply column structure changes for one sheet.
//
// CRITICAL: the diff compares ONLY the previously-synced *remote* columns
// (sheet.colMeta, which is set to the remote layout at the end of every sync)
// against the fresh remote columns. The user's own extra columns are NOT in
// colMeta, so they are never matched and never "deleted" — they simply ride
// along, shifted by the engine's insert/delete, with their formulas rewritten.
//
// On the very first sync a sheet has no colMeta baseline, so there is nothing
// structural to reconcile (we just adopt the remote layout) — guarded here.
//
// Returns { ops, changed } and mutates the workbook via the engine.
export function reconcileColumns(engine, sid, newColMeta) {
  const sh = engine.sheetById(sid);
  if (!sh) return { ops: [], changed: false };
  const baseMeta = sh.colMeta || [];
  if (!baseMeta.length) return { ops: [], changed: false }; // no prior remote baseline
  const baseIds = deriveIds(baseMeta, null, baseMeta.length);
  const newIds = deriveIds(newColMeta || [], null, (newColMeta || []).length);
  const ops = columnOps(baseIds, newIds);
  if (ops.length) applyColumnOps(engine, sid, ops);
  return { ops, changed: ops.length > 0, baseIds, newIds };
}

