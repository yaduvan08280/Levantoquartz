// ============================================================
//  Workspace Shell
//  Owns Mode ('dashboard' | 'sheet'); mounts one mode into the
//  shared #main / #sidebar / #modeActions. Also owns the shared
//  top nav (U2): logo, mode switcher, workspace name (rename in
//  place), sync status, global search (command palette), settings,
//  account menu (sign out / invites) — the one place both modes pull
//  their global chrome from. The SPA mounts only after auth (v3).
// ============================================================
import { Dashboard, focusDashboardPage } from './app.js';
import { MonoSheets } from './mono/monoSheets.js';
import { icon } from './ui/icons.js';
import { showSyncStatus } from './ui/syncStatus.js';
import { monoEnabled } from './data/monoSource.js';
import { togglePalette } from './ui/commandPalette.js';
import { registerCommands } from './ui/commandRegistry.js';
import { initAuth, Auth, openAccountMenu } from './auth.js';

const KEY = 'mono.mode';
let mode = localStorage.getItem(KEY) || 'dashboard';
let _wsName = '';

function applyTheme() { document.body.dataset.theme = localStorage.getItem('theme') || 'light'; }

function paintToggle() {
  document.querySelectorAll('#modeToggle .seg').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.body.dataset.mode = mode;
  showSyncStatus(mode === 'sheet' || (mode === 'dashboard' && monoEnabled()));
}

function setWsNameText(name) { _wsName = name || 'Workspace'; const el = document.getElementById('wsNameText'); if (el) el.textContent = _wsName; }

function wireWsName(root) {
  const wrap = root.querySelector('#wsName');
  wrap.addEventListener('click', () => {
    if (wrap.querySelector('input')) return;
    const cur = _wsName;
    wrap.innerHTML = `<input id="wsNameInput" value="${cur.replace(/"/g, '&quot;')}" />`;
    const inp = wrap.querySelector('input'); inp.focus(); inp.select();
    const commit = () => {
      const v = inp.value.trim();
      wrap.innerHTML = `<span id="wsNameText">${_wsName}</span>`;
      if (v && v !== cur) window.dispatchEvent(new CustomEvent('mono:renameWorkspace', { detail: { name: v } }));
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); else if (e.key === 'Escape') { wrap.innerHTML = `<span id="wsNameText">${cur}</span>`; } });
    inp.addEventListener('blur', commit);
  });
}

function openGlobalGear(anchor) {
  document.getElementById('navGearPop')?.remove();
  const cur = localStorage.getItem('theme') || 'light';
  const el = document.createElement('div'); el.className = 'cmdbar-popover cmdbar-popover-right open'; el.id = 'navGearPop';
  el.style.position = 'fixed';
  const r = anchor.getBoundingClientRect(); el.style.top = (r.bottom + 6) + 'px'; el.style.right = (innerWidth - r.right) + 'px'; el.style.left = 'auto';
  el.innerHTML = `
    <div class="cmdbar-pop-heading">Appearance</div>
    <button class="cmdbar-pop-item" data-th="light">${icon('sun', { size: 14 })}<span>Light</span>${cur === 'light' ? icon('check', { size: 13 }) : ''}</button>
    <button class="cmdbar-pop-item" data-th="dark">${icon('moon', { size: 14 })}<span>Dark</span>${cur === 'dark' ? icon('check', { size: 13 }) : ''}</button>
    <div class="cmdbar-pop-sep"></div>
    <button class="cmdbar-pop-item" data-act="palette">${icon('search', { size: 14 })}<span>Command palette</span><span class="cmdbar-kbd">Ctrl/⌘ K</span></button>`;
  document.body.appendChild(el);
  el.querySelectorAll('[data-th]').forEach((b) => b.addEventListener('click', () => {
    localStorage.setItem('theme', b.dataset.th); document.body.dataset.theme = b.dataset.th;
    el.remove();
  }));
  el.querySelector('[data-act="palette"]').addEventListener('click', () => { el.remove(); togglePalette(); });
  setTimeout(() => document.addEventListener('mousedown', function h(ev) { if (!el.contains(ev.target) && ev.target !== anchor) { el.remove(); document.removeEventListener('mousedown', h); } }), 0);
}

