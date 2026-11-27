// ============================================================
//  Unified DataSource registry (Phase 0 foundation)
//  Any source yields tabs in the shape the dashboard renders:
//    tab = { key, name, headers:[], rows:[{<header>:val}], rowCount,
//            sourceId, sourceName }
//  Phase 0: registry + Apps Script source exist. Mono + CSV sources
//  register here in Phase 7 so dashboards bind to them transparently.
// ============================================================
import { bus } from './bus.js';

const _sources = new Map(); // id -> DataSource

export const sources = {
  add(src) { _sources.set(src.id, src); bus.emit('sources:changed', { id: src.id }); return src; },
  remove(id) { const s = _sources.get(id); _sources.delete(id); bus.emit('sources:changed', { id }); return s; },
  get(id) { return _sources.get(id); },
  list() { return [..._sources.values()]; },
  clear() { _sources.clear(); },

  // Merge every enabled source into the { sheetName, tabs, timestamp } object
  // the dashboard expects. (The dashboard currently builds this from its own
  // connections list; this is the forward-looking path for mixed sources.)
  async buildWorkbook() {
    const tabs = []; const names = [];
    for (const s of _sources.values()) {
      if (s.enabled === false) continue;
      let t = [];
      try { t = await s.getTabs(); } catch (e) { bus.emit('source:error', { id: s.id, error: String(e) }); continue; }
      if (s.name) names.push(s.name);
      for (const tab of t) tabs.push(tab);
    }
    return { sheetName: names.join(' + ') || 'Workspace', tabs, timestamp: new Date().toISOString() };
  },
};
export default sources;
