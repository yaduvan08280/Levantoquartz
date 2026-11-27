// ============================================================
//  Mono formula engine — interpreter (Phase 2 + 4)
//  Tree-walk evaluator. Phase 4 adds array broadcasting (arrayMode,
//  for ARRAYFORMULA), LET/LAMBDA locals, and applyLambda.
// ============================================================
import { ERR, err, isError } from './errors.js';
import { isArray, makeArray, scalar, toNumber, toText, compare } from './values.js';
import { concreteRange } from './references.js';

export function evaluate(node, ctx) {
  switch (node.type) {
    case 'num': case 'str': case 'bool': return node.value;
    case 'err': return node.value;
    case 'blank': return null;
    case 'ref': return evalRef(node, ctx);
    case 'range': return evalRange(node, ctx);
    case 'name':
      if (ctx.locals && ctx.locals.has(node.name)) return ctx.locals.get(node.name);
      return ctx.resolveName ? ctx.resolveName(node) : err(ERR.NAME, 'Unknown name: ' + node.name);
    case 'unary': return evalUnary(node, ctx);
    case 'binary': return evalBinary(node, ctx);
    case 'array': return evalArrayLiteral(node, ctx);
    case 'call': return evalCall(node, ctx);
    default: return err(ERR.ERROR);
  }
}
/* An array literal stacks whatever its elements evaluate to, and an element
   can itself be an array. This used to call scalar() on every element, so
       ={"Duplicate Check"; ARRAYFORMULA(...)}
   collapsed the second row to one value and produced #VALUE! — a header above
   a computed column, which is how people actually write these, never worked.
   `,` joins side by side and `;` stacks, the same rules HSTACK and VSTACK
   already use; short rows are padded with null so the result stays
   rectangular. */
function evalArrayLiteral(node, ctx) {
  const out = [];
  for (const row of node.rows) {
    const parts = row.map((n) => { const v = evaluate(n, ctx); return isArray(v) ? v.data : [[scalar(v)]]; });
    const height = Math.max(1, ...parts.map((p) => p.length));
    for (let r = 0; r < height; r++) {
      let line = [];
      for (const p of parts) {
        const w = p[0] ? p[0].length : 1;
        line = line.concat(p[r] || new Array(w).fill(null));
      }
      out.push(line);
    }
  }
  const width = Math.max(1, ...out.map((r) => r.length));
  for (const r of out) while (r.length < width) r.push(null);
  return makeArray(out);
}

const targetSheet = (node, ctx) => node.sheet ? ctx.resolveSheetId(node.sheet) : ctx.sheetId;
function evalRef(node, ctx) { const sid = targetSheet(node, ctx); if (sid == null) return err(ERR.REF, 'Unknown sheet'); return ctx.readCell(sid, node.row, node.col); }
function evalRange(node, ctx) {
  const sid = targetSheet(node, ctx); if (sid == null) return err(ERR.REF);
  const dims = ctx.sheetDims(sid); const { c1, r1, c2, r2 } = concreteRange(node, dims.rows, dims.cols);
  // Memoised for the duration of ONE cell's evaluation. ctxFor() builds a
  // fresh context per cell, so the cache is discarded with it and cannot go
  // stale — nothing mutates the sheet while a single formula is running.
  //
  // This is what a Google Sheets export of a real workbook costs without it:
  //   =MAP(F7:F3614, LAMBDA(f, ... XLOOKUP(f, 'Mixer Form'!C:C, ...)))
  // re-materialises that whole column 3,608 times, once per lambda call.
  // About 20 formulas of this shape, ~1.2 s each, ~24 s of a 30 s recalc.
  //
  // ponytail: the cached array is SHARED between callers in the same
  // evaluation. Every builtin that sorts or reorders currently copies first
  // ([...n], gatherNumbers, SORTN's row .slice()), so this holds — but a
  // future builtin that mutates its input in place would corrupt the cache.
  // Upgrade path if that happens: freeze the rows, or cache only the row
  // arrays and rebuild the wrapper per call.
  const cache = ctx.rangeCache;
  const key = cache ? sid + '|' + r1 + '|' + c1 + '|' + r2 + '|' + c2 : null;
  if (cache) { const hit = cache.get(key); if (hit !== undefined) return hit; }
  const data = []; for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(ctx.readCell(sid, r, c)); data.push(row); }
  const out = makeArray(data);
  if (cache) cache.set(key, out);
  return out;
}

