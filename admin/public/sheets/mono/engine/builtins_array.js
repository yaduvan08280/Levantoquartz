// ============================================================
//  Mono formula engine — array & lambda functions (Phase 4)
//  Dynamic-array family. These return MonoArray values, which the
//  engine spills into neighbouring cells.
// ============================================================
import { registry } from './registry.js';
import { ERR, err, isError } from './errors.js';
import { isArray, makeArray, scalar, toNumber, toBool, compare, flatten, flatOf } from './values.js';
import { applyLambda } from './interpreter.js';
import { query } from './query.js';

const reg = (d) => registry.register(d);
const mat = (v) => isArray(v) ? v.data : [[v]];
const num = (v) => toNumber(scalar(v));
const isLambda = (v) => v && v.__lambda === true;

/* ---- lazy: ARRAYFORMULA / LAMBDA / LET ---- */
reg({ name: 'ARRAYFORMULA', aliases: ['ARRAY_FORMULA'], min: 1, max: 1, lazy: true, fn: (args, ctx, ev) => ev(args[0], Object.assign({}, ctx, { arrayMode: true })) });
reg({ name: 'LAMBDA', min: 1, lazy: true, fn: (args, ctx) => ({ __lambda: true, params: args.slice(0, -1).map((n) => n.name), body: args[args.length - 1], closure: ctx.locals ? new Map(ctx.locals) : null }) });
reg({ name: 'LET', min: 3, lazy: true, fn: (args, ctx, ev) => { const locals = ctx.locals ? new Map(ctx.locals) : new Map(); for (let i = 0; i + 1 < args.length; i += 2) locals.set(args[i].name, ev(args[i + 1], Object.assign({}, ctx, { locals }))); return ev(args[args.length - 1], Object.assign({}, ctx, { locals })); } });

/* ---- lambda-consuming ---- */
reg({ name: 'MAKEARRAY', min: 3, max: 3, fn: (a, ctx) => { const rows = num(a[0]), cols = num(a[1]), lam = a[2]; if (isError(rows)) return rows; if (isError(cols)) return cols; if (!isLambda(lam)) return err(ERR.VALUE, 'MAKEARRAY needs a LAMBDA'); if (rows < 1 || cols < 1 || rows * cols > 1e6) return err(ERR.NUM); const data = []; for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(scalar(applyLambda(lam, [r + 1, c + 1], ctx))); data.push(row); } return makeArray(data); } });
reg({ name: 'MAP', min: 2, fn: (a, ctx) => { const lam = a[a.length - 1]; if (!isLambda(lam)) return err(ERR.VALUE, 'MAP needs a LAMBDA'); const arrs = a.slice(0, -1).map(mat); const rows = arrs[0].length, cols = arrs[0][0] ? arrs[0][0].length : 0; const data = []; for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(scalar(applyLambda(lam, arrs.map((m) => m[r] ? m[r][c] : null), ctx))); data.push(row); } return makeArray(data); } });
reg({ name: 'REDUCE', min: 3, max: 3, fn: (a, ctx) => { let acc = scalar(a[0]); const lam = a[2]; if (!isLambda(lam)) return err(ERR.VALUE); for (const row of mat(a[1])) for (const v of row) acc = applyLambda(lam, [acc, v], ctx); return scalar(acc); } });
reg({ name: 'SCAN', min: 3, max: 3, fn: (a, ctx) => { let acc = scalar(a[0]); const lam = a[2]; if (!isLambda(lam)) return err(ERR.VALUE); return makeArray(mat(a[1]).map((row) => row.map((v) => { acc = applyLambda(lam, [acc, v], ctx); return scalar(acc); }))); } });
reg({ name: 'BYROW', min: 2, max: 2, fn: (a, ctx) => { const lam = a[1]; if (!isLambda(lam)) return err(ERR.VALUE); return makeArray(mat(a[0]).map((row) => [scalar(applyLambda(lam, [makeArray([row])], ctx))])); } });
reg({ name: 'BYCOL', min: 2, max: 2, fn: (a, ctx) => { const m = mat(a[0]); const lam = a[1]; if (!isLambda(lam)) return err(ERR.VALUE); const cols = m[0] ? m[0].length : 0; const out = []; for (let c = 0; c < cols; c++) out.push(scalar(applyLambda(lam, [makeArray(m.map((row) => [row[c]]))], ctx))); return makeArray([out]); } });

