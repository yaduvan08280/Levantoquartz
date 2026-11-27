// ============================================================
//  Mono — Formula Explainer
//  Walks the Pratt Parser AST to explain formulas locally.
// ============================================================
import { parse } from '../engine/parser.js';

function walk(node, depth = 0) {
  if (!node) return '';
  const pad = '  '.repeat(depth);
  switch (node.type) {
    case 'num': return `${node.value}`;
    case 'str': return `"${node.value}"`;
    case 'bool': return node.value ? 'TRUE' : 'FALSE';
    case 'err': return `error (${node.value})`;
    case 'ref': return `cell ${node.colAbs ? '$' : ''}${String.fromCharCode(65 + node.col)}${node.rowAbs ? '$' : ''}${node.row + 1}`;
    case 'name': return `named range "${node.name}"`;
    case 'call': {
      const args = node.args.map(a => walk(a, depth + 1));
      return `the ${node.name} function applied to: ${args.join(', ')}`;
    }
    case 'binary':
      return `${walk(node.left, depth)} ${node.op} ${walk(node.right, depth)}`;
    case 'unary':
      return `${node.op}${walk(node.operand, depth)}`;
    case 'range':
      return `the range from column ${String.fromCharCode(65 + node.c1)} to ${String.fromCharCode(65 + node.c2)} (rows ${node.r1 + 1} to ${node.r2 + 1})`;
    case 'array':
      return `an array literal`;
    case 'blank':
      return `(empty)`;
    default:
      return 'something else';
  }
}

/**
 * Returns a human-readable breakdown of a formula.
 * @param {string} formula - The raw formula string (with or without =)
 */
export function explainFormula(formula) {
  if (!formula || typeof formula !== 'string') return 'Not a formula.';
  let f = formula.trim();
  if (f.startsWith('=')) f = f.slice(1);
  try {
    const ast = parse(f);
    return `This formula calculates:\n${walk(ast)}`;
  } catch (e) {
    return `Could not parse this formula: ${e.message}`;
  }
}

