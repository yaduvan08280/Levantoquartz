// ============================================================
//  CellStore — a Map-shaped cell store that stops paying 146 bytes a cell
//  ------------------------------------------------------------
//  MonoSheet.cells is `new Map()` keyed "r,c" -> { raw?, st?, nf?, note?, cm? }.
//  Measured on this machine with distinct values:
//
//      146 bytes/cell · 1,392 MB heap for 10,000,000 cells · 6,471 ms to build
//
//  A browser tab caps at ~4,192 MB, so a 1,048,576 x 100 sheet (104,857,600
//  cells) cannot exist at all, and turning that Map into a plain object for
//  toJSON() ran over 20 minutes without finishing.
//
//  Almost every one of those 146 bytes is overhead: a Map entry, a string
//  key, a `{ raw }` wrapper object, and a string holding a number. A grid
//  is column-shaped and mostly numeric, so store it that way.
//
//  TWO MODES, switched automatically
//  --------------------------------
//   SMALL  (default, <= smallLimit entries) wraps a real Map. Behaviourally
//          IDENTICAL to Map, insertion-order iteration included. Small sheets
//          are the common case and must not pay for any of this.
//   TILED  (above smallLimit) stores, per column, fixed TILE_ROWS-row tiles:
//          a Float64Array of values + a Uint8Array occupancy bitmap + a
//          Uint8Array "raw was a string" bitmap + a per-tile min/max/count
//          zone map. Anything that is not a plain number-only cell —
//          formulas, text, or any cell carrying st/nf/note/cm — lives in a
//          sparse overlay Map instead. Dense numeric tiles cost ~8.4 bytes a
//          cell instead of 146.
//
//  WHY TILE_ROWS = 1024 (measured, not guessed)
//  --------------------------------------------
//  A sweep on real data: 90.9% of tiles were provably resolvable from the
//  zone map alone at 1,024 rows vs 58.3% at 8,192, and the viewport filter
//  ran 6.5x faster (276 us vs 1,798 us). Exported so it can be retuned.
//
//  DIFFERENCES FROM Map — both only in TILED mode
//  ----------------------------------------------
//  1. ITERATION ORDER is not insertion order. It is column ascending, then
//     tile ascending, then row ascending, then the overlay in its own
//     insertion order. It is deterministic and stable for a given history,
//     and every key appears exactly once. This is safe for this codebase:
//     canonicalJson() in ./workbook.js (see the comment above it) already
//     sorts cells by coordinate precisely because "a Map remembers insertion
//     order" made toJSON() the wrong yardstick for undo — so the one place
//     that compares whole workbooks is order-independent by construction.
//     The ~12 raw `for (const [k, v] of sh.cells)` loops in engine.js and
//     grid.js all rebuild a keyed map or scan for a maximum; none of them
//     depend on order.
//  2. get() MATERIALISES a fresh { raw } object for tiled numeric cells, so
//     mutating the result no longer writes back. workbook.js does exactly
//     that today — setRaw/setStyle/setNote/addComment all do
//     `const cell = this.cells.get(k); cell.raw = ...` with no re-set, and
//     engine.js:537 mutates cell.raw while iterating values. Wiring this
//     store in (step 2) therefore means making those writes go through
//     .set(k, cell) after mutating. Nothing here can paper over that, and
//     silently returning a live object would give back all the memory.
// ============================================================

/** Rows per tile. Measured; see the header before changing it. */
export const TILE_ROWS = 1024;

/** Entries above which a store migrates from SMALL to TILED. */
export const SMALL_LIMIT = 200_000;

/* The threshold is a calibration knob, not a constant of nature. MONO_TILE_AT
   overrides it process-wide, which is the only practical way to run the whole
   test suite against the TILED path: every suite here builds small sheets, so
   without this they all exercise the Map path and prove nothing about tiling.
   `MONO_TILE_AT=0 npm test` forces tiling from the first cell. Undefined in a
   browser, where the optional chain just yields the default. */
const ENV_LIMIT = Number(globalThis.process?.env?.MONO_TILE_AT);
const DEFAULT_LIMIT = Number.isFinite(ENV_LIMIT) ? ENV_LIMIT : SMALL_LIMIT;

const BITMAP_BYTES = Math.ceil(TILE_ROWS / 8);

/* "r,c" -> {r, c}, or null if the key is not a plain cell coordinate.
   Unparseable keys are not an error: they just live in the overlay, so the
   store stays a faithful Map for whatever anyone puts in it. */
function parseKey(k) {
  if (typeof k !== 'string') return null;
  const i = k.indexOf(',');
  if (i <= 0) return null;
  const r = +k.slice(0, i);
  const c = +k.slice(i + 1);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) return null;
  return { r, c };
}

/* A cell qualifies for the numeric path only if it is `{ raw }` and nothing
   else, and only if the value round-trips EXACTLY through a float. A raw of
   '007', '1.50' or '1e21' does not (String(Number(x)) !== x), so it goes to
   the overlay rather than coming back changed. Returns { n, s } where s says
   the original raw was a string, or null for "not numeric". */
