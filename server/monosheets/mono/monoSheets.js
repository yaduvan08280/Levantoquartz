// ============================================================
//  Mono Sheets — controller
//  Store-backed (local/server) async load+autosave, settings panel,
//  export/import, optional Google Sheets sync, and (U3/U4) a real
//  interactive sidebar + cross-mode "Feeds Dashboard" surface.
//  P20 — Multi-workbook workspace: N workbooks open at once, each in
//  its own store slot with its own sync config; sidebar groups sheets
//  under their workbook; live cross-workbook IMPORTRANGE; import-as-
//  new-workbook; one-click "Combine into…"; sidebar show/hide toggle.
// ============================================================
import { MonoWorkbook } from './model/workbook.js';
import { MonoGrid } from './grid.js';
import { Engine } from './engine/engine.js';
import { MonoScripts } from './scripts/monoScripts.js';
import { getStore, loadSettings, saveSettings } from './storage/index.js';
import { openSettings } from './settingsPanel.js';
import { importGoogleSheetImage, syncImageIntoWorkbook, workbookFromImage, appendImageSheets } from './import/index.js';
import { imageSheetToMonoSheet } from './import/sheetImage.js';
import { loadBase as loadSyncBase, saveBase as saveSyncBase } from './storage/syncBaseStore.js';
import { fingerprintMap } from './import/mergeImage.js';
import * as changes from './model/changeTracker.js';
import { buildWorkbookPatch, metaFingerprints, metaFingerprint } from './model/patchBuilder.js';
import { remoteCellsToApply } from './model/liveMerge.js';
import { META_KEYS } from './model/undoJournal.js';
import { ensureWorkspace, addToWorkspace, removeFromWorkspace, syncFor } from './model/workspace.js';
import { mergeWorkbooks } from './model/mergeWorkbooks.js';
import { setMonoEnabled, monoEnabled } from '../data/monoSource.js';
import { toast } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { openPanel } from '../ui/panel.js';
import { setSyncStatus } from '../ui/syncStatus.js';
import { registerCommands } from '../ui/commandRegistry.js';
import { mountFab, unmountFab } from './ai/copilot.js';
import { Auth } from '../auth.js';
import { openShareDialog } from './share.js';
import { ServerStore } from './storage/serverStore.js';
import { LocalStore } from './storage/localStore.js';
// P9: import view renderers so they self-register into the view kind registry
import './views/kanban/renderer.js';
import './views/calendar/renderer.js';
import './views/gallery/renderer.js';
import './views/form/renderer.js';
// P10: import cell types so they self-register into the cell type registry
import './model/cellTypes/rating.js';
import './model/cellTypes/progress.js';
import './model/cellTypes/email.js';
import './model/cellTypes/url.js';
import './model/cellTypes/phone.js';
import './model/cellTypes/button.js';
import './model/cellTypes/attachment.js';
import './model/cellTypes/autoNumber.js';
import './model/cellTypes/createdTime.js';
import './model/cellTypes/modifiedTime.js';
import './model/cellTypes/createdBy.js';
import './model/cellTypes/modifiedBy.js';
import { emptyStateHTML } from '../ui/emptyState.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// P20 — workspace state: every open workbook lives in _items as a
// { wb, engine, unsub } pair; only the active one has a mounted grid.
const _items = new Map();     // workbookId -> { wb, engine, unsub }
let _wb = null, _grid = null, _engine = null, _scripts = null, _store = null, _settings = null, _saveTimer = null;
const _autoTimers = new Map(); // workbookId -> interval handle (per-workbook autosync)
const _syncing = new Map();    // workbookId -> in-flight sync promise. The Google pull is
                               // chunked (many requests), so it can outlast a short auto-sync
                               // interval — never let two syncs of one workbook overlap.
let _srvList = [];               // server-side list: [{id, name, role, sharedCount, ownerName, ...}]

/* ---------- roles (UI Plan v3 §5) ---------- */
const serverMode = () => (_store instanceof ServerStore) && !!Auth.user;
function roleOf(wbId) {
  if (!serverMode()) return 'owner';
  const m = _store.meta(wbId);
  if (m && m.role) return m.role;
  const e = _srvList.find((w) => w.id === wbId);
  return e ? e.role : 'owner';
}
function accessFor(wbId) {
  const role = roleOf(wbId) || 'viewer';
  return { role, isOwner: role === 'owner', canEdit: role === 'owner' || role === 'editor', canComment: role !== 'viewer' };
}
async function refreshServerList() {
  if (!serverMode()) { _srvList = []; return _srvList; }
  _srvList = await _store.list();
  return _srvList;
}

const _ws = () => _settings.workspace;
const activeId = () => _ws().activeWorkbookId;

function seed() {
  const wb = new MonoWorkbook({ name: 'My MONO AI Workbook' });
  const s = wb.active;
  s.setRaw(0, 0, 'Item'); s.setRaw(0, 1, 'Qty'); s.setRaw(0, 2, 'Price'); s.setRaw(0, 3, 'Total');
  s.setRaw(1, 0, 'Granite slab'); s.setRaw(1, 1, '12'); s.setRaw(1, 2, '4500'); s.setRaw(1, 3, '=B2*C2');
  s.setRaw(2, 0, 'Marble slab'); s.setRaw(2, 1, '7'); s.setRaw(2, 2, '6200'); s.setRaw(2, 3, '=B3*C3');
  s.setRaw(3, 0, 'Quartz slab'); s.setRaw(3, 1, '20'); s.setRaw(3, 2, '5100'); s.setRaw(3, 3, '=B4*C4');
  s.setRaw(4, 0, 'Total'); s.setRaw(4, 3, '=SUM(D2:D4)');
  wb.scripts = { files: [{ name: 'Code.gs', source: [
    '// Mono Scripts — automate your sheet. Open via Extensions → Mono Scripts editor.',
    'function onOpen() {',
    "  SpreadsheetApp.getUi().createMenu('Tools').addItem('Stamp now in A1', 'stampNow').addToUi();",
    '}',
    'function stampNow() {',
    "  SpreadsheetApp.getActiveSheet().getRange('A1').setValue(new Date().toString());",
    '}',
    '// Custom function — use it in any cell as =DOUBLE(A1)',
    'function DOUBLE(x) { return Number(x) * 2; }',
  ].join('\n') }], props: { script: {}, document: {} } };
  return wb;
}
function setSaved(t) { setSyncStatus(t.startsWith('Saving') ? 'saving' : 'ok', t); }
function setSaveError(t) { setSyncStatus('err', t); }

/* ---------- P20: workspace lifecycle ---------- */

// Create the in-memory item for a workbook: engine + change subscription.
// The subscription is what keeps IMPORTRANGE formulas in *other* open
// workbooks live while this one is edited (Phase D).
function openItem(wb, { serverIsUpToDate = false } = {}) {
  const engine = new Engine(wb);
  const item = { wb, engine, unsub: null };
  const offEngine = engine.subscribe(() => onEngineChanged(wb.id));
  // Live collaboration: hear what everyone else writes to this workbook.
  const offLive = _store && _store.watch ? _store.watch(wb.id, (ev) => onRemote(wb.id, ev)) : null;
  item.unsub = () => { offEngine(); if (offLive) offLive(); };
  _items.set(wb.id, item);
  // A workbook just loaded from the server matches it exactly, so record that
  // as the save baseline: the FIRST edit of the session can then go out as a
  // patch instead of forcing one full save to establish it.
  if (serverIsUpToDate) markSaved(wb.id, wb);
  else _saved.delete(wb.id);
  // Any pending changes recorded against THESE sheet ids belong to the copy of
  // the workbook being replaced, so they are meaningless now. Other open
  // workbooks keep theirs.
  changes.dropSheets(wb.sheets.map((x) => x.id));
  return item;
}

// Register every open workbook as an IMPORTRANGE source on every *other*
// open workbook's engine — keyed by stable id, plus the human-readable
// name as an alias so =IMPORTRANGE("Sales", "Sheet1!A1") reads naturally.
function wireForeign() {
  for (const [idA, a] of _items) {
    for (const [idB, b] of _items) {
      if (idA === idB) continue;
      a.engine.registerForeign(idB, b.engine);
      a.engine.registerForeign(b.wb.name, b.engine);
    }
  }
}
function unwireForeignKeyEverywhere(wbId, name) {
  for (const [, it] of _items) { it.engine.unregisterForeign(wbId); if (name != null) it.engine.unregisterForeign(name); }
}

// A workbook's engine reported changed values → refresh IMPORTRANGE cells in
// every other open workbook. recalcForeign() only notifies onwards when a
// value actually changed, so chains propagate and cycles terminate.
function onEngineChanged(srcId) {
  for (const [id, it] of _items) {
    if (id === srcId) continue;
    const changed = it.engine.recalcForeign();
    if (changed && id === activeId() && _grid && !_grid.editing) _grid.render();
  }
}

// Add a fresh workbook to the workspace and make it active.
async function addWorkbook(wb, { activate = true } = {}) {
  openItem(wb);
  addToWorkspace(_settings, wb.id, saveSettings);
  if (!activate) { /* keep current active */ }
  wireForeign();
  try { await _store.save(wb.id, wb.toJSON()); } catch {}
  build(); setupAuto();
  return wb;
}

