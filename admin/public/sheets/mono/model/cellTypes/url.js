import { registerCellType } from '../cellTypes.js';

function isUrl(v) {
  try { return Boolean(new URL(v)); } catch { return false; }
}

registerCellType({
  id: 'url',
  displayName: 'URL',
  icon: 'link',
  coerce(raw) { return raw == null ? '' : String(raw).trim(); },
  validate(v) { return !v || isUrl(v) ? true : 'Invalid URL'; },
  format(value) { return value ?? ''; },
  renderHint(value) {
    if (!value) return null;
    const esc = value.replace(/"/g, '&quot;');
    const label = value.replace(/^https?:\/\//, '').replace(/\/.*/, '');
    return { html: `<a class="ct-link ct-url" href="${esc}" target="_blank" rel="noopener noreferrer" title="${esc}">${label}</a>` };
  },
  serialize(value) { return value ?? ''; },
  deserialize(raw) { return raw == null ? '' : String(raw).trim(); },
});
