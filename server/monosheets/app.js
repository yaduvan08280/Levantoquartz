// ============================================================
//  Mono Dashboard — SPA
//  Multi-sheet workspace + live widgets + filters/insights +
//  widget editor + layout saving + auto-refresh + dark mode + CSV/PDF.
//  All computed in the browser; works with no AI key.
//  Phase 0: exports a mountable `Dashboard` controller for shell.js
//  (no longer auto-boots); the sheet fetch is routed via the data layer.
// ============================================================
import { fetchConnectionTabs } from './data/appsScriptSource.js';
import { loadMonoTabs, monoEnabled, monoFeedDisabled } from './data/monoSource.js';
import { icon } from './ui/icons.js';
import { registerCommands } from './ui/commandRegistry.js';
import { emptyStateHTML } from './ui/emptyState.js';

const S = {
  config: null,
  connections: [],          // [{id,name,url,enabled}]
  workbook: null, tabsByKey: {}, profileByTab: {},
  dashboard: null, autoDashboard: null, pageId: null, structureSig: '',
  charts: {}, chat: [], pendingDashboard: null,
  filters: {}, editMode: false, autoRefresh: false, refreshTimer: null,
  theme: localStorage.getItem('theme') || 'light',
  wbKey: '',                // content fingerprint of the data tabs (H6/H7/M10)
  keysOnServer: new Set(),  // wbKeys the server has confirmed are cached
  tableShown: {},           // widgetId -> rows currently shown (C5)
  tableFind: {},            // widgetId -> model-level find query (C5)
};

/* ---------- perf memos (report M2/M3/M4) ----------
   _rowsMemo:     rowsOf() result per tab — cleared at the start of every
                  render/refresh pass and on any filter/data change, so every
                  widget on a page shares ONE filter pass (M4).
   _distinctMemo: distinct values per (tab|column) — depends only on raw rows,
                  cleared when the data itself changes (M2).
   _insightsMemo: insights HTML per (tab|filters) — cleared on data change,
                  capped so it can't grow unbounded (M3). */
const _rowsMemo = new Map();
const _distinctMemo = new Map();
const _insightsMemo = new Map();
function clearDataMemos() { _rowsMemo.clear(); _distinctMemo.clear(); _insightsMemo.clear(); }

/* ---------- utils ---------- */
const $ = (s, e = document) => e.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// M12: structuredClone instead of a JSON round-trip. Everything cloned here is
// JSON-safe (dashboards come from server JSON / localStorage), so behavior is
// identical — the JSON fallback stays as a belt-and-braces guard.
const clone = (o) => { try { return structuredClone(o); } catch { return JSON.parse(JSON.stringify(o)); } };
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstElementChild; };
const uid = () => Math.random().toString(36).slice(2, 9);
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms); }
function cleanNum(v) { if (v == null) return null; const s = String(v).replace(/[,₹$€£%\s]/g, ''); if (s === '' || s === '-' || s === '.') return null; const n = Number(s); return Number.isFinite(n) ? n : null; }
function fmtNum(n) { if (n == null || Number.isNaN(n)) return '—'; const a = Math.abs(n); if (a >= 1e7) return (n / 1e6).toFixed(1) + 'M'; if (a >= 1e5) return (n / 1e3).toFixed(0) + 'K'; return n % 1 === 0 ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function parseDate(v) {
  const s = String(v ?? '').trim(); if (!s) return { key: '', label: '' };
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) { let [, d, mo, y] = m; y = y.length === 2 ? '20' + y : y; return { key: `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, label: `${d}/${mo}` }; }
  m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) { const [, y, mo, d] = m; return { key: `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, label: `${d}/${mo}` }; }
  const t = Date.parse(s); if (!Number.isNaN(t)) { const dt = new Date(t); return { key: dt.toISOString().slice(0, 10), label: dt.toLocaleDateString() }; }
  return { key: s, label: s };
}
const POS = ['done', 'complete', 'completed', 'yes', 'approved', 'active', 'ok', 'pass', 'delivered', 'dispatched', 'ready', 'paid', 'closed'];
const WARN = ['pending', 'in progress', 'inprogress', 'review', 'on hold', 'hold', 'wip', 'scheduled', 'partial', 'started', 'running', 'open', 'todo'];
const NEG = ['rejected', 'no', 'fail', 'failed', 'blocked', 'overdue', 'cancelled'];
const isDone = (v) => POS.includes(String(v ?? '').trim().toLowerCase());
function badgeClass(v) { const s = String(v ?? '').trim().toLowerCase(); if (POS.includes(s)) return 'b-ok'; if (WARN.includes(s)) return 'b-warn'; if (NEG.includes(s)) return 'b-bad'; if (!s) return 'b-mute'; return 'b-info'; }
const isStatusVal = (v) => { const s = String(v ?? '').toLowerCase(); return POS.includes(s) || WARN.includes(s) || NEG.includes(s); };
// custom colors from formula rules (label -> hex), filled by rebuildViews()
const RULE_COLORS = { green: '#4F9D69', red: '#CF4F33', amber: '#E0892F', blue: '#5E7FA6', gray: '#8a7d6a', gold: '#D4A76A' };
S.labelColors = {};
function labelColor(v) { return S.labelColors[String(v ?? '')] || null; }
function badgeFor(v) { const hex = labelColor(v); if (hex) return `<span class="badge" style="background:${hex}22;color:${hex}">${esc(v)}</span>`; return isStatusVal(v) ? `<span class="badge ${badgeClass(v)}">${esc(v)}</span>` : esc(v); }
const PALETTE = ['#D4A76A', '#5E7FA6', '#4F9D69', '#CF4F33', '#B8944F', '#A98EC0', '#E0892F', '#8a7d6a'];
const agg = (vals, a) => { const n = vals.map(cleanNum).filter((x) => x != null); switch (a) { case 'avg': return n.length ? n.reduce((x, y) => x + y, 0) / n.length : 0; case 'min': return n.length ? Math.min(...n) : 0; case 'max': return n.length ? Math.max(...n) : 0; case 'count': return vals.length; default: return n.reduce((x, y) => x + y, 0); } };

/* ---------- connections ---------- */
function saveConnections() { try { localStorage.setItem('connections', JSON.stringify(S.connections)); } catch {} }
function loadConnections() { try { S.connections = JSON.parse(localStorage.getItem('connections') || '[]'); } catch { S.connections = []; } }

/* ---------- boot ---------- */
async function boot() {
  Dashboard.active = true; document.body.dataset.mode = 'dashboard';
  window.ChatUI?.mount();
  window.ChatUI?.setMode('dashboard');
  if (window.ChatUI) window.ChatUI.onSend = sendDashboardChat;
  document.body.dataset.theme = S.theme;
  $('#chatIcon').innerHTML = icon('sparkles', { size: 15 });
  $('#chatCloseBtn').innerHTML = icon('x', { size: 14 });
  $('#fab').innerHTML = icon('sparkles', { size: 20 });
  try { S.config = await (await fetch('/api/config')).json(); } catch { S.config = { llm: { configured: false, provider: '-', model: '-' }, defaultAppsScriptUrl: '' }; }
  $('#chatProvider').textContent = S.config.llm.configured ? `${S.config.llm.provider} · ${S.config.llm.model}` : 'no AI key — chat off';
  loadConnections();
  // migrate legacy single-url, or default url from server
  if (!S.connections.length) {
    const legacy = localStorage.getItem('appsScriptUrl') || S.config.defaultAppsScriptUrl;
    if (legacy) S.connections = [{ id: uid(), name: legacy, url: legacy, enabled: true }];
  }
  if (S.connections.length || monoEnabled()) connectAll(); else renderConnect();
}

function renderConnect(err) {
  if (!Dashboard.active) return;
  $('#sidebar').innerHTML = ''; $('#modeActions').innerHTML = '';
  $('#main').innerHTML = `<div class="center"><div class="connect">
    <h2>Connect a Google Sheet</h2>
    <p>Paste your Apps Script <b>/exec</b> URL. You can add more sheets later from the sidebar.</p>
    ${err ? `<div class="error">${esc(err)}</div>` : ''}
    <input id="urlInput" class="mono" placeholder="https://script.google.com/macros/s/…/exec" />
    <button class="btn btn-primary btn-block" onclick="App.connectFromInput()">Connect &amp; build dashboard</button>
    <div class="note">Everything (KPIs, charts, filters, insights, PDF) runs locally and free.</div>
  </div></div>`;
}
function connectFromInput() { const u = $('#urlInput').value.trim(); if (!u) return; S.connections = [{ id: uid(), name: u, url: u, enabled: true }]; saveConnections(); connectAll(); }

/* ---------- fetch + merge all sheets ---------- */
async function buildWorkbook() {
  const tabs = []; const names = [];
  for (const c of S.connections.filter((x) => x.enabled)) {
    const res = await fetchConnectionTabs(c);
    if (!res.ok) { toast(`${c.name}: ${res.error}`); continue; }
    if (res.sheetName && (c.name === c.url || !c.name)) { c.name = res.sheetName; }
    names.push(c.name);
    (res.tabs || []).forEach((t) => tabs.push({ ...t, connId: c.id, connName: c.name, origKey: t.key, key: c.id + '__' + t.key }));
  }
  if (monoEnabled()) { const mt = await loadMonoTabs(); if (mt.length) { names.push('Mono Sheets'); mt.forEach((t) => tabs.push(t)); } }
  return { sheetName: names.join(' + ') || 'Workspace', tabs, timestamp: new Date().toISOString() };
}
function setWorkbook(wb) { S.workbook = wb; S.tabsByKey = {}; wb.tabs.forEach((t) => { S.tabsByKey[t.key] = t; }); S.structureSig = wb.tabs.map((t) => t.key + ':' + (t.headers || []).join('|')).join('||'); S.wbKey = wbFingerprint(wb); clearDataMemos(); }

/* ---------- workbook fingerprint (H6/H7/M10) ----------
   Cheap, stable content hash over the data tabs (views excluded — they are
   derived). Hashing the same JSON we previously UPLOADED on every AI call is
   strictly cheaper than uploading it. Length is mixed in to cut collision
   odds; a false "unchanged" would skip one refresh, a false "changed" only
   costs one full upload — both self-heal on the next data edit. */
function wbFingerprint(wb) {
  let acc = '';
  for (const t of (wb.tabs || [])) {
    if (t.isView) continue;
    const rowsJson = JSON.stringify(t.rows || []);
    acc += t.key + '|h:' + (t.headers || []).join('\t') + '|d:' + hash(rowsJson) + ':' + rowsJson.length + ';;';
  }
  return 'fp_' + hash(acc) + '_' + acc.length;
}
/** The workbook payload for /api/generate: data tabs only, views stripped —
 *  exactly what regenerate() always sent. */
function dataWorkbook() { return { ...S.workbook, tabs: (S.workbook.tabs || []).filter((t) => !t.isView) }; }

/* ---------- AI transport (H6/H7 — server-side mitigation) ----------
   Every AI route accepts { wbKey } instead of the multi-MB workbook. The full
   workbook is sent only when the data actually changed (or the server lost
   its cache — it answers workbook_required and we retry ONCE with the data).
   The server profiles the FULL data and feeds the LLM the same compact
   profile as always, so answer quality is untouched — only the wire shrinks.

   Two payload shapes exist today and BOTH are preserved bit-for-bit:
   - generate: data tabs only (views stripped)            -> key = wbKey
   - chat:     all tabs INCLUDING derived formula views   -> key = wbKey|v<sig>
   Separate cache keys mean the chat LLM keeps seeing the view tabs it has
   always seen, and generate keeps not seeing them. */