/* ---- pure array transforms ---- */
reg({ name: 'FILTER', min: 2, lazy: true, fn: (args, ctx, ev) => { const m = mat(ev(args[0], Object.assign({}, ctx, { arrayMode: true }))); const conds = args.slice(1).map((n) => mat(ev(n, Object.assign({}, ctx, { arrayMode: true })))); const keep = []; for (let r = 0; r < m.length; r++) { let ok = true; for (const cm of conds) { if (!toBool(cm[r] ? cm[r][0] : null)) { ok = false; break; } } if (ok) keep.push(m[r]); } return keep.length ? makeArray(keep) : err(ERR.NA, 'No matches'); } });
reg({ name: 'SORT', min: 1, fn: (a) => { const m = mat(a[0]).map((r) => r.slice()); const col = a.length > 1 ? num(a[1]) - 1 : 0; const asc = a.length > 2 ? toBool(scalar(a[2])) : true; m.sort((x, y) => { const cmp = compare(x[col], y[col]); return asc ? cmp : -cmp; }); return makeArray(m); } });
reg({ name: 'UNIQUE', min: 1, max: 1, fn: (a) => { const seen = new Set(), out = []; for (const row of mat(a[0])) { const k = JSON.stringify(row.map((v) => v && v.__error ? v.type : v)); if (!seen.has(k)) { seen.add(k); out.push(row); } } return makeArray(out); } });
reg({ name: 'SEQUENCE', min: 1, max: 4, fn: (a) => { const rows = num(a[0]), cols = a.length > 1 ? num(a[1]) : 1, start = a.length > 2 ? num(a[2]) : 1, step = a.length > 3 ? num(a[3]) : 1; if ([rows, cols, start, step].some(isError)) return err(ERR.VALUE); if (rows < 1 || cols < 1 || rows * cols > 1e6) return err(ERR.NUM); const data = []; let v = start; for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) { row.push(v); v += step; } data.push(row); } return makeArray(data); } });
reg({ name: 'TRANSPOSE', min: 1, max: 1, fn: (a) => { const m = mat(a[0]); const rows = m.length, cols = m[0] ? m[0].length : 0; const out = []; for (let c = 0; c < cols; c++) { const row = []; for (let r = 0; r < rows; r++) row.push(m[r][c]); out.push(row); } return makeArray(out); } });
reg({ name: 'FLATTEN', min: 1, fn: (a) => { const out = []; for (const x of a) for (const v of flatten(x)) out.push([v]); return makeArray(out); } });
reg({ name: 'VSTACK', min: 1, fn: (a) => { const mats = a.map(mat); const cols = Math.max(...mats.map((m) => m[0] ? m[0].length : 0)); const out = []; for (const m of mats) for (const row of m) { const r = row.slice(); while (r.length < cols) r.push(null); out.push(r); } return makeArray(out); } });
reg({ name: 'HSTACK', min: 1, fn: (a) => { const mats = a.map(mat); const rows = Math.max(...mats.map((m) => m.length)); const out = []; for (let r = 0; r < rows; r++) { let row = []; for (const m of mats) row = row.concat(m[r] || new Array(m[0] ? m[0].length : 0).fill(null)); out.push(row); } return makeArray(out); } });
reg({ name: 'TOROW', min: 1, fn: (a) => makeArray([flatten(a[0])]) });
reg({ name: 'TOCOL', min: 1, fn: (a) => makeArray(flatten(a[0]).map((v) => [v])) });
reg({ name: 'CHOOSEROWS', min: 2, fn: (a) => { const m = mat(a[0]); return makeArray(a.slice(1).map(num).map((i) => (m[i < 0 ? m.length + i : i - 1] || []).slice())); } });
reg({ name: 'CHOOSECOLS', min: 2, fn: (a) => { const m = mat(a[0]); const idx = a.slice(1).map(num); return makeArray(m.map((row) => idx.map((i) => row[i < 0 ? row.length + i : i - 1]))); } });

