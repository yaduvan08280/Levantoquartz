// Mono storage — LocalStore (Phase 6). localStorage-backed (offline-first).
// (IndexedDB for very large workbooks is a noted enhancement.)
const PREFIX = 'mono.wb.';
const OLD = 'mono.workbook.v1';
export class LocalStore {
  label() { return 'On this device'; }
  async load(id = 'default') {
    try { let r = localStorage.getItem(PREFIX + id); if (!r && id === 'default') { const o = localStorage.getItem(OLD); if (o) { r = o; localStorage.setItem(PREFIX + id, o); } } return r ? JSON.parse(r) : null; } catch { return null; }
  }
  async save(id = 'default', json) { try { localStorage.setItem(PREFIX + id, JSON.stringify(json)); return true; } catch (e) { console.error('LocalStore.save', e); return false; } }
  // localStorage has to be rewritten whole regardless, so there is nothing a
  // patch could save here — the caller falls back to a full save.
  async patch() { return { ok: false, code: 'unpatchable' }; }
  async list() { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) out.push({ id: k.slice(PREFIX.length) }); } return out; }
  async remove(id = 'default') { localStorage.removeItem(PREFIX + id); }
}