function viewsSig() {
  let acc = '';
  for (const t of (S.workbook?.tabs || [])) {
    if (!t.isView) continue;
    acc += t.key + '|' + (t.headers || []).join('\t') + '|' + hash(JSON.stringify(t.rows || [])) + ';;';
  }
  return acc ? hash(acc) : '';
}
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function aiPost(url, payload, { withViews = false } = {}) {
  const vs = withViews ? viewsSig() : '';
  const key = vs ? S.wbKey + '|v' + vs : S.wbKey;
  const fullPayload = () => withViews ? { ...S.workbook } : dataWorkbook();
  const body = { ...payload, wbKey: key };
  const sendData = !S.keysOnServer.has(key);               // avoid a guaranteed 409 round trip
  if (sendData) body.workbook = fullPayload();
  let r = await postJson(url, body);
  if (r && r.error === 'workbook_required') {
    S.keysOnServer.delete(key);                            // server evicted / restarted
    r = await postJson(url, { ...payload, wbKey: key, workbook: fullPayload() });
    if (r && r.ok !== false) S.keysOnServer.add(key);
  } else if (r && sendData && r.ok !== false) {
    S.keysOnServer.add(key);
  }
  if (S.keysOnServer.size > 64) S.keysOnServer.clear();    // ancient keys are useless — server LRU forgot them anyway
  return r;
}
// U2: the shared top nav (shell-owned) shows "the current workbook/dashboard
// name" for whichever mode is active — Dashboard's is S.dashboard.title.
function announceWorkspaceName() { window.dispatchEvent(new CustomEvent('mono:workspaceName', { detail: { name: (S.dashboard && S.dashboard.title) || (S.workbook && S.workbook.sheetName) || 'Workspace' } })); }
// U4: cross-mode collaboration — best-effort queries the shell/Sheets side
// uses to build the "Feeds Dashboard" preview drawer and the reverse jump.
export function getMonoFeedPreview(sheetId) {
  if (!S.dashboard) return null;
  const key = 'mono__' + sheetId;
  const page = S.dashboard.pages.find((p) => p.id === key); if (!page) return null;
  const widgets = []; for (const sec of page.sections || []) for (const w of sec.widgets || []) widgets.push({ id: w.id, title: w.title || w.type, type: w.type });
  return { pageId: page.id, pageTitle: page.title, widgets };
}
export function focusDashboardPage(pageId) { if (!S.dashboard || !S.dashboard.pages.some((p) => p.id === pageId)) return; S.pageId = pageId; if (Dashboard.active) render(); }
function openSheetSource(sheetId) { window.dispatchEvent(new CustomEvent('mono:openSheet', { detail: { sheetId } })); }
function indexProfile(profile) { S.profileByTab = {}; (profile?.tabs || []).forEach((t) => { S.profileByTab[t.key] = t; }); }

async function connectAll(opts = {}) {
  if (!opts.silent && Dashboard.active) $('#main').innerHTML = `<div class="center"><div style="text-align:center"><div class="spin"></div><p class="muted" style="margin-top:14px">Reading ${S.connections.filter((c) => c.enabled).length} sheet(s)…</p></div></div>`;
  try {
    const wb = await buildWorkbook();
    if (!wb.tabs.length) { renderConnect('No tabs found in the connected sheet(s).'); return; }
    // M10: a (silent) refresh that fetched byte-identical data skips the
    // regenerate AND the re-render entirely — nothing can have changed.
    // Charts keep their instances, the server does zero profiling work.
    if (opts.silent && S.dashboard && S.workbook && Object.keys(S.profileByTab).length
        && wbFingerprint(wb) === S.wbKey) {
      S.workbook.timestamp = wb.timestamp;
      return;
    }
    setWorkbook(wb);
    const gen = await aiPost('/api/generate', {});
    if (!gen || gen.ok === false) throw new Error((gen && (gen.detail || gen.error)) || 'Dashboard generation failed');
    indexProfile(gen.profile); S.autoDashboard = clone(gen.dashboard);
    const saved = loadLayout();
    S.dashboard = saved ? reconcile(saved, gen.dashboard) : clone(gen.dashboard);
    rebuildViews();
    if (!S.dashboard.pages.find((p) => p.id === S.pageId)) S.pageId = S.dashboard.pages[0]?.id || null;
    saveConnections(); saveLayout();
    if (!opts.silent) toast(saved ? 'Loaded your layout' : (gen.usedAI ? 'Designed by AI' : 'Dashboard built'));
    render();
  } catch (e) { renderConnect(String(e.message || e)); }
}
// keep user edits: keep existing pages for tabs that still exist; add new tab pages; refresh overview
function reconcile(saved, auto) {
  const cur = new Set(S.workbook.tabs.map((t) => t.key));
  const autoById = {}; auto.pages.forEach((p) => { autoById[p.id] = p; });
  let pages = (saved.pages || []).filter((p) => p.id !== 'overview' && (cur.has(p.id) || p.id.startsWith('view:')));
  if (autoById.overview) pages.unshift(autoById.overview);
  for (const t of S.workbook.tabs) if (!pages.find((p) => p.id === t.key) && autoById[t.key]) pages.push(autoById[t.key]);
  const d = clone(saved); d.pages = pages; d.title = auto.title; return d;
}

/* ---------- connection management ---------- */
function openAddSheet() {
  const back = el(`<div class="modal-backdrop"><div class="modal">
    <h3>Add a sheet</h3>
    <div class="form-row"><label>Name (optional)</label><input id="as_name" placeholder="e.g. Plant 2"/></div>
    <div class="form-row"><label>Apps Script /exec URL</label><input id="as_url" class="mono" placeholder="https://script.google.com/macros/s/…/exec"/></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" onclick="App.addSheet()">Add</button></div>
  </div></div>`);
  document.body.appendChild(back);
}
function closeModal() { $('.modal-backdrop')?.remove(); }
async function addSheet() {
  const url = $('#as_url').value.trim(); const name = $('#as_name').value.trim();
  if (!/^https:\/\/script\.google\.com\//.test(url)) return toast('Enter a valid script.google.com /exec URL');
  S.connections.push({ id: uid(), name: name || url, url, enabled: true }); saveConnections(); closeModal();
  toast('Added — loading…'); connectAll();
}
function removeConn(id) {
  const c = S.connections.find((x) => x.id === id); if (!c) return;
  if (!confirm(`Remove "${c.name}" and its tabs from this dashboard?`)) return;
  S.connections = S.connections.filter((x) => x.id !== id);
  if (S.dashboard) S.dashboard.pages = S.dashboard.pages.filter((p) => !p.id.startsWith(id + '__'));
  saveConnections();
  if (!S.connections.length) { localStorage.removeItem('appsScriptUrl'); renderConnect(); return; }
  connectAll();
}
function renameConn(id) { const c = S.connections.find((x) => x.id === id); if (!c) return; const n = prompt('Rename sheet', c.name); if (n) { c.name = n.trim(); saveConnections(); renderSidebar(); } }
function refreshConn() { toast('Refreshing…'); connectAll({ silent: true }); }

/* ---------- layout persistence ---------- */
function layoutKey() { return 'layout:' + hash(S.connections.map((c) => c.id).sort().join(',') + '|' + S.structureSig); }
function saveLayout() { try { localStorage.setItem(layoutKey(), JSON.stringify(S.dashboard)); } catch {} }
function loadLayout() { try { const r = localStorage.getItem(layoutKey()); return r ? JSON.parse(r) : null; } catch { return null; } }
function resetLayout() { const fx = (S.dashboard && S.dashboard.formulas) || []; localStorage.removeItem(layoutKey()); S.dashboard = clone(S.autoDashboard); S.dashboard.formulas = fx; rebuildViews(); S.pageId = S.dashboard.pages[0]?.id; render(); toast('Reset layout (formulas kept)'); }

/* ---------- filtered rows ---------- */
// M4: one filter pass per tab per render pass — every widget on the page used
// to re-run the whole search+filter chain. The memo is cleared at the start of
// each render/refresh pass and whenever filters or data change.
function rowsOf(tabKey) {
  const hit = _rowsMemo.get(tabKey);
  if (hit) return hit;
  const t = S.tabsByKey[tabKey]; if (!t) throw new Error('tab "' + tabKey + '" not found');
  let rows = t.rows || []; const f = S.filters[tabKey];
  if (f) {
    if (f.search) { const q = f.search.toLowerCase(); rows = rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q))); }
    for (const [col, val] of Object.entries(f.cols || {})) if (val !== undefined && val !== '') rows = rows.filter((r) => String(r[col] ?? '') === val);
    const dc = (S.profileByTab[tabKey]?.dateColumns || [])[0];
    if (dc && (f.from || f.to)) rows = rows.filter((r) => { const k = parseDate(r[dc]).key; return (!f.from || k >= f.from) && (!f.to || k <= f.to); });
  }
  _rowsMemo.set(tabKey, rows);
  return rows;
}
const rawRowsOf = (tabKey) => S.tabsByKey[tabKey]?.rows || [];
function activeFilterCount(tabKey) { const f = S.filters[tabKey]; if (!f) return 0; return (f.search ? 1 : 0) + Object.values(f.cols || {}).filter((v) => v).length + (f.from || f.to ? 1 : 0); }

/* ---------- shell render ---------- */
// Full structural render: rebuilds the page DOM (page change, edit mode,
// widget add/remove, theme, new dashboard). Chart canvases are replaced, so
// instances must be destroyed here. Data-only changes (filters, search,
// drill-down) go through refreshData() below instead (M9/C4) and do NOT
// destroy charts.
function render() {
  if (!Dashboard.active) return;
  _rowsMemo.clear();                                   // M4: one filter pass per render pass
  Object.values(S.charts).forEach((c) => { try { c.destroy(); } catch {} }); S.charts = {};
  renderSidebar();
  announceWorkspaceName();
  const ai = S.config.llm.configured;
  registerCommands('Dashboard: actions', [
    { id: 'act:toggleEdit', label: S.editMode ? 'Exit edit layout' : 'Edit layout', icon: 'edit', run: () => toggleEdit() },
    { id: 'act:addWidget', label: 'Add widget', icon: 'plus', run: () => openEditor() },
    { id: 'act:refresh', label: 'Refresh now', icon: 'refresh-cw', run: () => refresh() },
    { id: 'act:toggleTheme', label: 'Toggle light / dark theme', icon: S.theme === 'dark' ? 'sun' : 'moon', run: () => toggleTheme() },
    { id: 'act:resetLayout', label: 'Reset layout', icon: 'undo', run: () => resetLayout() },
    { id: 'act:exportPdf', label: 'Export PDF report', icon: 'download', run: () => exportPdf() },
    { id: 'act:openFormula', label: 'New data view (formula)', icon: 'sparkles', run: () => openFormula() },
    { id: 'act:openAddSheet', label: 'Add a sheet', icon: 'plus', run: () => openAddSheet() },
    ...(ai ? [{ id: 'act:regenerate', label: 'AI redesign dashboard', icon: 'sparkles', run: () => regenerate() }] : []),
  ]);
  $('#modeActions').innerHTML = `
    <button class="ibtn ${S.editMode ? 'on' : ''}" title="Edit layout" onclick="App.toggleEdit()">${icon('edit', { size: 15 })}</button>
    <button class="ibtn" title="Add widget" onclick="App.openEditor()">${icon('plus', { size: 15 })}</button>
    <button class="ibtn ${S.autoRefresh ? 'on' : ''}" title="Auto-refresh 30s" onclick="App.toggleAuto()">${icon('history', { size: 15 })}</button>
    <button class="ibtn" title="Refresh now" onclick="App.refresh()">${icon('refresh-cw', { size: 15 })}</button>
    <button class="ibtn" title="Dark mode" onclick="App.toggleTheme()">${icon(S.theme === 'dark' ? 'sun' : 'moon', { size: 15 })}</button>
    ${ai ? `<button class="ibtn" title="AI redesign" onclick="App.regenerate()">${icon('sparkles', { size: 15 })}</button>` : ''}
    <button class="ibtn" title="Reset layout" onclick="App.resetLayout()">${icon('undo', { size: 15 })}</button>
    <button class="btn btn-primary" onclick="App.exportPdf()">${icon('download', { size: 14 })} PDF</button>`;

  const page = S.dashboard.pages.find((p) => p.id === S.pageId) || S.dashboard.pages[0];
  if (!page) { $('#main').innerHTML = emptyStateHTML({ icon: 'layout-dashboard', message: 'No pages yet.', ctaLabel: 'Add a widget', ctaOnclick: 'App.openEditor()' }); return; }
  const tabKey = S.tabsByKey[page.id] ? page.id : null; const t = tabKey ? S.tabsByKey[tabKey] : null;
  const sourceChip = (t && t.connId === 'mono' && t.sourceSheetMeta) ? `<button class="source-chip" onclick="App.openSheetSource('${esc(t.sourceSheetMeta.sheetId)}')">${icon('share', { size: 11 })} Source: ${esc(t.name)} ↗</button>` : '';
  let html = `<div class="page-head"><div><div class="page-title">${esc(page.title)}</div>
    <div class="page-sub">${t ? `${rowsOf(tabKey).length}/${t.rowCount} rows · ${(t.headers || []).length} cols · ${esc(t.connName || '')}` : `${S.dashboard.pages.length} views`} · ${new Date(S.workbook.timestamp || Date.now()).toLocaleTimeString()}</div>${sourceChip}</div>`;
  if (t) html += `<button class="btn btn-ghost" onclick="App.exportTabCsv('${esc(tabKey)}')">${icon('download', { size: 14 })} CSV</button>`;
  html += `</div>`;
  if (tabKey) html += filterBarHtml(tabKey);
  if (tabKey) html += insightsHtml(tabKey);
  for (const sec of page.sections || []) html += `<div class="section"><div class="section-title">${esc(sec.title)} ${S.editMode ? `<button class="xmini" title="Remove section" onclick="App.delSection('${esc(sec.id)}')">${icon('x', { size: 12 })}</button>` : ''}</div><div class="grid" id="sec_${esc(sec.id)}"></div></div>`;
  $('#main').innerHTML = html;
  for (const sec of page.sections || []) {
    const host = $('#sec_' + CSS.escape(sec.id)); if (!host) continue;
    for (const w of sec.widgets || []) {
      host.appendChild(buildWidgetNode(sec, w, tabKey));
    }
  }
}

