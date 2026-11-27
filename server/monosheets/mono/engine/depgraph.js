// ============================================================
//  Mono formula engine — dependency graph (Phase 2)
//  Directed graph of cell addresses. Edge p -> a means "a reads p".
//  Drives minimal recalculation: dirty expand + topological order
//  (Kahn) + cycle detection.
// ============================================================
const EMPTY = new Set();

/* An edge list is stored as a bare string when there is exactly ONE edge, and
   as a Set only from two upwards.

   Measured on 300,000 formulas of the shape =A1*2: graph.pre and graph.dep
   were 180 MB of the engine's 319 MB — 56% — and every single Set in them
   held exactly one element. An empty JS Set is roughly 300 bytes, so this was
   paying ~300 bytes to hold an 8-byte reference, 600,000 times.

   One precedent is the overwhelmingly common shape (any fill-down of
   =A1*rate), and one dependent is common for the same reason. Wide cases
   (=SUM(A1:A100), a cell everything references) still get a Set, so deletes
   stay O(1) there rather than degrading to an array scan. */
const iter = (e) => (e === undefined ? EMPTY : typeof e === 'string' ? [e] : e);

export class Graph {
  constructor() { this.pre = new Map(); this.dep = new Map(); }

  _link(map, k, v) {
    const cur = map.get(k);
    if (cur === undefined) map.set(k, v);
    else if (typeof cur === 'string') { if (cur !== v) map.set(k, new Set([cur, v])); }
    else cur.add(v);
  }
  _unlink(map, k, v) {
    const cur = map.get(k);
    if (cur === undefined) return;
    if (typeof cur === 'string') { if (cur === v) map.delete(k); return; }
    cur.delete(v);
    if (cur.size === 1) map.set(k, cur.values().next().value);   // collapse back
    else if (cur.size === 0) map.delete(k);
  }

  setPrecedents(addr, list) {
    for (const p of iter(this.pre.get(addr))) this._unlink(this.dep, p, addr);
    this.pre.delete(addr);
    for (const p of new Set(list)) {                              // dedup the input
      this._link(this.pre, addr, p);
      this._link(this.dep, p, addr);
    }
  }
  clear(addr) {
    for (const p of iter(this.pre.get(addr))) this._unlink(this.dep, p, addr);
    this.pre.delete(addr);
  }
  precedentsOf(addr) { return iter(this.pre.get(addr)); }
  dependentsOf(addr) { return iter(this.dep.get(addr)); }

  // seed ∪ all transitive dependents
  expandDirty(seed) {
    const out = new Set(seed);
    const stack = [...seed];
    while (stack.length) { const a = stack.pop(); for (const d of iter(this.dep.get(a))) if (!out.has(d)) { out.add(d); stack.push(d); } }
    return out;
  }

  // Kahn's topological sort restricted to `dirty`. Returns ordered list +
  // the set left over (members of cycles).
  topo(dirty) {
    const indeg = new Map();
    for (const a of dirty) { let n = 0; for (const p of iter(this.pre.get(a))) if (dirty.has(p)) n++; indeg.set(a, n); }
    const q = []; for (const [a, n] of indeg) if (n === 0) q.push(a);
    const order = []; const seen = new Set();
    // Walk the queue with a head index. Array.prototype.shift() is O(n) — it
    // reindexes the whole array — so dequeuing n cells that way is O(n^2), and
    // on a 100,000-formula sheet this one call was 4,850 ms of a 5,701 ms
    // engine build (85% of it, measured with --cpu-prof). Same algorithm,
    // same order, O(1) dequeue.
    for (let qh = 0; qh < q.length; qh++) {
      const a = q[qh]; order.push(a); seen.add(a);
      for (const d of iter(this.dep.get(a))) if (dirty.has(d)) { const n = indeg.get(d) - 1; indeg.set(d, n); if (n === 0) q.push(d); }
    }
    const cyclic = new Set();
    if (order.length !== dirty.size) for (const a of dirty) if (!seen.has(a)) cyclic.add(a);
    return { order, cyclic };
  }
}
export default Graph;
