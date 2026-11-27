// Created-time cell type — stamped by engine.setRaw when a row is first created.
// Read-only after creation.  Raw value: ISO 8601 string.
import { registerCellType } from '../cellTypes.js';

function fmt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  } catch { return iso; }
}

registerCellType({
  id: 'createdTime',
  displayName: 'Created time',
  icon: 'clock',
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
  autoStamp: 'created',  // engine checks this flag
});