/* ---------- M9 + C4: targeted data refresh ---------- */
const CHART_TYPES = new Set(['trend_line', 'area_chart', 'bar_chart', 'stacked_bar', 'pie_chart']);

function buildWidgetNode(sec, w, tabKey) {
  let node;
  try { node = renderWidget(w, tabKey); }
  catch (e) { node = el(`<div class="card col-4"><h4>${esc(w.title || w.type)}</h4><div class="empty-w">${icon('alert-triangle', { size: 13 })} ${esc(e.message)}</div></div>`); }
  node.dataset.wid = w.id;
  if (S.editMode) node.appendChild(el(`<div class="wtools"><button title="edit" onclick="App.openEditor({secId:'${esc(sec.id)}',wid:'${esc(w.id)}'})">${icon('edit', { size: 12 })}</button><button title="move left" onclick="App.moveWidget('${esc(sec.id)}','${esc(w.id)}',-1)">${icon('chevron-left', { size: 12 })}</button><button title="move right" onclick="App.moveWidget('${esc(sec.id)}','${esc(w.id)}',1)">${icon('chevron-right', { size: 12 })}</button><button title="remove" onclick="App.delWidget('${esc(sec.id)}','${esc(w.id)}')">${icon('x', { size: 12 })}</button></div>`));
  return node;
}

/** Data-only refresh of the current page: charts update IN PLACE (C4 — no
 *  destroy/recreate, no flicker), other widgets re-render only their own
 *  card, and the insights/filter chrome is patched. Used by every filter,
 *  search and drill-down path (M9); structure changes still use render(). */
function refreshData(opts = {}) {
  if (!Dashboard.active || !S.dashboard) return;
  const page = curPage();
  if (!page) return render();
  _rowsMemo.clear();                                   // filters changed — recompute once per tab
  const tabKey = S.tabsByKey[page.id] ? page.id : null;
  if (tabKey) {
    const t = S.tabsByKey[tabKey];
    const sub = $('.page-sub');
    if (sub) sub.textContent = `${rowsOf(tabKey).length}/${t.rowCount} rows · ${(t.headers || []).length} cols · ${t.connName || ''} · ${new Date(S.workbook.timestamp || Date.now()).toLocaleTimeString()}`;
    refreshFilterUi(tabKey, opts.keepFilterBar);
    refreshInsights(tabKey);
  }
  for (const sec of page.sections || []) for (const w of sec.widgets || []) refreshWidget(sec, w, tabKey);
}

function refreshFilterUi(tabKey, keepBar) {
  const bar = $('.filterbar'); if (!bar) return;
  if (keepBar) {
    // the user is typing in the search box — patch only the "clear n" button
    const n = activeFilterCount(tabKey);
    const btn = bar.querySelector('.fb-clear');
    if (n) {
      const html = `<button class="fb-clear" onclick="App.clearFilters('${esc(tabKey)}')">${icon('x', { size: 11 })} clear ${n}</button>`;
      if (btn) btn.outerHTML = html; else bar.insertAdjacentHTML('beforeend', html);
    } else btn?.remove();
  } else {
    const html = filterBarHtml(tabKey);
    if (html) bar.outerHTML = html;
  }
}

function refreshInsights(tabKey) {
  const cur = $('.insights');
  const html = insightsHtml(tabKey);
  if (cur) { if (html) cur.outerHTML = html; else cur.remove(); }
  else if (html) ($('.filterbar') || $('.page-head'))?.insertAdjacentHTML('afterend', html);
}

function refreshWidget(sec, w, tabKey) {
  const host = $('#sec_' + CSS.escape(sec.id)); if (!host) return;
  const node = host.querySelector(`[data-wid="${CSS.escape(w.id)}"]`);
  const ch = S.charts[w.id];
  if (ch && CHART_TYPES.has(w.type)) {
    // C4: same chart type -> swap data + drill handler, update in place.
    // Structure changes (widget type edited) destroy + recreate — Chart.js
    // in-place updates across type changes are unreliable (report §2.4).
    try {
      const cfg = chartConfig(w, w.binding || {});
      if (ch.config.type === cfg.type) {
        ch.data = cfg.data;
        if (cfg.options && cfg.options.onClick) ch.options.onClick = cfg.options.onClick;   // fresh closure — fresh labels
        ch.update('none');
        return;
      }
    } catch { /* fall through to full card re-render */ }
    try { ch.destroy(); } catch {}
    delete S.charts[w.id];
  } else if (ch) {
    try { ch.destroy(); } catch {}
    delete S.charts[w.id];
  }
  if (!node) return;
  host.replaceChild(buildWidgetNode(sec, w, tabKey), node);
}
function renderSidebar() {
  if (!Dashboard.active) return;
  const hasOv = S.dashboard?.pages?.some((p) => p.id === 'overview');
  const groups = {}; S.workbook.tabs.forEach((t) => { (groups[t.connId] ||= []).push(t); });
  let h = '';
  if (hasOv) h += `<div class="sb-sec">Workspace</div><div class="sb-item ${S.pageId === 'overview' ? 'active' : ''}" onclick="App.goPage('overview')">${icon('grid', { size: 13 })} Overview</div>`;
  h += `<div class="sb-sec">Sheets <button class="sb-add" title="Add sheet" onclick="App.openAddSheet()">${icon('plus', { size: 13 })}</button></div>`;
  for (const c of S.connections) {
    h += `<div class="sb-conn"><div class="sb-conn-head"><span class="nm">${esc(c.name)}</span>
      <button title="refresh" onclick="App.refreshConn('${c.id}')">${icon('refresh-cw', { size: 12 })}</button>
      <button title="rename" onclick="App.renameConn('${c.id}')">${icon('edit', { size: 12 })}</button>
      <button title="remove" onclick="App.removeConn('${c.id}')">${icon('trash', { size: 12 })}</button></div>`;
    const g = groups[c.id];
    h += g ? g.map((t) => `<div class="sb-tab ${S.pageId === t.key ? 'active' : ''}" onclick="App.goPage('${esc(t.key)}')">${esc(t.name)}<span class="ct">${t.rowCount || 0}</span></div>`).join('') : `<div class="sb-empty">${c.enabled ? '(no tabs)' : '(disabled)'}</div>`;
    h += `</div>`;
  }
  // U3: Mono Sheets group — same sb-row visual language as the Sheets-mode
  // sidebar, plus a one-click "Open sheet →" affordance back to its source.
  if (groups['mono'] && groups['mono'].length) {
    h += `<div class="sb-sec">${icon('database', { size: 11 })} Mono Sheets <button class="sb-add" title="Refresh" onclick="App.refresh()">${icon('refresh-cw', { size: 12 })}</button></div><div class="sb-conn">` +
      groups['mono'].map((t) => {
        const sheetId = (t.sourceSheetMeta && t.sourceSheetMeta.sheetId) || t.origKey;
        // A frozen tab is a disconnected sheet — its page stays visible but its
        // values are frozen at the last feed, and it can't be refreshed.
        const chip = t.frozen
          ? `<span class="sb-chip sb-chip-off" title="Disconnected — showing last-fed values">Not connected</span>`
          : `<button class="sb-chip" title="Open in Sheets" onclick="event.stopPropagation();App.openSheetSource('${esc(sheetId)}')">${icon('share', { size: 10 })} Open sheet</button>`;
        return `<div class="sb-row ${t.frozen ? 'sb-row-disc' : ''} ${S.pageId === t.key ? 'active' : ''}" title="${t.frozen ? 'Disconnected — page frozen at last-fed values' : ''}" onclick="App.goPage('${esc(t.key)}')">
          <span class="sb-row-icon">${icon('sheet', { size: 13 })}</span>
          <span class="sb-row-name">${esc(t.name)}<span class="ct" style="margin-left:6px">${t.rowCount || 0}</span></span>
          <button class="sb-row-menu" title="Refresh this sheet" onclick="event.stopPropagation();App.refreshMonoSheet('${esc(sheetId)}')">${icon('refresh-cw', { size: 12 })}</button>
          ${chip}
        </div>`;
      }).join('') + `</div>`;
  }
  // Data Views (formulas)
  const fs = (S.dashboard && S.dashboard.formulas) || [];
  h += `<div class="sb-sec">Data Views <button class="sb-add" title="New formula" onclick="App.openFormula()">ƒx</button></div>`;
  if (fs.length) { h += `<div class="sb-conn">` + fs.map((f) => `<div class="sb-tab ${S.pageId === 'view:' + f.id ? 'active' : ''}" onclick="App.goPage('view:${f.id}')">ƒ ${esc(f.name)}${S.editMode ? ` <button class="xmini" onclick="event.stopPropagation();App.openFormula('${f.id}')">${icon('edit', { size: 11 })}</button><button class="xmini" onclick="event.stopPropagation();App.delFormula('${f.id}')">${icon('x', { size: 11 })}</button>` : ''}</div>`).join('') + `</div>`; }
  else h += `<div class="sb-empty">No formulas. ƒx creates computed columns &amp; red/green rules — e.g. time between two tabs.</div>`;
  $('#sidebar').innerHTML = h;
  registerCommands('Dashboard: pages', (S.dashboard?.pages || []).map((p) => ({ id: 'goPage:' + p.id, label: 'Go to: ' + p.title, icon: 'layout-dashboard', run: () => goPage(p.id) })));
}
function goPage(id) { S.pageId = id; render(); }

/* ---------- filter bar (fixed: use column name) ---------- */
// M2: distinct values depend only on the RAW rows, so they're cached per
// (tab, column) and invalidated only when the data itself changes.
function distinctVals(tabKey, col) {
  const k = tabKey + '|#|' + col;
  const hit = _distinctMemo.get(k);
  if (hit) return hit;
  const set = new Set();
  for (const r of rawRowsOf(tabKey)) { const v = String(r[col] ?? '').trim(); if (v) set.add(v); }
  const out = [...set].sort().slice(0, 60);
  _distinctMemo.set(k, out);
  return out;
}
function filterBarHtml(tabKey) {
  const prof = S.profileByTab[tabKey]; if (!prof) return '';
  const cols = prof.columns.filter((c) => (c.role === 'dimension' || c.role === 'status') && c.distinct >= 2 && c.distinct <= 40);
  const dc = (prof.dateColumns || [])[0]; const f = S.filters[tabKey] || {};
  const sel = (name) => { const cur = f.cols?.[name] || ''; return `<select onchange="App.setFilter('${esc(tabKey)}','${esc(name)}',this.value)"><option value="">${esc(name)}: All</option>${distinctVals(tabKey, name).map((v) => `<option ${v === cur ? 'selected' : ''} value="${esc(v)}">${esc(v)}</option>`).join('')}</select>`; };
  let h = `<div class="filterbar"><span class="fb-label">Filter</span><input class="fb-search" placeholder="search rows…" value="${esc(f.search || '')}" oninput="App.setSearch('${esc(tabKey)}',this.value)" />`;
  h += cols.map((c) => sel(c.name)).join('');
  if (dc) h += `<span class="fb-date">${esc(dc)}: <input type="date" value="${esc(f.from || '')}" onchange="App.setDate('${esc(tabKey)}','from',this.value)"/> → <input type="date" value="${esc(f.to || '')}" onchange="App.setDate('${esc(tabKey)}','to',this.value)"/></span>`;
  const n = activeFilterCount(tabKey); if (n) h += `<button class="fb-clear" onclick="App.clearFilters('${esc(tabKey)}')">${icon('x', { size: 11 })} clear ${n}</button>`;
  return h + `</div>`;
}
function ensureF(tabKey) { S.filters[tabKey] ||= { cols: {} }; S.filters[tabKey].cols ||= {}; return S.filters[tabKey]; }
// M9: filter/search/date changes update data-bound widgets in place — no full
// page rebuild, no chart destroy/recreate. Charts get update('none') via C4.
function setFilter(tabKey, col, val) { ensureF(tabKey).cols[col] = val; refreshData(); }
function setSearch(tabKey, val) { ensureF(tabKey).search = val; clearTimeout(setSearch._t); setSearch._t = setTimeout(() => refreshData({ keepFilterBar: true }), 250); }
function setDate(tabKey, which, val) { ensureF(tabKey)[which] = val; refreshData(); }
function clearFilters(tabKey) { S.filters[tabKey] = { cols: {} }; refreshData(); }

