// ============================================================
//  Mono formula engine — parser (Phase 2)
//  Pratt parser → AST. (AST nodes are plain objects; ast.js folded
//  in here.) Precedence matches Sheets; '^' right-assoc; unary minus
//  binds tighter than '^' (Excel-style: -2^2 = 4).
// ============================================================
import { lex } from './lexer.js';
import { parseCell, lettersToCol, isColText } from './references.js';

const LBP = { '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10, '&': 20, '+': 30, '-': 30, '*': 40, '/': 40, '^': 50 };

export function parse(formula) {
  const toks = lex(formula);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (type) => { const t = next(); if (t.type !== type) throw new Error('Expected ' + type + ', got ' + t.type); return t; };

  function parseExpr(minbp) {
    let left = parsePrefix();
    while (true) {
      const t = peek();
      if (t.type !== 'op') break;
      if (t.op === '%') { next(); left = { type: 'unary', op: '%', operand: left }; continue; }
      const bp = LBP[t.op];
      if (bp == null || bp < minbp) break;
      next();
      const right = parseExpr(t.op === '^' ? bp : bp + 1);
      left = { type: 'binary', op: t.op, left, right };
    }
    return left;
  }

  function parsePrefix() {
    const t = peek();
    if (t.type === 'op' && (t.op === '-' || t.op === '+')) { next(); return { type: 'unary', op: t.op, operand: parseExpr(60) }; }
    let node = parsePrimary();
    if (peek().type === 'colon') { next(); node = makeRange(node, parsePrimary()); }
    return node;
  }

  function makeRange(a, b) {
    if (a.type === 'ref' && b.type === 'ref') {
      return { type: 'range', sheet: a.sheet || b.sheet || null, kind: 'cells', c1: a.col, r1: a.row, c2: b.col, r2: b.row };
    }
    const isColN = (n) => n.type === 'name' && isColText(n.name);
    const isRowN = (n) => n.type === 'num' && Number.isInteger(n.value);
    if (isColN(a) && isColN(b)) return { type: 'range', sheet: a.sheet || null, kind: 'cols', c1: lettersToCol(a.name), c2: lettersToCol(b.name), r1: null, r2: null };
    if (isRowN(a) && isRowN(b)) return { type: 'range', sheet: null, kind: 'rows', r1: a.value - 1, r2: b.value - 1, c1: null, c2: null };
    /* C2:C - "column C from row 2 down to the bottom". Google Sheets exports
       are full of these; this used to set r2 = a.row, making it a ONE ROW
       range, so FILTER('unique codes'!C2:C, ...) only ever looked at C2 and
       quietly returned nothing. Its own kind because r2 stays open: the
       'cells' paths do arithmetic on r2, and a null there would corrupt the
       formula on the next row insert. */
    if (a.type === 'ref' && isColN(b)) return { type: 'range', sheet: a.sheet || null, kind: 'colsFrom', c1: a.col, r1: a.row, c2: lettersToCol(b.name), r2: null, a1: a };
    throw new Error('Invalid range');
  }

  function parsePrimary() {
    const t = next();
    switch (t.type) {
      case 'num': return { type: 'num', value: t.value };
      case 'str': return { type: 'str', value: t.value };
      case 'bool': return { type: 'bool', value: t.value };
      case 'err': return { type: 'err', value: t.value };
      case 'ref': { const c = parseCell(t.text); return { type: 'ref', sheet: t.sheet || null, col: c.col, row: c.row, colAbs: c.colAbs, rowAbs: c.rowAbs }; }
      case 'name': return { type: 'name', sheet: t.sheet || null, name: t.text };
      case 'func': {
        expect('lp');
        const args = [];
        if (peek().type !== 'rp') { args.push(parseArg()); while (peek().type === 'comma') { next(); args.push(parseArg()); } }
        expect('rp');
        return { type: 'call', name: t.text.toUpperCase(), args };
      }
      case 'lp': { const e = parseExpr(0); expect('rp'); return e; }
      case 'lbrace': return parseArrayLit();
      default: throw new Error('Unexpected token: ' + t.type);
    }
  }

  function parseArg() { if (peek().type === 'comma' || peek().type === 'rp') return { type: 'blank' }; return parseExpr(0); }

  function parseArrayLit() {
    const rows = []; let row = [];
    if (peek().type !== 'rbrace') {
      row.push(parseExpr(0));
      while (peek().type === 'comma' || peek().type === 'semi') { const sep = next().type; if (sep === 'semi') { rows.push(row); row = []; } row.push(parseExpr(0)); }
    }
    rows.push(row);
    expect('rbrace');
    return { type: 'array', rows };
  }

  const ast = parseExpr(0);
  if (peek().type !== 'eof') throw new Error('Unexpected trailing token: ' + peek().type);
  return ast;
}
export default parse;
