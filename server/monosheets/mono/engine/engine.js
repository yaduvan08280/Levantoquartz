// ============================================================
//  Mono formula engine — orchestrator (Phase 2 + 2.5)
//  Wraps a MonoWorkbook: parses formulas, maintains the dependency
//  graph, recalculates dirty cells in topological order, and exposes
//  getRaw / getValue / getDisplay / setRaw to the grid.
//  Phase 2.5 adds: structural ops (insert/delete row/col) with
//  reference rewriting, paste-translate, batch edits, and a foreign
//  workbook registry powering IMPORTRANGE.
// ============================================================
import { parse } from './parser.js';
import { serialize } from './serialize.js';
import { evaluate } from './interpreter.js';
import { registry } from './registry.js';
import { CellStore } from '../model/columnStore.js';
import './builtins.js';                 // side-effect: populate the registry
import './builtins_array.js';            // side-effect: array/LAMBDA functions
import './builtins_math2.js';            // GS-parity: trig, combinatorics, bases, matrix, operators
import './builtins_stats.js';            // GS-parity: descriptive stats, regression, distributions
import './builtins_text2.js';            // GS-parity: regex, split/join, formatting, unicode
import './builtins_datetime2.js';        // GS-parity: DATEDIF, NETWORKDAYS, WORKDAY, WEEKNUM, YEARFRAC
import './builtins_financial.js';        // GS-parity: TVM, cash flows, depreciation, T-bills
import './builtins_engineering.js';      // GS-parity: base conversions, bitwise, complex numbers
import './builtins_misc.js';             // GS-parity: OFFSET/XMATCH/CELL, D-functions, service stubs
import './builtins_arrayflags.js';       // MUST be last: arrayAware flags + key vectorization for all modules
import { Graph } from './depgraph.js';
import { activeJournal } from '../model/undoJournal.js';
import { trackSheetRebuilt } from '../model/changeTracker.js';
import { ERR, err, isError } from './errors.js';
import { numToStr, makeArray } from './values.js';
import { formatValue } from './numberFormat.js';
import { concreteRange, parseCell, shiftIndex } from './references.js';
import { shiftRowIdsInsert, shiftRowIdsDelete, ensureRowIds } from '../model/rowId.js';
import { cellTypeFor } from '../model/cellTypes.js';

/* ---------- H8 (performance_resolution_report.md): shared AST cache ----------
   Parsing is the expensive half of recalcAll(), and recalcAll() re-parses
   every formula in the workbook — including after every structural op
   (insert/delete row/col all end in recalcAll). Formula text repeats heavily
   across cells and recalcs, so parse results are memoized by formula body.

   SAFETY INVARIANT — cached ASTs are SHARED and must never be mutated:
   - evaluate() (interpreter.js) only reads nodes — verified, no writes.
   - collectDeps / isVolatileAst / _astUsesImportRange only read — verified.
   - the ONLY code that mutates AST nodes is _transformFormula(), and it
     deliberately calls parse() directly (not parseShared) so it always
     mutates a private, freshly parsed copy.
   If you add a new AST consumer that mutates nodes, parse a fresh copy. */
const _astCache = new Map();          // formula body -> AST | {__parseError}
const AST_CACHE_MAX = 5000;
function parseShared(body) {
  let ast = _astCache.get(body);
  if (ast === undefined) {
    try { ast = parse(body); } catch (e) { ast = { __parseError: e.message || 'parse error' }; }
    if (_astCache.size >= AST_CACHE_MAX) _astCache.clear();   // simple, rare, safe
    _astCache.set(body, ast);
  }
  return ast;
}

// Structural ops rebuild the whole cell map, so they are journalled
// analytically: the inverse of "insert 3 rows at 5" is a relabelling, and
// needs no data at all. A delete additionally keeps the band it removed.
function recordStruct(sh, op) {
  const j = activeJournal();
  if (j && j.open) j.recordStruct(op);
  // Every cell below the insert/delete point moves, so no cell-level patch can
  // describe this sheet any more - the next save sends it whole.
  trackSheetRebuilt(op.sid);
}

function bandCells(sh, axis, at, count) {
  const out = {};
  for (const [k, cell] of sh.cells) {
    const i = k.indexOf(',');
    const idx = axis === 'row' ? +k.slice(0, i) : +k.slice(i + 1);
    if (idx >= at && idx < at + count) out[k] = { ...cell };
  }
  return out;
}

export class Engine {
  constructor(workbook) {
    this.wb = workbook;
    this.graph = new Graph();
    this.asts = new Map();      // addr -> ast | {__parseError}
    this.values = new Map();    // addr -> Value
    this.volatile = new Set();  // addr with a volatile function
    this.foreign = new Map();   // key -> Engine (for IMPORTRANGE)
    this.customResolver = null; // (name, jsArgs) -> jsValue | undefined  (Mono Scripts)
    this.spills = new Map();    // anchorAddr -> {rows,cols,data,sid,r,c}
    this.spillOwner = new Map();// coveredAddr -> anchorAddr
    this._pending = new Set();
    this.anchorWish = new Map();
    this.wishIndex = new Map();
    // P20 — cross-workbook liveness: other engines (or the app shell) can
    // subscribe to be told "my values just changed", so their IMPORTRANGE
    // formulas targeting this workbook stay live while both are open.
    this._subs = new Set();     // Set<fn()>
    this._quiet = false;        // suppress notifications during foreign-driven recalcs
    this.recalcAll();
  }

