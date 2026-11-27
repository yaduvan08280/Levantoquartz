// ============================================================
//  Apps Script data source (Phase 0)
//  Wraps the server-side proxy fetch (/api/sheet) of a Google
//  Apps Script /exec URL. Returns the existing tab shape so the
//  dashboard renders it unchanged.
// ============================================================

// Low-level: fetch one connection's workbook payload.
// -> { ok, sheetName, tabs } | { ok:false, error }
export async function fetchConnectionTabs(conn) {
  let wb;
  try { wb = await (await fetch('/api/sheet?url=' + encodeURIComponent(conn.url))).json(); }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
  if (!wb || !wb.ok) return { ok: false, error: wb?.error || 'fetch failed' };
  return { ok: true, sheetName: wb.sheetName || '', tabs: wb.tabs || [] };
}

// DataSource factory for the unified registry (used from Phase 7).
// Yields namespaced tabs: key = `${connId}__${localKey}`.
export function appsScriptSource(conn) {
  return {
    id: conn.id, kind: 'appsscript', name: conn.name, enabled: conn.enabled !== false,
    async getTabs() {
      const res = await fetchConnectionTabs(conn);
      if (!res.ok) throw new Error(res.error);
      return (res.tabs || []).map((t) => ({
        ...t, connId: conn.id, connName: conn.name, origKey: t.key,
        key: conn.id + '__' + t.key, sourceId: conn.id, sourceName: conn.name,
      }));
    },
  };
}