/* ---------- insights ---------- */
function periodDelta(tabKey, fn) {
  const dc = (S.profileByTab[tabKey]?.dateColumns || [])[0]; if (!dc) return null;
  const rows = rowsOf(tabKey).filter((r) => String(r[dc] ?? '').trim() !== ''); if (rows.length < 6) return null;
  const sorted = [...rows].sort((a, b) => parseDate(a[dc]).key < parseDate(b[dc]).key ? -1 : 1);
  const mid = Math.floor(sorted.length / 2); const o = fn(sorted.slice(0, mid)), n = fn(sorted.slice(mid));
  if (!o) return null; return Math.round(((n - o) / Math.abs(o)) * 100);
}
function insightsHtml(tabKey) {
  // M3: memoized on (tab, filter state); entries only invalidate on data
  // change (clearDataMemos) — a different filter state is a different key.
  const memoKey = tabKey + '|#|' + JSON.stringify(S.filters[tabKey] || null);
  const memoHit = _insightsMemo.get(memoKey);
  if (memoHit !== undefined) return memoHit;
  const prof = S.profileByTab[tabKey]; const rows = rowsOf(tabKey); if (!prof || !rows.length) return '';
  const items = [`<b>${rows.length}</b> records${activeFilterCount(tabKey) ? ' (filtered)' : ''}`];
  for (const m of prof.metricColumns.slice(0, 2)) { const total = agg(rows.map((r) => r[m]), 'sum'); const d = periodDelta(tabKey, (rs) => agg(rs.map((r) => r[m]), 'sum')); items.push(`Total <b>${esc(m)}</b>: <b>${fmtNum(total)}</b>${d != null ? ` <span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}%</span>` : ''}`); }
  for (const s of prof.statusColumns.slice(0, 2)) { const done = rows.filter((r) => isDone(r[s])).length; const pend = rows.filter((r) => WARN.includes(String(r[s] ?? '').toLowerCase())).length; items.push(`<b>${esc(s)}</b>: ${Math.round((done / rows.length) * 100)}% done${pend ? `, <span class="down">${pend} pending</span>` : ''}`); }
  const dim = prof.dimensionColumns[0];
  if (dim) { const g = {}; rows.forEach((r) => { const k = String(r[dim] ?? '—'); g[k] = (g[k] || 0) + 1; }); const top = Object.entries(g).sort((a, b) => b[1] - a[1])[0]; if (top) items.push(`Top <b>${esc(dim)}</b>: ${esc(top[0])} (${top[1]})`); }
  let alerts = 0; for (const s of prof.statusColumns) alerts += rows.filter((r) => NEG.includes(String(r[s] ?? '').toLowerCase())).length;
  const html = `<div class="insights"><span class="ins-ic">${icon('sparkles', { size: 13 })}</span>${items.map((i) => `<span class="ins-item">${i}</span>`).join('')}${alerts ? `<span class="ins-alert">${icon('alert-triangle', { size: 11 })} ${alerts} flagged</span>` : ''}</div>`;
  if (_insightsMemo.size > 100) _insightsMemo.clear();
  _insightsMemo.set(memoKey, html);
  return html;
}

/* ---------- widget rendering ---------- */
const SPAN = { kpi_tile: 'col-3', gauge: 'col-3', trend_line: 'col-8', area_chart: 'col-8', bar_chart: 'col-6', stacked_bar: 'col-6', pie_chart: 'col-4', table: 'col-12', pivot: 'col-12', leaderboard: 'col-6', progress_tracker: 'col-12', status_matrix: 'col-12', text_summary: 'col-6' };
function renderWidget(w, pageTab) {
  const b = w.binding || {}; const span = SPAN[w.type] || 'col-6';
  if (w.type === 'kpi_tile') {
    const rows = rowsOf(b.tab);
    const calc = (rs) => b.agg === 'count' ? rs.length : b.agg === 'countWhere' ? rs.filter((r) => (b.equals || []).map((x) => String(x).toLowerCase()).includes(String(r[b.column] ?? '').toLowerCase())).length : agg(rs.map((r) => r[b.column]), b.agg || 'sum');
    const value = calc(rows); const d = (b.tab === pageTab) ? periodDelta(b.tab, calc) : null;
    return el(`<div class="card ${span} kpi"><div class="label">${esc(w.title)}</div><div class="value">${typeof value === 'number' ? fmtNum(value) : esc(value)}</div><div class="meta">${b.column ? esc((b.agg || 'sum') + ' · ' + b.column) : esc((S.tabsByKey[b.tab]?.name) || b.tab)}${d != null ? ` <span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'}${Math.abs(d)}%</span>` : ''}</div></div>`);
  }
  if (w.type === 'gauge') {
    const rows = rowsOf(b.tab); const value = agg(rows.map((r) => r[b.column]), b.agg || 'sum'); const target = Number(b.target) || 0; const pct = target ? Math.max(0, Math.min(100, (value / target) * 100)) : 0;
    return el(`<div class="card ${span} kpi"><div class="label">${esc(w.title)}</div><div class="gauge" style="--p:${pct}"><div class="gauge-c">${Math.round(pct)}%</div></div><div class="meta">${fmtNum(value)}${target ? ' / ' + fmtNum(target) : ''} ${esc(b.column || '')}</div></div>`);
  }
  if (w.type === 'table') return renderTable(w, span);
  if (w.type === 'pivot') return renderPivot(w, b);
  if (w.type === 'leaderboard') {
    const rows = rowsOf(b.tab); const g = {};
    rows.forEach((r) => { const k = String(r[b.dimension] ?? '—'); g[k] = (g[k] || 0) + (b.valueColumn ? (cleanNum(r[b.valueColumn]) || 0) : 1); });
    const ent = Object.entries(g).sort((a, b2) => b2[1] - a[1]).slice(0, b.limit || 8); const max = ent[0]?.[1] || 1;
    return el(`<div class="card ${span}"><h4>${esc(w.title)}</h4><div class="lb">${ent.map(([k, v], i) => `<div class="lb-row"><span class="lb-rank">${i + 1}</span><span class="lb-name">${esc(k)}</span><span class="lb-bar"><span style="width:${(v / max) * 100}%"></span></span><span class="lb-val">${fmtNum(v)}</span></div>`).join('') || '<div class="empty-w">no data</div>'}</div></div>`);
  }
  if (w.type === 'progress_tracker') {
    const rows = rowsOf(b.tab); const steps = (b.stepColumns || []).filter((c) => (S.tabsByKey[b.tab].headers || []).includes(c));
    const data = steps.map((c) => ({ name: c, pct: rows.length ? Math.round((rows.filter((r) => isDone(r[c])).length / rows.length) * 100) : 0 }));
    const inner = data.map((s, i) => `${i ? `<div class="connector ${data[i - 1].pct >= 100 ? 'fill' : ''}"></div>` : ''}<div class="step ${s.pct >= 60 ? 'done' : ''}"><div class="dot">${s.pct}%</div><div class="nm">${esc(s.name)}</div></div>`).join('');
    return el(`<div class="card ${span}"><h4>${esc(w.title)}</h4><div class="steps">${inner || '<div class="empty-w">no steps</div>'}</div></div>`);
  }
  if (w.type === 'status_matrix') {
    const t = S.tabsByKey[b.tab]; const rows = rowsOf(b.tab); const steps = (b.stepColumns || []).filter((c) => t.headers.includes(c)); const labelCol = t.headers.includes(b.rowLabel) ? b.rowLabel : t.headers[0];
    const body = rows.slice(0, 60).map((r) => `<tr><td><b>${esc(r[labelCol])}</b></td>${steps.map((c) => `<td><span class="badge ${badgeClass(r[c])}">${esc(r[c] || '—')}</span></td>`).join('')}</tr>`).join('');
    return el(`<div class="card ${span}"><h4>${esc(w.title)}</h4><div class="matrix"><table><thead><tr><th>${esc(labelCol)}</th>${steps.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div></div>`);
  }
  if (w.type === 'text_summary') return el(`<div class="card ${span}"><h4>${esc(w.title)}</h4><p style="color:var(--ink-soft);line-height:1.6">${esc(b.text || '')}</p></div>`);
  const card = el(`<div class="card ${span}"><h4>${esc(w.title)}</h4><div style="position:relative;height:260px"><canvas></canvas></div></div>`);
  const canvas = $('canvas', card); const cfg = chartConfig(w, b);
  requestAnimationFrame(() => { try { S.charts[w.id] = new Chart(canvas.getContext('2d'), cfg); } catch (e) { card.querySelector('div').innerHTML = `<div class="empty-w">${icon('alert-triangle', { size: 13 })} ${esc(e.message)}</div>`; } });
  return card;
}
function chartConfig(w, b) {
  const rows = rowsOf(b.tab); const base = { responsive: true, maintainAspectRatio: false }; const grid = { color: 'rgba(150,140,120,.18)' };
  if (w.type === 'trend_line' || w.type === 'area_chart') {
    const groups = {}; for (const r of rows) { const dt = parseDate(r[b.dateColumn]); if (!dt.key) continue; (groups[dt.key] ||= { label: dt.label, rows: [] }).rows.push(r); }
    const keys = Object.keys(groups).sort(); const labels = keys.map((k) => groups[k].label); const cols = (b.valueColumns && b.valueColumns.length ? b.valueColumns : [null]);
    const datasets = cols.map((c, i) => ({ label: c || 'count', tension: .35, borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length] + '33', fill: true, pointRadius: 2, data: keys.map((k) => c ? agg(groups[k].rows.map((r) => r[c]), b.agg || 'sum') : groups[k].rows.length) }));
    return { type: 'line', data: { labels, datasets }, options: { ...base, scales: { x: { grid }, y: { grid } } } };
  }
  if (w.type === 'stacked_bar') {
    const xs = [...new Set(rows.map((r) => String(r[b.dimension] ?? '—')))].slice(0, 14); const series = [...new Set(rows.map((r) => String(r[b.seriesColumn] ?? '—')))].slice(0, 8);
    const datasets = series.map((sv, i) => ({ label: sv, backgroundColor: PALETTE[i % PALETTE.length], data: xs.map((x) => agg(rows.filter((r) => String(r[b.dimension] ?? '—') === x && String(r[b.seriesColumn] ?? '—') === sv).map((r) => r[b.valueColumn]), b.agg || 'sum')) }));
    return { type: 'bar', data: { labels: xs, datasets }, options: { ...base, scales: { x: { stacked: true, grid }, y: { stacked: true, grid } } } };
  }
  const g = {}; for (const r of rows) { const k = String(r[b.dimension] ?? '—').trim() || '—'; (g[k] ||= []).push(r); }
  let ent = Object.entries(g).map(([k, rs]) => [k, b.valueColumn ? agg(rs.map((r) => r[b.valueColumn]), b.agg || 'sum') : rs.length]);
  ent.sort((a, b2) => b2[1] - a[1]); if (w.type === 'bar_chart') ent = ent.slice(0, 12);
  const labels = ent.map((e) => e[0]); const data = ent.map((e) => e[1]);
  const drill = { onClick: (_e, els2) => { if (els2.length) { const lbl = labels[els2[0].index]; ensureF(b.tab).cols[b.dimension] = (S.filters[b.tab].cols[b.dimension] === lbl ? '' : lbl); refreshData(); } } };
  if (w.type === 'pie_chart') return { type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: labels.map((l, i) => labelColor(l) || PALETTE[i % PALETTE.length]) }] }, options: { ...base, ...drill, plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } } } };
  return { type: 'bar', data: { labels, datasets: [{ data, label: b.valueColumn || 'count', backgroundColor: '#D4A76A', borderRadius: 5 }] }, options: { ...base, ...drill, plugins: { legend: { display: false } }, scales: { x: { grid }, y: { grid } } } };
}
/* C5 (report §2.3): tables render 200 rows by default with an explicit
   "showing X of Y" label + "Show more" (steps of 500). No data is dropped —
   the full set stays available via stepping, filters, find and CSV export.
   The find box now searches the FULL data model (all rows), not just the
   rendered DOM — strictly better than the old 3,000-row DOM scan. */