  /* ---------- addressing ---------- */
  key(sid, r, c) { return sid + '|' + r + '|' + c; }
  parseKey(k) { const i = k.lastIndexOf('|'); const j = k.lastIndexOf('|', i - 1); return { sid: k.slice(0, j), r: +k.slice(j + 1, i), c: +k.slice(i + 1) }; }
  sheetById(id) { return this.wb.sheets.find((s) => s.id === id); }
  resolveId(name) { const sh = this.wb.sheets.find((x) => x.name.toLowerCase() === String(name).toLowerCase()); return sh ? sh.id : null; }

  /* ---------- foreign workbooks (IMPORTRANGE) ---------- */
  registerForeign(key, engine) { this.foreign.set(String(key), engine); this.recalcForeign(String(key)); }
  // On close/disconnect we deliberately do NOT recompute: cells that pull from
  // the closed workbook keep their last computed value (stale) instead of
  // flipping to #REF!. Only a later edit that re-evaluates them surfaces the
  // missing source as an error (reusing the existing error styling).
  unregisterForeign(key) { this.foreign.delete(String(key)); }

  /* ---------- P20: change subscriptions (cross-workbook liveness) ---------- */
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _notifySubs() { if (this._quiet || !this._subs.size) return; for (const fn of [...this._subs]) { try { fn(this); } catch {} } }
  // Cheap value signature for "did anything actually change?" checks — keeps
  // notification chains between workbooks finite (they stop once values settle).
  _valSig(v) {
    if (v == null) return '';
    if (v.__error) return '#' + v.type;
    if (v.__array) { let s = 'A'; for (const row of v.data) for (const x of row) s += '|' + this._valSig(x); return s; }
    return typeof v + ':' + String(v);
  }
  _astUsesImportRange(ast, key) {
    let hit = false;
    const walk = (n) => {
      if (!n || typeof n !== 'object' || hit) return;
      if (n.type === 'call' && /^importrange$/i.test(n.name)) {
        const a0 = n.args && n.args[0];
        // Literal key must match; a computed key (non-literal) always matches.
        if (key == null || !a0 || a0.type !== 'str' || String(a0.value) === String(key)) { hit = true; return; }
      }
      for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); }
    };
    walk(ast); return hit;
  }
  /**
   * Re-evaluate every formula that uses IMPORTRANGE (optionally only those
   * pointing at `key`). Called when a source workbook's engine reports a
   * change. Notifies this engine's own subscribers only if a value actually
   * changed, so A→B→C chains propagate but cycles terminate.
   * Returns true if any importing cell's value changed.
   */
  recalcForeign(key) {
    const seeds = [];
    for (const [addr, ast] of this.asts) { if (!ast.__parseError && this._astUsesImportRange(ast, key)) seeds.push(addr); }
    if (!seeds.length) return false;
    const before = new Map(seeds.map((a) => [a, this._valSig(this.values.get(a))]));
    const wasQuiet = this._quiet; this._quiet = true;
    try { this.recompute(seeds); } finally { this._quiet = wasQuiet; }
    let changed = false;
    for (const a of seeds) if (this._valSig(this.values.get(a)) !== before.get(a)) { changed = true; break; }
    if (changed) this._notifySubs();
    return changed;
  }
  importRange(key, rangeText) {
    const fe = this.foreign.get(String(key));
    if (!fe) return err(ERR.REF, 'Unknown source: ' + key);
    let sheetName = null, body = String(rangeText);
    const bang = body.indexOf('!'); if (bang >= 0) { sheetName = body.slice(0, bang).replace(/^'|'$/g, ''); body = body.slice(bang + 1); }
    const sid = sheetName ? fe.resolveId(sheetName) : fe.wb.sheets[0].id;
    if (sid == null) return err(ERR.REF);
    const parts = body.split(':');
    const a = parseCell(parts[0].toUpperCase()); if (!a) return err(ERR.REF);
    if (parts.length === 1) return fe.valueAt(sid, a.row, a.col);
    const b = parseCell(parts[1].toUpperCase()); if (!b) return err(ERR.REF);
    const data = [];
    for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) { const row = []; for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) row.push(fe.valueAt(sid, r, c)); data.push(row); }
    return makeArray(data);
  }

  resolveName(node) {
    const nr = this.wb.getNamedRange(node.name);
    if (!nr) return err(ERR.NAME, 'Unknown name: ' + node.name);
    if (nr.r1 === nr.r2 && nr.c1 === nr.c2) return this.valueAt(nr.sid, nr.r1, nr.c1);
    const data = [];
    for (let r = nr.r1; r <= nr.r2; r++) { const row = []; for (let c = nr.c1; c <= nr.c2; c++) row.push(this.valueAt(nr.sid, r, c)); data.push(row); }
    return makeArray(data);
  }

  setCustomResolver(fn) { this.customResolver = fn; }
  callCustom(name, argValues) {
    if (!this.customResolver) return undefined;
    const cellJs = (v) => v == null ? '' : (v && v.__error ? v.type : v);
    const jsArgs = argValues.map((a) => (a && a.__array) ? a.data.map((row) => row.map(cellJs)) : cellJs(a));
    let out; try { out = this.customResolver(name, jsArgs); } catch (e) { return err(ERR.ERROR, String(e && e.message || e)); }
    if (out === undefined) return undefined;
    const toVal = (x) => x == null ? '' : (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') ? x : String(x);
    if (Array.isArray(out)) { const rows = Array.isArray(out[0]) ? out : [out]; return makeArray(rows.map((r) => (Array.isArray(r) ? r : [r]).map(toVal))); }
    return toVal(out);
  }

  /* ---------- evaluation context ---------- */
  ctxFor(sid, r, c) {
    const self = this;
    return {
      sheetId: sid, r, c, registry,
      // Range results, memoised for this one cell's evaluation — see
      // evalRange in interpreter.js. Fresh per cell, so it cannot go stale.
      rangeCache: new Map(),
      readCell(s, row, col) { return self.valueAt(s, row, col); },
      getRaw(s, row, col) { return self.getRaw(s, row, col); },   // FORMULATEXT / ISFORMULA
      resolveSheetId(name) { return self.resolveId(name); },
      sheetDims(s) { const sh = self.sheetById(s); return sh ? { rows: sh.rows, cols: sh.cols } : { rows: 0, cols: 0 }; },
      importRange(k, rt) { return self.importRange(k, rt); },
      resolveName(node) { return self.resolveName(node); },
      callCustom(name, args) { return self.callCustom(name, args); },
    };
  }
  valueAt(sid, r, c) {
    const k = this.key(sid, r, c);
    const owner = this.spillOwner.get(k);
    if (owner !== undefined) { const sp = this.spills.get(owner); if (sp) return sp.data[r - sp.r][c - sp.c]; }
    const v = this.values.get(k);
    if (v !== undefined) return v;
    // A literal cell is NOT pre-computed by recalcAll (see there): parsing
    // every one of them up front cost ~90s on a 2.8M-cell workbook and threw
    // the result away for cells nobody looked at. Compute on first read and
    // memoise, so the cost lands only on cells that are actually used. Every
    // write path re-evaluates through recompute(), and recalcAll() clears the
    // whole map, so a memo can never go stale.
    if (this.asts.has(k)) return null;                 // a formula, not yet evaluated
    const lit = this.literalValue(this.sheetById(sid)?.getRaw(r, c));
    const out = lit === undefined ? null : lit;
    this.values.set(k, out);
    return out;
  }

  /* ---------- literal parsing ---------- */
  literalValue(raw) {
    if (raw == null || raw === '') return null;
    // A numeric raw is already the value. CellStore has always been able to
    // hand one back — decode() returns { raw: <number> } for a tiled cell
    // whose raw was written as a number — and the streaming importer now does
    // exactly that, because stringifying 10,000,000 numbers so this function
    // could parse them straight back cost 12 s on a single import. Everything
    // below is string parsing, and raw.trim() threw on a number.
    if (typeof raw === 'number') return raw;
    if (raw[0] === "'") return raw.slice(1);
    const t = raw.trim();
    if (/^(TRUE|FALSE)$/i.test(t)) return /^true$/i.test(t);
    if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
    if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
    if (/^-?(?:\d+(?:\.\d+)?)%$/.test(t)) return Number(t.slice(0, -1)) / 100;
    return raw;
  }

  /* ---------- dependency extraction ---------- */
  collectDeps(ast, sid) {
    const out = new Set();
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'name') { const nr = this.wb.getNamedRange(n.name); if (nr) for (let r = nr.r1; r <= nr.r2; r++) for (let c = nr.c1; c <= nr.c2; c++) out.add(this.key(nr.sid, r, c)); return; }
      if (n.type === 'ref') { const s = n.sheet ? this.resolveId(n.sheet) : sid; if (s != null) out.add(this.key(s, n.row, n.col)); return; }
      if (n.type === 'range') {
        const s = n.sheet ? this.resolveId(n.sheet) : sid; if (s == null) return;
        const sh = this.sheetById(s); const cr = concreteRange(n, sh ? sh.rows : 0, sh ? sh.cols : 0);
        for (let r = cr.r1; r <= cr.r2; r++) for (let c = cr.c1; c <= cr.c2; c++) out.add(this.key(s, r, c));
        return;
      }
      for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); }
    };
    walk(ast);
    return out;
  }
  isVolatileAst(ast) {
    let vol = false;
    const walk = (n) => { if (!n || typeof n !== 'object' || vol) return; if (n.type === 'call') { const d = registry.get(n.name); if (d && d.volatile) vol = true; } for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); } };
    walk(ast); return vol;
  }

  /* ---------- per-cell parse + graph maintenance ---------- */
  parseCellAt(sid, r, c) {
    const sh = this.sheetById(sid); const raw = sh ? sh.getRaw(r, c) : '';
    const addr = this.key(sid, r, c);
    if (raw && raw[0] === '=') {
      const ast = parseShared(raw.slice(1));   // H8: memoized — see cache invariant above
      this.asts.set(addr, ast);
      if (ast.__parseError) { this.graph.setPrecedents(addr, []); this.volatile.delete(addr); }
      else { this.graph.setPrecedents(addr, [...this.collectDeps(ast, sid)]); if (this.isVolatileAst(ast)) this.volatile.add(addr); else this.volatile.delete(addr); }
    } else {
      this.asts.delete(addr); this.graph.clear(addr); this.volatile.delete(addr);
    }
  }

  evalCellAt(addr) {
    const { sid, r, c } = this.parseKey(addr);
    const ast = this.asts.get(addr);
    let val;
    if (ast === undefined) val = this.literalValue(this.sheetById(sid)?.getRaw(r, c));
    else if (ast.__parseError) val = err(ERR.ERROR, ast.__parseError);
    else { try { val = evaluate(ast, this.ctxFor(sid, r, c)); } catch (e) { val = err(ERR.ERROR, String(e && e.message || e)); } }
    if (val === undefined) val = null;
    this.values.set(addr, val);
  }

  _clearWish(anchor) { const old = this.anchorWish.get(anchor); if (old) { for (const tk of old) { const set = this.wishIndex.get(tk); if (set) { set.delete(anchor); if (!set.size) this.wishIndex.delete(tk); } } this.anchorWish.delete(anchor); } }
  _setWish(anchor, cells) { this._clearWish(anchor); this.anchorWish.set(anchor, cells); for (const tk of cells) { let set = this.wishIndex.get(tk); if (!set) { set = new Set(); this.wishIndex.set(tk, set); } set.add(anchor); } }
  _removeSpill(addr) {
    const sp = this.spills.get(addr); if (!sp) return;
    for (let dr = 0; dr < sp.rows; dr++) for (let dc = 0; dc < sp.cols; dc++) { if (!dr && !dc) continue; const tk = this.key(sp.sid, sp.r + dr, sp.c + dc); if (this.spillOwner.get(tk) === addr) { this.spillOwner.delete(tk); for (const d of this.graph.dependentsOf(tk)) this._pending.add(d); } }
    this.spills.delete(addr);
  }
  evalCellWithSpill(addr) {
    const { sid, r, c } = this.parseKey(addr);
    if (this.spills.has(addr)) this._removeSpill(addr);
    const ast = this.asts.get(addr);
    let val;
    if (ast === undefined) val = this.literalValue(this.sheetById(sid)?.getRaw(r, c));
    else if (ast.__parseError) val = err(ERR.ERROR, ast.__parseError);
    else { try { val = evaluate(ast, this.ctxFor(sid, r, c)); } catch (e) { val = err(ERR.ERROR, String(e && e.message || e)); } }
    if (val && val.__array) {
      if (val.rows <= 1 && val.cols <= 1) { val = val.data[0] ? val.data[0][0] : null; this._clearWish(addr); }
      else {
        const sh = this.sheetById(sid);
        const wish = [];
        for (let dr = 0; dr < val.rows; dr++) for (let dc = 0; dc < val.cols; dc++) { if (!dr && !dc) continue; wish.push(this.key(sid, r + dr, c + dc)); }
        this._setWish(addr, wish);
        let blocked = false;
        for (const tk of wish) { const a = this.parseKey(tk); if (sh.getRaw(a.r, a.c) !== '') { blocked = true; break; } const o = this.spillOwner.get(tk); if (o && o !== addr) { blocked = true; break; } }
        if (blocked) val = err(ERR.SPILL);
        else {
          this.spills.set(addr, { rows: val.rows, cols: val.cols, data: val.data, sid, r, c });
          for (const tk of wish) { const a = this.parseKey(tk); this.spillOwner.set(tk, addr); for (const d of this.graph.dependentsOf(tk)) this._pending.add(d); if (sh.rows < a.r + 1) sh.rows = a.r + 1; if (sh.cols < a.c + 1) sh.cols = a.c + 1; }
          val = val.data[0][0];
        }
      }
    } else { this._clearWish(addr); }
    if (val === undefined) val = null;
    this.values.set(addr, val);
  }
  isSpillCell(sid, r, c) { return this.spillOwner.has(this.key(sid, r, c)); }
  isSpillAnchor(sid, r, c) { return this.spills.has(this.key(sid, r, c)); }

  /* ---------- recalculation ---------- */
  recompute(seedAddrs) {
    this._pending = new Set();
    const seed = new Set(seedAddrs);
    for (const a of this.volatile) seed.add(a);
    for (const a of [...seed]) { const o = this.spillOwner.get(a); if (o) seed.add(o); }
    let dirty = this.graph.expandDirty(seed);
    const changed = new Set();
    for (let pass = 0; pass < 6 && dirty.size; pass++) {
      const { order, cyclic } = this.graph.topo(dirty);
      for (const addr of order) { this.evalCellWithSpill(addr); changed.add(addr); }
      for (const addr of cyclic) { this._removeSpill(addr); this.values.set(addr, err(ERR.CYCLE)); changed.add(addr); }
      dirty = this.graph.expandDirty(this._pending); for (const a of dirty) changed.add(a); this._pending = new Set();
    }
    if (changed.size) this._notifySubs();   // P20: keep foreign IMPORTRANGE views live
    return [...changed].map((a) => this.parseKey(a));
  }

  recalcAll() {
    this.graph = new Graph(); this.asts.clear(); this.values.clear(); this.volatile.clear();
    // Only FORMULA cells go into the graph and the dirty set. Literal cells
    // have no precedents and nothing to parse, so walking all 2.8M of them
    // through parseCellAt + topo was pure overhead; they are evaluated lazily
    // by valueAt() the first time anything reads them.
    const all = [];
    for (const sh of this.wb.sheets) {
      const sid = sh.id;
      for (const [k, cell] of sh.cells) {
        const raw = cell && cell.raw;
        if (typeof raw !== 'string' || raw.charCodeAt(0) !== 61) continue;   // 61 = '='
        const i = k.indexOf(',');
        const r = +k.slice(0, i), c = +k.slice(i + 1);
        this.parseCellAt(sid, r, c);
        all.push(this.key(sid, r, c));
      }
    }
    this.spills.clear(); this.spillOwner.clear(); this.anchorWish.clear(); this.wishIndex.clear(); this._pending = new Set();
    let dirty = new Set(all);
    for (let pass = 0; pass < 8 && dirty.size; pass++) {
      const { order, cyclic } = this.graph.topo(dirty);
      for (const addr of order) this.evalCellWithSpill(addr);
      for (const addr of cyclic) { this._removeSpill(addr); this.values.set(addr, err(ERR.CYCLE)); }
      dirty = this.graph.expandDirty(this._pending); this._pending = new Set();
    }
    this._notifySubs();   // P20: keep foreign IMPORTRANGE views live
  }

  /* ---------- formula transforms (paste / structural) ---------- */
  _transformFormula(raw, fn) {
    let ast; try { ast = parse(raw.slice(1)); } catch { return raw; }
    const walk = (n) => {
      if (!n || typeof n !== 'object') return n;
      if (n.type === 'ref' || n.type === 'range') return fn(n);
      for (const k in n) { const v = n[k]; if (Array.isArray(v)) n[k] = v.map(walk); else if (v && typeof v === 'object') n[k] = walk(v); }
      return n;
    };
    return '=' + serialize(walk(ast));
  }
  // Translate relative refs by (dRow,dCol) — used on paste/fill.
  translateFormula(raw, dRow, dCol) {
    if (!raw || raw[0] !== '=') return raw;
    return this._transformFormula(raw, (n) => {
      if (n.type === 'ref') { if (!n.colAbs) n.col += dCol; if (!n.rowAbs) n.row += dRow; if (n.col < 0 || n.row < 0) return { type: 'err', value: err(ERR.REF) }; return n; }
      if (n.kind === 'cells') { n.c1 += dCol; n.r1 += dRow; n.c2 += dCol; n.r2 += dRow; if (n.c1 < 0 || n.r1 < 0 || n.c2 < 0 || n.r2 < 0) return { type: 'err', value: err(ERR.REF) }; return n; }
      if (n.kind === 'colsFrom') { n.c1 += dCol; n.c2 += dCol; n.r1 += dRow; if (n.c1 < 0 || n.c2 < 0 || n.r1 < 0) return { type: 'err', value: err(ERR.REF) }; return n; }
      if (n.kind === 'cols') { n.c1 += dCol; n.c2 += dCol; return n; }
      if (n.kind === 'rows') { n.r1 += dRow; n.r2 += dRow; return n; }
      return n;
    });
  }
  // Shift refs that point at `edit.sid` along `edit.axis` for an insert/delete.
  shiftFormulaForEdit(raw, formulaSid, edit) {
    if (!raw || raw[0] !== '=') return raw;
    const clampLow = edit.at, clampHigh = Math.max(0, edit.at - 1);
    return this._transformFormula(raw, (n) => {
      const target = n.sheet ? this.resolveId(n.sheet) : formulaSid;
      if (target !== edit.sid) return n;
      if (n.type === 'ref') {
        const idx = edit.axis === 'row' ? n.row : n.col;
        const ni = shiftIndex(idx, edit.at, edit.count);
        if (ni === 'REF') return { type: 'err', value: err(ERR.REF) };
        if (edit.axis === 'row') n.row = ni; else n.col = ni; return n;
      }
      if (n.kind === 'cells') {
        if (edit.axis === 'row') {
          let r1 = shiftIndex(n.r1, edit.at, edit.count), r2 = shiftIndex(n.r2, edit.at, edit.count);
          if (r1 === 'REF' && r2 === 'REF') return { type: 'err', value: err(ERR.REF) };
          if (r1 === 'REF') r1 = clampLow; if (r2 === 'REF') r2 = clampHigh;
          n.r1 = Math.min(r1, r2); n.r2 = Math.max(r1, r2); return n;
        }
        let c1 = shiftIndex(n.c1, edit.at, edit.count), c2 = shiftIndex(n.c2, edit.at, edit.count);
        if (c1 === 'REF' && c2 === 'REF') return { type: 'err', value: err(ERR.REF) };
        if (c1 === 'REF') c1 = clampLow; if (c2 === 'REF') c2 = clampHigh;
        n.c1 = Math.min(c1, c2); n.c2 = Math.max(c1, c2); return n;
      }
      // Only the START row moves: the range stays open at the bottom, so an
      // insert below it changes nothing and a delete cannot orphan its end.
      if (n.kind === 'colsFrom') {
        if (edit.axis === 'row') { let r1 = shiftIndex(n.r1, edit.at, edit.count); if (r1 === 'REF') r1 = clampLow; n.r1 = r1; return n; }
        let a = shiftIndex(n.c1, edit.at, edit.count), b = shiftIndex(n.c2, edit.at, edit.count);
        if (a === 'REF' && b === 'REF') return { type: 'err', value: err(ERR.REF) };
        if (a === 'REF') a = clampLow; if (b === 'REF') b = clampHigh;
        n.c1 = Math.min(a, b); n.c2 = Math.max(a, b); return n;
      }
      if (n.kind === 'cols' && edit.axis === 'col') { let a = shiftIndex(n.c1, edit.at, edit.count), b = shiftIndex(n.c2, edit.at, edit.count); if (a === 'REF') a = clampLow; if (b === 'REF') b = clampLow; n.c1 = Math.min(a, b); n.c2 = Math.max(a, b); return n; }
      if (n.kind === 'rows' && edit.axis === 'row') { let a = shiftIndex(n.r1, edit.at, edit.count), b = shiftIndex(n.r2, edit.at, edit.count); if (a === 'REF') a = clampLow; if (b === 'REF') b = clampLow; n.r1 = Math.min(a, b); n.r2 = Math.max(a, b); return n; }
      return n;
    });
  }

  /* ---------- structural ops ---------- */
  _shiftAllFormulas(edit) {
    // Shifting rewrites formula TEXT, and a delete CLAMPS ranges that straddle
    // the removed band (=AVERAGE(A2:A10) with rows 5-7 gone becomes A2:A7).
    // Re-inserting rows cannot recover the original bounds, so the old text is
    // the one thing a structural op must journal. Formula cells are a tiny
    // fraction of a data sheet, so this stays cheap.
    const j = activeJournal();
    const journalling = !!(j && j.open);
    for (const s of this.wb.sheets) {
      for (const [k, cell] of s.cells) {
        if (!cell.raw || cell.raw[0] !== '=') continue;
        const next = this.shiftFormulaForEdit(cell.raw, s.id, edit);
        if (next === cell.raw) continue;
        if (journalling) j.recordCell(s.id, k, cell);
        cell.raw = next;
      }
    }
  }
  insertRows(sid, at, count = 1) {
    const sh = this.sheetById(sid); if (!sh) return;
    ensureRowIds(sh);                                        // P10: maintain stable IDs
    recordStruct(sh, { kind: 'insertRows', sid, at, count });
    this._shiftAllFormulas({ sid, axis: 'row', at, count });
    shiftRowIdsInsert(sh, at, count);                        // P10
    // CellStore, not Map: rebuilding into a plain Map here silently
    // reverted the sheet to ~146 B/cell and threw away the tiling.
    const moved = new CellStore();
    for (const [k, cell] of sh.cells) { const [r, c] = k.split(',').map(Number); moved.set((r >= at ? r + count : r) + ',' + c, cell); }
    sh.cells = moved; sh.rows += count;
    // P10: stamp createdTime/createdBy for each newly inserted row
    for (let i = 0; i < count; i++) this._stampAutoFields(sh, sid, at + i, 'created');
    this.recalcAll();
  }
  deleteRows(sid, at, count = 1) {
    const sh = this.sheetById(sid); if (!sh) return;
    ensureRowIds(sh);                                        // P10: maintain stable IDs
    recordStruct(sh, { kind: 'deleteRows', sid, at, count, removed: bandCells(sh, 'row', at, count) });
    this._shiftAllFormulas({ sid, axis: 'row', at, count: -count });
    shiftRowIdsDelete(sh, at, count);                        // P10
    // CellStore, not Map: rebuilding into a plain Map here silently
    // reverted the sheet to ~146 B/cell and threw away the tiling.
    const moved = new CellStore();
    for (const [k, cell] of sh.cells) { const [r, c] = k.split(',').map(Number); if (r >= at && r < at + count) continue; moved.set((r >= at + count ? r - count : r) + ',' + c, cell); }
    sh.cells = moved; sh.rows = Math.max(1, sh.rows - count); this.recalcAll();
  }
  insertCols(sid, at, count = 1) {
    const sh = this.sheetById(sid); if (!sh) return;
    recordStruct(sh, { kind: 'insertCols', sid, at, count });
    this._shiftAllFormulas({ sid, axis: 'col', at, count });
    // CellStore, not Map: rebuilding into a plain Map here silently
    // reverted the sheet to ~146 B/cell and threw away the tiling.
    const moved = new CellStore();
    for (const [k, cell] of sh.cells) { const [r, c] = k.split(',').map(Number); moved.set(r + ',' + (c >= at ? c + count : c), cell); }
    sh.cells = moved; sh.cols += count; this.recalcAll();
  }
  deleteCols(sid, at, count = 1) {
    const sh = this.sheetById(sid); if (!sh) return;
    recordStruct(sh, { kind: 'deleteCols', sid, at, count, removed: bandCells(sh, 'col', at, count) });
    this._shiftAllFormulas({ sid, axis: 'col', at, count: -count });
    // CellStore, not Map: rebuilding into a plain Map here silently
    // reverted the sheet to ~146 B/cell and threw away the tiling.
    const moved = new CellStore();
    for (const [k, cell] of sh.cells) { const [r, c] = k.split(',').map(Number); if (c >= at && c < at + count) continue; moved.set(r + ',' + (c >= at + count ? c - count : c), cell); }
    sh.cells = moved; sh.cols = Math.max(1, sh.cols - count); this.recalcAll();
  }

  /* ---------- move / reorder (columns & rows) ----------
   * Physically relocate a block of columns/rows to a new position and remap
   * every reference in the workbook through the resulting index permutation.
   * perm[oldIndex] = newIndex. Absolute ($) refs are remapped too - a $-ref
   * points at logical data that has moved, so it must follow. */

  // Build the post-move order array: order[newPos] = oldIndex.
  _buildMoveOrder(n, from, count, to) {
    const idx = Array.from({ length: n }, (_, i) => i);
    const block = idx.splice(from, count);
    let dest = to > from ? to - count : to;
    dest = Math.max(0, Math.min(dest, idx.length));
    idx.splice(dest, 0, ...block);
    return idx;
  }
  // Invert an order array into perm[oldIndex] = newPos.
  _orderToPerm(order) { const perm = new Array(order.length); order.forEach((oldIdx, newPos) => { perm[oldIdx] = newPos; }); return perm; }

  // Remap refs pointing at edit.sid along edit.axis through edit.perm.
  remapFormulaByPermutation(raw, formulaSid, edit) {
    if (!raw || raw[0] !== '=') return raw;
    const map = (i) => (i >= 0 && i < edit.perm.length ? edit.perm[i] : i);
    return this._transformFormula(raw, (n) => {
      const target = n.sheet ? this.resolveId(n.sheet) : formulaSid;
      if (target !== edit.sid) return n;
      if (n.type === 'ref') { if (edit.axis === 'col') n.col = map(n.col); else n.row = map(n.row); return n; }
      if (n.kind === 'cells') {
        if (edit.axis === 'col') { const a = map(n.c1), b = map(n.c2); n.c1 = Math.min(a, b); n.c2 = Math.max(a, b); }
        else { const a = map(n.r1), b = map(n.r2); n.r1 = Math.min(a, b); n.r2 = Math.max(a, b); }
        return n;
      }
      if (n.kind === 'colsFrom') {
        if (edit.axis === 'row') { n.r1 = map(n.r1); return n; }
        const a = map(n.c1), b = map(n.c2); n.c1 = Math.min(a, b); n.c2 = Math.max(a, b); return n;
      }
      if (n.kind === 'cols' && edit.axis === 'col') { const a = map(n.c1), b = map(n.c2); n.c1 = Math.min(a, b); n.c2 = Math.max(a, b); return n; }
      if (n.kind === 'rows' && edit.axis === 'row') { const a = map(n.r1), b = map(n.r2); n.r1 = Math.min(a, b); n.r2 = Math.max(a, b); return n; }
      return n;
    });
  }
  _permuteObj(obj, perm) { const out = {}; for (const k in obj) { const i = Number(k); out[perm[i] ?? i] = obj[k]; } return out; }
  _remapRangeObj(rg, axis, perm) {
    if (!rg) return; const map = (i) => (i >= 0 && i < perm.length ? perm[i] : i);
    if (axis === 'col' && rg.c1 != null) { const a = map(rg.c1), b = map(rg.c2); rg.c1 = Math.min(a, b); rg.c2 = Math.max(a, b); }
    if (axis === 'row' && rg.r1 != null) { const a = map(rg.r1), b = map(rg.r2); rg.r1 = Math.min(a, b); rg.r2 = Math.max(a, b); }
  }
  _permuteSheetRanges(sh, axis, perm) {
    for (const m of (sh.merges || [])) this._remapRangeObj(m, axis, perm);
    for (const p of (sh.protectedRanges || [])) this._remapRangeObj(p, axis, perm);
    for (const v of (sh.validations || [])) this._remapRangeObj(v.range, axis, perm);
    for (const rl of (sh.conditionalFormats || [])) this._remapRangeObj(rl.range, axis, perm);
    if (sh.filter && sh.filter.range) { this._remapRangeObj(sh.filter.range, axis, perm); if (axis === 'col' && sh.filter.cols) sh.filter.cols = this._permuteObj(sh.filter.cols, perm); }
  }
  _remapAllFormulas(sid, axis, perm) {
    // set() back rather than mutating in place: cells is a CellStore, and a
    // tiled cell is decoded into a fresh object on get/iterate.
    for (const s of this.wb.sheets) for (const [k, cell] of s.cells) if (cell.raw && cell.raw[0] === '=') { cell.raw = this.remapFormulaByPermutation(cell.raw, s.id, { sid, axis, perm }); s.cells.set(k, cell); }
  }
  moveCols(sid, from, count = 1, to = 0) {
    const sh = this.sheetById(sid); if (!sh) return;
    const n = sh.cols;
    if (from < 0 || count < 1 || from + count > n) return;
    if (to >= from && to <= from + count) return;            // dropping inside/adjacent-noop
    const perm = this._orderToPerm(this._buildMoveOrder(n, from, count, to));
    this._remapAllFormulas(sid, 'col', perm);
    // CellStore, not Map: rebuilding into a plain Map here silently
    // reverted the sheet to ~146 B/cell and threw away the tiling.
    const moved = new CellStore();
    for (const [k, cell] of sh.cells) { const [r, c] = k.split(',').map(Number); moved.set(r + ',' + (perm[c] ?? c), cell); }
    sh.cells = moved;
    sh.colWidths = this._permuteObj(sh.colWidths, perm);
    sh.colTypes = this._permuteObj(sh.colTypes, perm);
    sh.hiddenCols = (sh.hiddenCols || []).map((c) => perm[c] ?? c);
    if (Array.isArray(sh.colMeta) && sh.colMeta.length) { const nm = []; sh.colMeta.forEach((m, c) => { if (m) nm[perm[c] ?? c] = m; }); sh.colMeta = nm; }
    this._permuteSheetRanges(sh, 'col', perm);
    this.recalcAll();
  }
  moveRows(sid, from, count = 1, to = 0) {
    const sh = this.sheetById(sid); if (!sh) return;
    const n = sh.rows;
    if (from < 0 || count < 1 || from + count > n) return;
    if (to >= from && to <= from + count) return;
    const perm = this._orderToPerm(this._buildMoveOrder(n, from, count, to));
    this._remapAllFormulas(sid, 'row', perm);
    // CellStore, not Map: rebuilding into a plain Map here silently
    // reverted the sheet to ~146 B/cell and threw away the tiling.
    const moved = new CellStore();
    for (const [k, cell] of sh.cells) { const [r, c] = k.split(',').map(Number); moved.set((perm[r] ?? r) + ',' + c, cell); }
    sh.cells = moved;
    sh.rowHeights = this._permuteObj(sh.rowHeights, perm);
    sh.rowIdMap = this._permuteObj(sh.rowIdMap, perm);
    sh.hiddenRows = (sh.hiddenRows || []).map((r) => perm[r] ?? r);
    this._permuteSheetRanges(sh, 'row', perm);
    this.recalcAll();
  }

  /* ---------- public API (grid) ---------- */
  setRaw(sid, r, c, raw) {
    const sh = this.sheetById(sid); if (!sh) return { changed: [] };
    sh.setRaw(r, c, raw);
    this.parseCellAt(sid, r, c);
    // P10 — stamp auto-fields (modifiedTime / modifiedBy) on the same row.
    // Guard: sh.colTypes must exist and be non-empty — common case exits immediately.
    this._stampAutoFields(sh, sid, r, 'modified');
    const k = this.key(sid, r, c); const seed = [k]; const o = this.spillOwner.get(k); if (o) seed.push(o); const w = this.wishIndex.get(k); if (w) for (const an of w) seed.push(an);
    return { changed: this.recompute(seed) };
  }

  /**
   * Stamp auto-field columns in row `r` for the given stamp kind.
   * 'modified' → modifiedTime + modifiedBy
   * 'created'  → createdTime + createdBy  (called once per new row by insertRows)
   * No-op when sheet has no colTypes — zero overhead for regular sheets.
   * @param {MonoSheet} sh
   * @param {string}    sid
   * @param {number}    r
   * @param {'modified'|'created'} kind
   */
  /** Cells another collaborator wrote: { "r,c": cell|null }. Written straight
   *  into the cell store rather than through setRaw, so they are neither
   *  queued for saving (they came FROM the server) nor put on this user's
   *  undo stack (Ctrl+Z must not undo someone else's typing). Only what
   *  depends on them is recalculated. Returns the cells whose value moved. */
  applyRemoteCells(sid, cells) {
    const sh = this.sheetById(sid); if (!sh) return [];
    const seed = [];
    for (const k of Object.keys(cells)) {
      const i = k.indexOf(','), r = +k.slice(0, i), c = +k.slice(i + 1);
      if (cells[k] == null) sh.cells.delete(k); else { sh.cells.set(k, cells[k]); sh._grow(r, c); }
      this.parseCellAt(sid, r, c);
      const a = this.key(sid, r, c); seed.push(a);
      const w = this.wishIndex.get(a); if (w) for (const an of w) seed.push(an);
    }
    const changed = this.recompute(seed);
    for (const k of Object.keys(cells)) { const i = k.indexOf(','); changed.push({ sid, r: +k.slice(0, i), c: +k.slice(i + 1) }); }
    return changed;
  }

  setCellsBatch(sid, list) {
    const sh = this.sheetById(sid); if (!sh) return;
    for (const it of list) { sh.setRaw(it.r, it.c, it.raw); this.parseCellAt(sid, it.r, it.c); }
    this.recalcAll();
  }

  _stampAutoFields(sh, sid, r, kind) {
    if (!sh.colTypes || !Object.keys(sh.colTypes).length) return; // fast exit
    const now = new Date().toISOString();
    const user = (typeof localStorage !== 'undefined' && localStorage.getItem('mono.settings.displayName')) || 'Unknown';
    for (const [col, typeId] of Object.entries(sh.colTypes)) {
      const ct = cellTypeFor(sh, Number(col));
      if (!ct || !ct.autoStamp) continue;
      const stamp = ct.autoStamp;
      if (kind === 'modified' && (stamp === 'modified' || stamp === 'modifiedBy')) {
        const val = stamp === 'modified' ? now : user;
        sh.setRaw(r, Number(col), val);
        this.parseCellAt(sid, r, Number(col));
      } else if (kind === 'created' && (stamp === 'created' || stamp === 'createdBy')) {
        if (sh.getRaw(r, Number(col)) === '') {
          const val = stamp === 'created' ? now : user;
          sh.setRaw(r, Number(col), val);
          this.parseCellAt(sid, r, Number(col));
        }
      }
    }
  }

  getRaw(sid, r, c) { const sh = this.sheetById(sid); return sh ? sh.getRaw(r, c) : ''; }
  getValue(sid, r, c) { return this.valueAt(sid, r, c); }
  isNumberAt(sid, r, c) { return typeof this.valueAt(sid, r, c) === 'number'; }
  isErrorAt(sid, r, c) { return isError(this.valueAt(sid, r, c)); }
  getDisplay(sid, r, c) {
    const raw = this.getRaw(sid, r, c);
    const spilled = this.spillOwner.has(this.key(sid, r, c));
    if (!spilled && (raw === '' || raw == null)) return '';
    const v = this.valueAt(sid, r, c);
    if (v == null) return raw[0] === '=' ? '' : raw;
    if (isError(v)) return v.type;
    if (typeof v === 'number') return formatValue(v, this.sheetById(sid)?.getFormat(r, c));
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v && v.__array) { const f = v.data?.[0]?.[0]; return f == null ? '' : typeof f === 'number' ? numToStr(f) : isError(f) ? f.type : String(f); }
    return String(v);
  }
}
export default Engine;
