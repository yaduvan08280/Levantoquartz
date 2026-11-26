// ============================================================
//  Mono — View Kind Registry  (P8)
//  Stores renderer definitions by kind string.
//  No DOM here — pure registration map.
//
//  registerViewKind({ kind, label, icon, render, commandBarConfig })
//  getViewKind(kind)  → def | null
//  listViewKinds()    → def[]
// ============================================================

const _registry = new Map();

/**
 * Register a view kind.
 * @param {object} def
 * @param {string} def.kind        — 'grid'|'kanban'|'calendar'|'gallery'|'form'|'gantt'|'map'
 * @param {string} def.label       — human-readable name
 * @param {string} def.icon        — icon name from icons.js
 * @param {Function} def.render    — (host, mount) → void
 * @param {Function} def.commandBarConfig — (spec) → {left,right,overflow} for commandBarHTML
 */
export function registerViewKind(def) {
  if (!def || !def.kind) throw new Error('registerViewKind: def.kind is required');
  if (_registry.has(def.kind)) throw new Error(`registerViewKind: kind '${def.kind}' already registered`);
  _registry.set(def.kind, def);
}

/** @returns {object|null} */
export function getViewKind(kind) {
  return _registry.get(kind) || null;
}

/** @returns {object[]} all registered definitions */
export function listViewKinds() {
  return [..._registry.values()];
}