/* ---------- incremental save ----------
   A full save serialises the whole workbook: ~100 MB and several seconds on a
   two-lakh-row book, whether you typed one character or rewrote everything.
   persist() sends only what changed, and falls back to a full save whenever a
   patch cannot describe the change exactly — sheets added or removed, a
   structural op, a first save, or a server that refuses the delta. The
   fallback is what makes this safe: a patch is an optimisation, never a
   correctness requirement.

   _saved holds, per workbook, the state the SERVER is known to have: the sheet
   ids and a fingerprint of each sheet's (small) metadata. Without it a change
   no cell write reveals — freezing a pane, hiding a column — could be missed. */
const _saved = new Map();   // workbookId -> { ids: [sid], meta: Map(sid -> fingerprint) }

function markSaved(wbId, wb) {
  _saved.set(wbId, { ids: wb.sheets.map((s) => s.id), meta: metaFingerprints(wb) });
}

async function persist(wbId, wb) {
  const known = _saved.get(wbId);
  const taken = changes.take(wb.sheets.map((s) => s.id));
  _inFlight.set(wbId, taken.sheets);
  try { return await persistTaken(wbId, wb, known, taken); }
  finally { _inFlight.delete(wbId); }
}

// What this tab has written lately, so a remote write that the server ordered
// BEFORE ours but that reaches us after it does not overwrite our cell.
const _inFlight = new Map();   // workbookId -> Map(sid -> Set|'full') sent, not yet answered
const _acked = new Map();      // workbookId -> [{ v, sheets }] accepted, newest last
function noteAcked(wbId, res, taken) {
  if (!res || typeof res.version !== 'number') return;
  const list = _acked.get(wbId) || [];
  list.push({ v: res.version, sheets: taken.sheets });
  _acked.set(wbId, list.slice(-30));
}

async function persistTaken(wbId, wb, known, taken) {
  let built = null;
  try {
    built = buildWorkbookPatch(wb, taken, known && known.meta, known && known.ids);
  } catch { built = null; }

  if (built && _store.patch) {
    const res = await _store.patch(wbId, built.patch);
    if (res && res.ok) { noteAcked(wbId, res, taken); markSaved(wbId, wb); return res; }
    // 'unpatchable' just means fall back; a conflict or a permission problem is
    // the caller's to handle and must not be retried as a full overwrite.
    if (res && (res.code === 'conflict' || res.code === 'forbidden' || res.code === 'auth')) {
      changes.restore(taken);
      return res;
    }
  }

  const res = await _store.save(wbId, wb.toJSON());
  if (res === true || (res && res.ok)) { noteAcked(wbId, res, taken); markSaved(wbId, wb); return res; }
  changes.restore(taken);     // nothing landed - keep the changes pending
  return res;
}

async function saveWorkbookNow(wbId) {
  const it = _items.get(wbId); if (!it) return false;
  try { return await persist(wbId, it.wb); } catch { return false; }
}

function switchWorkbook(wbId, sheetId) {
  if (wbId === activeId()) { if (sheetId) _grid?.onTab(sheetId); return; }
  try { _grid?.commitIfEditing?.(); } catch {}
  try { flushNow(); } catch {}
  _ws().activeWorkbookId = wbId; saveSettings(_settings);
  const it = _items.get(wbId);
  if (it && sheetId) it.wb.setActive(sheetId);
  build();
}

/* ---------- resilient autosave (active workbook) ---------- */
// _pendingSave is a flag: there is work the server has not accepted. The work
// itself lives in the change tracker (persist() puts it back on failure), so a
// retry sends the CURRENT state rather than the stale snapshot this used to
// hold - anything typed while offline is included instead of being dropped.
let _pendingSave = null, _retryTimer = null, _retryDelay = 0;

async function flushSave() {
  const wbId = _wb.id;
  if (!accessFor(wbId).canEdit) { _pendingSave = null; return; }   // read-only roles never write
  let res;
  try { res = await persist(wbId, _wb); }
  catch (e) { console.error('save failed', e); res = { ok: false, code: 'net' }; }
  if (res === true || (res && res.ok)) {
    _pendingSave = null; _retryDelay = 0; clearTimeout(_retryTimer);
    setSaved('All changes saved');
    return;
  }
  const code = res && res.code;
  if (code === 'conflict') {
    // Cell edits merge on the server now, so this only happens when a
    // structural change (rows inserted, a sort, sheets added) raced with
    // someone else's save. Take theirs and say so, rather than stopping work.
    _pendingSave = null; _retryDelay = 0; clearTimeout(_retryTimer);
    onConflict(wbId);
  } else if (code === 'forbidden') {
    _pendingSave = null; _retryDelay = 0; clearTimeout(_retryTimer);
    if (res.detail && String(res.detail).includes('sheet')) {
      toast('Only the owner can delete sheets — reloading the workbook.', 4000);
      reloadWorkbook(wbId);
    } else {
      handleRevoked(wbId);
    }
  } else if (code === 'auth') {
    _pendingSave = true;                       // retried on mono:reauthed
    setSyncStatus('err', 'Signed out — sign in to save');
  } else {
    _pendingSave = true;
    setSyncStatus('offline', 'Reconnecting…');
    scheduleRetry();
  }
}

/* ---------- conflict / revoked / reload (UI Plan v3 §8, §3) ---------- */
function onConflict(wbId) {
  toast('Someone changed the sheet layout at the same moment — showing the latest. Please redo your last change.', 5000);
  reloadKeepingPlace(wbId);
}

/* ---------- live collaboration ---------- */
// Someone else wrote to an open workbook. A cell patch is applied in place:
// no reload, no prompt, selection and scroll untouched. Anything a patch
// cannot describe (their structural change, or a dropped stream) falls back
// to quietly reloading that workbook.
function onRemote(wbId, ev) {
  const it = _items.get(wbId); if (!it) return;
  if (ev.resync || ev.reload || !ev.patch) return resync(wbId);
  const { wb, engine } = it;
  const known = _saved.get(wbId);
  const mine = { pending: changes.pending(), inFlight: _inFlight.get(wbId), acked: _acked.get(wbId) };
  const touched = [];
  let layout = false;

  for (const [sid, delta] of Object.entries(ev.patch.sheets || {})) {
    const sh = wb.sheets.find((x) => x.id === sid);
    if (!sh) return resync(wbId);              // a sheet we do not have: we are out of step
    // Their sheet metadata (widths, frozen panes, filters...) is taken only if
    // ours has nothing unsent - otherwise ours is about to be saved and wins.
    if (delta.meta && known && metaFingerprint(sh) === known.meta.get(sid)) {
      for (const k of META_KEYS) if (k in delta.meta) sh[k] = delta.meta[k];
      const fp = metaFingerprint(sh);
      if (fp !== known.meta.get(sid)) { known.meta.set(sid, fp); layout = true; }
    }
    if (delta.cells) {
      const cells = remoteCellsToApply(sid, delta.cells, ev.v, mine);
      for (const ch of engine.applyRemoteCells(sid, cells)) touched.push(ch);
    }
  }
  if (ev.patch.namedRanges && JSON.stringify(ev.patch.namedRanges) !== JSON.stringify(wb.namedRanges)) {
    wb.namedRanges = ev.patch.namedRanges; engine.recalcAll(); layout = true;
  }
  _store.bumpVersion(wbId, ev.v);

  if (layout) renderSidebar();
  if (wbId !== activeId() || !_grid) return;
  const sh = _grid.sheet(), sid = sh.id;
  // Mid-edit, never rebuild the grid under the caret: repaint the cells only.
  if (!_grid.editing && (layout || engine.spills.size || sh.conditionalFormats.length)) { if (layout || touched.some((c) => c.sid === sid)) _grid.render(); return; }
  for (const c of touched) if (c.sid === sid) _grid.paintCell(c.r, c.c);
}

// Fall back to the server's copy, at most one at a time per workbook. Unsent
// edits go out first so they are not lost; an open cell editor is left to
// finish.
const _resyncing = new Set();
async function resync(wbId) {
  if (_resyncing.has(wbId)) return;
  if (wbId === activeId() && _grid && _grid.editing) { setTimeout(() => resync(wbId), 1500); return; }
  _resyncing.add(wbId);
  try {
    if (accessFor(wbId).canEdit) { clearTimeout(_saveTimer); await saveWorkbookNow(wbId); }
    await reloadKeepingPlace(wbId);
  } finally { _resyncing.delete(wbId); }
}

// A reload opens the workbook on whichever sheet the LAST saver was looking
// at. Put this user back on their own sheet and cell.
async function reloadKeepingPlace(wbId) {
  const here = wbId === activeId() && _grid ? { sid: _grid.sid(), r: _grid.active.r, c: _grid.active.c } : null;
  await reloadWorkbook(wbId, here && here.sid);
  if (here && wbId === activeId() && _grid && _grid.sid() === here.sid) _grid.select(here.r, here.c);
}

