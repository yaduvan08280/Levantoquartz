import { registerCellType } from '../cellTypes.js';

const RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

registerCellType({
  id: 'email',
  displayName: 'Email',
  icon: 'mail',
  coerce(raw) { return raw == null ? '' : String(raw).trim().toLowerCase(); },
  validate(v) { return !v || RE.test(v) ? true : 'Invalid email address'; },
  format(value) { return value ?? ''; },
  renderHint(value) {
    if (!value) return null;
    return { html: `<a class="ct-link ct-email" href="mailto:${encodeURIComponent(value)}">${value}</a>` };
  },
  serialize(value) { return value ?? ''; },
  deserialize(raw) { return raw == null ? '' : String(raw).trim().toLowerCase(); },
});
