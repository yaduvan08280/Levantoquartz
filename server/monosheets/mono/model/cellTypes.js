// ============================================================
//  Mono — Cell Type registry  (P10)
//
//  Cell types declare how a column's values are coerced, validated,
//  formatted for display, and rendered in the grid.
//
//  CellTypeDef shape:
//  {
//    id:          string,          — unique identifier e.g. 'rating'
//    displayName: string,          — shown in type picker
//    icon:        string,          — icon name from icons.js
//    coerce(raw)         → value,  — raw string → stored value
//    validate(value)     → true|string,  — true = valid, string = error msg
//    format(value, ctx)  → string, — display string (no HTML)
//    renderHint(value, ctx) → {html?,cls?,title?}|null,
//                                  — rich grid cell content (optional)
//    serialize(value)    → string, — value → raw storage string
//    deserialize(raw)    → value,  — raw → value (inverse of coerce)
//  }
//
//  API:
//    registerCellType(def)         — throws on duplicate id
//    getCellType(id)               → def | null
//    cellTypeFor(sheet, c)         → def | null
//    listCellTypes()               → def[]
// ============================================================

const _registry = new Map();

/**
 * @param {CellTypeDef} def
 */
export function registerCellType(def) {
  if (!def || !def.id) throw new Error('registerCellType: def.id is required');
  if (_registry.has(def.id)) throw new Error(`registerCellType: id '${def.id}' already registered`);
  _registry.set(def.id, def);
}

/**
 * @param {string} id
 * @returns {CellTypeDef|null}
 */
export function getCellType(id) {
  return _registry.get(id) ?? null;
}

/**
 * Return the registered cell type for column `c` of `sheet`, or null.
 * Sheet with no colTypes field → always null (zero overhead).
 * @param {MonoSheet} sheet
 * @param {number}    c
 * @returns {CellTypeDef|null}
 */
export function cellTypeFor(sheet, c) {
  if (!sheet || !sheet.colTypes) return null;
  const id = sheet.colTypes[c];
  if (!id) return null;
  return getCellType(id) ?? null;
}

/**
 * @returns {CellTypeDef[]}
 */
export function listCellTypes() {
  return [..._registry.values()];
}