async function reloadWorkbook(wbId, keepSheetId) {
  const json = await _store.load(wbId);
  if (!json || json.__denied) { handleRevoked(wbId); return; }
  const old = _items.get(wbId);
  unwireForeignKeyEverywhere(wbId, old?.wb.name);
  old?.unsub?.(); _items.delete(wbId);
  if (!openStored(wbId, json, { serverIsUpToDate: true })) { showOpenFailure(); return; }
  if (keepSheetId) _items.get(wbId).wb.setActive(keepSheetId);
  wireForeign();
  if (wbId === activeId()) build(); else renderSidebar();
  setSaved('All changes saved');
}

function handleRevoked(wbId) {
  const it = _items.get(wbId);
  const name = it ? it.wb.name : wbId;
  unwireForeignKeyEverywhere(wbId, it?.wb.name);
  it?.unsub?.(); _items.delete(wbId);
  clearInterval(_autoTimers.get(wbId)); _autoTimers.delete(wbId);
  const wasActive = wbId === activeId();
  removeFromWorkspace(_settings, wbId, saveSettings);
  refreshServerList().then(renderSidebar);
  if (wasActive) {
    if (_items.size) { _ws().activeWorkbookId = _ws().order[0]; build(); toast(`Your access to “${name}” was removed`); }
    else showRevokedBlocker(name);
  } else {
    renderSidebar();
    toast(`Your access to “${name}” was removed`);
  }
}

function showRevokedBlocker(name) {
  const main = document.getElementById('main'); if (!main) return;
  main.innerHTML = `<div class="ms-blocker"><div class="ms-blocker-card">
    <div class="ic">${icon('lock', { size: 30 })}</div>
    <h3>Your access to this workbook was removed</h3>
    <p>“${escH(name)}” is no longer shared with you. If that's unexpected, ask the owner.</p>
    <button class="btn btn-primary" id="rbBack">Back to My workbooks</button>
  </div></div>`;
  main.querySelector('#rbBack').addEventListener('click', async () => {
    await refreshServerList();
    const owned = _srvList.find((w) => w.role === 'owner');
    if (owned) { await openWorkbookById(owned.id); }
    else { const wb = seed(); openItem(wb); _ws().order = [wb.id]; _ws().activeWorkbookId = wb.id; saveSettings(_settings); try { await _store.save(wb.id, wb.toJSON()); } catch {} build(); setupAuto(); }
  });
}

/* Open a workbook that isn't in the workspace yet (closed / shared row). */
async function openWorkbookById(wbId) {
  if (_items.has(wbId)) { switchWorkbook(wbId); return; }
  const json = await _store.load(wbId);
  if (!json || json.__denied) { toast('Could not open that workbook — access may have been removed'); refreshServerList().then(renderSidebar); return; }
  if (!openStored(wbId, json, { serverIsUpToDate: true })) {
    toast('That workbook could not be opened: ' + (_broken.get(wbId) || 'unknown error'), 6000);
    return;
  }
  addToWorkspace(_settings, wbId, saveSettings);
  wireForeign();
  build(); setupAuto();
}
function scheduleRetry() {
  clearTimeout(_retryTimer);
  _retryDelay = Math.min(_retryDelay ? _retryDelay * 2 : 2000, 30000);
  _retryTimer = setTimeout(() => { if (_pendingSave != null) flushSave(); }, _retryDelay);
}
function save() {
  if (_wb && !accessFor(_wb.id).canEdit) return;   // comment/view roles never autosave
  setSaved('Saving…'); clearTimeout(_saveTimer);
  _retryDelay = 0; clearTimeout(_retryTimer);
  _saveTimer = setTimeout(flushSave, 150);   // others see a change this long after it is made, plus the round trip
  pulseFeedBadge(_wb.active.id);
}
function flushNow() {
  if (!_wb || !_store) return;
  clearTimeout(_saveTimer);
  flushSave();
}

function theme() { return localStorage.getItem('theme') || 'light'; }
function setTheme(t) { localStorage.setItem('theme', t); document.body.dataset.theme = t; }

/* ---------- U3/U4: sidebar ---------- */
// Allowlist (default-OFF): a sheet feeds the dashboard only when explicitly
// enabled via the row menu → "Feed dashboard".
function isFeedEnabled(sheetId) { return !!(_settings.feedEnabled && _settings.feedEnabled[sheetId]); }
function setFeedEnabled(sheetId, on) {
  _settings.feedEnabled = _settings.feedEnabled || {};
  if (on) _settings.feedEnabled[sheetId] = true; else delete _settings.feedEnabled[sheetId];
  saveSettings(_settings);
}
function feedsDashboard(wb, sheetId) {
  if (!monoEnabled()) return false;
  if (!isFeedEnabled(sheetId)) return false;
  const sh = wb.sheets.find((s) => s.id === sheetId);
  return !!(sh && sh.cells.size);
}
function pulseFeedBadge(sheetId) {
  const el = document.querySelector(`[data-feeds="${sheetId}"]`); if (!el) return;
  el.classList.remove('live'); void el.offsetWidth; el.classList.add('live');
}
const SWATCHES = ['#D4A76A', '#5E7FA6', '#4F9D69', '#CF4F33', '#A98EC0', '#8a7d6a'];
function closeRowPop() { document.getElementById('sbRowPop')?.remove(); }
function popAt(el, anchor) {
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.min(r.left, innerWidth - el.offsetWidth - 8) + 'px';
  el.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function h(ev) { if (!el.contains(ev.target)) { el.remove(); document.removeEventListener('mousedown', h); } }), 0);
}
function openRowMenu(sheetId, anchor) {
  closeRowPop();
  const acc = accessFor(activeId());
  if (!acc.canEdit) return;                          // read-only roles: no sheet mutations
  const el = document.createElement('div'); el.className = 'sb-row-pop'; el.id = 'sbRowPop';
  const swatches = SWATCHES.map((c) => `<button class="ms-sw ms-sw-sm" data-color="${c}" style="background:${c}"></button>`).join('');
  const feeding = isFeedEnabled(sheetId);
  const feedBtn = feeding
    ? `<button data-act="feed">${icon('eye-off', { size: 14 })}<span>Disconnect from dashboard</span></button>`
    : `<button data-act="feed">${icon('plug', { size: 14 })}<span>Feed dashboard</span></button>`;
  el.innerHTML = `
    <button data-act="ren">${icon('edit', { size: 14 })}<span>Rename</span></button>
    <button data-act="dup">${icon('copy', { size: 14 })}<span>Duplicate</span></button>
    ${acc.isOwner ? `<button data-act="del">${icon('trash', { size: 14 })}<span>Delete</span></button>` : ''}
    <div class="cmdbar-pop-sep"></div>
    ${feedBtn}
    <div class="cmdbar-pop-sep"></div>
    <div class="sb-swatch-row">${swatches}<button class="sb-sw-clear" data-color="" title="Clear color">${icon('x', { size: 13 })}</button></div>`;
  popAt(el, anchor);
  el.querySelector('[data-act="ren"]').addEventListener('click', () => { closeRowPop(); _grid?.renameSheetPrompt(sheetId); });
  el.querySelector('[data-act="dup"]').addEventListener('click', () => { closeRowPop(); _grid?.duplicateSheet(sheetId); });
  el.querySelector('[data-act="del"]')?.addEventListener('click', () => { closeRowPop(); _grid?.deleteSheetPrompt(sheetId); });
  el.querySelector('[data-act="feed"]').addEventListener('click', () => {
    closeRowPop();
    if (!isFeedEnabled(sheetId)) { setFeedEnabled(sheetId, true); if (!monoEnabled()) setMonoEnabled(true); }
    else setFeedEnabled(sheetId, false);
    renderSidebar();
  });
  el.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
    _settings.sheetColors = _settings.sheetColors || {};
    if (b.dataset.color) _settings.sheetColors[sheetId] = b.dataset.color; else delete _settings.sheetColors[sheetId];
    saveSettings(_settings); closeRowPop(); renderSidebar();
  }));
}

