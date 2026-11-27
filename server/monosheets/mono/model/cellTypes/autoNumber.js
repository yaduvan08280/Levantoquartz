// Auto-number cell type — read-only sequential integer assigned at row creation.
// The engine stamps the next value from sheet.autoNumberCounters[c] in
// engine.insertRows (P10 modification).
// The cell's raw value IS the number string — auto-number is just a declared
// type that prevents manual editing and formats as an integer badge.
import { registerCellType } from '../cellTypes.js';

registerCellType({
  id: 'autoNumber',
  displayName: 'Auto-number',
  icon: 'hash',
  coerce(raw) {
    if (raw === '' || raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  },
  validate() { return true; },   // read-only — no user input to validate
  format(value) { return value == null ? '' : String(value); },
  renderHint(value) {
    if (value == null) return null;
    return { html: `<span class="ct-badge ct-autonumber">#${value}</span>`, cls: 'ct-autonumber-cell' };
  },
  serialize(value) { return value == null ? '' : String(value); },
  deserialize(raw) {
    if (raw === '' || raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  },
  readOnly: true,
});