/* ---- XLOOKUP ---- */
/* XLOOKUP's linear scan, indexed.

   The shape that matters is a lookup driven by MAP over a whole column:
     =MAP(F7:F3614, LAMBDA(f, IFERROR(XLOOKUP(f, 'Batching Form'!C:C,
                                               'Batching Form'!E:E, ""), "")))
   3,608 keys scanned against a 5,188-row column is 18.7 million compare()
   calls for ONE cell. The real workbook has ten of these, ~170 ms each,
   ~1.6 s of a 1.9 s recalcAll() - and insertRows() calls recalcAll().
   evalRange() hands back the SAME array object for the lookup column on
   every iteration, so the column can be indexed once and every key answered
   in O(1). The index is keyed on that array, so it dies with it.

   This only replaces the scan where it is provably the same answer. compare()
   is looser than it looks: rank() maps everything that is not a number,
   string or boolean to 1, so an error value compares EQUAL to any number, and
   NaN compares equal to every number too. A column holding either is left on
   the scan. null is the other trap - compare() coerces it to the other side's
   zero value, so a blank cell equals 0, "" AND false, and blanks are
   registered under all three. First match wins, exactly as the scan did. */
const XL_KEY = (v) => typeof v === 'number' ? 'n:' + v : typeof v === 'boolean' ? 'b:' + v : 's:' + String(v).toLowerCase();
// Values compare() handles by identity rather than by its rank-1 catch-all.
const XL_SIMPLE = (v) => v == null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && !Number.isNaN(v));
const XL_INDEX = new WeakMap();
function xlIndex(arrObj, L) {
  let ix = XL_INDEX.get(arrObj);
  if (ix !== undefined) return ix;                       // null cached too: do not rescan
  ix = new Map();
  for (let i = 0; i < L.length; i++) {
    const v = L[i];
    if (!XL_SIMPLE(v)) { ix = null; break; }              // errors / NaN / objects: keep the scan
    if (v == null) { for (const k of ['n:0', 'b:false', 's:']) if (!ix.has(k)) ix.set(k, i); }
    else { const k = XL_KEY(v); if (!ix.has(k)) ix.set(k, i); }
  }
  XL_INDEX.set(arrObj, ix);
  return ix;
}
reg({ name: 'XLOOKUP', min: 3, max: 6, fn: (a) => {
  const key = scalar(a[0]); const lk = mat(a[1]); const rt = mat(a[2]); const ifnf = a.length > 3 ? a[3] : null;
  const col = lk.length >= 1 && lk[0].length === 1;
  const L = col ? lk.map((r) => r[0]) : lk[0];
  let hit = -1;
  // A null key matches blanks, 0, "" and false all at once - rare, and the
  // scan already picks the earliest of those. Not worth indexing.
  const ix = (key != null && XL_SIMPLE(key) && isArray(a[1])) ? xlIndex(a[1], L) : null;
  if (ix) { const i = ix.get(XL_KEY(key)); if (i !== undefined) hit = i; }
  else { for (let i = 0; i < L.length; i++) if (compare(L[i], key) === 0) { hit = i; break; } }
  if (hit >= 0) { if (col) { const row = rt[hit] || []; return row.length === 1 ? row[0] : makeArray([row]); } return rt[0] ? rt[0][hit] : null; }
  return ifnf == null ? err(ERR.NA) : scalar(ifnf);
} });
/* ---- QUERY / SORTN / RANDARRAY (Phase 4B) ---- */
reg({ name: 'QUERY', min: 2, max: 3, arrayAware: true, fn: (a) => query(mat(a[0]), String(scalar(a[1]) ?? ''), a.length > 2 ? num(a[2]) : null) });
reg({ name: 'SORTN', min: 1, arrayAware: true, fn: (a) => { const m = mat(a[0]).map((r) => r.slice()); const n = a.length > 1 ? num(a[1]) : 1; const sc = a.length > 3 ? num(a[3]) - 1 : 0; const asc = a.length > 4 ? toBool(scalar(a[4])) : true; m.sort((x, y) => { const cmp = compare(x[sc], y[sc]); return asc ? cmp : -cmp; }); return makeArray(m.slice(0, Math.max(0, n))); } });
reg({ name: 'RANDARRAY', min: 0, max: 5, volatile: true, arrayAware: true, fn: (a) => { const rows = a.length > 0 ? num(a[0]) : 1, cols = a.length > 1 ? num(a[1]) : 1, lo = a.length > 2 ? num(a[2]) : 0, hi = a.length > 3 ? num(a[3]) : 1, whole = a.length > 4 ? toBool(scalar(a[4])) : false; if (rows < 1 || cols < 1 || rows * cols > 1e6) return err(ERR.NUM); const data = []; for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(whole ? Math.floor(lo + Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo)); data.push(row); } return makeArray(data); } });