// P20 — workbook group overflow menu: Rename / Combine into… / Close.
function openWorkbookMenu(wbId, anchor) {
  closeRowPop();
  const acc = accessFor(wbId);
  const others = _ws().order.filter((id) => id !== wbId && _items.has(id) && accessFor(id).canEdit);
  const el = document.createElement('div'); el.className = 'sb-row-pop'; el.id = 'sbRowPop';
  el.innerHTML = `
    ${acc.canEdit ? `<button data-act="ren">${icon('edit', { size: 14 })}<span>Rename workbook</span></button>` : ''}
    ${acc.isOwner ? `<button data-act="settings">${icon('settings', { size: 14 })}<span>Data &amp; Sync settings</span></button>` : ''}
    ${serverMode() && acc.isOwner ? `<button data-act="share">${icon('users', { size: 14 })}<span>Share…</span></button>` : ''}
    <div class="cmdbar-pop-sep"></div>
    ${acc.isOwner && others.length ? `<button data-act="combine">${icon('merge', { size: 14 })}<span>Combine into…</span></button>` : ''}
    <button data-act="close" ${_ws().order.length <= 1 ? 'disabled style="opacity:.45;cursor:default"' : ''}>${icon('x', { size: 14 })}<span>Close workbook</span></button>
    ${acc.isOwner ? `<button data-act="delwb">${icon('trash', { size: 14 })}<span>Delete workbook</span></button>` : ''}`;
  popAt(el, anchor);
  el.querySelector('[data-act="share"]')?.addEventListener('click', () => { closeRowPop(); openShare(wbId); });
  el.querySelector('[data-act="delwb"]')?.addEventListener('click', () => { closeRowPop(); deleteWorkbookAction(wbId); });
  el.querySelector('[data-act="ren"]')?.addEventListener('click', () => {
    closeRowPop();
    const it = _items.get(wbId); if (!it) return;
    const name = prompt('Workbook name', it.wb.name);
    if (name && name.trim()) renameWorkbook(wbId, name.trim());
  });
  el.querySelector('[data-act="settings"]')?.addEventListener('click', () => { closeRowPop(); openSettings(ctx(wbId)); });
  el.querySelector('[data-act="combine"]')?.addEventListener('click', (e) => {
    closeRowPop();
    if (others.length === 1) { combineWorkbooks(wbId, others[0]); return; }
    const pick = document.createElement('div'); pick.className = 'sb-row-pop'; pick.id = 'sbRowPop';
    pick.innerHTML = `<div class="sb-empty" style="padding:5px 9px">Combine "${escH(_items.get(wbId).wb.name)}" into:</div>` +
      others.map((id) => `<button data-into="${id}">${icon('layers', { size: 14 })}<span>${escH(_items.get(id).wb.name)}</span></button>`).join('');
    popAt(pick, anchor);
    pick.querySelectorAll('[data-into]').forEach((b) => b.addEventListener('click', () => { closeRowPop(); combineWorkbooks(wbId, b.dataset.into); }));
  });
  el.querySelector('[data-act="close"]')?.addEventListener('click', () => {
    closeRowPop();
    if (_ws().order.length <= 1) return;
    closeWorkbook(wbId);
  });
}

function openFeedsPreview(sheetId) {
  const sh = _wb.sheets.find((s) => s.id === sheetId); if (!sh) return;
  let body;
  const w = window.__monoDashboardApi;
  const preview = w && w.getMonoFeedPreview ? w.getMonoFeedPreview(sheetId) : null;
  if (preview) {
    body = `<div class="muted" style="margin-bottom:10px">Live in the current Dashboard session:</div>
      <div class="preview-thumb" data-open="1"><div class="pt-title">${escH(preview.pageTitle)}</div><div class="pt-meta">${preview.widgets.length} widget${preview.widgets.length === 1 ? '' : 's'}${preview.widgets.length ? ' · ' + preview.widgets.map((x) => escH(x.title)).join(', ') : ''}</div></div>`;
  } else {
    body = emptyStateHTML({ icon: 'layout-dashboard', message: `Open Dashboard to see the live preview of what "${sh.name}" feeds — this drawer shows it instantly once Dashboard has loaded this session.`, ctaLabel: 'Open Dashboard', ctaOnclick: '' });
  }
  const panel = openPanel({ title: `${sh.name} → Dashboard`, width: 380, body });
  panel.el.querySelector('.empty-state .btn')?.addEventListener('click', () => { window.dispatchEvent(new CustomEvent('mono:useInDashboard')); });
  panel.el.querySelector('[data-open]')?.addEventListener('click', () => { window.dispatchEvent(new CustomEvent('mono:openDashboardPage', { detail: { pageId: 'mono__' + sheetId } })); });
}

