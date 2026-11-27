// Modified-by cell type — stamped with the current user's display name on every
// write.  Display name from localStorage 'mono.settings.displayName'.
import { registerCellType } from '../cellTypes.js';

registerCellType({
  id: 'modifiedBy',
  displayName: 'Modified by',
  icon: 'user-check',
  coerce(raw) { return raw == null ? '' : String(raw); },
  validate() { return true; },
  format(value) { return value ?? ''; },
  renderHint(value) {
    if (!value) return null;
    return { html: `<span class="ct-badge ct-user">${value}</span>` };
  },
  serialize(value) { return value ?? ''; },
  deserialize(raw) { return raw ?? ''; },
  readOnly: true,
  autoStamp: 'modifiedBy',
});