/* ---- generic vectorization of scalar-key/criteria arguments ----
   Wraps a registered function so that when any of the designated argument
   positions receives a multi-cell array (e.g. VLOOKUP(A:A, tbl, 2) or
   COUNTIF(B:B, B:B) inside ARRAYFORMULA), the core logic runs once per
   element and the results spill as an array. `idxs` may be an array of
   positions or a fn(argCount) -> positions for variadic funcs. */
const isMulti = (v) => isArray(v) && (v.rows > 1 || v.cols > 1);
const bAt = (v, r, c) => isArray(v) ? v.data[v.rows === 1 ? 0 : r]?.[v.cols === 1 ? 0 : c] : v;
export function vectorize(name, idxs) {
  const def = registry.get(name); if (!def) return;
  const base = def.fn;
  def.fn = (a, ctx) => {
    const pos = (typeof idxs === 'function' ? idxs(a.length) : idxs).filter((i) => i < a.length);
    const hot = pos.filter((i) => isMulti(a[i]));
    if (!hot.length) return base(a, ctx);
    const rows = Math.max(...hot.map((i) => a[i].rows));
    const cols = Math.max(...hot.map((i) => a[i].cols));
    const data = [];
    for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) {
      const ca = a.slice(); for (const i of hot) ca[i] = bAt(a[i], r, c);
      row.push(scalar(base(ca, ctx)));
    } data.push(row); }
    return makeArray(data);
  };
}
vectorize('VLOOKUP', [0]);
vectorize('HLOOKUP', [0]);
vectorize('MATCH', [0]);
vectorize('XLOOKUP', [0]);
vectorize('INDEX', [1, 2]);
vectorize('COUNTIF', [1]);
/* COUNTIF(range, criteria) where the criteria are themselves a range - the
   duplicate check everyone writes:
     ={"Duplicate Check"; ARRAYFORMULA(IF(C2:C3124="","",
        IF(COUNTIF($C$2:$C$3124,C2:C3124)>1,"Duplicate","")))}
   vectorize() above runs the scalar COUNTIF once per criterion, and each of
   those scans the whole range: 3,123 criteria over 3,123 cells is 9.75
   MILLION critTest() calls, and critTest builds a fresh RegExp on every one.
   Measured on a real workbook, ONE such cell cost 6.2 s, and two of them were
   12.3 s of a 14.1 s recalcAll() - which insertRows/deleteRows call, so
   inserting a single row froze the tab for fourteen seconds.

   A plain criterion - no >, <, >=, <=, <>, = prefix and no * ? ~ wildcard -
   is just equality, so the range can be counted ONCE into a lookup and every
   criterion answered from it: O(n) instead of O(n^2). Operators and wildcards
   still take the original per-criterion scan, so nothing else changes.

   The three maps mirror critTest's branches exactly. A criterion that parses
   as a number compares numerically against numeric cells (v === asNum) and
   textually against everything else, so numeric cells are kept OUT of
   textNonNum and a numeric criterion can never count a cell twice. A
   criterion that does not parse as a number compares textually against every
   cell, numeric ones included - that is textAll. asNum is derived with the
   same expression critTest uses, so odd spellings (' 5', '0x10', 'Infinity')
   land on the same side in both.

   ponytail: text keys fold with toUpperCase(), which is what a
   case-insensitive RegExp does per ECMA-262 Canonicalize. A character whose
   uppercase is a different length (the classic is German sharp s) is the
   known corner; if one ever matters, key those values by identity instead. */
{
  const def = registry.get('COUNTIF');
  const perCriterion = def.fn;                 // vectorize()'s version, still the fallback
  const render = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)).toUpperCase();
  // Keyed on the range array itself. evalRange() memoises a range for the
  // duration of one cell's evaluation and hands back the same object, so the
  // index is built once per formula and cannot outlive the values it counted.
  const INDEX = new WeakMap();
  const indexOf = (arr) => {
    let ix = INDEX.get(arr);
    if (ix) return ix;
    const nums = new Map(), textAll = new Map(), textNonNum = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const v of flatOf(arr)) {
      const t = render(v);
      if (typeof v === 'number') bump(nums, v); else bump(textNonNum, t);
      bump(textAll, t);
    }
    ix = { nums, textAll, textNonNum };
    INDEX.set(arr, ix);
    return ix;
  };
  const countPlain = (ix, rhs) => {
    const asNum = (rhs !== '' && !isNaN(Number(rhs))) ? Number(rhs) : null;
    const key = rhs.toUpperCase();
    return asNum !== null
      ? (ix.nums.get(asNum) || 0) + (ix.textNonNum.get(key) || 0)
      : (ix.textAll.get(key) || 0);
  };
  const plain = (crit) => typeof crit === 'string' && !/^(>=|<=|<>|>|<|=)/.test(crit) && !/[*?~]/.test(crit);
  def.fn = (a, ctx) => {
    const rng = a[0], crits = a[1];
    if (a.length !== 2 || !isArray(rng) || !isMulti(crits)) return perCriterion(a, ctx);
    const ix = indexOf(rng);
    const data = [];
    for (let r = 0; r < crits.rows; r++) {
      const row = [];
      for (let c = 0; c < crits.cols; c++) {
        const crit = crits.data[r] ? crits.data[r][c] : null;
        row.push(plain(crit) ? countPlain(ix, crit) : scalar(perCriterion([rng, crit], ctx)));
      }
      data.push(row);
    }
    return makeArray(data);
  };
}
vectorize('SUMIF', [1]);
vectorize('AVERAGEIF', [1]);
vectorize('COUNTIFS', (n) => { const p = []; for (let i = 1; i < n; i += 2) p.push(i); return p; });
vectorize('SUMIFS', (n) => { const p = []; for (let i = 2; i < n; i += 2) p.push(i); return p; });

/* mark array-consuming functions so ARRAYFORMULA does NOT map them elementwise */
const ARRAY_AWARE = ['ARRAYFORMULA','LAMBDA','LET','MAKEARRAY','MAP','REDUCE','SCAN','BYROW','BYCOL','FILTER','SORT','SORTN','UNIQUE','SEQUENCE','TRANSPOSE','FLATTEN','VSTACK','HSTACK','TOROW','TOCOL','CHOOSEROWS','CHOOSECOLS','XLOOKUP','QUERY','RANDARRAY','SUM','PRODUCT','SUMIF','SUMIFS','AVERAGEIF','SUMPRODUCT','AVERAGE','COUNT','COUNTA','COUNTBLANK','COUNTIF','COUNTIFS','MAX','MIN','MEDIAN','LARGE','SMALL','MODE','AND','OR','XOR','CONCAT','CONCATENATE','TEXTJOIN','VLOOKUP','HLOOKUP','INDEX','MATCH','GCD','LCM'];
for (const n of ARRAY_AWARE) { const d = registry.get(n); if (d) d.arrayAware = true; }

export default registry;
