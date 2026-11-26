// Modified-time cell type — stamped by engine.setRaw on every write.
// Raw value: ISO 8601 string.
import { registerCellType } from '../cellTypes.js';

function fmt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  } catch { return iso; }
}

registerCellType({
  id: 'modifiedTime',
  displayName: 'Modified time',
  icon: 'edit-3',
  coerce(raw) { return raw == null ? '' : String(raw); },
  validate() { return true; },
  format: fmt,
  renderHint(value) {
    if (!value) return null;
    return { html: `<time class="ct-timestamp" datetime="${value}" title="${value}">${fmt(value)}</time>` };
  },
  serialize(value) { return value ?? ''; },
  deserialize(raw) { return raw ?? ''; },
  readOnly: true,
  autoStamp: 'modified',  // engine checks this flag on every setRaw
});
