// ============================================================
//  Mono formula engine — AST serializer (Phase 2.5)
//  ast -> formula string. Rewrites references on insert/delete and
//  on paste-translate. Adds parens only where precedence requires.
// ============================================================
import { formatCell, colToLetters } from './references.js';

const PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
const precOf = (n) => n.type === 'binary' ? (PREC[n.op] || 0) : n.type === 'unary' ? (n.op === '%' ? 7 : 6) : 9;
const needsQuote = (name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
const sheetPrefix = (name) => (needsQuote(name) ? "'" + String(name).replace(/'/g, "''") + "'" : name) + '!';

function wrapChild(n, parentPrec, parentRightAssoc, side) {
  const s = serialize(n); const p = precOf(n);
  let wrap = p < parentPrec;
  if (p === parentPrec) { if (side === 'right' && !parentRightAssoc) wrap = true; if (side === 'left' && parentRightAssoc) wrap = true; }
  return wrap ? '(' + s + ')' : s;
}
function serRange(n) {
  const sp = n.sheet ? sheetPrefix(n.sheet) : '';
  if (n.kind === 'cols') return sp + colToLetters(n.c1) + ':' + colToLetters(n.c2);
  if (n.kind === 'rows') return sp + (n.r1 + 1) + ':' + (n.r2 + 1);
  if (n.kind === 'colsFrom') return sp + formatCell(n.c1, n.r1, n.a1 && n.a1.colAbs, n.a1 && n.a1.rowAbs) + ':' + colToLetters(n.c2);
  return sp + formatCell(n.c1, n.r1, n.a1 && n.a1.colAbs, n.a1 && n.a1.rowAbs) + ':' + formatCell(n.c2, n.r2, n.a2 && n.a2.colAbs, n.a2 && n.a2.rowAbs);
}
export function serialize(node) {
  switch (node.type) {
    case 'num': return String(node.value);
    case 'str': return '"' + String(node.value).replace(/"/g, '""') + '"';
    case 'bool': return node.value ? 'TRUE' : 'FALSE';
    case 'err': return node.value.type;
    case 'blank': return '';
    case 'ref': return (node.sheet ? sheetPrefix(node.sheet) : '') + formatCell(node.col, node.row, node.colAbs, node.rowAbs);
    case 'range': return serRange(node);
    case 'name': return (node.sheet ? sheetPrefix(node.sheet) : '') + node.name;
    case 'unary': { const inner = wrapChild(node.operand, node.op === '%' ? 7 : 6, false, 'left'); return node.op === '%' ? inner + '%' : node.op + inner; }
    case 'binary': { const p = PREC[node.op]; const ra = node.op === '^'; return wrapChild(node.left, p, ra, 'left') + node.op + wrapChild(node.right, p, ra, 'right'); }
    case 'call': return node.name + '(' + node.args.map((a) => serialize(a)).join(',') + ')';
    case 'array': return '{' + node.rows.map((r) => r.map(serialize).join(',')).join(';') + '}';
    default: return '';
  }
}
export default serialize;
