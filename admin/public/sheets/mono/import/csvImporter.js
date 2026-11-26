// ============================================================
//  Mono — CSV / TSV importer  [Unified Import v1]
//  ------------------------------------------------------------
//  Parses delimited text (RFC-4180-ish: quotes, escaped quotes,
//  embedded newlines, CRLF) into a SheetImage. Auto-detects the
//  delimiter, keeps values as raw strings (the engine infers
//  numbers/dates), and seeds colMeta from the header row so a
//  re-import lines up with structural sync.
// ============================================================
import { emptyImage, emptySheetImage } from './sheetImage.js';
import { deriveIds } from './structuralSync.js';

// Robust delimited-text parser. Returns string[][].
export function parseDelimited(text, sep) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') { q = true; }
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
    else if (ch === '\r') { /* handled by \n */ }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  return rows;
}

// Guess the delimiter from the first few lines (comma / tab / semicolon / pipe).
export function detectDelimiter(text, hintName = '') {
  if (/\.tsv$/i.test(hintName)) return '\t';
  const sample = String(text).split(/\r?\n/).slice(0, 5).join('\n');
  const cands = [',', '\t', ';', '|'];
  let best = ',', bestScore = -1;
  for (const d of cands) {
    // score = consistency of column counts across sampled lines
    const counts = sample.split('\n').filter(Boolean).map((l) => l.split(d).length);
    if (!counts.length) continue;
    const max = Math.max(...counts);
    if (max <= 1) continue;
    const consistent = counts.filter((c) => c === counts[0]).length / counts.length;
    const score = max * consistent;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// text -> SheetImage (single sheet). name defaults from the file name.
export function csvToImage(text, name = 'Imported CSV', sep) {
  const delim = sep || detectDelimiter(text, name);
  const grid = parseDelimited(text, delim);
  const image = emptyImage({ kind: 'csv', name });
  const sheetName = String(name).replace(/\.[^.]+$/, '').slice(0, 60) || 'Sheet1';
  const s = emptySheetImage(sheetName, 0);
  let maxC = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c];
      if (v !== '' && v != null) s.cells[r + ',' + c] = { raw: String(v) };
      if (c + 1 > maxC) maxC = c + 1;
    }
  }
  s.rows = Math.max(50, grid.length);
  s.cols = Math.max(26, maxC);
  const headers = grid[0] || [];
  const ids = deriveIds(null, headers, maxC);
  s.colMeta = ids.map((id, c) => ({ id, header: headers[c] != null ? String(headers[c]) : '' }));
  image.sheets.push(s);
  return image;
}

