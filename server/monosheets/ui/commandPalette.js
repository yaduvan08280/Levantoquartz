// ============================================================
//  Mono — command palette (U6 capstone, Ctrl/Cmd+K)
//  A searchable overlay (fuzzy-match) listing every command-bar
//  action, every sheet, every dashboard page, and every mode
//  switch — the fastest way to do anything without touching the
//  mouse. Reuses the shared command registry (ui/commandRegistry.js)
//  that commandBar.js instances register into.
// ============================================================
import { getCommands, runCommand } from './commandRegistry.js';
import { icon } from './icons.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// simple subsequence fuzzy match — good enough for short command labels,
// no dependency needed.
function fuzzyScore(q, text) {
  q = q.toLowerCase(); text = text.toLowerCase();
  if (!q) return 1;
  if (text.includes(q)) return 100 - text.indexOf(q); // prefer earlier/contiguous matches
  let ti = 0, score = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = text.indexOf(q[qi], ti);
    if (idx === -1) return -1;
    score += 1 - (idx - ti) * 0.02;
    ti = idx + 1;
  }
  return score;
}

let _active = -1, _filtered = [], _overlay = null;

function render(query) {
  const all = getCommands();
  _filtered = all
    .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.label), fuzzyScore(query, (c.keywords || '') + ' ' + c.group)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map((x) => x.c);
  _active = _filtered.length ? 0 : -1;
  paintList();
}
function paintList() {
  const list = _overlay.querySelector('#cmdkList');
  if (!_filtered.length) { list.innerHTML = '<div class="cmdk-empty">No matching commands</div>'; return; }
  list.innerHTML = _filtered.map((c, i) => `<div class="cmdk-item ${i === _active ? 'active' : ''}" data-i="${i}">${c.icon ? icon(c.icon, { size: 16 }) : ''}<span>${escH(c.label)}</span>${c.kbd ? `<span class="cmdbar-kbd">${escH(c.kbd)}</span>` : ''}<span class="cmdk-group">${escH(c.group)}</span></div>`).join('');
  list.querySelectorAll('.cmdk-item').forEach((el) => {
    el.addEventListener('mouseenter', () => { _active = +el.dataset.i; paintActive(); });
    el.addEventListener('click', () => pick(+el.dataset.i));
  });
  list.querySelector('.cmdk-item.active')?.scrollIntoView({ block: 'nearest' });
}
function paintActive() { _overlay.querySelectorAll('.cmdk-item').forEach((el) => el.classList.toggle('active', +el.dataset.i === _active)); _overlay.querySelector('.cmdk-item.active')?.scrollIntoView({ block: 'nearest' }); }
function pick(i) { const c = _filtered[i]; if (!c) return; close(); runCommand(c.id); }

export function openPalette() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'cmdk-overlay';
  _overlay.innerHTML = `<div class="cmdk" role="dialog" aria-label="Command palette">
    <div class="cmdk-input">${icon('search', { size: 16 })}<input id="cmdkInput" placeholder="Type a command, sheet, or page…" autocomplete="off" /><span class="cmdk-hint">Esc</span></div>
    <div class="cmdk-list" id="cmdkList"></div>
  </div>`;
  document.body.appendChild(_overlay);
  requestAnimationFrame(() => _overlay.classList.add('open'));
  const input = _overlay.querySelector('#cmdkInput');
  render('');
  input.focus();
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); _active = Math.min(_active + 1, _filtered.length - 1); paintActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _active = Math.max(_active - 1, 0); paintActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(_active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  _overlay.addEventListener('mousedown', (e) => { if (e.target === _overlay) close(); });
}
function close() { if (!_overlay) return; _overlay.classList.remove('open'); const el = _overlay; _overlay = null; setTimeout(() => el.remove(), 160); }
export function togglePalette() { if (_overlay) close(); else openPalette(); }
export function isPaletteOpen() { return !!_overlay; }

if (typeof window !== 'undefined' && !window.__monoCmdkBound) {
  window.__monoCmdkBound = true;
  window.addEventListener('keydown', (e) => {
    // Google Sheets maps Ctrl+K to "Insert link" inside the grid, so the
    // command palette instead follows Help → Search the menus [Alt+/],
    // with Ctrl/Cmd+K kept as a courtesy alias anywhere the grid itself
    // isn't the one handling it (grid.js intercepts+stops it for links).
    if (e.altKey && e.key === '/') { e.preventDefault(); togglePalette(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); togglePalette(); }
  });
}

export default { openPalette, togglePalette, isPaletteOpen };
