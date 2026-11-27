// Created-by cell type — stamped with the current user's display name when a row
// is first created. Display name comes from Settings → General (stored in
// localStorage as 'mono.settings.displayName').  Read-only after creation.
import { registerCellType } from '../cellTypes.js';

registerCellType({
  id: 'createdBy',
  displayName: 'Created by',
  icon: 'user',
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
  autoStamp: 'createdBy',
});
