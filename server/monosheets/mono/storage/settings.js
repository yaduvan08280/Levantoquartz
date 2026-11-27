// Mono — app settings (Phase 6, P20 multi-workbook). Persisted in localStorage('mono.settings').
// P20: `sync` (legacy single-workbook config) is superseded by `syncByWorkbook`
// keyed by workbook id; `workspace` tracks open workbooks + active one;
// `wbCollapsed` remembers which sidebar workbook groups are folded;
// `sidebarHidden` remembers the sidebar show/hide toggle.
const KEY = 'mono.settings';
const DEFAULTS = {
  dataHome: 'local', serverUrl: '',
  sync: { enabled: false, execUrl: '', direction: 'twoWay', onConflict: 'ask', auto: false, intervalSec: 30, lastSyncAt: null, base: {} },
  syncByWorkbook: {},
  workspace: null,            // { order: [workbookId], activeWorkbookId } — seeded by ensureWorkspace()
  wbCollapsed: {},            // { [workbookId]: true }
  sidebarHidden: false,
  // feedDisabled: legacy denylist (default-ON feed). feedEnabled: allowlist
  // (default-OFF) — a sheet reaches the dashboard only when explicitly enabled.
  sheetColors: {}, feedDisabled: {}, feedEnabled: {},
};
export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return Object.assign({}, DEFAULTS, s, {
      sync: Object.assign({}, DEFAULTS.sync, s.sync),
      syncByWorkbook: Object.assign({}, s.syncByWorkbook),
      wbCollapsed: Object.assign({}, s.wbCollapsed),
      sheetColors: Object.assign({}, DEFAULTS.sheetColors, s.sheetColors),
      feedDisabled: Object.assign({}, DEFAULTS.feedDisabled, s.feedDisabled),
      feedEnabled: Object.assign({}, DEFAULTS.feedEnabled, s.feedEnabled),
    });
  } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }
// (P20)
