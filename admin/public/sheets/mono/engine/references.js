// ============================================================
//  Mono formula engine — A1 references (Phase 2)
//  Parse/format cell + range refs, resolve open-ended ranges,
//  and shift refs for row/col insert/delete (→ #REF! when deleted).
// ============================================================
export function colToLetters(c) { let s = ''; c++; while (c) { s = String.fromCharCode(65 + (c - 1) % 26) + s; c = Math.floor((c - 1) / 26); } return s; }
export function lettersToCol(s) { let c = 0; for (const ch of String(s).replace(/\$/g, '').toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; }

export const isCellText = (t) => /^\$?[A-Za-z]{1,3}\$?\d+$/.test(t);
export const isColText = (t) => /^\$?[A-Za-z]{1,3}$/.test(t);
export const isRowText = (t) => /^\$?\d+$/.test(t);

export function parseCell(text) {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text);
  if (!m) return null;
  return { colAbs: m[1] === '$', col: lettersToCol(m[2]), rowAbs: m[3] === '$', row: parseInt(m[4], 10) - 1 };
}
export function formatCell(col, row, colAbs, rowAbs) {
  return (colAbs ? '$' : '') + colToLetters(col) + (rowAbs ? '$' : '') + (row + 1);
}

// Resolve an (possibly open-ended) range to a concrete rectangle using sheet size.
export function concreteRange(rng, sheetRows, sheetCols) {
  let { c1, r1, c2, r2, kind } = rng;
  if (kind === 'cols') { r1 = 0; r2 = Math.max(0, sheetRows - 1); }
  if (kind === 'rows') { c1 = 0; c2 = Math.max(0, sheetCols - 1); }
  // C2:C - the start row is given, the end runs to the bottom of the sheet.
  if (kind === 'colsFrom') { r2 = Math.max(0, sheetRows - 1); }
  return { c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
}

// Shift one index for a structural edit on its axis. count>0 = insert, <0 = delete.
// Returns the new index, or the string 'REF' if the cell was deleted.
export function shiftIndex(idx, at, count) {
  if (count > 0) return idx >= at ? idx + count : idx;
  const delEnd = at - count;                 // delete range [at, delEnd)
  if (idx >= at && idx < delEnd) return 'REF';
  if (idx >= delEnd) return idx + count;
  return idx;
}