const TBL_BASE = 200, TBL_STEP = 500, TBL_ALL_MAX = 3000;
function tableCols(w) {
  const b = w.binding; const t = S.tabsByKey[b.tab];
  return (b.columns && b.columns.length ? b.columns : t.headers).filter((c) => t.headers.includes(c));
}
function tableWrapHtml(w) {
  const b = w.binding; const all = rowsOf(b.tab); const cols = tableCols(w);
  const q = String(S.tableFind[w.id] || '').trim().toLowerCase();
  const rows = q ? all.filter((r) => cols.some((c) => String(r[c] ?? '').toLowerCase().includes(q))) : all;
  const shownN = Math.min(rows.length, S.tableShown[w.id] || TBL_BASE);
  const body = rows.slice(0, shownN).map((r) => `<tr>${cols.map((c) => `<td>${badgeFor(r[c])}</td>`).join('')}</tr>`).join('');
  let foot = '';
  if (rows.length > shownN) {
    foot = `<div class="muted" style="padding:6px 10px">showing ${shownN} of ${rows.length}${q ? ' matching' : ''} rows
      <button class="xmini" onclick="App.tblMore('${esc(w.id)}')" style="margin-left:8px">Show ${Math.min(TBL_STEP, rows.length - shownN)} more</button>
      ${rows.length <= TBL_ALL_MAX ? `<button class="xmini" onclick="App.tblAll('${esc(w.id)}')">Show all</button>` : ''}</div>`;
  } else if (q) {
    foot = `<div class="muted" style="padding:6px 10px">showing ${rows.length} matching of ${all.length} rows</div>`;
  }
  return `<div style="overflow:auto;max-height:70vh"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td class="empty-w">no rows</td></tr>`}</tbody></table></div>${foot}`;
}
function renderTable(w, span) {
  const b = w.binding; const rows = rowsOf(b.tab); const cols = tableCols(w);
  return el(`<div class="card ${span}"><div class="card-bar"><h4>${esc(w.title)} <span class="muted">(${rows.length})</span></h4><span><input class="tbl-search" placeholder="find…" value="${esc(S.tableFind[w.id] || '')}" oninput="App.tblFind('${esc(w.id)}',this.value)"/> <button class="xmini" title="Export CSV" onclick="App.exportWidgetCsv('${esc(b.tab)}',this)" data-cols="${esc(cols.join('|'))}">${icon('download', { size: 12 })}</button></span></div><div class="tbl-wrap">${tableWrapHtml(w)}</div></div>`);
}
function repaintTable(wid) {
  const hit = findWidgetById(wid); if (!hit) return;
  const card = document.querySelector(`[data-wid="${CSS.escape(wid)}"]`);
  const wrap = card && card.querySelector('.tbl-wrap');
  if (wrap) wrap.innerHTML = tableWrapHtml(hit.w);
}
function findWidgetById(wid) {
  for (const p of (S.dashboard?.pages || [])) for (const sec of (p.sections || [])) {
    const w = (sec.widgets || []).find((x) => x.id === wid);
    if (w) return { sec, w };
  }
  return null;
}
function tblFind(wid, q) { S.tableFind[wid] = q; clearTimeout(tblFind._t); tblFind._t = setTimeout(() => repaintTable(wid), 200); }
function tblMore(wid) { S.tableShown[wid] = (S.tableShown[wid] || TBL_BASE) + TBL_STEP; repaintTable(wid); }
function tblAll(wid) { S.tableShown[wid] = TBL_ALL_MAX; repaintTable(wid); }
/* DOM-level find — still used by pivot cards (their rows are aggregates). */
function tblSearch(input) { const q = input.value.toLowerCase(); input.closest('.card').querySelectorAll('tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; }); }

/* ---------- pivot table ---------- */
function pivotData(b) {
  const rows = rowsOf(b.tab);
  const kf = (col, bucket) => bucket ? (r) => parseDate(r[col]).key || '—' : (r) => (String(r[col] ?? '').trim() || '—');
  const rKey = kf(b.rows, b.bucketRows), cKey = kf(b.cols, b.bucketCols);
  const rowSet = new Set(), colSet = new Set(); const cell = {};
  for (const r of rows) {
    const rk = rKey(r), ck = cKey(r); rowSet.add(rk); colSet.add(ck);
    (cell[rk] ||= {}); (cell[rk][ck] ||= []);
    if (b.agg === 'count') cell[rk][ck].push(1);
    else if (b.agg === 'list') cell[rk][ck].push(r[b.value]);
    else cell[rk][ck].push(cleanNum(r[b.value]));
  }
  const fmt = (arr) => {
    if (!arr || !arr.length) return '';
    if (b.agg === 'count') return arr.length;
    if (b.agg === 'list') return [...new Set(arr.map((x) => String(x ?? '')))].filter(Boolean).join(', ');
    const n = arr.filter((x) => x != null); if (!n.length) return '';
    const s = n.reduce((a, c) => a + c, 0); return b.agg === 'avg' ? round2(s / n.length) : round2(s);
  };
  return { rowKeys: [...rowSet].sort(), colKeys: [...colSet].sort(), cell, fmt };
}
function renderPivot(w, b) {
  if (!b.rows || !b.cols) return el(`<div class="card col-12"><h4>${esc(w.title)}</h4><div class="empty-w">Pivot needs a Rows and a Columns field — edit the widget.</div></div>`);
  const { rowKeys, colKeys, cell, fmt } = pivotData(b);
  const head = `<tr><th class="pv-corner">${esc(b.rows)} \\ ${esc(b.cols)}</th>${colKeys.map((c) => `<th>${esc(c)}</th>`).join('')}<th>Total</th></tr>`;
  const body = rowKeys.map((rk) => {
    let tot = 0; const tds = colKeys.map((ck) => { const arr = cell[rk]?.[ck]; if (arr && (b.agg === 'count')) tot += arr.length; else if (arr && (b.agg === 'sum' || b.agg === 'avg')) tot += arr.filter((x) => x != null).reduce((a, c) => a + c, 0); const val = fmt(arr); return `<td>${esc(val)}</td>`; }).join('');
    const totCell = (b.agg === 'count' || b.agg === 'sum') ? fmtNum(tot) : (b.agg === 'list' ? '' : '');
    return `<tr><td class="pv-row"><b>${esc(rk)}</b></td>${tds}<td class="pv-tot">${totCell}</td></tr>`;
  }).join('');
  const card = el(`<div class="card col-12"><div class="card-bar"><h4>${esc(w.title)} <span class="muted">${b.agg} of ${esc(b.value || 'rows')}</span></h4><span><input class="tbl-search" placeholder="find…" oninput="App.tblSearch(this)"/> <button class="xmini" title="Export CSV" onclick="App.exportPivotCsv(this)">${icon('download', { size: 12 })}</button></span></div><div style="overflow:auto;max-height:72vh"><table class="pivot"><thead>${head}</thead><tbody>${body || `<tr><td class="empty-w">no data</td></tr>`}</tbody></table></div></div>`);
  card._pivotB = b; return card;
}
function exportPivotCsv(btn) {
  const b = btn.closest('.card')._pivotB; if (!b) return; const { rowKeys, colKeys, cell, fmt } = pivotData(b);
  const lines = [[`${b.rows}\\${b.cols}`, ...colKeys].map((s) => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : s).join(',')];
  for (const rk of rowKeys) lines.push([rk, ...colKeys.map((ck) => fmt(cell[rk]?.[ck]))].map((s) => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : s).join(','));
  downloadCsv('pivot.csv', lines.join('\n')); toast('Pivot CSV exported');
}

/* ---------- CSV ---------- */
function toCsv(cols, rows) { const e2 = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; return [cols.map(e2).join(','), ...rows.map((r) => cols.map((c) => e2(r[c])).join(','))].join('\n'); }
function downloadCsv(name, text) { const b = new Blob([text], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
function exportTabCsv(tabKey) { const t = S.tabsByKey[tabKey]; downloadCsv(`${t.name || tabKey}.csv`, toCsv(t.headers, rowsOf(tabKey))); toast('CSV exported'); }
function exportWidgetCsv(tabKey, btn) { downloadCsv(`${tabKey}.csv`, toCsv(btn.dataset.cols.split('|'), rowsOf(tabKey))); }

/* ---------- widget editor ---------- */
function editorTab() { return S.tabsByKey[S.pageId] ? S.pageId : S.workbook.tabs.find((t) => t.rowCount)?.key; }
function openEditor(edit) {
  let widget = null, tabKey;
  if (edit) { const s = curPage().sections.find((x) => x.id === edit.secId); widget = s?.widgets.find((w) => w.id === edit.wid); if (!widget) return; tabKey = widget.binding.tab; }
  else tabKey = editorTab();
  if (!tabKey || !S.tabsByKey[tabKey]) return toast('No data tab to add to');
  const types = ['kpi_tile', 'gauge', 'bar_chart', 'pie_chart', 'stacked_bar', 'trend_line', 'area_chart', 'leaderboard', 'table', 'pivot', 'progress_tracker', 'status_matrix', 'text_summary'];
  const back = el(`<div class="modal-backdrop"><div class="modal">
    <h3>${edit ? 'Edit' : 'Add'} widget <span class="muted">→ ${esc(S.tabsByKey[tabKey].name)}</span></h3>
    <div class="form-row"><label>Type</label><select id="ed_type" onchange="App.editorFields()">${types.map((t) => `<option value="${t}" ${widget && widget.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="form-row"><label>Title</label><input id="ed_title" placeholder="(optional)" value="${esc(widget?.title || '')}"/></div>
    <div id="ed_dyn"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="App.${edit ? `saveWidgetEdit('${edit.secId}','${edit.wid}')` : 'addWidget()'}">${edit ? 'Save' : 'Add'}</button></div>
  </div></div>`);
  const prof = S.profileByTab[tabKey] || { metricColumns: [], dimensionColumns: [], dateColumns: [], statusColumns: [] };
  back.dataset.tab = tabKey; back._cols = { all: S.tabsByKey[tabKey].headers || [], metric: prof.metricColumns, dim: prof.dimensionColumns, date: prof.dateColumns, status: prof.statusColumns };
  document.body.appendChild(back); editorFields();
  if (widget) prefillEditor(widget);
}
function setVal(id, val) { const e = $('#' + id); if (e && val != null) e.value = val; }
function prefillEditor(w) {
  const b = w.binding || {};
  if (w.type === 'kpi_tile') { setVal('ed_col', b.column || '(row count)'); setVal('ed_agg', b.agg || 'sum'); }
  else if (w.type === 'gauge') { setVal('ed_col', b.column); setVal('ed_agg', b.agg || 'sum'); setVal('ed_target', b.target); }
  else if (w.type === 'bar_chart' || w.type === 'leaderboard') { setVal('ed_dim', b.dimension); setVal('ed_val', b.valueColumn || '(count)'); setVal('ed_agg', b.agg || 'sum'); }
  else if (w.type === 'pie_chart') setVal('ed_dim', b.dimension);
  else if (w.type === 'stacked_bar') { setVal('ed_dim', b.dimension); setVal('ed_series', b.seriesColumn); setVal('ed_val', b.valueColumn || '(count)'); setVal('ed_agg', b.agg || 'sum'); }
  else if (w.type === 'trend_line' || w.type === 'area_chart') { setVal('ed_date', b.dateColumn); setVal('ed_val', (b.valueColumns && b.valueColumns[0]) || '(count)'); setVal('ed_agg', b.agg || 'sum'); }
  else if (w.type === 'progress_tracker' || w.type === 'status_matrix') { if (b.rowLabel) setVal('ed_row', b.rowLabel); document.querySelectorAll('#ed_steps input').forEach((i) => { i.checked = (b.stepColumns || []).includes(i.value); }); }
  else if (w.type === 'text_summary') setVal('ed_text', b.text || '');
  else if (w.type === 'pivot') { setVal('ed_prows', b.rows); setVal('ed_pcols', b.cols); setVal('ed_pval', b.value || '(count)'); setVal('ed_pagg', b.agg || 'count'); const br = $('#ed_pbr'); if (br) br.checked = !!b.bucketRows; const bc = $('#ed_pbc'); if (bc) bc.checked = !!b.bucketCols; }
}
function editorFields() {
  const back = $('.modal-backdrop'); const c = back._cols; const type = $('#ed_type').value; const dyn = $('#ed_dyn');
  const sel = (id, arr, label) => `<div class="form-row"><label>${label}</label><select id="${id}">${arr.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('') || '<option value="">(none)</option>'}</select></div>`;
  const aggSel = (id) => `<div class="form-row"><label>Aggregate</label><select id="${id}"><option>sum</option><option>avg</option><option>count</option><option>min</option><option>max</option></select></div>`;
  const num = c.metric.length ? c.metric : c.all; let h = '';
  if (type === 'kpi_tile') h = sel('ed_col', ['(row count)', ...num], 'Value column') + aggSel('ed_agg');
  else if (type === 'gauge') h = sel('ed_col', num, 'Value column') + aggSel('ed_agg') + `<div class="form-row"><label>Target</label><input id="ed_target" type="number"/></div>`;
  else if (type === 'bar_chart' || type === 'leaderboard') h = sel('ed_dim', c.dim.length ? c.dim : c.all, 'Group by') + sel('ed_val', ['(count)', ...num], 'Value') + aggSel('ed_agg');
  else if (type === 'pie_chart') h = sel('ed_dim', [...c.dim, ...c.status, ...c.all], 'Slice by');
  else if (type === 'stacked_bar') h = sel('ed_dim', c.dim.length ? c.dim : c.all, 'X axis') + sel('ed_series', [...c.status, ...c.dim], 'Stack by') + sel('ed_val', ['(count)', ...num], 'Value') + aggSel('ed_agg');
  else if (type === 'trend_line' || type === 'area_chart') h = sel('ed_date', c.date.length ? c.date : c.all, 'Date column') + sel('ed_val', ['(count)', ...num], 'Value') + aggSel('ed_agg');
  else if (type === 'progress_tracker') h = multiSel('ed_steps', c.status.length ? c.status : c.all, 'Step columns');
  else if (type === 'status_matrix') h = sel('ed_row', c.dim.length ? c.dim : c.all, 'Row label') + multiSel('ed_steps', c.status.length ? c.status : c.all, 'Step columns');
  else if (type === 'text_summary') h = `<div class="form-row"><label>Text</label><textarea id="ed_text" rows="3"></textarea></div>`;
  else if (type === 'table') h = `<div class="muted" style="padding:4px 0">Shows all columns of the tab.</div>`;
  else if (type === 'pivot') h = sel('ed_prows', c.all, 'Rows (down the side)') + sel('ed_pcols', c.all, 'Columns (across the top)') + sel('ed_pval', ['(count)', ...c.all], 'Cell value') + `<div class="form-row"><label>Cell shows</label><select id="ed_pagg"><option>count</option><option>sum</option><option>avg</option><option>list</option></select></div><div class="form-row"><label style="font-weight:400"><input type="checkbox" id="ed_pbr"/> group Rows by day</label><label style="font-weight:400"><input type="checkbox" id="ed_pbc"/> group Columns by day</label></div>`;
  dyn.innerHTML = h;
}
function multiSel(id, arr, label) { return `<div class="form-row"><label>${label}</label><div class="chk" id="${id}">${arr.map((x) => `<label><input type="checkbox" value="${esc(x)}" checked/> ${esc(x)}</label>`).join('') || '(none)'}</div></div>`; }
function getMulti(id) { return [...document.querySelectorAll('#' + id + ' input:checked')].map((i) => i.value); }
function v(id) { const e = $('#' + id); return e ? e.value : ''; }
function readWidgetForm() {
  const back = $('.modal-backdrop'); const tab = back.dataset.tab; const type = v('ed_type'); const title = v('ed_title');
  let binding = { tab }; const colN = (x) => x && !x.startsWith('(') ? x : null;
  if (type === 'kpi_tile') { const col = colN(v('ed_col')); binding = col ? { tab, column: col, agg: v('ed_agg') } : { tab, agg: 'count' }; }
  else if (type === 'gauge') binding = { tab, column: v('ed_col'), agg: v('ed_agg'), target: Number(v('ed_target')) || 0 };
  else if (type === 'bar_chart' || type === 'leaderboard') binding = { tab, dimension: v('ed_dim'), valueColumn: colN(v('ed_val')), agg: v('ed_agg') };
  else if (type === 'pie_chart') binding = { tab, dimension: v('ed_dim'), agg: 'count' };
  else if (type === 'stacked_bar') binding = { tab, dimension: v('ed_dim'), seriesColumn: v('ed_series'), valueColumn: colN(v('ed_val')), agg: v('ed_agg') };
  else if (type === 'trend_line' || type === 'area_chart') binding = { tab, dateColumn: v('ed_date'), valueColumns: colN(v('ed_val')) ? [v('ed_val')] : [], agg: v('ed_agg') };
  else if (type === 'progress_tracker') binding = { tab, stepColumns: getMulti('ed_steps') };
  else if (type === 'status_matrix') binding = { tab, rowLabel: v('ed_row'), stepColumns: getMulti('ed_steps') };
  else if (type === 'text_summary') binding = { text: v('ed_text') };
  else if (type === 'table') binding = { tab };
  else if (type === 'pivot') binding = { tab, rows: v('ed_prows'), cols: v('ed_pcols'), value: colN(v('ed_pval')), agg: v('ed_pagg'), bucketRows: $('#ed_pbr')?.checked || false, bucketCols: $('#ed_pbc')?.checked || false };
  return { type, title: title || type.replace('_', ' '), binding };
}
function addWidget() {
  const f = readWidgetForm(); const w = { id: 'w_' + uid(), ...f };
  const page = curPage(); let sec = page.sections.find((s) => s.id === 'custom');
  if (!sec) { sec = { id: 'custom', title: 'Custom', widgets: [] }; page.sections.push(sec); }
  sec.widgets.push(w); saveLayout(); closeModal(); render(); toast('Widget added & saved');
}
function saveWidgetEdit(secId, wid) {
  const f = readWidgetForm(); const s = curPage().sections.find((x) => x.id === secId); const w = s?.widgets.find((x) => x.id === wid); if (!w) return;
  w.type = f.type; w.title = f.title; w.binding = f.binding; saveLayout(); closeModal(); render(); toast('Widget updated');
}