// P20 — sidebar: two-level tree. Multi-user (UI Plan v3 §3): the tree is
// split into "My workbooks" (owned — open groups + closed rows) and
// "Shared with me" (role badge, shared-by, no owner controls).
function renderSidebar() {
  const side = document.getElementById('sidebar'); if (!side) return;
  applySidebarHidden();
  const colors = _settings.sheetColors || {};
  const srv = serverMode();
  const roleBadge = (role) => role && role !== 'owner' ? `<span class="role-badge ${role}">${role}</span>` : '';

  const groupFor = (wbId) => {
    const it = _items.get(wbId); if (!it) return '';
    const acc = accessFor(wbId);
    const isActiveWb = wbId === activeId();
    const collapsed = !!_settings.wbCollapsed[wbId];
    const sc = syncFor(_settings, wbId);
    const meta = _srvList.find((w) => w.id === wbId);
    const rows = collapsed ? '' : it.wb.sheets.map((sh) => {
      const active = isActiveWb && sh.id === it.wb.activeSheetId;
      const feeds = feedsDashboard(it.wb, sh.id);
      const dot = colors[sh.id] ? `<span style="width:7px;height:7px;border-radius:50%;background:${colors[sh.id]};flex:0 0 auto"></span>` : '';
      return `<div class="sb-row sb-row-sheet ${active ? 'active' : ''}" data-wb="${wbId}" data-sheet="${sh.id}" role="button" tabindex="0" aria-current="${active}" aria-label="Switch to sheet ${escH(sh.name)}">
        <span class="sb-row-icon">${icon('sheet', { size: 14 })}</span>${dot}
        <span class="sb-row-name" data-name>${escH(sh.name)}</span>
        ${feeds ? `<button class="sb-feed-dot" data-feeds="${sh.id}" title="Feeding Dashboard — click to preview" aria-label="Feeding Dashboard"></button>` : ''}
        ${isActiveWb && acc.canEdit ? `<button class="sb-row-menu" data-menu="${sh.id}" title="More">${icon('more-horizontal', { size: 14 })}</button>` : ''}
      </div>`;
    }).join('');
    return `<div class="sb-wb ${isActiveWb ? 'active-wb' : ''}" data-wbgroup="${wbId}">
      <div class="sb-wb-head" data-wbhead="${wbId}" role="button" tabindex="0" aria-label="Workbook ${escH(it.wb.name)}">
        <button class="sb-wb-chev" data-chev="${wbId}" title="${collapsed ? 'Expand' : 'Collapse'}">${icon(collapsed ? 'chevron-right' : 'chevron-down', { size: 13 })}</button>
        <span class="sb-wb-icon">${icon('layers', { size: 13 })}</span>
        <span class="sb-wb-name">${escH(it.wb.name)}</span>
        ${roleBadge(acc.role)}
        ${acc.isOwner && meta && meta.sharedCount ? `<span class="sb-shared-ind" data-shared="${wbId}" title="Shared with ${meta.sharedCount} ${meta.sharedCount === 1 ? 'person' : 'people'} — click to manage">${icon('users', { size: 12 })}</span>` : ''}
        ${acc.isOwner && sc.enabled && sc.execUrl ? `<span class="sb-wb-sync" title="Google Sheets sync on${sc.lastSyncAt ? ' · last ' + new Date(sc.lastSyncAt).toLocaleTimeString() : ''}">${icon('refresh-cw', { size: 11 })}</span>` : ''}
        <button class="sb-row-menu sb-wb-more" data-wbmenu="${wbId}" title="More">${icon('more-horizontal', { size: 14 })}</button>
        ${isActiveWb && acc.canEdit ? `<button class="sb-add" title="Add sheet" data-addsheet="${wbId}">${icon('plus', { size: 13 })}</button>` : ''}
      </div>
      <div class="sb-wb-rows">${rows}</div>
    </div>`;
  };

  const openIds = new Set(_ws().order);
  const ownedOpen = _ws().order.filter((id) => accessFor(id).isOwner).map(groupFor).join('');
  const sharedOpen = _ws().order.filter((id) => !accessFor(id).isOwner).map(groupFor).join('');
  const closedRow = (w) => `
    <div class="sb-row sb-row-closedwb" data-openwb="${escH(w.id)}" role="button" tabindex="0" title="${w.role === 'owner' ? 'Open workbook' : 'Shared by ' + escH(w.ownerName || '')}">
      <span class="sb-row-icon">${icon('layers', { size: 13 })}</span>
      <span class="sb-row-name">${escH(w.name)}</span>
      ${roleBadge(w.role)}
      ${w.role === 'owner' && w.sharedCount ? `<span class="sb-shared-ind" title="Shared with ${w.sharedCount}">${icon('users', { size: 12 })}</span>` : ''}
      ${w.role !== 'owner' && w.ownerName ? `<span class="sb-sharedby">by ${escH(w.ownerName)}</span>` : ''}
    </div>`;
  const ownedClosed = srv ? _srvList.filter((w) => w.role === 'owner' && !openIds.has(w.id)).map(closedRow).join('') : '';
  const sharedClosed = srv ? _srvList.filter((w) => w.role !== 'owner' && !openIds.has(w.id)).map(closedRow).join('') : '';
  const sharedAny = srv && (sharedOpen || sharedClosed);

  side.innerHTML = `
    <div class="sb-sec">${srv ? 'My workbooks' : 'Workbooks'}</div>
    <div class="sb-conn sb-workspace">${ownedOpen}${ownedClosed}</div>
    ${srv ? `
      <div class="sb-sec">Shared with me</div>
      <div class="sb-conn sb-workspace">${sharedAny ? sharedOpen + sharedClosed : emptyStateHTML({ icon: 'users', message: 'Nothing shared with you yet' })}</div>` : ''}
    <div class="sb-wb-actions">
      <button class="sb-wb-add" data-act="addwb">${icon('plus', { size: 13 })} New workbook</button>
      <button class="sb-wb-add" data-act="connectwb">${icon('plug', { size: 13 })} Connect workbook…</button>
    </div>
    <div class="sb-sec">Data</div>
    <div class="sb-empty">${serverMode() ? 'On the server · signed in as ' + escH(Auth.user.username) : escH(_store.label())} · ${_ws().order.length} workbook${_ws().order.length === 1 ? '' : 's'} open. Each workbook has its own sync — open its ${icon('more-horizontal', { size: 10 })} menu in the list above and pick "Data &amp; Sync settings".</div>
    <div class="sb-empty" style="margin-top:6px">While two workbooks are open, pull live values across with <b>=IMPORTRANGE("Workbook name", "Sheet1!A1:B2")</b>.</div>
    <div class="sb-sec">Scripting</div>
    <div class="sb-empty">Extensions → Mono Scripts. Custom functions, triggers &amp; menus.</div>`;

  // Workbook group interactions
  side.querySelectorAll('[data-chev]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = b.dataset.chev;
    if (_settings.wbCollapsed[id]) delete _settings.wbCollapsed[id]; else _settings.wbCollapsed[id] = true;
    saveSettings(_settings); renderSidebar();
  }));
  side.querySelectorAll('[data-wbmenu]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openWorkbookMenu(b.dataset.wbmenu, e.currentTarget); }));
  side.querySelectorAll('[data-addsheet]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); _grid?.addSheet(); }));
  side.querySelectorAll('[data-wbhead]').forEach((h) => {
    const id = h.dataset.wbhead;
    h.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (id !== activeId()) switchWorkbook(id);
    });
    h.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      const it = _items.get(id); if (!it) return;
      const name = prompt('Workbook name', it.wb.name);
      if (name && name.trim()) renameWorkbook(id, name.trim());
    });
    h.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openWorkbookMenu(id, h.querySelector('.sb-wb-more') || h); });
  });

  // Sheet rows — clicking a row under another workbook switches both the
  // active workbook and the active sheet in one action.
  side.querySelectorAll('.sb-row-sheet').forEach((row) => {
    const id = row.dataset.sheet, wbId = row.dataset.wb;
    const go = () => { if (wbId === activeId()) _grid?.onTab(id); else switchWorkbook(wbId, id); };
    row.addEventListener('click', (e) => { if (e.target.closest('.sb-chip') || e.target.closest('.sb-row-menu')) return; go(); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    row.querySelector('[data-name]').addEventListener('dblclick', (e) => { e.stopPropagation(); if (wbId === activeId()) _grid?.renameSheetPrompt(id); });
    row.querySelector('.sb-row-menu')?.addEventListener('click', (e) => { e.stopPropagation(); openRowMenu(id, e.currentTarget); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); if (wbId === activeId()) openRowMenu(id, row.querySelector('.sb-row-menu') || row); });
    row.querySelector('[data-feeds]')?.addEventListener('click', (e) => { e.stopPropagation(); if (wbId === activeId()) openFeedsPreview(id); });
  });

  side.querySelector('[data-act="addwb"]')?.addEventListener('click', () => newWorkbook());
  side.querySelector('[data-act="connectwb"]')?.addEventListener('click', () => connectWorkbook());
  side.querySelectorAll('[data-openwb]').forEach((row) => {
    const go = () => openWorkbookById(row.dataset.openwb);
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  side.querySelectorAll('[data-shared]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); openShare(el.dataset.shared); }));
}

/* ---------- P20: sidebar show/hide toggle ---------- */
// Hides the whole sidebar so the grid, toolbar, formula bar and menu bar can
// use the full window width. Persisted; the toggle lives in the topbar, and
// a low-profile floating tab (only shown while hidden) hovers at the left
// edge of the grid so the panel is easy to bring back without hunting for
// the topbar icon.
function ensureReopenTab() {
  let tab = document.getElementById('sbReopenTab');
  if (!tab) {
    tab = document.createElement('button');
    tab.id = 'sbReopenTab';
    tab.className = 'sb-reopen-tab';
    tab.title = 'Show workbook panel';
    tab.innerHTML = icon('chevron-right', { size: 14 });
    tab.addEventListener('click', () => toggleSidebar());
    document.body.appendChild(tab);
  }
  return tab;
}
// A small always-visible toggle pinned to the top-right corner of the
// sidebar itself (sitting right on the border with the grid) — the spot
// people naturally reach for to collapse the panel. Lives outside
// #sidebar's innerHTML so renderSidebar() re-renders don't wipe it out.
function ensureCornerToggle() {
  let btn = document.getElementById('sbCornerToggle');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'sbCornerToggle';
    btn.className = 'sb-corner-toggle';
    btn.addEventListener('click', () => toggleSidebar());
    document.body.appendChild(btn);
  }
  return btn;
}
function applySidebarHidden() {
  const side = document.getElementById('sidebar');
  if (side) side.classList.toggle('ms-hidden', !!_settings.sidebarHidden);
  const btn = document.getElementById('msSideBtn');
  if (btn) { btn.innerHTML = icon(_settings.sidebarHidden ? 'chevron-right' : 'chevron-left', { size: 16 }); btn.title = _settings.sidebarHidden ? 'Show workbook panel' : 'Hide workbook panel'; }
  const tab = ensureReopenTab();
  tab.classList.toggle('is-visible', !!_settings.sidebarHidden);
  const corner = ensureCornerToggle();
  corner.classList.toggle('is-visible', !_settings.sidebarHidden);
  corner.title = 'Hide workbook panel';
  corner.innerHTML = icon('chevron-left', { size: 13 });
}
function toggleSidebar() {
  _settings.sidebarHidden = !_settings.sidebarHidden;
  saveSettings(_settings);
  applySidebarHidden();
}

function announceWorkspaceName() { window.dispatchEvent(new CustomEvent('mono:workspaceName', { detail: { name: _wb.name } })); }

/* ---------- P20: workbook actions ---------- */
async function newWorkbook(name) {
  const wb = new MonoWorkbook({ name: name || nextWorkbookName() });
  await addWorkbook(wb);
  toast('New workbook "' + wb.name + '" added');
  return wb;
}
function nextWorkbookName() {
  const used = new Set([..._items.values()].map((it) => it.wb.name));
  let i = _items.size + 1, n = 'Workbook ' + i;
  while (used.has(n)) n = 'Workbook ' + (++i);
  return n;
}
// "+ Connect workbook…" — blank workbook whose settings open straight on the
// /exec URL field, so pasting a link + Sync now populates it.
async function connectWorkbook() {
  const wb = await newWorkbook('Connected workbook');
  const sc = syncFor(_settings, wb.id);
  sc.enabled = true; saveSettings(_settings);
  openSettings(ctx(wb.id, { focusExec: true }));
}

function renameWorkbook(wbId, name) {
  const it = _items.get(wbId); if (!it || !name) return;
  const oldName = it.wb.name;
  it.wb.name = name;
  // Refresh the name alias on every other engine (id key is stable).
  for (const [id, other] of _items) {
    if (id === wbId) continue;
    other.engine.unregisterForeign(oldName);
    other.engine.registerForeign(name, it.engine);
  }
  saveWorkbookNow(wbId);
  if (wbId === activeId()) announceWorkspaceName();
  renderSidebar();
}

async function closeWorkbook(wbId) {
  const it = _items.get(wbId); if (!it) return;
  if (_ws().order.length <= 1) { toast('The last workbook can’t be closed'); return; }
  const srv = serverMode();
  const msg = srv
    ? `Close "${it.wb.name}"?\n\nIt stays ${accessFor(wbId).isOwner ? 'in My workbooks' : 'in Shared with me'} — open it again any time. Formulas in other workbooks that IMPORTRANGE from it keep their last value until edited.`
    : `Close "${it.wb.name}"?\n\nThis removes the workbook from the workspace and deletes its local copy. Formulas in other workbooks that IMPORTRANGE from it keep their last value until edited. Use "Combine into…" first if you want to keep its sheets.`;
  if (!confirm(msg)) return;
  try { _grid?.commitIfEditing?.(); } catch {}
  try { flushNow(); } catch {}
  // Phase D: leave dependents' last computed values in place (stale) — no forced recompute.
  unwireForeignKeyEverywhere(wbId, it.wb.name);
  it.unsub?.(); _items.delete(wbId);
  if (!srv) { try { await _store.remove?.(wbId); } catch {} }   // local mode keeps old semantics
  const wasActive = wbId === activeId();
  removeFromWorkspace(_settings, wbId, saveSettings);
  clearInterval(_autoTimers.get(wbId)); _autoTimers.delete(wbId);
  if (wasActive) build(); else renderSidebar();
  toast(srv ? 'Workbook closed — still in your list' : 'Workbook closed');
}

/* Owner-only, permanent (Plan v3 §5.2 delete-workbook). */
async function deleteWorkbookAction(wbId) {
  if (!accessFor(wbId).isOwner) { toast('Only the owner can delete a workbook'); return; }
  const it = _items.get(wbId);
  const name = it ? it.wb.name : (_srvList.find((w) => w.id === wbId)?.name || wbId);
  if (!confirm(`Delete "${name}" permanently?\n\nThis removes it for you AND everyone it's shared with. This can't be undone.`)) return;
  try { await _store.remove?.(wbId); } catch {}
  if (it) { unwireForeignKeyEverywhere(wbId, it.wb.name); it.unsub?.(); _items.delete(wbId); }
  clearInterval(_autoTimers.get(wbId)); _autoTimers.delete(wbId);
  removeFromWorkspace(_settings, wbId, saveSettings);
  await refreshServerList();
  if (!_items.size) {
    const wb = seed(); openItem(wb);
    _ws().order = [wb.id]; _ws().activeWorkbookId = wb.id; saveSettings(_settings);
    try { await _store.save(wb.id, wb.toJSON()); } catch {}
  } else if (!_items.has(activeId())) {
    _ws().activeWorkbookId = _ws().order[0]; saveSettings(_settings);
  }
  build(); setupAuto();
  toast('Workbook deleted');
}

// Phase F — one click: fold `sourceId` into `targetId`, rewrite formerly
// cross-workbook IMPORTRANGE formulas into plain references, drop the source.
async function combineWorkbooks(sourceId, targetId) {
  const src = _items.get(sourceId), tgt = _items.get(targetId);
  if (!src || !tgt || sourceId === targetId) return;
  if (!confirm(`Combine "${src.wb.name}" into "${tgt.wb.name}"?\n\nAll its sheets move across (renamed on collision) and IMPORTRANGE formulas between the two become normal references. "${src.wb.name}" is then removed from the workspace.`)) return;
  try { _grid?.commitIfEditing?.(); } catch {}
  mergeWorkbooks(tgt.wb, src.wb);
  // Unregister the source everywhere, drop its item + storage + sync config.
  unwireForeignKeyEverywhere(sourceId, src.wb.name);
  src.unsub?.(); _items.delete(sourceId);
  try { await _store.remove?.(sourceId); } catch {}
  removeFromWorkspace(_settings, sourceId, saveSettings);
  clearInterval(_autoTimers.get(sourceId)); _autoTimers.delete(sourceId);
  _ws().activeWorkbookId = targetId; saveSettings(_settings);
  tgt.engine.recalcAll();
  await saveWorkbookNow(targetId);
  build(); setupAuto();
  toast(`Combined into "${tgt.wb.name}"`);
}

/* ---------- Phase E: import a file as its own workbook ---------- */
function chooseImportTarget(image, fileName) {
  const baseName = String(fileName || 'Imported workbook').replace(/\.(csv|tsv|txt|xlsx|xlsm)$/i, '');
  const back = document.createElement('div'); back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal"><h3>Import "${escH(fileName)}"</h3>
    <p class="muted" style="margin-bottom:14px">Where should the imported sheet${(image.sheets || []).length === 1 ? '' : 's'} go?</p>
    <div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap">
      <button class="btn btn-primary" id="impNew">${icon('layers', { size: 13 })} New workbook</button>
      <button class="btn btn-ghost" id="impMerge">${icon('sheet', { size: 13 })} Add to "${escH(_wb.name)}"</button>
      <button class="btn btn-ghost" id="impCancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(back);
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
  back.querySelector('#impCancel').onclick = () => back.remove();
  back.querySelector('#impNew').onclick = async () => {
    back.remove();
    const wb = workbookFromImage(image, baseName);
    await addWorkbook(wb);
    toast(`Imported ${image.sheets.length} sheet(s) as workbook "${wb.name}" — other workbooks can IMPORTRANGE it now`);
  };
  back.querySelector('#impMerge').onclick = () => {
    back.remove();
    _grid?.commitIfEditing(); _grid?.pushUndo();
    const ids = appendImageSheets(_wb, image);
    if (ids.length) _grid?.onTab(ids[0]);
    _engine.recalcAll(); save(); _grid?.render(); renderSidebar();
    toast(`Imported ${image.sheets.length} sheet(s) from ${fileName}`);
  };
}

/* ---------- opening a stored workbook ----------
   Everything that turns stored JSON into a live workbook happens here, behind
   a guard. One workbook that cannot be parsed or engined must not stop the
   others from opening, and must NEVER leave the app on the loading spinner
   with no way in - which is exactly what happened: the guard around build()
   did not cover fromJSON() or openItem(), which run before it. */
const _broken = new Map();   // workbookId -> why it would not open

function openStored(id, json, opts) {
  try {
    const wb = MonoWorkbook.fromJSON(json);
    wb.id = id;
    openItem(wb, opts);
    _broken.delete(id);
    return true;
  } catch (err) {
    console.error('[mono] could not open workbook ' + id, err);
    _broken.set(id, String((err && err.message) || err));
    return false;
  }
}

// Last-resort screen: something outside the workbook loop threw. Shows what,
// so a stuck app reports its own cause instead of spinning silently.
function showMountFailure(err) {
  const main = document.getElementById('main'); if (!main) return;
  const msg = String((err && err.message) || err);
  main.innerHTML = `<div class="center"><div style="text-align:left;max-width:560px">
    <h3 style="margin:0 0 8px">Mono could not start</h3>
    <p class="muted" style="margin:0 0 6px"><code>${escH(msg)}</code></p>
    <p class="muted" style="font-size:12px;margin:0 0 16px">Your data has not been changed. The full stack trace is in the browser console.</p>
    <div class="modal-actions" style="justify-content:flex-start">
      <button class="btn btn-primary" id="mfRetry">Try again</button>
      <button class="btn btn-ghost" id="mfCopy">Copy the error</button>
    </div></div></div>`;
  main.querySelector('#mfRetry')?.addEventListener('click', () => MonoSheets.mount());
  main.querySelector('#mfCopy')?.addEventListener('click', () => {
    const NL = String.fromCharCode(10);
    const text = msg + NL + NL + String((err && err.stack) || '');
    navigator.clipboard?.writeText(text).then(() => toast('Error copied'), () => {});
  });
}

// Shown when NOTHING could be opened. Seeding a blank workbook here instead
// would look exactly like the account's data had been lost.
function showOpenFailure() {
  const main = document.getElementById('main'); if (!main) return;
  const rows = [..._broken.entries()]
    .map(([id, why]) => `<li style="margin-bottom:4px"><code>${escH(id)}</code><br><span class="muted" style="font-size:12px">${escH(why)}</span></li>`)
    .join('');
  main.innerHTML = `<div class="center"><div style="text-align:left;max-width:560px">
    <h3 style="margin:0 0 8px">Your workbooks could not be opened</h3>
    <p class="muted" style="margin:0 0 12px">Nothing has been deleted or overwritten — this is a problem reading them, and the files are intact on the server.</p>
    <ul style="margin:0 0 16px;padding-left:18px">${rows}</ul>
    <div class="modal-actions" style="justify-content:flex-start">
      <button class="btn btn-primary" id="ofRetry">Try again</button>
      <button class="btn btn-ghost" id="ofNew">Start a blank workbook</button>
    </div></div></div>`;
  main.querySelector('#ofRetry')?.addEventListener('click', () => MonoSheets.mount());
  main.querySelector('#ofNew')?.addEventListener('click', async () => { _broken.clear(); await addWorkbook(seed()); });
}

/* ---------- build (mount grid for the active workbook) ----------
   Wrapped, because build() is what replaces the loading spinner. Anything that
   throws in here - one malformed rule in one imported sheet was enough - left
   the app on "Loading workbook..." for ever, with no way back in and no
   indication of what was wrong. A broken workbook must never cost you the
   whole application. */
function build() {
  try { buildUnsafe(); }
  catch (err) {
    console.error('[mono] could not render this workbook', err);
    showBuildFailure(err);
  }
}

function showBuildFailure(err) {
  const main = document.getElementById('main'); if (!main) return;
  const other = _ws().order.filter((id) => id !== activeId());
  main.innerHTML = `<div class="center"><div style="text-align:center;max-width:520px">
    <h3 style="margin:0 0 8px">This workbook could not be opened</h3>
    <p class="muted" style="margin:0 0 4px">${escH(String(err && err.message || err))}</p>
    <p class="muted" style="font-size:12px;margin:0 0 16px">The data is safe on the server — nothing has been overwritten.</p>
    <div class="modal-actions" style="justify-content:center">
      <button class="btn btn-primary" id="bfReload">Reload it</button>
      ${other.length ? '<button class="btn btn-ghost" id="bfOther">Open another workbook</button>' : ''}
      <button class="btn btn-ghost" id="bfNew">Start a blank workbook</button>
    </div></div></div>`;
  main.querySelector('#bfReload')?.addEventListener('click', () => reloadWorkbook(activeId()));
  main.querySelector('#bfOther')?.addEventListener('click', () => switchWorkbook(other[0]));
  main.querySelector('#bfNew')?.addEventListener('click', async () => {
    const wb = seed(); await addWorkbook(wb);
  });
}

function buildUnsafe() {
  const main = document.getElementById('main'); if (!main) return;
  const it = _items.get(activeId());
  if (!it) return;
  _wb = it.wb; _engine = it.engine;
  announceWorkspaceName();
  _grid = new MonoGrid(main, _engine, { onChange: save });
  const acc = accessFor(_wb.id);
  _grid.access = acc;                                     // role → UI mode (edit / comment / view)
  _grid.onSaveConflict = () => onConflict(_wb.id);
  _grid.commentApi = serverMode() ? {
    me: () => Auth.user,
    access: () => accessFor(_wb.id),
    add: (sheetId, r, c, text) => _store.addComment(_wb.id, { sheetId, r, c, text }),
    remove: (sheetId, r, c, cid) => _store.deleteComment(_wb.id, { sheetId, r, c, cid }),
  } : null;
  _scripts = new MonoScripts({ engine: _engine, grid: _grid, save });
  _grid.scripts = _scripts; _grid.onUseInDashboard = useInDashboard; _grid.onSheetListChange = renderSidebar;
  _grid.onImportImage = (image, fname) => chooseImportTarget(image, fname);   // Phase E
  if (acc.canEdit) _scripts.fireOpen();                   // scripts write cells — edit roles only
  _grid.render();
  paintTopbarActions();
  mountFab(_grid);
  renderSidebar();
  registerCommands('Sheets: navigate', _wb.sheets.map((sh) => ({ id: 'gotoSheet:' + sh.id, label: 'Go to sheet: ' + sh.name, icon: 'sheet', run: () => _grid?.onTab(sh.id) })));
  registerCommands('Workspace', [
    { id: 'newWorkbook', label: 'New workbook', icon: 'layers', keywords: 'workbook add create', run: () => newWorkbook() },
    { id: 'toggleSidebar', label: 'Toggle sidebar', icon: 'columns', keywords: 'sidebar hide show panel', run: () => toggleSidebar() },
    ..._ws().order.filter((id) => id !== activeId()).map((id) => ({ id: 'gotoWb:' + id, label: 'Go to workbook: ' + (_items.get(id)?.wb.name || id), icon: 'layers', run: () => switchWorkbook(id) })),
  ]);
  registerCommands('Copilot', [{ id: 'askMono', label: 'Ask Copilot', icon: 'sparkles', kbd: 'Ctrl+/', keywords: 'ai assistant copilot mono ask', run: () => window.ChatUI?.toggle() }]);
}

function exportJson() {
  const blob = new Blob([JSON.stringify(_wb.toJSON(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (_wb.name || 'workbook').replace(/[^a-z0-9]+/gi, '_') + '.mono.json'; a.click(); URL.revokeObjectURL(a.href);
}
// Replace the *active* workbook in place with an imported .mono.json.
function importJson(file) {
  if (!accessFor(activeId()).isOwner) { toast('Only the owner can replace this workbook from a file'); return; }
  const fr = new FileReader();
  fr.onload = async () => {
    try {
      const incoming = MonoWorkbook.fromJSON(JSON.parse(fr.result));
      const oldId = activeId();
      const old = _items.get(oldId);
      unwireForeignKeyEverywhere(oldId, old?.wb.name);
      old?.unsub?.(); _items.delete(oldId);
      try { await _store.remove?.(oldId); } catch {}
      // keep the workspace slot position: swap the id in `order`
      const ws = _ws();
      const idx = ws.order.indexOf(oldId);
      if (idx >= 0) ws.order[idx] = incoming.id; else ws.order.push(incoming.id);
      ws.activeWorkbookId = incoming.id;
      if (_settings.syncByWorkbook && _settings.syncByWorkbook[oldId]) { _settings.syncByWorkbook[incoming.id] = _settings.syncByWorkbook[oldId]; delete _settings.syncByWorkbook[oldId]; }
      saveSettings(_settings);
      openItem(incoming); wireForeign();
      await _store.save(incoming.id, incoming.toJSON());
      build(); setupAuto();
    } catch (e) { toast('Could not import: ' + (e && e.message || e)); }
  };
  fr.readAsText(file);
}
async function migrateTo(home, serverUrl) {
  _settings.dataHome = home; if (serverUrl != null) _settings.serverUrl = serverUrl; saveSettings(_settings);
  _store = getStore(_settings);
  for (const [id, it] of _items) { try { await _store.save(id, it.wb.toJSON()); } catch {} }
  setSaved('Moved to ' + _store.label()); renderSidebar();
}

/* ---------- Phase C: per-workbook sync ---------- */
// Paint a first sync as it downloads. The manifest already carried every
// sheet's structure, so a sheet can be materialised from the first band and
// simply gain rows as later ones arrive. Repainting is throttled - the point
// is that the sheet is usable early, not that it updates on every packet.
const PAINT_EVERY_MS = 400;

function makeProgressiveApply(wbId, it) {
  let lastPaint = 0;
  let dirty = false;
  let timer = null;

  const paint = () => {
    dirty = false; lastPaint = Date.now();
    clearTimeout(timer); timer = null;
    try {
      it.engine.recalcAll();          // only walks formula cells, so this is cheap
      if (wbId === activeId() && _grid) {
        const top = _grid.scrollEl?.scrollTop ?? 0;
        const left = _grid.scrollEl?.scrollLeft ?? 0;
        _grid.render();
        if (_grid.scrollEl) { _grid.scrollEl.scrollTop = top; _grid.scrollEl.scrollLeft = left; }
      }
    } catch { /* a partial repaint must never abort the download */ }
  };

  const schedule = () => {
    dirty = true;
    const since = Date.now() - lastPaint;
    if (since >= PAINT_EVERY_MS) { paint(); return; }
    if (!timer) timer = setTimeout(() => { if (dirty) paint(); }, PAINT_EVERY_MS - since);
  };

  return {
    onChunk({ sheet, chunk }) {
      let sh = it.wb.sheets.find((x) => x.name === sheet.name);
      if (!sh) {
        // the manifest gave us the whole structure, so this is complete
        // except for the rows still in flight
        sh = imageSheetToMonoSheet(sheet);
        it.wb.sheets.push(sh);
      } else {
        for (const k of Object.keys(chunk.cells || {})) {
          const cell = sheet.cells[k];
          const i = k.indexOf(',');
          const r = +k.slice(0, i), c = +k.slice(i + 1);
          if (cell) { const { dv, ...keep } = cell; sh.setCellObj(r, c, keep); }
        }
        if (sheet.rows > sh.rows) sh.rows = sheet.rows;
        if (sheet.cols > sh.cols) sh.cols = sheet.cols;
      }
      schedule();
    },
    finish() { clearTimeout(timer); timer = null; },
  };
}

// The last-synced remote snapshot. Older builds kept it inside settings as
// whole cells; if one of those is still there, fingerprint it once so the
// first sync after upgrading keeps its anti-clobber protection instead of
// starting blind.
async function readSyncBase(wbId, sc) {
  const stored = await loadSyncBase(wbId);
  if (stored.base) return stored.base;
  if (sc.base && Object.keys(sc.base).length) {
    const migrated = {};
    for (const name of Object.keys(sc.base)) migrated[name] = fingerprintMap(sc.base[name]);
    return migrated;
  }
  return {};
}

function syncNow(wbId, opts) {
  wbId = wbId || activeId();
  const running = _syncing.get(wbId);
  if (running) return running;                       // already pulling — join that run
  const p = runSync(wbId, opts).finally(() => { _syncing.delete(wbId); });
  _syncing.set(wbId, p);
  return p;
}

async function runSync(wbId, opts) {
  const it = _items.get(wbId); if (!it) throw new Error('Workbook not open');
  const sc = syncFor(_settings, wbId);
  if (!sc.enabled || !sc.execUrl) throw new Error('Sync not configured');
  const prev = await readSyncBase(wbId, sc);
  // A FIRST sync has nothing local to protect, so each band can go straight
  // onto the sheet as it arrives instead of the user watching a blank grid
  // until the last one lands. This is what Google Sheets does (progressive
  // loading, patent US10061759B2): show the viewport immediately, keep filling
  // in behind it. A later sync keeps the careful three-way merge, and by then
  // the user is looking at data anyway rather than an empty screen.
  const firstLoad = !sc.lastSyncAt && !Object.keys(prev).length;
  const stream = firstLoad ? makeProgressiveApply(wbId, it) : null;

  // The Google pull arrives in chunks, so hand progress back to the caller.
  const image = await importGoogleSheetImage(sc.execUrl, null, {
    onProgress: opts && opts.onProgress,
    onChunk: stream ? stream.onChunk : undefined,
  });
  // First sync of an empty/seed workbook → adopt the remote name.
  if (image.source?.name && !sc.lastSyncAt) renameWorkbook(wbId, image.source.name);
  if (stream) stream.finish();

  const { base, stats, structural } = syncImageIntoWorkbook(it.wb, it.engine, image, prev, { adopt: firstLoad });

  // The base lives in IndexedDB, NOT in settings: as full cells inside
  // localStorage it silently blew the quota on a large workbook and took
  // every other setting down with it.
  const saved = await saveSyncBase(wbId, base);
  const warnings = [];
  if (!saved.ok) warnings.push('Could not remember this sync (' + saved.error + '), so the next one cannot protect local edits in cells that are empty in Google.');
  if (image.warnings) warnings.push(...image.warnings);
  if (image.reduced) warnings.push('The Apps Script is missing the advanced "Google Sheets API" service, so borders and font family/size were not imported.');

  if (sc.base) delete sc.base;                  // drop any legacy in-settings base
  sc.lastSyncAt = new Date().toISOString(); saveSettings(_settings);
  it.engine.recalcAll();
  await saveWorkbookNow(wbId);
  if (wbId === activeId() && _grid) {
    const savedTop = _grid.scrollEl?.scrollTop ?? 0;
    const savedLeft = _grid.scrollEl?.scrollLeft ?? 0;
    _grid.render();
    if (_grid.scrollEl) { _grid.scrollEl.scrollTop = savedTop; _grid.scrollEl.scrollLeft = savedLeft; }
  }
  renderSidebar();
  return { stats, structural, warnings, reduced: !!image.reduced };
}
// One independent auto-sync timer per workbook that has auto:true — each ticks
// on its own interval and calls syncNow(workbookId).
function setupAuto() {
  for (const t of _autoTimers.values()) clearInterval(t);
  _autoTimers.clear();
  for (const wbId of _ws().order) {
    const sc = syncFor(_settings, wbId);
    if (sc.enabled && sc.auto && sc.execUrl) {
      _autoTimers.set(wbId, setInterval(() => { syncNow(wbId).catch(() => {}); }, Math.max(10, sc.intervalSec) * 1000));
    }
  }
}
async function useInDashboard() { setMonoEnabled(true); try { await _store.save(_wb.id, _wb.toJSON()); } catch {} renderSidebar(); window.dispatchEvent(new CustomEvent('mono:useInDashboard')); }
function renameWorkspace(name) { if (!name || !name.trim()) return; renameWorkbook(activeId(), name.trim()); save(); }
function ctx(wbId, opts) {
  wbId = wbId || activeId();
  const it = _items.get(wbId);
  return {
    settings: _settings, save: saveSettings,
    wb: it ? it.wb : _wb,
    workbookId: wbId,
    sync: syncFor(_settings, wbId),
    isActive: wbId === activeId(),
    persist: wbId === activeId() ? save : () => saveWorkbookNow(wbId),
    onRename: (name) => renameWorkbook(wbId, name),
    exportJson, importJson, migrateTo,
    syncNow: (o) => syncNow(wbId, o),
    theme, setTheme, setupAuto,
    focusExec: !!(opts && opts.focusExec),
  };
}

/* ---------- topbar actions: Share (owner) · sidebar toggle · settings (owner) ---------- */
function paintTopbarActions() {
  const actions = document.getElementById('modeActions'); if (!actions) return;
  if (document.body.dataset.mode !== 'sheet') return;
  const acc = _wb ? accessFor(_wb.id) : { isOwner: true, canEdit: true };
  actions.innerHTML = `
    ${serverMode() && acc.isOwner && _wb ? `<button class="btn btn-primary" id="msShare" style="padding:5px 12px;gap:6px">${icon('users', { size: 14 })}<span>Share</span></button>` : ''}
    <button class="ibtn" id="msSideBtn" title="Hide workbook panel">${icon('chevron-left', { size: 16 })}</button>`;
  actions.querySelector('#msSideBtn')?.addEventListener('click', () => toggleSidebar());
  actions.querySelector('#msShare')?.addEventListener('click', () => openShare(_wb.id));
}

function openShare(wbId) {
  if (!serverMode()) { toast('Sharing needs a signed-in server session'); return; }
  const myWorkbooks = _srvList.filter((w) => w.role === 'owner').map((w) => ({ id: w.id, name: w.name }));
  const cur = _items.get(wbId);
  openShareDialog({
    store: _store, workbookId: wbId,
    workbookName: cur ? cur.wb.name : (_srvList.find((w) => w.id === wbId)?.name || wbId),
    myWorkbooks,
    onChanged: () => refreshServerList().then(renderSidebar),
  });
}

export const MonoSheets = {
  // Nothing in here may reject. mount() is what replaces the loading spinner,
  // so ANY throw on the way - workspace migration, foreign-workbook wiring,
  // the sidebar, the server list - left the app spinning for ever with no
  // error and no way in. Guarding the workbook loop was not enough: the throw
  // can happen either side of it.
  async mount() {
    try {
      await MonoSheets._mount();
    } catch (err) {
      console.error('[mono] mount failed', err);
      showMountFailure(err);
    }
  },

  async _mount() {
    _settings = loadSettings();
    // Signed in ⇒ data lives on the server under the account (sharing, roles
    // and concurrency need one source of truth). Local mode remains only for
    // the offline/dev build with auth unreachable.
    if (Auth.user && _settings.dataHome !== 'server') {
      _settings.dataHome = 'server'; _settings.serverUrl = '';
      saveSettings(_settings);
    }
    _store = getStore(_settings);
    paintTopbarActions();
    const main = document.getElementById('main');
    if (main) main.innerHTML = `<div class="center"><div style="text-align:center"><div class="spin"></div><p class="muted" style="margin-top:14px">Loading workbook…</p></div></div>`;
    // Phase A/G — workspace index + one-time migration of the legacy
    // 'default' slot and single sync config. No user action, no data loss.
    const ws = await ensureWorkspace(_settings, _store, saveSettings);
    _items.clear();
    for (const id of [...ws.order]) {
      let json = null; try { json = await _store.load(id); } catch {}
      if (json && json.__denied) { ws.order = ws.order.filter((x) => x !== id); continue; }
      if (!json && serverMode()) {
        // First sign-in on a browser that has local workbooks: move them up
        // to the account (one-time, per workbook).
        try {
          const local = await new LocalStore().load(id);
          if (local) { const res = await _store.save(id, local); if (res && res.ok) json = local; }
        } catch {}
      }
      if (!json || !openStored(id, json, { serverIsUpToDate: true })) ws.order = ws.order.filter((x) => x !== id);
    }
    // Fresh browser but the account already owns workbooks → open those
    // instead of seeding a demo one.
    if (!_items.size && serverMode()) {
      await refreshServerList();
      for (const w of _srvList.filter((x) => x.role === 'owner').slice(0, 4)) {
        const json = await _store.load(w.id);
        if (json && !json.__denied && openStored(w.id, json, { serverIsUpToDate: true })) ws.order.push(w.id);
      }
      if (ws.order.length && !ws.activeWorkbookId) ws.activeWorkbookId = ws.order[0];
    }
    if (!_items.size && _broken.size) {
      // Some workbooks EXIST but none would open. Seeding a blank one here
      // would look like the account's data had vanished.
      saveSettings(_settings);
      showOpenFailure();
      return;
    }
    if (!_items.size) {
      const wb = seed();
      openItem(wb);
      ws.order = [wb.id]; ws.activeWorkbookId = wb.id;
      try { await _store.save(wb.id, wb.toJSON()); } catch {}
    }
    if (!ws.activeWorkbookId || !_items.has(ws.activeWorkbookId)) ws.activeWorkbookId = ws.order[0];
    saveSettings(_settings);
    wireForeign();      // Phase D: every open workbook is IMPORTRANGE-able from the others
    build(); setupAuto(); setSaved('All changes saved');
    if (_broken.size) toast(`${_broken.size} workbook(s) could not be opened — see the console for details`, 6000);
    applySidebarHidden();
    refreshServerList().then(() => { renderSidebar(); paintTopbarActions(); });
    if (!MonoSheets._renameBound) {
      window.addEventListener('mono:renameWorkspace', (e) => { if (_grid) renameWorkspace(e.detail && e.detail.name); });
      // Session came back after expiry → push the save that was held (§2.3)
      window.addEventListener('mono:reauthed', () => { if (_pendingSave != null) flushSave(); });
      // P22: keyboard chord "open settings" (grid.js) — msGear is gone, open directly
      window.addEventListener('mono:openSettings', () => { if (_wb && accessFor(_wb.id).isOwner) openSettings(ctx()); });
      MonoSheets._renameBound = true;
    }
  },
  unmount() {
    try { _grid?.commitIfEditing?.(); } catch {}
    try { flushNow(); } catch {}
    for (const t of _autoTimers.values()) clearInterval(t);
    _autoTimers.clear();
    // Dashboard shares the #sidebar element — never leave it hidden.
    document.getElementById('sidebar')?.classList.remove('ms-hidden');
    document.getElementById('sbReopenTab')?.classList.remove('is-visible');
    document.getElementById('sbCornerToggle')?.classList.remove('is-visible');
    _grid = null; unmountFab();
  },
  focusSheet(sheetId) {
    if (!sheetId) return;
    if (_wb && _wb.sheets.some((s) => s.id === sheetId)) { _grid?.onTab(sheetId); return; }
    // The sheet may live in a non-active workbook — switch to it.
    for (const [wbId, it] of _items) if (it.wb.sheets.some((s) => s.id === sheetId)) { switchWorkbook(wbId, sheetId); return; }
  },
  currentName() { return _wb ? _wb.name : ''; },
};
export default MonoSheets;
