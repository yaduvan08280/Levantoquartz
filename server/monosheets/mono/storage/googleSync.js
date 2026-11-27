// ============================================================
//  Mono — Google Sheets sync client (v2 — full-detail)
//  Reads via the /api/sheet proxy; writes via /api/sheet-write.
//  NOTE: requires MonoSync.gs v2 deployed in the user's sheet.
//
//  v2 changes:
//  • Parses the coordinate-based sparse cell map from MonoSync v2.
//  • Carries full cell objects (raw, st, nf, note) — not just strings.
//  • applyCellsToWorkbook now sets styles, number formats, notes,
//    frozen panes, merges, and auto-grows the grid.
// ============================================================
import { threeWayMerge } from './syncEngine.js';

// ── Pull: fetch full cell details from Google Sheets ──────────
export async function pullRemoteCells(execUrl) {
  const r = await (await fetch('/api/sheet?url=' + encodeURIComponent(execUrl))).json();
  if (!r || !r.ok) throw new Error((r && r.error) || 'pull failed');

  // v2 format: tabs[].cells is a sparse map of "r,c" -> { raw, st, nf, note, dv }
  // v1 fallback: tabs[].rows is an array of header-keyed objects
  // Detection is per-tab (see loop below) for robustness.

  const result = {
    cells: {},        // "sheetName!r,c" -> { raw, st, nf, note }
    sheetMeta: {},    // "sheetName" -> { rows, cols, merges, frozen }
    sheetName: r.sheetName || ''
  };

  for (const tab of (r.tabs || [])) {
    // Detect v2 per-tab: v2 has tab.cells as an object; v1 has tab.rows as an array
    const tabIsV2 = tab.cells && typeof tab.cells === 'object' && !Array.isArray(tab.cells);

    if (tabIsV2) {
      // ── v2: coordinate-based sparse map ──
      const tabCells = tab.cells || {};
      for (const key of Object.keys(tabCells)) {
        const src = tabCells[key];
        const cell = {};
        if (src.raw != null && src.raw !== '') cell.raw = String(src.raw);
        if (src.st && Object.keys(src.st).length) cell.st = { ...src.st };
        if (src.nf) cell.nf = src.nf;
        if (src.note) cell.note = src.note;
        // Only store non-empty cells
        if (cell.raw != null || cell.st || cell.nf || cell.note) {
          result.cells[tab.name + '!' + key] = cell;
        }
      }
      result.sheetMeta[tab.name] = {
        rows:   tab.rows   || 50,
        cols:   tab.cols   || 26,
        merges: tab.merges || [],
        frozen: tab.frozen || { rows: 0, cols: 0 }
      };
    } else {
      // ── v1 fallback: header-keyed rows ──
      const headers = tab.headers || [];
      headers.forEach((h, j) => {
        if (h !== '') result.cells[tab.name + '!0,' + j] = { raw: String(h) };
      });
      const rowsArr = Array.isArray(tab.rows) ? tab.rows : [];
      rowsArr.forEach((row, i) =>
        headers.forEach((h, j) => {
          const v = row[h];
          if (v != null && v !== '') result.cells[tab.name + '!' + (i + 1) + ',' + j] = { raw: String(v) };
        })
      );
    }
  }

  return result;
}

// ── Push: write changed cells back to Google Sheets ───────────
export async function pushCells(execUrl, cellList) {
  const r = await (await fetch('/api/sheet-write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: execUrl, payload: { action: 'monoWrite', cells: cellList } })
  })).json();
  if (!r || !r.ok) throw new Error((r && r.error) || 'push failed');
  return r;
}

// ── Apply pulled cells onto a MonoWorkbook ────────────────────
// Handles: raw values, formulas, styles, number formats, notes,
// grid dimensions, frozen panes, and merged cells.
export function applyCellsToWorkbook(wb, remotePull) {
  const cells = remotePull.cells || remotePull;  // support both v2 shape and legacy flat map
  const meta  = remotePull.sheetMeta || {};

  // Group cells by sheet name
  const bySheet = {};
  for (const fullKey of Object.keys(cells)) {
    const bangIdx = fullKey.indexOf('!');
    const sheetName = fullKey.slice(0, bangIdx);
    const coordKey  = fullKey.slice(bangIdx + 1);
    if (!bySheet[sheetName]) bySheet[sheetName] = {};
    bySheet[sheetName][coordKey] = cells[fullKey];
  }

  // For each remote sheet, find or create the MonoSheet
  const remoteSheetNames = new Set([...Object.keys(bySheet), ...Object.keys(meta)]);

  for (const sheetName of remoteSheetNames) {
    let sh = wb.sheets.find(s => s.name === sheetName);
    if (!sh) {
      sh = wb.addSheet(sheetName);
    }

    const sheetCells = bySheet[sheetName] || {};
    const sheetMeta  = meta[sheetName] || {};

    // Grow the grid to match Google Sheets dimensions
    if (sheetMeta.rows && sheetMeta.rows > sh.rows) sh.rows = sheetMeta.rows;
    if (sheetMeta.cols && sheetMeta.cols > sh.cols) sh.cols = sheetMeta.cols;

    // Apply frozen panes
    if (sheetMeta.frozen) {
      sh.frozen = { rows: sheetMeta.frozen.rows || 0, cols: sheetMeta.frozen.cols || 0 };
    }

    // Apply merged cells
    if (sheetMeta.merges && sheetMeta.merges.length) {
      sh.merges = sheetMeta.merges.map(m => ({ ...m }));
    }

    // Clear existing cells that are not in the remote set
    for (const existingKey of [...sh.cells.keys()]) {
      if (!(existingKey in sheetCells)) {
        sh.cells.delete(existingKey);
      }
    }

    // Apply each remote cell
    for (const coordKey of Object.keys(sheetCells)) {
      const src = sheetCells[coordKey];
      const [r, c] = coordKey.split(',').map(Number);

      // Build the full cell object for MonoSheet
      const cellObj = {};

      // raw: formula or value
      if (src.raw != null && src.raw !== '') cellObj.raw = String(src.raw);

      // Style
      if (src.st && Object.keys(src.st).length) cellObj.st = { ...src.st };

      // Number format
      if (src.nf) cellObj.nf = src.nf;

      // Note
      if (src.note) cellObj.note = src.note;

      // Write the cell — setCellObj handles grow + cleanup
      sh.setCellObj(r, c, cellObj);
    }
  }
}

// ── Diff: find cells that need pushing to remote ──────────────
// Compares local cell objects to remote cell objects by raw value only
// (we don't push styles back in this phase).
export function diffToPush(localCells, remoteCells) {
  const list = [];

  for (const k of Object.keys(localCells)) {
    const localRaw  = localCells[k]?.raw ?? '';
    const remoteRaw = remoteCells[k]?.raw ?? '';
    if (localRaw !== remoteRaw) {
      const bangIdx = k.indexOf('!');
      const name = k.slice(0, bangIdx);
      const [r, c] = k.slice(bangIdx + 1).split(',').map(Number);
      list.push({ sheet: name, row: r, col: c, value: localRaw });
    }
  }

  // Cells in remote that are not in local → clear them
  for (const k of Object.keys(remoteCells)) {
    if (!(k in localCells)) {
      const bangIdx = k.indexOf('!');
      const name = k.slice(0, bangIdx);
      const [r, c] = k.slice(bangIdx + 1).split(',').map(Number);
      list.push({ sheet: name, row: r, col: c, value: '' });
    }
  }

  return list;
}

export { threeWayMerge };
