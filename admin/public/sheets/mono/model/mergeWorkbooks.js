// ============================================================
//  Mono Sheets — Combine workbooks (P20 Phase F)
//  Folds every sheet of `source` into `target`, remaps named
//  ranges, and rewrites IMPORTRANGE("<source>", "Sheet!A1:B2")
//  formulas in `target` into plain in-workbook references now
//  that the data lives in the same workbook — the same reference-
//  rewriting idea structuralSync uses for column shifts, applied
//  to a cross-workbook → intra-workbook transition.
// ============================================================
import { parse } from '../engine/parser.js';
import { serialize } from '../engine/serialize.js';
import { parseCell } from '../engine/references.js';

/**
 * Rewrite one formula: replace IMPORTRANGE(key, "Sheet!A1:B2") calls whose
 * `key` matches the merged-in source with a direct 'Sheet'!A1:B2 reference.
 * @param {string} raw            formula text (starts with '=')
 * @param {Set<string>} keys      keys that resolve to the source (id + name)
 * @param {Map<string,string>} renames  source sheet name → post-collision name
 * @param {string} defaultSheet   post-merge name of the source's first sheet
 * @returns {string}              rewritten formula (or the original on any parse issue)
 */
export function rewriteImportRangeFormula(raw, keys, renames, defaultSheet) {
  if (!raw || raw[0] !== '=' || !/importrange/i.test(raw)) return raw;
  let ast; try { ast = parse(raw.slice(1)); } catch { return raw; }
  let touched = false;
  const rewrite = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (n.type === 'call' && /^importrange$/i.test(n.name)) {
      const a0 = n.args && n.args[0], a1 = n.args && n.args[1];
      if (a0 && a0.type === 'str' && keys.has(String(a0.value)) && a1 && a1.type === 'str') {
        const node = rangeTextToNode(String(a1.value), renames, defaultSheet);
        if (node) { touched = true; return node; }
      }
    }
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) n[k] = v.map(rewrite); else if (v && typeof v === 'object') n[k] = rewrite(v); }
    return n;
  };
  ast = rewrite(ast);
  return touched ? '=' + serialize(ast) : raw;
}

// "Sheet1!A1:B2" | "Sheet1!A1" | "A1:B2" | "A1" → ref/range AST node.
function rangeTextToNode(text, renames, defaultSheet) {
  let sheetName = null, body = String(text);
  const bang = body.indexOf('!');
  if (bang >= 0) { sheetName = body.slice(0, bang).replace(/^'|'$/g, ''); body = body.slice(bang + 1); }
  const finalSheet = sheetName ? (renames.get(sheetName) || sheetName) : defaultSheet;
  if (!finalSheet) return null;
  const parts = body.split(':');
  const a = parseCell(parts[0].toUpperCase()); if (!a) return null;
  if (parts.length === 1) return { type: 'ref', sheet: finalSheet, row: a.row, col: a.col, rowAbs: false, colAbs: false };
  const b = parseCell(parts[1].toUpperCase()); if (!b) return null;
  return {
    type: 'range', sheet: finalSheet, kind: 'cells',
    r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col),
    a1: { rowAbs: false, colAbs: false }, a2: { rowAbs: false, colAbs: false },
  };
}

/**
 * Merge `source` into `target` (both MonoWorkbook). Mutates `target` and
 * empties nothing in `source` (caller discards it afterwards).
 * Returns { renames, movedSheetIds } for the caller's bookkeeping.
 */
export function mergeWorkbooks(target, source) {
  // 1) Move sheets across, renaming on collision (Sheet1 → Sheet1 (2)).
  const renames = new Map();
  const movedSheetIds = [];
  for (const sh of source.sheets) {
    const base = sh.name; let name = base, i = 1;
    while (target.sheets.some((x) => x.name === name)) name = base + ' (' + (++i) + ')';
    if (name !== base) renames.set(base, name);
    sh.name = name;
    target.sheets.push(sh);
    movedSheetIds.push(sh.id);
  }
  // 2) Remap source named ranges (skip on name collision — target wins).
  for (const [key, spec] of Object.entries(source.namedRanges || {})) {
    if (!target.namedRanges[key]) target.namedRanges[key] = { ...spec };
  }
  // 3) Rewrite IMPORTRANGE formulas in target that pointed at source.
  const keys = new Set([String(source.id), String(source.name)]);
  const defaultSheet = source.sheets[0] ? source.sheets[0].name : null;
  for (const sh of target.sheets) {
    for (const [, cell] of sh.cells) {
      if (cell.raw && cell.raw[0] === '=' && /importrange/i.test(cell.raw)) {
        cell.raw = rewriteImportRangeFormula(cell.raw, keys, renames, defaultSheet);
      }
    }
  }
  return { renames, movedSheetIds };
}

export default mergeWorkbooks;
