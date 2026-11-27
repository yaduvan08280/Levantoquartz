// ============================================================
//  Shared event bus (Phase 0)
//  Decouples the two modes + the data layer. Mono engine recalcs,
//  source changes, and dashboard refreshes all flow through here.
// ============================================================
const map = new Map(); // event -> Set<fn>

export const bus = {
  on(evt, fn) {
    if (!map.has(evt)) map.set(evt, new Set());
    map.get(evt).add(fn);
    return () => bus.off(evt, fn);
  },
  off(evt, fn) { map.get(evt)?.delete(fn); },
  emit(evt, payload) {
    map.get(evt)?.forEach((fn) => { try { fn(payload); } catch (e) { console.error('[bus]', evt, e); } });
  },
};
export default bus;
