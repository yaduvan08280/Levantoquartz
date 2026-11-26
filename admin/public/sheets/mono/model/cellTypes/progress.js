import { registerCellType } from '../cellTypes.js';

function coerce(raw) {
  if (raw === '' || raw == null) return 0;
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

registerCellType({
  id: 'progress',
  displayName: 'Progress',
  icon: 'bar-chart-2',
  coerce,
  validate(v) { const n = Number(v); return (Number.isNaN(n) || n < 0 || n > 100) ? 'Must be 0–100' : true; },
  format(value) { return `${coerce(value)}%`; },
  renderHint(value) {
    const pct = coerce(value);
    return {
      html: `<span class="ct-progress-bar" title="${pct}%"><span class="ct-progress-fill" style="width:${pct}%"></span><span class="ct-progress-label">${pct}%</span></span>`,
    };
  },
  serialize(value) { return String(coerce(value)); },
  deserialize(raw) { return coerce(raw); },
});