export function binScalar(op, a, b) {
  if (isError(a)) return a; if (isError(b)) return b;
  if (op === '&') { const x = toText(a); if (isError(x)) return x; const y = toText(b); if (isError(y)) return y; return x + y; }
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') { const c = compare(a, b); return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0; }
  const x = toNumber(a); if (isError(x)) return x; const y = toNumber(b); if (isError(y)) return y;
  switch (op) { case '+': return x + y; case '-': return x - y; case '*': return x * y; case '/': return y === 0 ? err(ERR.DIV0) : x / y; case '^': { const r = Math.pow(x, y); return Number.isFinite(r) ? r : err(ERR.NUM); } }
  return err(ERR.ERROR);
}
export function broadcast(op, a, b) {
  const rows = Math.max(isArray(a) ? a.rows : 1, isArray(b) ? b.rows : 1);
  const cols = Math.max(isArray(a) ? a.cols : 1, isArray(b) ? b.cols : 1);
  const at = (arr, r, c) => isArray(arr) ? arr.data[arr.rows === 1 ? 0 : r]?.[arr.cols === 1 ? 0 : c] : arr;
  const data = []; for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(binScalar(op, at(a, r, c), at(b, r, c))); data.push(row); }
  return makeArray(data);
}
function evalBinary(node, ctx) {
  const a = evaluate(node.left, ctx), b = evaluate(node.right, ctx);
  if (ctx.arrayMode && (isArray(a) || isArray(b))) return broadcast(node.op, a, b);
  const sa = scalar(a); if (isError(sa)) return sa; const sb = scalar(b); if (isError(sb)) return sb;
  return binScalar(node.op, sa, sb);
}
function unaryScalar(op, v) { if (isError(v)) return v; const n = toNumber(v); if (isError(n)) return n; if (op === '%') return n / 100; return op === '-' ? -n : n; }
function evalUnary(node, ctx) {
  const v = evaluate(node.operand, ctx);
  if (ctx.arrayMode && isArray(v)) return makeArray(v.data.map((row) => row.map((x) => unaryScalar(node.op, x))));
  return unaryScalar(node.op, scalar(v));
}
// Element accessor with 1-row/1-col broadcasting (shared by vectorized builtins).
export const broadcastGet = (v, r, c) => isArray(v) ? v.data[v.rows === 1 ? 0 : r]?.[v.cols === 1 ? 0 : c] : v;
export const isMulti = (v) => isArray(v) && (v.rows > 1 || v.cols > 1);
export function applyLambda(lam, argVals, ctx) {
  const locals = lam.closure ? new Map(lam.closure) : new Map();
  lam.params.forEach((p, i) => locals.set(p, argVals[i]));
  return evaluate(lam.body, Object.assign({}, ctx, { locals }));
}
function evalCall(node, ctx) {
  const def = ctx.registry.get(node.name);
  if (!def) { if (ctx.callCustom) { const cr = ctx.callCustom(node.name, node.args.map((a) => evaluate(a, ctx))); if (cr !== undefined) return cr; } return err(ERR.NAME, 'Unknown function: ' + node.name); }
  if (def.min != null && node.args.length < def.min) return err(ERR.NA, node.name + ' needs at least ' + def.min + ' argument(s)');
  if (def.max != null && node.args.length > def.max) return err(ERR.VALUE, node.name + ' takes at most ' + def.max + ' argument(s)');
  if (def.lazy) return def.fn(node.args, ctx, (n, c) => evaluate(n, c || ctx));
  // Array-consuming functions (SUM, FILTER, SORT, VLOOKUP, …) evaluate their
  // argument expressions in arrayMode so nested vector logic (A:A*2,
  // IF(A:A>1,…), LEN(A:A), …) broadcasts instead of collapsing to a scalar.
  const argCtx = (def.arrayAware && !ctx.arrayMode) ? Object.assign({}, ctx, { arrayMode: true }) : ctx;
  const args = node.args.map((a) => evaluate(a, argCtx));
  if (!def.passErrors) for (const a of args) if (isError(a)) return a;
  if (ctx.arrayMode && !def.arrayAware && args.some(isArray)) return mapCall(def, args, ctx);
  return def.fn(args, ctx);
}
function mapCall(def, args, ctx) {
  const rows = Math.max(...args.map((a) => isArray(a) ? a.rows : 1));
  const cols = Math.max(...args.map((a) => isArray(a) ? a.cols : 1));
  const at = (a, r, c) => isArray(a) ? a.data[a.rows === 1 ? 0 : r]?.[a.cols === 1 ? 0 : c] : a;
  const data = [];
  for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) { const ca = args.map((a) => at(a, r, c)); const e = def.passErrors ? null : ca.find(isError); row.push(e || scalar(def.fn(ca, ctx))); } data.push(row); }
  return makeArray(data);
}
export default evaluate;