function encode(v) {
  if (v === null || typeof v !== 'object') return null;
  for (const key in v) if (key !== 'raw') return null;
  const raw = v.raw;
  const t = typeof raw;
  if (t === 'number') return { n: raw, s: false };
  if (t !== 'string' || raw === '') return null;
  const n = Number(raw);
  if (String(n) !== raw) return null;
  return { n, s: true };
}

function decode(t, i) {
  const n = t.v[i];
  return (t.str[(i / 8) | 0] & (1 << (i & 7))) ? { raw: String(n) } : { raw: n };
}

function newTile() {
  return {
    v: new Float64Array(TILE_ROWS),
    occ: new Uint8Array(BITMAP_BYTES),   // slot holds a value
    str: new Uint8Array(BITMAP_BYTES),   // that value's raw was a string
    n: 0,                                // occupied slots
    min: Infinity,                       // zone map; Infinity/-Infinity = none
    max: -Infinity,
    dirty: false,                        // min/max stale after an extreme left
  };
}

/* NaN is a legal cell value but poisons a min/max comparison, so it occupies
   a slot and counts, but is excluded from the bounds. */
function rebound(t) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < TILE_ROWS; i++) {
    if (!(t.occ[(i / 8) | 0] & (1 << (i & 7)))) continue;
    const x = t.v[i];
    if (Number.isNaN(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  t.min = min; t.max = max; t.dirty = false;
}

export class CellStore {
  /**
   * @param {Iterable<[string, object]>} [entries] like `new Map(entries)`
   * @param {{smallLimit?: number}} [opts] migration threshold, for tests/tuning
   */
  constructor(entries, { smallLimit = DEFAULT_LIMIT } = {}) {
    this._limit = Math.max(1, Math.floor(smallLimit));
    this._map = new Map();   // SMALL mode; null once tiled
    this._cols = null;       // TILED: Map(col -> Map(tileIndex -> tile))
    this._over = null;       // TILED: Map("r,c" -> value) for everything else
    this._n = 0;             // TILED: cells living in tiles
    if (entries) for (const [k, v] of entries) this.set(k, v);
  }

  /** True while the tiled representation is in use. Diagnostics only. */
  get tiled() { return this._map === null; }

  get size() { return this._map ? this._map.size : this._n + this._over.size; }

  get(k) {
    if (this._map) return this._map.get(k);
    const p = parseKey(k);
    if (p) {
      const t = this._tile(p.c, p.r, false);
      if (t) {
        const i = p.r % TILE_ROWS;
        if (t.occ[(i / 8) | 0] & (1 << (i & 7))) return decode(t, i);
      }
    }
    return this._over.size ? this._over.get(k) : undefined;
  }

  has(k) {
    if (this._map) return this._map.has(k);
    const p = parseKey(k);
    if (p) {
      const t = this._tile(p.c, p.r, false);
      if (t) {
        const i = p.r % TILE_ROWS;
        if (t.occ[(i / 8) | 0] & (1 << (i & 7))) return true;
      }
    }
    return this._over.size ? this._over.has(k) : false;
  }

  set(k, v) {
    if (this._map) {
      this._map.set(k, v);
      if (this._map.size > this._limit) this._toTiled();
      return this;
    }
    const p = parseKey(k);
    const e = p ? encode(v) : null;
    if (e) {
      if (this._over.size) this._over.delete(k);
      this._tileSet(p.r, p.c, e.n, e.s);
    } else {
      if (p) this._tileDel(p.r, p.c);
      this._over.set(k, v);
    }
    return this;
  }

  /**
   * set() for a caller that already has r and c as numbers.
   *
   * Not sugar. A bulk loader builds `r + ',' + c` only for set() to slice it
   * straight back into two numbers, and on a 10,000,000-cell import that
   * round trip measured 5.6 s of a 14.7 s build — the largest single cost
   * after the scan itself. Identical semantics to set(); it just skips
   * constructing and re-parsing the key, and only builds one when a cell has
   * to go to the overlay (a formula, text, or anything styled), which is the
   * minority at this scale.
   */
  setAt(r, c, v) {
    if (this._map) return this.set(r + ',' + c, v);
    const e = encode(v);
    if (e) {
      if (this._over.size) this._over.delete(r + ',' + c);
      this._tileSet(r, c, e.n, e.s);
    } else {
      this._tileDel(r, c);
      this._over.set(r + ',' + c, v);
    }
    return this;
  }

  delete(k) {
    if (this._map) return this._map.delete(k);
    const p = parseKey(k);
    let hit = p ? this._tileDel(p.r, p.c) : false;
    if (!hit && this._over.size) hit = this._over.delete(k);
    // Hysteresis: fall back to a plain Map only at half the threshold, so a
    // workload sitting exactly on the line does not migrate on every edit.
    if (hit && this.size < this._limit / 2) this._toSmall();
    return hit;
  }

  clear() {
    this._map = new Map();
    this._cols = null; this._over = null; this._n = 0;
  }

  *entries() {
    if (this._map) { yield* this._map.entries(); return; }
    for (const c of [...this._cols.keys()].sort((a, b) => a - b)) {
      const tiles = this._cols.get(c);
      for (const ti of [...tiles.keys()].sort((a, b) => a - b)) {
        const t = tiles.get(ti);
        const base = ti * TILE_ROWS;
        for (let i = 0; i < TILE_ROWS; i++) {
          if (!(t.occ[(i / 8) | 0] & (1 << (i & 7)))) continue;
          yield [(base + i) + ',' + c, decode(t, i)];
        }
      }
    }
    yield* this._over.entries();
  }

  *keys() { for (const e of this.entries()) yield e[0]; }

  *values() { for (const e of this.entries()) yield e[1]; }

  forEach(cb, thisArg) { for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this); }

  /**
   * The zone map: the numeric range held by one tile. Cells in the overlay
   * (text, formulas, styled cells) are not counted — they cannot be filtered
   * by value anyway. min/max are null when the tile holds no comparable
   * value (empty, or NaN only).
   *
   * Nothing reads this yet; it exists so step 3's viewport filter and step
   * 5's proofs can skip whole tiles.
   *
   * @returns {{min: number|null, max: number|null, count: number}}
   */
  tileBounds(col, tileIndex) {
    if (this._map) return this._smallBounds(col, tileIndex);
    const tiles = this._cols.get(col);
    const t = tiles && tiles.get(tileIndex);
    if (!t) return { min: null, max: null, count: 0 };
    if (t.dirty) rebound(t);
    return {
      min: t.min === Infinity ? null : t.min,
      max: t.max === -Infinity ? null : t.max,
      count: t.n,
    };
  }

  /* ---------- internals ---------- */

  _tile(col, row, create) {
    let tiles = this._cols.get(col);
    if (!tiles) {
      if (!create) return null;
      this._cols.set(col, tiles = new Map());
    }
    const ti = Math.floor(row / TILE_ROWS);
    let t = tiles.get(ti);
    if (!t && create) tiles.set(ti, t = newTile());
    return t || null;
  }

  _tileSet(row, col, n, isStr) {
    const t = this._tile(col, row, true);
    const i = row % TILE_ROWS;
    const bi = (i / 8) | 0, mask = 1 << (i & 7);
    if (t.occ[bi] & mask) {
      const old = t.v[i];
      if (old === t.min || old === t.max) t.dirty = true;   // an extreme moved
    } else {
      t.occ[bi] |= mask; t.n++; this._n++;
    }
    t.v[i] = n;
    if (isStr) t.str[bi] |= mask; else t.str[bi] &= ~mask;
    if (!Number.isNaN(n)) {
      if (n < t.min) t.min = n;
      if (n > t.max) t.max = n;
    }
  }

  _tileDel(row, col) {
    const tiles = this._cols.get(col);
    if (!tiles) return false;
    const ti = Math.floor(row / TILE_ROWS);
    const t = tiles.get(ti);
    if (!t) return false;
    const i = row % TILE_ROWS;
    const bi = (i / 8) | 0, mask = 1 << (i & 7);
    if (!(t.occ[bi] & mask)) return false;
    const old = t.v[i];
    t.occ[bi] &= ~mask; t.str[bi] &= ~mask; t.n--; this._n--;
    if (!t.n) {
      tiles.delete(ti);                       // give the Float64Array back
      if (!tiles.size) this._cols.delete(col);
    } else if (old === t.min || old === t.max) {
      t.dirty = true;
    }
    return true;
  }

  // ponytail: SMALL mode has no zone map, so this scans the whole Map —
  // O(size) per call, bounded by smallLimit. Fine for the one-off callers it
  // has today; if step 3 ever calls it per tile in a loop, keep a per-column
  // tile index in SMALL mode too, or just force TILED for that sheet.
  _smallBounds(col, tileIndex) {
    const lo = tileIndex * TILE_ROWS, hi = lo + TILE_ROWS;
    let min = Infinity, max = -Infinity, count = 0;
    for (const [k, v] of this._map) {
      const p = parseKey(k);
      if (!p || p.c !== col || p.r < lo || p.r >= hi) continue;
      const e = encode(v);
      if (!e) continue;
      count++;
      if (Number.isNaN(e.n)) continue;
      if (e.n < min) min = e.n;
      if (e.n > max) max = e.n;
    }
    return { min: min === Infinity ? null : min, max: max === -Infinity ? null : max, count };
  }

  _toTiled() {
    const m = this._map;
    this._map = null; this._cols = new Map(); this._over = new Map(); this._n = 0;
    for (const [k, v] of m) this.set(k, v);
  }

  _toSmall() {
    const m = new Map();
    for (const [k, v] of this.entries()) m.set(k, v);   // still the tiled iterator
    this._map = m;
    this._cols = null; this._over = null; this._n = 0;
  }
}

// Map aliases its iterator to entries; anything doing `[...cells]` or
// `for (const [k, v] of cells)` relies on it.
CellStore.prototype[Symbol.iterator] = CellStore.prototype.entries;
