// Attachment cell type — stores one or more file attachment IDs.
// The raw value is a JSON array of attachment IDs: '["att_abc","att_xyz"]'.
// Actual blobs live in attachmentStore.js (IndexedDB). The cell never
// stores the blob itself, only references.
//
// Dashboard treatment: emit "[file]" placeholder — excluded from aggregation.
import { registerCellType } from '../cellTypes.js';

function parseIds(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

registerCellType({
  id: 'attachment',
  displayName: 'Attachment',
  icon: 'paperclip',
  coerce(raw) {
    // Accept either a JSON array string or a bare attachment ID
    if (!raw) return '';
    if (raw.startsWith('[')) return raw;        // already JSON array
    return JSON.stringify([raw]);               // wrap bare ID
  },
  validate() { return true; },
  format(value) {
    const ids = parseIds(value);
    if (!ids.length) return '';
    return ids.length === 1 ? '[file]' : `[${ids.length} files]`;
  },
  renderHint(value) {
    const ids = parseIds(value);
    if (!ids.length) return null;
    const label = ids.length === 1 ? '📎 1 file' : `📎 ${ids.length} files`;
    return { html: `<span class="ct-attachment-badge" data-ids="${encodeURIComponent(JSON.stringify(ids))}">${label}</span>` };
  },
  serialize(value) { return value ?? ''; },
  deserialize(raw) { return raw ?? ''; },
  // Dashboard: exclude from numeric aggregation
  dashboardExclude: true,
});