/* ---------- edit ops ---------- */
function toggleEdit() { S.editMode = !S.editMode; render(); }
function curPage() { return S.dashboard.pages.find((p) => p.id === S.pageId); }
function delWidget(secId, wid) { const s = curPage().sections.find((x) => x.id === secId); if (s) s.widgets = s.widgets.filter((w) => w.id !== wid); saveLayout(); render(); }
function delSection(secId) { const p = curPage(); p.sections = p.sections.filter((s) => s.id !== secId); saveLayout(); render(); }
function moveWidget(secId, wid, dir) { const s = curPage().sections.find((x) => x.id === secId); const i = s.widgets.findIndex((w) => w.id === wid); const j = i + dir; if (j < 0 || j >= s.widgets.length) return; [s.widgets[i], s.widgets[j]] = [s.widgets[j], s.widgets[i]]; saveLayout(); render(); }

/* ---------- refresh / theme / regen ---------- */
function refresh() { toast('Refreshing…'); connectAll({ silent: true }); }
// Refresh a single Mono sheet's feed. A disconnected sheet is not connected to
// the dashboard, so it can't be refreshed with new values.
function refreshMonoSheet(sheetId) {
  if (monoFeedDisabled(sheetId)) { toast('Sheet not connected'); return; }
  toast('Refreshing…'); connectAll({ silent: true });
}
function toggleAuto() { S.autoRefresh = !S.autoRefresh; if (S.autoRefresh) { S.refreshTimer = setInterval(() => connectAll({ silent: true }), 30000); toast('Auto-refresh on'); } else { clearInterval(S.refreshTimer); toast('Auto-refresh off'); } render(); }
function toggleTheme() { S.theme = S.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('theme', S.theme); document.body.dataset.theme = S.theme; render(); }
async function regenerate() { toast('Rebuilding…'); try { const fx = (S.dashboard && S.dashboard.formulas) || []; const gen = await aiPost('/api/generate', {}); if (!gen || gen.ok === false) throw new Error((gen && (gen.detail || gen.error)) || 'generate failed'); indexProfile(gen.profile); S.autoDashboard = clone(gen.dashboard); S.dashboard = gen.dashboard; S.dashboard.formulas = fx; rebuildViews(); S.pageId = S.dashboard.pages[0]?.id; saveLayout(); render(); toast(gen.usedAI ? 'Redesigned by AI' : 'Rebuilt'); } catch (e) { toast('Failed: ' + (e.message || e)); } }

/* ---------- chat ---------- */
async function sendDashboardChat(msg) {
  if (!S.config.llm.configured) { 
    window.ChatUI.pushUser(msg); 
    window.ChatUI.pushBot('No AI key set. Use the + Add widget button and filters — all free.'); 
    return; 
  }
  window.ChatUI.pushUser(msg);
  window.ChatUI.showSpinner();

  try {
    // H7: the chat turn carries the message + current dashboard + wbKey — the
    // multi-MB workbook goes over the wire only when the data changed (the
    // server keeps the profile cached per fingerprint and the LLM sees the
    // exact same compact profile as before, so answers don't change).
    const r = await aiPost('/api/chat', { message: msg, dashboard: S.dashboard }, { withViews: true });
    window.ChatUI.removeSpinner();
    let extra = null;
    if (r.dashboard) { S.pendingDashboard = r.dashboard; extra = el(`<div class="applybar"><button onclick="App.applyPending()">${icon('check', { size: 12 })} Apply</button></div>`); }
    window.ChatUI.pushBot(r.reply || '(no reply)', extra);
  } catch (e) { 
    window.ChatUI.removeSpinner(); 
    window.ChatUI.pushBot('Error: ' + (e.message || e)); 
  }
}
function applyPending() { if (!S.pendingDashboard) return; S.dashboard = S.pendingDashboard; S.pendingDashboard = null; if (!S.dashboard.pages.find((p) => p.id === S.pageId)) S.pageId = S.dashboard.pages[0]?.id; saveLayout(); render(); toast('Updated'); window.ChatUI.toggle(); }

/* ---------- PDF ---------- */
async function exportPdf() {
  toast('Building PDF…'); const { jsPDF } = window.jspdf; const doc = new jsPDF({ unit: 'pt', format: 'a4' }); const W = doc.internal.pageSize.getWidth(); const M = 40; let y = 54;
  const page = curPage(); const tabKey = S.tabsByKey[page.id] ? page.id : null; const tab = tabKey ? S.tabsByKey[tabKey] : null;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.text(String(S.dashboard.title || 'Dashboard'), M, y); y += 22;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(108, 104, 93); doc.text(`${page.title} · ${new Date().toLocaleString()}`, M, y); y += 10; doc.setDrawColor(212, 167, 106); doc.setLineWidth(1.5); doc.line(M, y, W - M, y); y += 22;
  if (tabKey) { const tmp = el(insightsHtml(tabKey)); if (tmp) { doc.setTextColor(40, 40, 40); doc.setFontSize(10); const txt = [...tmp.querySelectorAll('.ins-item,.ins-alert')].map((s) => '• ' + s.textContent).join('   '); const lines = doc.splitTextToSize(txt, W - 2 * M); doc.text(lines, M, y); y += lines.length * 13 + 12; } }
  const stats = []; for (const sec of page.sections) for (const w of sec.widgets) if (w.type === 'kpi_tile') { const b = w.binding; const rows = rowsOf(b.tab); const val = b.agg === 'count' ? rows.length : b.agg === 'countWhere' ? rows.filter((r) => (b.equals || []).map((x) => String(x).toLowerCase()).includes(String(r[b.column] ?? '').toLowerCase())).length : agg(rows.map((r) => r[b.column]), b.agg || 'sum'); stats.push([w.title, fmtNum(val)]); }
  if (stats.length) { doc.autoTable({ startY: y, margin: { left: M, right: M }, head: [['Metric', 'Value']], body: stats, theme: 'grid', headStyles: { fillColor: [35, 34, 32] }, styles: { fontSize: 10 } }); y = doc.lastAutoTable.finalY + 18; }
  for (const sec of page.sections) for (const w of sec.widgets) { const ch = S.charts[w.id]; if (!ch) continue; if (y > 660) { doc.addPage(); y = 54; } doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(27, 26, 23); doc.text(String(w.title), M, y); y += 8; try { const w2 = W - 2 * M; const h2 = w2 * 0.4; doc.addImage(ch.toBase64Image('image/png', 1), 'PNG', M, y, w2, h2); y += h2 + 18; } catch {} }
  if (tab) { const cols = (tab.headers || []).slice(0, 8); if (y > 640) { doc.addPage(); y = 54; } doc.autoTable({ startY: y, margin: { left: M, right: M }, head: [cols], body: rowsOf(tabKey).slice(0, 60).map((r) => cols.map((c) => String(r[c] ?? ''))), theme: 'striped', headStyles: { fillColor: [212, 167, 106], textColor: [27, 26, 23] }, styles: { fontSize: 8 } }); }
  const n = doc.internal.getNumberOfPages(); for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(9); doc.setTextColor(154, 150, 139); doc.text(`Mono · ${page.title} · ${i}/${n}`, M, doc.internal.pageSize.getHeight() - 20); }
  doc.save(`${(S.dashboard.title || 'report').replace(/[^a-z0-9]+/gi, '_')}_${page.title.replace(/[^a-z0-9]+/gi, '_')}.pdf`); toast('PDF downloaded');
}