function renderTopbar() {
  const top = document.getElementById('topbar'); if (!top) return;
  top.innerHTML = `
    <div class="brand"><div class="logo">M</div><div class="brand-name">MONO AI</div></div>
    <div class="ws-switcher" id="modeToggle" title="Switch mode (Ctrl/Cmd+Shift+M)">
      <button class="seg" data-mode="dashboard">${icon('layout-dashboard', { size: 13 })}<span>Dashboard</span></button>
      <button class="seg" data-mode="sheet">${icon('sheet', { size: 13 })}<span>Sheets</span></button>
    </div>
    <div class="ws-name" id="wsName" title="Click to rename this workspace"><span id="wsNameText">${_wsName || 'Workspace'}</span></div>
    <div class="spacer"></div>
    <button class="ibtn" id="navSearch" title="Search everything (Ctrl/Cmd+K)">${icon('search', { size: 16 })}</button>
    <div class="sync-status" id="syncStatus"><span class="sync-dot" id="syncDot"></span><span id="syncLabel">All changes saved</span></div>
    <div class="actions" id="modeActions"></div>
    <button class="ibtn" id="navGear" title="Settings">${icon('settings', { size: 16 })}</button>
    <div class="avatar" id="navAvatar" title="Account — ${(Auth.user && Auth.user.username) || ''}" role="button" tabindex="0">${icon('user', { size: 15 })}</div>`;
  top.querySelectorAll('#modeToggle .seg').forEach((b) => b.addEventListener('click', () => enter(b.dataset.mode)));
  top.querySelector('#navSearch').addEventListener('click', () => togglePalette());
  top.querySelector('#navGear').addEventListener('click', (e) => openGlobalGear(e.currentTarget));
  top.querySelector('#navAvatar').addEventListener('click', (e) => openAccountMenu(e.currentTarget));
  wireWsName(top);
}

async function enter(next) {
  if (next === mode && document.body.dataset.mode) return;
  mode = next; localStorage.setItem(KEY, mode); paintToggle();
  if (mode === 'sheet') { Dashboard.hide(); await MonoSheets.mount(); }
  else { MonoSheets.unmount(); await Dashboard.boot(); }
}

function registerShellCommands() {
  registerCommands('Mono', [
    { id: 'goto:dashboard', label: 'Go to Dashboard', icon: 'layout-dashboard', kbd: 'Ctrl+Shift+M', run: () => enter('dashboard') },
    { id: 'goto:sheets', label: 'Go to Sheets', icon: 'sheet', kbd: 'Ctrl+Shift+M', run: () => enter('sheet') },
    { id: 'toggle:theme', label: 'Toggle light / dark theme', icon: 'sun', run: () => { const t = (localStorage.getItem('theme') || 'light') === 'dark' ? 'light' : 'dark'; localStorage.setItem('theme', t); document.body.dataset.theme = t; } },
  ]);
}

async function init() {
  applyTheme();
  await initAuth();                       // pre-app gate (UI plan §2.1) — SPA mounts only when signed in
  renderTopbar(); paintToggle(); registerShellCommands();
  window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); enter(mode === 'dashboard' ? 'sheet' : 'dashboard'); } });
  window.addEventListener('mono:useInDashboard', async () => { await enter('dashboard'); try { if (window.App && window.App.refresh) window.App.refresh(); } catch {} });
  // U4: cross-mode collaboration — Sheets' "Feeds Dashboard" badge and
  // Dashboard's "Source: [Sheet] ↗" chip both round-trip through here so
  // neither mode needs to import the other directly.
  window.addEventListener('mono:openSheet', async (e) => { const sheetId = e.detail && e.detail.sheetId; await enter('sheet'); if (sheetId) MonoSheets.focusSheet(sheetId); });
  window.addEventListener('mono:openDashboardPage', async (e) => { await enter('dashboard'); if (e.detail && e.detail.pageId) focusDashboardPage(e.detail.pageId); });
  window.addEventListener('mono:workspaceName', (e) => setWsNameText(e.detail && e.detail.name));
  if (mode === 'sheet') MonoSheets.mount(); else Dashboard.boot();
}
init();
