import { registerCellType } from '../cellTypes.js';

registerCellType({
  id: 'phone',
  displayName: 'Phone',
  icon: 'phone',
  coerce(raw) { return raw == null ? '' : String(raw).trim(); },
  validate() { return true; },  // any non-empty string is valid
  format(value) { return value ?? ''; },
  renderHint(value) {
    if (!value) return null;
    const esc = value.replace(/"/g, '&quot;');
    return { html: `<a class="ct-link ct-phone" href="tel:${encodeURIComponent(value)}">${esc}</a>` };
  },
  serialize(value) { return value ?? ''; },
  deserialize(raw) { return raw == null ? '' : String(raw).trim(); },
});
