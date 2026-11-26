// ============================================================
//  Mono Sheets — Workspace (P20 Phase A)
//  A workspace is the set of *open* workbooks: their display order
//  and which one is active. Each workbook persists in its own store
//  slot ('wb_xxx'), each with its own sync config under
//  settings.syncByWorkbook[workbookId].
//
//  Persisted shape (kept inside the settings blob):
//    settings.workspace = { order: [workbookId, ...], activeWorkbookId }
//
//  One-time migration: the legacy single-workbook world stored the
//  whole workbook under store slot 'default' and its sync config
//  under settings.sync. On first load after upgrade we move the
//  'default' slot to a per-workbook slot keyed by the workbook's own
//  id, seed the workspace index with that one entry, and move
//  settings.sync under settings.syncByWorkbook[id]. No data loss,
//  no visible change for existing users.
// ============================================================

export const DEFAULT_SYNC = { enabled: false, execUrl: '', direction: 'twoWay', onConflict: 'ask', auto: false, intervalSec: 30, lastSyncAt: null, base: {} };

export function newSyncConfig() { return JSON.parse(JSON.stringify(DEFAULT_SYNC)); }

/** Per-workbook sync config, seeding a default entry on first access. */
export function syncFor(settings, workbookId) {
  settings.syncByWorkbook = settings.syncByWorkbook || {};
  if (!settings.syncByWorkbook[workbookId]) settings.syncByWorkbook[workbookId] = newSyncConfig();
  // Backfill any fields added after the entry was created.
  settings.syncByWorkbook[workbookId] = Object.assign(newSyncConfig(), settings.syncByWorkbook[workbookId]);
  return settings.syncByWorkbook[workbookId];
}

/**
 * Ensure settings.workspace exists, migrating the legacy 'default'
 * store slot + settings.sync if present. Async because store access is.
 * Returns the workspace object ({ order, activeWorkbookId }).
 */
export async function ensureWorkspace(settings, store, saveSettings) {
  if (settings.workspace && Array.isArray(settings.workspace.order) && settings.workspace.order.length) {
    return settings.workspace;
  }
  const ws = { order: [], activeWorkbookId: null };
  // Legacy migration: single 'default' slot → wb.<id> slot.
  let legacy = null;
  try { legacy = await store.load('default'); } catch {}
  if (legacy) {
    const id = legacy.id || ('wb_' + Math.random().toString(36).slice(2, 8));
    legacy.id = id;
    await store.save(id, legacy);
    ws.order.push(id);
    ws.activeWorkbookId = id;
    // Move the single global sync config under this workbook's id.
    settings.syncByWorkbook = settings.syncByWorkbook || {};
    if (settings.sync && !settings.syncByWorkbook[id]) settings.syncByWorkbook[id] = Object.assign(newSyncConfig(), settings.sync);
  }
  settings.workspace = ws;
  if (saveSettings) saveSettings(settings);
  return ws;
}

/** Add a workbook id to the workspace (and make it active). */
export function addToWorkspace(settings, workbookId, saveSettings) {
  const ws = settings.workspace;
  if (!ws.order.includes(workbookId)) ws.order.push(workbookId);
  ws.activeWorkbookId = workbookId;
  if (saveSettings) saveSettings(settings);
}

/** Remove a workbook id from the workspace; returns the new active id. */
export function removeFromWorkspace(settings, workbookId, saveSettings) {
  const ws = settings.workspace;
  ws.order = ws.order.filter((id) => id !== workbookId);
  if (settings.syncByWorkbook) delete settings.syncByWorkbook[workbookId];
  if (ws.activeWorkbookId === workbookId) ws.activeWorkbookId = ws.order[0] || null;
  if (saveSettings) saveSettings(settings);
  return ws.activeWorkbookId;
}

