// Button cell type — renders a clickable button.
// The raw value is the button label (or JSON config: {label,url,cmd}).
// Clicking: if value has a url → open in new tab. cmd → dispatched as
// a 'ms-btn-click' CustomEvent on the cell TD (handled by grid.js P14+).
import { registerCellType } from '../cellTypes.js';

function parse(raw) {
  if (!raw) return { label: 'Click' };
  try { const o = JSON.parse(raw); return typeof o === 'object' && o !== null ? o : { label: String(raw) }; } catch { return { label: String(raw) }; }
}

registerCellType({
  id: 'button',
  displayName: 'Button',
  icon: 'mouse-pointer',
  coerce(raw) { return raw == null ? '' : String(raw); },
  validate() { return true; },
  format(value) { return parse(value).label || 'Click'; },
  renderHint(value) {
    const { label = 'Click', url, cmd } = parse(value);
    const esc = (s) => String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return {
      html: `<button class="ct-btn" type="button" data-url="${esc(url || '')}" data-cmd="${esc(cmd || '')}">${esc(label)}</button>`,
    };
  },
  serialize(value) { return value ?? ''; },
  deserialize(raw) { return raw == null ? '' : String(raw); },
});
