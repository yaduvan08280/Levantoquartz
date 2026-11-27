// ============================================================
//  Mono → Dashboard data source (Phase 7)
//  Converts a Mono workbook into the dashboard tab shape
//  { key, name, headers, rows } — computed live via the engine —
//  so the existing profiler + widgets render Mono tables unchanged.
// ============================================================
import { MonoWorkbook, colToLetters } from '../mono/model/workbook.js';
import { Engine } from '../mono/engine/engine.js';

// Core (testable): a MonoWorkbook -> tabs[].
export function workbookToTabs(wb, connId = 'mono') {
  const eng = new Engine(wb);
  const tabs = [];
  for (const sh of wb.sheets) {
    if (!sh.cells.size) continue;
    const sid = sh.id;
    let lastR = 0, lastC = 0;
    for (const k of sh.cells.keys()) { const [r, c] = k.split(',').map(Number); if (r > lastR) lastR = r; if (c > lastC) lastC = c; }
    const cols = lastC + 1;
    const headers = []; const seen = {};
    for (let c = 0; c < cols; c++) { let h = eng.getDisplay(sid, 0, c); if (!h) h = colToLetters(c); if (seen[h] != null) h = h + '_' + c; seen[h] = 1; headers.push(h); }
    const rows = [];
    for (let r = 1; r <= lastR; r++) { let any = false; const obj = {}; for (let c = 0; c < cols; c++) { const v = eng.getDisplay(sid, r, c); obj[headers[c]] = v; if (v !== '') any = true; } if (any) rows.push(obj); }
    // U4: sourceSheetMeta lets a dashboard widget resolve its way back to the
    // sheet (and, once P9 views ship, the specific view) that fed it — additive
    // and backward compatible; old dashboards without it just skip the reverse-link.
    if (rows.length) tabs.push({ key: connId + '__' + sid, name: sh.name, headers, rows, rowCount: rows.length, connId, connName: 'Mono Sheets', origKey: sid, sourceId: connId, sourceName: 'Mono Sheets', sourceSheetMeta: { sheetId: sid, viewId: null } });
  }
  return tabs;
}
// Per-sheet feed toggle (set in Sheets mode via the row menu → "Feed dashboard"
// / "Disconnect from dashboard"). Allowlist, stored in the Mono settings blob:
// a sheet reaches the dashboard ONLY when it has been explicitly enabled here.
// Default is OFF — nothing feeds until the user opts a sheet in.
function feedEnabledSet() {
  try { const s = JSON.parse(localStorage.getItem('mono.settings') || '{}'); return s.feedEnabled || {}; } catch { return {}; }
}
// Kept name for the dashboard's "Sheet not connected" guard: a sheet is
// "not connected" (feed-disabled) whenever it is not on the allowlist.
export function monoFeedDisabled(sheetId) { return !feedEnabledSet()[sheetId]; }
const sheetIdOf = (t) => t.sourceSheetMeta && t.sourceSheetMeta.sheetId;

// Where Mono keeps its data depends on sign-in state: signed-in users live on
// the server (ServerStore); local/offline builds live in localStorage.
function serverModeInfo() {
  try { const s = JSON.parse(localStorage.getItem('mono.settings') || '{}'); return { server: s.dataHome === 'server', base: s.serverUrl || '' }; }
  catch { return { server: false, base: '' }; }
}

// Server path: pull EVERY workbook the signed-in user can see (owned + shared)
// from the same API ServerStore uses, so the dashboard sees exactly what Sheets
// mode does. Returns the inner workbook JSONs (MonoWorkbook.fromJSON-ready).
async function loadWorkbookJsonsServer(base) {
  const out = [];
  try {
    const list = await (await fetch(base + '/api/workbooks')).json();
    const wbs = (list && list.workbooks) || [];
    for (const w of wbs) {
      try {
        const r = await fetch(base + '/api/workbook/' + encodeURIComponent(w.id));
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.ok && j.workbook) out.push(j.workbook);
      } catch {}
    }
  } catch {}
  return out;
}

// Local path (offline/dev). P20: the workspace can hold several workbooks, each
// in its own 'mono.wb.<id>' slot, indexed by settings.workspace.order. Pre-P20
// data lives in the single 'mono.wb.default' slot — keep reading it as fallback.
function loadWorkbookJsons() {
  const out = [];
  try {
    const s = JSON.parse(localStorage.getItem('mono.settings') || '{}');
    const order = (s.workspace && s.workspace.order) || [];
    for (const id of order) {
      const raw = localStorage.getItem('mono.wb.' + id);
      if (raw) { try { out.push(JSON.parse(raw)); } catch {} }
    }
  } catch {}
  if (!out.length) {
    const raw = localStorage.getItem('mono.wb.default');
    if (raw) { try { out.push(JSON.parse(raw)); } catch {} }
  }
  return out;
}

// Async because server mode fetches over the network. Builds tabs for every
// sheet of every workbook, then keeps only the sheets on the feed allowlist —
// so the dashboard nav shows exactly the sheets the user opted in.
export async function loadMonoTabs() {
  try {
    const { server, base } = serverModeInfo();
    const jsons = server ? await loadWorkbookJsonsServer(base) : loadWorkbookJsons();
    if (!jsons.length) return [];
    const enabled = feedEnabledSet();
    const all = [];
    for (const j of jsons) { try { all.push(...workbookToTabs(MonoWorkbook.fromJSON(j))); } catch {} }
    return all.filter((t) => enabled[sheetIdOf(t)]);
  } catch { return []; }
}
export function monoEnabled() { try { return localStorage.getItem('mono.dash.enabled') === '1'; } catch { return false; } }
export function setMonoEnabled(v) { try { localStorage.setItem('mono.dash.enabled', v ? '1' : '0'); } catch {} }
