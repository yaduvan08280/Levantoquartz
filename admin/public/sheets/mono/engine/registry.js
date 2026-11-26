// ============================================================
//  Mono formula engine — function registry (Phase 2)
//  register({ name, min, max, lazy, passErrors, volatile, fn, help })
//  Categories live in builtins.js (Tier-1). Per-category files +
//  full catalog land in later phases.
// ============================================================
const _fns = new Map();

/* Excel writes any function newer than the file format with an `_xlfn.`
   prefix, and worksheet-only ones with `_xlws.` - `_xlfn.XLOOKUP`,
   `_xlfn.TEXTJOIN`, `_xlfn._xlws.FILTER`. The prefix is a marker, not part of
   the name, and a Google Sheets export carries the same spelling. Without
   stripping it every such call resolved to #NAME?, and because these formulas
   are almost always wrapped in IFERROR the error was swallowed and the column
   just came out blank - silently wrong rather than visibly broken. Seen on a
   real workbook: ten MAP(...XLOOKUP...) columns returning nothing at all. */
const canonical = (name) => {
  let n = String(name).toUpperCase();
  while (n.startsWith('_XLFN.') || n.startsWith('_XLWS.')) n = n.slice(6);
  return n;
};

export const registry = {
  register(def) {
    _fns.set(def.name, def);
    for (const a of def.aliases || []) _fns.set(a, def);
    return def;
  },
  get(name) { return _fns.get(canonical(name)); },
  has(name) { return _fns.has(canonical(name)); },
  list() { return [..._fns.values()]; },
  names() { return [..._fns.keys()]; },
};
export default registry;