/* ================= Pass 2: formula / rules / data-view engine ================= */
function round2(x) { return x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100; }
function unitDiv(ms, unit) { return unit === 'hours' ? ms / 3600000 : unit === 'days' ? ms / 86400000 : ms / 60000; }
function parseDT(v) {
  const s = String(v ?? '').trim(); if (!s) return null;
  // dd/mm/yyyy hh:mm(:ss)
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) { let [, d, mo, y, h, mi, se] = m; y = y.length === 2 ? '20' + y : y; const t = Date.parse(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${(se || '00').padStart(2, '0')}`); if (!Number.isNaN(t)) return t; }
  // time of day hh:mm(:ss)
  m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return ((+m[1] * 60 + +m[2]) * 60 + (+m[3] || 0)) * 1000;
  const t = Date.parse(s); return Number.isNaN(t) ? null : t;
}
function numOp(op, a, b) { if (a == null) return null; if (op === 'plus') return a + (b ?? 0); if (op === 'minus') return a - (b ?? 0); if (op === 'mul') return a * (b ?? 0); if (op === 'div') return b ? a / b : null; if (op === 'pct') return b ? (a / b) * 100 : null; return a; }
function cmpTest(v, op, a, b) { switch (op) { case '<': return v < a; case '<=': return v <= a; case '>': return v > a; case '>=': return v >= a; case '==': return v === a; case 'between': return v >= Math.min(a, b) && v <= Math.max(a, b); default: return false; } }
function classify(value, rules) {
  if (value == null || Number.isNaN(value)) return { label: '—', color: null };
  for (const r of (rules || [])) { if (r.else) continue; if (cmpTest(value, r.cmp, Number(r.val), Number(r.val2))) return { label: r.label || '?', color: RULE_COLORS[r.color] || r.color }; }
  const e = (rules || []).find((r) => r.else); return e ? { label: e.label || 'Other', color: RULE_COLORS[e.color] || e.color } : { label: '—', color: null };
}
function pickId(tabKey) { const p = S.profileByTab[tabKey]; const t = S.tabsByKey[tabKey]; if (!p) return t?.headers?.[0]; return (p.columns.find((c) => c.role === 'identifier')?.name) || p.dimensionColumns[0] || p.columns[0]?.name; }

function computeFormula(f) { try { return f.mode === 'within' ? computeWithin(f) : f.mode === 'asof' ? computeAsof(f) : computeCross(f); } catch { return null; } }
// M11: greatest index i with arr[i].t <= t (arr sorted ascending), else -1.
// Replaces the O(n) per-row scans in the time matchers — same results,
// O(log n) per lookup.
function lastLE(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
// As-of lookup: for each EVENT row, find the LOOKUP row with the same key and the
// latest time <= event time; bring a column from it (e.g. the driver) + optional gap.
function computeAsof(f) {
  const E = S.tabsByKey[f.eventTab], L = S.tabsByKey[f.lookupTab]; if (!E || !L) return null;
  const byKey = {};
  (L.rows || []).forEach((r) => { const k = String(r[f.lookupKey] ?? '').trim(); const t = parseDT(r[f.lookupTime]); if (!k || t == null) return; (byKey[k] ||= []).push({ t, val: r[f.bringCol] }); });
  Object.values(byKey).forEach((arr) => arr.sort((a, b) => a.t - b.t));
  const idCol = f.eventId || pickId(f.eventTab); const name = f.name;
  const rows = (E.rows || []).map((r) => {
    const k = String(r[f.eventKey] ?? '').trim(); const te = parseDT(r[f.eventTime]);
    let resolved = '', gap = null;
    if (k && te != null && byKey[k]) { const i = lastLE(byKey[k], te); if (i >= 0) { const best = byKey[k][i]; resolved = best.val; gap = unitDiv(te - best.t, f.unit); } }
    const cls = classify(gap, f.rules); const o = {};
    if (idCol && idCol !== f.eventTime && idCol !== f.eventKey) o[idCol] = r[idCol];
    o[f.eventTime] = r[f.eventTime]; o[f.eventKey] = r[f.eventKey]; o[f.bringCol] = resolved;
    o[name] = gap == null ? '' : round2(gap); o.Status = cls.label; return o;
  });
  const headers = []; if (idCol && idCol !== f.eventTime && idCol !== f.eventKey) headers.push(idCol);
  headers.push(f.eventTime, f.eventKey, f.bringCol, name, 'Status');
  return { headers, rows };
}
function computeWithin(f) {
  const t = S.tabsByKey[f.tab]; if (!t) return null; const name = f.name;
  const rows = (t.rows || []).map((r) => {
    let val;
    if (f.op === 'concat') val = String(r[f.colA] ?? '') + String(f.colB === '(constant)' ? (f.constB ?? '') : (r[f.colB] ?? ''));
    else if (f.op === 'timeDiff') { const a = parseDT(r[f.colA]), b = parseDT(r[f.colB]); val = (a != null && b != null) ? unitDiv(b - a, f.unit) : null; }
    else if (f.op === 'dateDiff') { const a = parseDT(r[f.colA]), b = parseDT(r[f.colB]); val = (a != null && b != null) ? (b - a) / 86400000 : null; }
    else { const a = cleanNum(r[f.colA]); const b = f.colB === '(constant)' ? Number(f.constB) : cleanNum(r[f.colB]); val = numOp(f.op, a, b); }
    const cls = classify(typeof val === 'number' ? val : NaN, f.rules);
    const o = { [f.colA]: r[f.colA] }; if (f.colB && f.colB !== '(constant)') o[f.colB] = r[f.colB];
    o[name] = typeof val === 'number' ? round2(val) : val; o.Status = cls.label; return o;
  });
  const headers = [f.colA, ...(f.colB && f.colB !== '(constant)' && f.op !== 'concat' ? [f.colB] : []), name, 'Status'];
  return { headers, rows };
}
function computeCross(f) {
  const A = S.tabsByKey[f.tabA], B = S.tabsByKey[f.tabB]; if (!A || !B) return null;
  const aRows = A.rows || [], bRows = B.rows || []; const pairs = [];
  if (f.match === 'row') { const n = Math.min(aRows.length, bRows.length); for (let i = 0; i < n; i++) pairs.push([aRows[i], bRows[i]]); }
  else if (f.match === 'key') { const map = {}; aRows.forEach((r) => { const k = String(r[f.keyA] ?? '').trim(); if (k && !(k in map)) map[k] = r; }); bRows.forEach((r) => { const k = String(r[f.keyB] ?? '').trim(); if (map[k]) pairs.push([map[k], r]); }); }
  else { const aT = aRows.map((r) => ({ t: parseDT(r[f.timeColA]), r })).filter((x) => x.t != null).sort((x, y) => x.t - y.t);
    // M11: binary search over the sorted array — identical matches to the old
    // linear scan (when nothing is <= tb, every t > tb, so the old nearest-
    // by-|Δ| reduce always landed on aT[0]).
    bRows.forEach((r) => { const tb = parseDT(r[f.timeColB]); if (tb == null) return; const i = lastLE(aT, tb); const best = i >= 0 ? aT[i] : (aT.length ? aT[0] : null); if (best) pairs.push([best.r, r]); }); }
  const idA = pickId(f.tabA); const name = f.name;
  const hIdA = `${A.name} ${idA || 'row'}`; const hTA = `${A.name} time`; const hTB = `${B.name} time`;
  const rows = pairs.map(([a, b]) => {
    const ta = parseDT(a[f.timeColA]), tb = parseDT(b[f.timeColB]); const val = (ta != null && tb != null) ? unitDiv(tb - ta, f.unit) : null;
    const cls = classify(val, f.rules);
    return { [hIdA]: idA ? a[idA] : '', [hTA]: a[f.timeColA], [hTB]: b[f.timeColB], [name]: round2(val), Status: cls.label };
  });
  return { headers: [hIdA, hTA, hTB, name, 'Status'], rows };
}
function profileView(tab, valueName) {
  const cols = (tab.headers || []).map((h) => { const isVal = h === valueName; const isStatus = h === 'Status'; return { name: h, type: isVal ? 'number' : (isStatus ? 'status' : 'text'), role: isVal ? 'metric' : (isStatus ? 'status' : 'dimension'), distinct: new Set(tab.rows.map((r) => String(r[h]))).size, fillRate: 1, sample: [] }; });
  return { key: tab.key, name: tab.name, rowCount: tab.rows.length, columns: cols, metricColumns: [valueName], dimensionColumns: (tab.headers || []).filter((h) => h !== valueName && h !== 'Status'), dateColumns: [], statusColumns: ['Status'] };
}
function viewPage(f) {
  const key = 'view:' + f.id;
  return { id: key, title: 'ƒ ' + f.name, sections: [
    { id: 's_k_' + f.id, title: 'Summary', widgets: [
      { id: 'vk1_' + f.id, type: 'kpi_tile', title: 'Entries', binding: { tab: key, agg: 'count' } },
      { id: 'vk2_' + f.id, type: 'kpi_tile', title: 'Average ' + f.name, binding: { tab: key, column: f.name, agg: 'avg' } },
      { id: 'vk3_' + f.id, type: 'kpi_tile', title: 'Max ' + f.name, binding: { tab: key, column: f.name, agg: 'max' } } ] },
    { id: 's_r_' + f.id, title: 'Ratio', widgets: [
      { id: 'vp_' + f.id, type: 'pie_chart', title: f.name + ' — ratio', binding: { tab: key, dimension: 'Status', agg: 'count' } },
      { id: 'vb_' + f.id, type: 'bar_chart', title: 'Count by status', binding: { tab: key, dimension: 'Status', agg: 'count' } } ] },
    { id: 's_t_' + f.id, title: 'Details', widgets: [ { id: 'vt_' + f.id, type: 'table', title: f.name + ' — every entry', binding: { tab: key } } ] } ] };
}
function rebuildViews() {
  clearDataMemos();               // view tabs/rows are about to change (M2/M3/M4)
  S.labelColors = {};
  S.workbook.tabs = S.workbook.tabs.filter((t) => !t.isView);
  Object.keys(S.tabsByKey).forEach((k) => { if (k.startsWith('view:')) delete S.tabsByKey[k]; });
  const formulas = (S.dashboard && S.dashboard.formulas) || []; const live = new Set();
  for (const f of formulas) {
    (f.rules || []).forEach((r) => { if (r.label) S.labelColors[r.label] = RULE_COLORS[r.color] || r.color || '#8a7d6a'; });
    const res = computeFormula(f); if (!res) continue;
    const key = 'view:' + f.id; live.add(key);
    const tab = { key, name: f.name, headers: res.headers, rows: res.rows, connId: '__views', connName: 'Data Views', origKey: f.id, isView: true, rowCount: res.rows.length, valueName: f.name };
    S.workbook.tabs.push(tab); S.tabsByKey[key] = tab; S.profileByTab[key] = profileView(tab, f.name);
    if (!S.dashboard.pages.find((p) => p.id === key)) S.dashboard.pages.push(viewPage(f));
  }
  S.dashboard.pages = S.dashboard.pages.filter((p) => !p.id.startsWith('view:') || live.has(p.id));
}

/* ---- formula builder modal ---- */
function dataTabs() { return S.workbook.tabs.filter((t) => !t.isView && (t.rowCount || (t.rows || []).length)); }
function tabColOptions(tabKey, sel) { const t = S.tabsByKey[tabKey]; return (t?.headers || []).map((h) => `<option ${h === sel ? 'selected' : ''} value="${esc(h)}">${esc(h)}</option>`).join(''); }
function tabOptions(sel) { return dataTabs().map((t) => `<option ${t.key === sel ? 'selected' : ''} value="${esc(t.key)}">${esc(t.connName)} · ${esc(t.name)}</option>`).join(''); }
function ruleRowHtml(r = {}) {
  const cmp = ['<', '<=', '>', '>=', '==', 'between']; const col = ['green', 'red', 'amber', 'blue', 'gray', 'gold'];
  return `<div class="rule-row"><select class="r_cmp">${cmp.map((o) => `<option ${r.cmp === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
    <input class="r_val" type="number" placeholder="value" value="${esc(r.val ?? '')}"/>
    <input class="r_val2" type="number" placeholder="…and (between)" value="${esc(r.val2 ?? '')}"/>
    <input class="r_label" placeholder="label e.g. On time" value="${esc(r.label ?? '')}"/>
    <select class="r_color">${col.map((o) => `<option ${r.color === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
    <button class="xmini" title="Remove rule" onclick="this.parentElement.remove()">${icon('x', { size: 11 })}</button></div>`;
}
function addRule(r) { $('#f_rules').insertAdjacentHTML('beforeend', ruleRowHtml(r || {})); }
function openFormula(editId) {
  const tabs = dataTabs(); if (tabs.length < 1) return toast('Connect a sheet with data first');
  const f = editId ? (S.dashboard.formulas || []).find((x) => x.id === editId) : null;
  const tA = f?.tabA || tabs[0].key, tB = f?.tabB || (tabs[1]?.key || tabs[0].key), tW = f?.tab || tabs[0].key;
  const eT = f?.eventTab || tabs[0].key, lT = f?.lookupTab || (tabs[1]?.key || tabs[0].key);
  const back = el(`<div class="modal-backdrop"><div class="modal" style="width:min(620px,94vw)">
    <h3>${f ? 'Edit' : 'New'} formula</h3>
    <div class="form-row"><label>Name</label><input id="f_name" placeholder="e.g. Slab → Pack minutes" value="${esc(f?.name || '')}"/></div>
    <div class="form-row"><label>Compare</label><select id="f_mode" onchange="App.formulaMode()">
      <option value="cross" ${(!f || f.mode === 'cross') ? 'selected' : ''}>Across two tabs (time difference)</option>
      <option value="asof" ${f?.mode === 'asof' ? 'selected' : ''}>As-of lookup (bring a value, e.g. driver)</option>
      <option value="within" ${f?.mode === 'within' ? 'selected' : ''}>Two columns in one tab</option></select></div>
    <div id="f_cross">
      <div class="form-grid">
        <div class="form-row"><label>Tab A (earlier)</label><select id="f_tabA" onchange="App.fcols('A')">${tabOptions(tA)}</select></div>
        <div class="form-row"><label>A time column</label><select id="f_timeA">${tabColOptions(tA, f?.timeColA)}</select></div>
        <div class="form-row"><label>Tab B (later)</label><select id="f_tabB" onchange="App.fcols('B')">${tabOptions(tB)}</select></div>
        <div class="form-row"><label>B time column</label><select id="f_timeB">${tabColOptions(tB, f?.timeColB)}</select></div>
        <div class="form-row"><label>Pair rows by</label><select id="f_match" onchange="App.formulaMode()">
          <option value="time" ${f?.match !== 'row' && f?.match !== 'key' ? 'selected' : ''}>nearest time</option>
          <option value="row" ${f?.match === 'row' ? 'selected' : ''}>row position</option>
          <option value="key" ${f?.match === 'key' ? 'selected' : ''}>matching code</option></select></div>
        <div class="form-row"><label>Unit</label><select id="f_unit">${['minutes', 'hours', 'days'].map((u) => `<option ${f?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
        <div class="form-row f_keyrow"><label>A code column</label><select id="f_keyA">${tabColOptions(tA, f?.keyA)}</select></div>
        <div class="form-row f_keyrow"><label>B code column</label><select id="f_keyB">${tabColOptions(tB, f?.keyB)}</select></div>
      </div>
    </div>
    <div id="f_within">
      <div class="form-grid">
        <div class="form-row"><label>Tab</label><select id="f_tab" onchange="App.fcols('W')">${tabOptions(tW)}</select></div>
        <div class="form-row"><label>Column A</label><select id="f_colA">${tabColOptions(tW, f?.colA)}</select></div>
        <div class="form-row"><label>Operation</label><select id="f_op" onchange="App.formulaMode()">${[['minus', 'A − B'], ['plus', 'A + B'], ['mul', 'A × B'], ['div', 'A ÷ B'], ['pct', 'A as % of B'], ['timeDiff', 'time B − A'], ['dateDiff', 'days B − A'], ['concat', 'join text']].map(([o, t]) => `<option value="${o}" ${f?.op === o ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="form-row"><label>Column B</label><select id="f_colB"><option>(constant)</option>${tabColOptions(tW, f?.colB)}</select></div>
        <div class="form-row"><label>Constant (if B = constant)</label><input id="f_const" value="${esc(f?.constB || '')}"/></div>
        <div class="form-row"><label>Unit (time/date diff)</label><select id="f_unitW">${['minutes', 'hours', 'days'].map((u) => `<option ${f?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      </div>
    </div>
    <div id="f_asof">
      <div class="form-grid">
        <div class="form-row"><label>Event tab (e.g. Loading)</label><select id="f_eTab" onchange="App.fcols('E')">${tabOptions(eT)}</select></div>
        <div class="form-row"><label>Event time</label><select id="f_eTime">${tabColOptions(eT, f?.eventTime)}</select></div>
        <div class="form-row"><label>Event key (e.g. Vehicle)</label><select id="f_eKey">${tabColOptions(eT, f?.eventKey)}</select></div>
        <div class="form-row"><label>Lookup tab (e.g. Dumper Driver)</label><select id="f_lTab" onchange="App.fcols('L')">${tabOptions(lT)}</select></div>
        <div class="form-row"><label>Lookup time</label><select id="f_lTime">${tabColOptions(lT, f?.lookupTime)}</select></div>
        <div class="form-row"><label>Lookup key (e.g. Vehicle)</label><select id="f_lKey">${tabColOptions(lT, f?.lookupKey)}</select></div>
        <div class="form-row"><label>Bring column (e.g. Driver name)</label><select id="f_bring">${tabColOptions(lT, f?.bringCol)}</select></div>
        <div class="form-row"><label>Gap unit</label><select id="f_unitA">${['minutes', 'hours', 'days'].map((u) => `<option ${f?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      </div>
      <div class="muted" style="margin-top:6px">For each event, finds the lookup row with the same key and the latest time ≤ the event time, and brings its value. Rules below color the time-gap (optional).</div>
    </div>
    <div class="form-row"><label>Rules — first match wins</label><div id="f_rules"></div>
      <button class="xmini" onclick="App.addRule()">+ add rule</button></div>
    <div class="form-row"><label>Otherwise</label><div id="f_else" class="rule-row">
      <span class="muted" style="flex:1">if no rule matches →</span>
      <input class="r_label" placeholder="label e.g. Delayed" value="${esc((f?.rules || []).find((r) => r.else)?.label || '')}"/>
      <select class="r_color">${['red', 'green', 'amber', 'blue', 'gray', 'gold'].map((o) => `<option ${((f?.rules || []).find((r) => r.else)?.color) === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="App.saveFormula(${f ? `'${f.id}'` : ''})">${f ? 'Save' : 'Create'}</button></div>
  </div></div>`);
  document.body.appendChild(back);
  const userRules = (f?.rules || []).filter((r) => !r.else);
  if (userRules.length) userRules.forEach((r) => addRule(r)); else addRule({ cmp: '<', val: 20, label: 'On time', color: 'green' });
  formulaMode();
}
function formulaMode() {
  const m = v('f_mode');
  $('#f_cross').style.display = m === 'cross' ? '' : 'none';
  $('#f_asof').style.display = m === 'asof' ? '' : 'none';
  $('#f_within').style.display = m === 'within' ? '' : 'none';
  document.querySelectorAll('.f_keyrow').forEach((e) => { e.style.display = (m === 'cross' && v('f_match') === 'key') ? '' : 'none'; });
}
function fcols(side) {
  if (side === 'A') { const tk = v('f_tabA'); $('#f_timeA').innerHTML = tabColOptions(tk); $('#f_keyA').innerHTML = tabColOptions(tk); }
  if (side === 'B') { const tk = v('f_tabB'); $('#f_timeB').innerHTML = tabColOptions(tk); $('#f_keyB').innerHTML = tabColOptions(tk); }
  if (side === 'W') { const tk = v('f_tab'); $('#f_colA').innerHTML = tabColOptions(tk); $('#f_colB').innerHTML = '<option>(constant)</option>' + tabColOptions(tk); }
  if (side === 'E') { const tk = v('f_eTab'); $('#f_eTime').innerHTML = tabColOptions(tk); $('#f_eKey').innerHTML = tabColOptions(tk); }
  if (side === 'L') { const tk = v('f_lTab'); $('#f_lTime').innerHTML = tabColOptions(tk); $('#f_lKey').innerHTML = tabColOptions(tk); $('#f_bring').innerHTML = tabColOptions(tk); }
}
function saveFormula(editId) {
  const mode = v('f_mode'); const name = v('f_name') || 'Formula';
  const rules = [...document.querySelectorAll('#f_rules .rule-row')].map((row) => ({ cmp: row.querySelector('.r_cmp').value, val: row.querySelector('.r_val').value, val2: row.querySelector('.r_val2').value, label: row.querySelector('.r_label').value, color: row.querySelector('.r_color').value }));
  const er = $('#f_else'); rules.push({ else: true, label: er.querySelector('.r_label').value || 'Other', color: er.querySelector('.r_color').value });
  let f = { id: editId || uid(), name, mode, rules };
  if (mode === 'cross') Object.assign(f, { tabA: v('f_tabA'), timeColA: v('f_timeA'), tabB: v('f_tabB'), timeColB: v('f_timeB'), match: v('f_match'), keyA: v('f_keyA'), keyB: v('f_keyB'), unit: v('f_unit') });
  else if (mode === 'asof') Object.assign(f, { eventTab: v('f_eTab'), eventTime: v('f_eTime'), eventKey: v('f_eKey'), lookupTab: v('f_lTab'), lookupTime: v('f_lTime'), lookupKey: v('f_lKey'), bringCol: v('f_bring'), unit: v('f_unitA') });
  else Object.assign(f, { tab: v('f_tab'), colA: v('f_colA'), op: v('f_op'), colB: v('f_colB'), constB: v('f_const'), unit: v('f_unitW') });
  S.dashboard.formulas ||= []; const i = S.dashboard.formulas.findIndex((x) => x.id === f.id);
  if (i >= 0) S.dashboard.formulas[i] = f; else S.dashboard.formulas.push(f);
  rebuildViews(); if (!computeFormula(f)) toast('No matched rows — check the columns/match'); S.pageId = 'view:' + f.id; saveLayout(); closeModal(); render(); toast('Formula saved');
}
function delFormula(id) { if (!confirm('Delete this formula?')) return; S.dashboard.formulas = (S.dashboard.formulas || []).filter((f) => f.id !== id); rebuildViews(); if (S.pageId === 'view:' + id) S.pageId = S.dashboard.pages[0]?.id; saveLayout(); render(); }
function sendChat(msg) { ChatUI.send(msg); }

const App = { connectFromInput, goPage, refresh, regenerate, exportPdf, resetLayout, toggleEdit, toggleAuto, toggleTheme, openEditor, closeModal, editorFields, addWidget, saveWidgetEdit, delWidget, delSection, moveWidget, setFilter, setSearch, setDate, clearFilters, tblSearch, tblFind, tblMore, tblAll, exportTabCsv, exportWidgetCsv, openAddSheet, addSheet, removeConn, renameConn, refreshConn, refreshMonoSheet, openFormula, formulaMode, fcols, addRule, saveFormula, delFormula, exportPivotCsv, openSheetSource, sendChat };
window.App = App;
// U4: window-level bridge so Sheets mode (a separate module that isn't
// necessarily booted) can read live Dashboard state for the preview drawer
// without a circular import.
window.__monoDashboardApi = { getMonoFeedPreview, focusDashboardPage };
window.addEventListener('mono:renameWorkspace', (e) => {
  if (!Dashboard.active || !S.dashboard) return;
  const name = e.detail && e.detail.name; if (!name || !name.trim()) return;
  S.dashboard.title = name.trim(); saveLayout(); announceWorkspaceName();
});
window.addEventListener('mono:openDashboardPage', (e) => { if (e.detail && e.detail.pageId) focusDashboardPage(e.detail.pageId); });

// ============================================================
//  Mountable controller for the workspace shell (Phase 0).
//  The shell (public/shell.js) owns mode; it calls boot/show/hide.
//  `active` gates all DOM painting so dashboard code never draws
//  over Sheet mode (e.g. from the 30s auto-refresh timer).
// ============================================================
let _booted = false;
export const Dashboard = {
  active: false,
  // On first entry, do the full boot (mount chat, wire events, read data).
  // On every RE-entry, re-read the data (loadMonoTabs + reconcile) instead of
  // just re-rendering the stale cached workbook — otherwise edits made in Sheets
  // after the dashboard's first load never appear here. reconcile() preserves
  // the user's saved layout, so this is a data refresh, not a reset.
  async boot() { this.active = true; if (_booted) { document.body.dataset.mode = 'dashboard'; await connectAll({ silent: true }); return; } _booted = true; await boot(); },
  show() { this.active = true; if (S.workbook && S.dashboard) render(); else renderConnect(); },
  hide() { this.active = false; Object.values(S.charts).forEach((c) => { try { c.destroy(); } catch {} }); S.charts = {}; },
};