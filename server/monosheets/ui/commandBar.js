// ============================================================
//  Mono — reusable command-bar shell (U1 foundation)
//  One component: left icon-button cluster, optional center slot
//  (search/formula input), right icon-button cluster, one
//  collapsible overflow (⋯) menu. Every toolbar in the app is an
//  *instance* of this component with a different button set —
//  never a hand-rolled `<div class="...toolbar...">`.
//
//  Item shapes (used in `left`/`right` arrays and popover `items`):
//    'sep'                                  — visual separator
//    { cmd, icon, title, label? }            — plain button, dispatches data-cmd
//    { split:true, id, icon, label?, title?, items:[...] } — button that
//      opens a popover containing more buttons (also `data-cmd`)
//    { html }                               — escape hatch for bespoke markup
//
//  `overflow`: array of { section?:string, items:[...] } OR flat item array.
//
//  Command dispatch is generic: anything rendered by this module gets
//  `data-cmd="<id>"`; the caller wires clicks once via `wireCommandBar`.
// ============================================================
import { icon } from './icons.js';

const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function btnHTML(it, extraClass = '') {
  if (it === 'sep') return '<span class="cmdbar-sep"></span>';
  if (it.html != null) return it.html;
  if (it.split) {
    const popId = it.id || it.cmd || Math.random().toString(36).slice(2, 8);
    return `<div class="cmdbar-split">
      <button type="button" class="cmdbar-btn cmdbar-split-main ${extraClass}" data-pop="${popId}" title="${escAttr(it.title || it.label || '')}">
        ${icon(it.icon, { size: 16 })}${it.label ? `<span class="cmdbar-label">${escH(it.label)}</span>` : ''}${icon('chevron-down', { size: 11, className: 'cmdbar-caret' })}
      </button>
      <div class="cmdbar-popover" id="pop-${popId}" data-popover>${(it.items || []).map((sub) => popItemHTML(sub)).join('')}</div>
    </div>`;
  }
  return `<button type="button" class="cmdbar-btn ${it.on ? 'on' : ''} ${extraClass}" data-cmd="${escAttr(it.cmd)}" title="${escAttr(it.title || it.label || '')}">${icon(it.icon, { size: 16 })}${it.label ? `<span class="cmdbar-label">${escH(it.label)}</span>` : ''}</button>`;
}
// Menu-inside-a-menu support: an item with `items` (no `cmd`) is a submenu
// trigger — Google Sheets' "Paste special ▸", "Delete ▸", etc. Opens a
// second-level flyout to the side of the trigger instead of a flat list.
let _subSeq = 0;
function popItemHTML(it) {
  if (it === 'sep') return '<div class="cmdbar-pop-sep"></div>';
  if (it.html != null) return it.html;
  if (it.items) {
    const subId = 'sub' + (_subSeq++);
    return `<div class="cmdbar-pop-sub" data-subwrap>
      <button type="button" class="cmdbar-pop-item cmdbar-pop-sub-trigger" data-subtrigger="${subId}">${it.icon ? icon(it.icon, { size: 15 }) : ''}<span>${escH(it.label)}</span>${icon('chevron-right', { size: 12, className: 'cmdbar-subcaret' })}</button>
      <div class="cmdbar-popover cmdbar-subpopover" data-subpop="${subId}">${it.items.map((sub) => popItemHTML(sub)).join('')}</div>
    </div>`;
  }
  return `<button type="button" class="cmdbar-pop-item" data-cmd="${escAttr(it.cmd)}">${it.icon ? icon(it.icon, { size: 15 }) : ''}<span>${escH(it.label)}</span>${it.kbd ? `<span class="cmdbar-kbd">${escH(it.kbd)}</span>` : ''}</button>`;
}
function overflowHTML(overflow) {
  const sections = Array.isArray(overflow) && overflow.length && overflow[0] && overflow[0].items
    ? overflow
    : [{ items: overflow }];
  const body = sections.map((sec) => `${sec.section ? `<div class="cmdbar-pop-heading">${escH(sec.section)}</div>` : ''}${(sec.items || []).map((it) => popItemHTML(it)).join('')}`).join('<div class="cmdbar-pop-sep"></div>');
  return `<div class="cmdbar-split cmdbar-overflow">
    <button type="button" class="cmdbar-btn cmdbar-split-main" data-pop="overflow" title="More (overflow menu)">${icon('more-horizontal', { size: 16 })}</button>
    <div class="cmdbar-popover cmdbar-popover-right" id="pop-overflow" data-popover>${body}</div>
  </div>`;
}

/**
 * Render a full command bar. `center` is raw HTML (e.g. the formula-ref +
 * fx input markup) — passed through untouched so callers keep full control
 * of ids/behavior for anything already deeply wired (autocomplete, etc.).
 */
export function commandBarHTML({ left = [], right = [], center = '', overflow = [], spacer = true } = {}) {
  return `<div class="cmdbar" role="toolbar" aria-label="Command bar">
    <div class="cmdbar-group cmdbar-left">${left.map((it) => btnHTML(it)).join('')}</div>
    ${center ? `<div class="cmdbar-center">${center}</div>` : (spacer ? '<div class="cmdbar-spacer"></div>' : '')}
    <div class="cmdbar-group cmdbar-right">${right.map((it) => btnHTML(it)).join('')}${overflow && overflow.length ? overflowHTML(overflow) : ''}</div>
  </div>`;
}

function closeAllPopovers(root) {
  root.querySelectorAll('.cmdbar-popover.open').forEach((p) => { p.classList.remove('open'); p.style.top = p.style.left = p.style.right = ''; });
  root.querySelectorAll('.cmdbar-split-main.open').forEach((b) => b.classList.remove('open'));
  root.querySelectorAll('[data-subtrigger].open').forEach((b) => b.classList.remove('open'));
}

/**
 * Wire a rendered command bar: popover open/close + generic data-cmd
 * dispatch. Call once per render(); safe to call on any root containing
 * zero or more `.cmdbar` instances (e.g. a whole panel).
 * @param {HTMLElement} root
 * @param {(cmd:string, el:HTMLElement)=>void} onCommand
 */
export function wireCommandBar(root, onCommand) {
  root.querySelectorAll('.cmdbar-split-main[data-pop]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = document.getElementById('pop-' + btn.dataset.pop) || btn.parentElement.querySelector('[data-popover]');
      const wasOpen = pop && pop.classList.contains('open');
      closeAllPopovers(root);
      if (pop && !wasOpen) {
        pop.classList.add('open'); btn.classList.add('open');
        // The command bar itself scrolls horizontally at narrow widths
        // (overflow-x:auto), which clips any absolutely-positioned child —
        // that's the "options open inside a thin scrolling strip" bug.
        // Fix: position the popover with `fixed` coordinates computed from
        // the trigger button, so it floats freely over the grid instead of
        // being clipped by the bar's own scroll box.
        const r = btn.getBoundingClientRect();
        const alignRight = pop.classList.contains('cmdbar-popover-right');
        pop.style.top = (r.bottom + 5) + 'px';
        if (alignRight) {
          pop.style.right = Math.max(8, innerWidth - r.right) + 'px';
          pop.style.left = 'auto';
        } else {
          const maxLeft = innerWidth - pop.offsetWidth - 8;
          pop.style.left = Math.max(8, Math.min(r.left, maxLeft)) + 'px';
          pop.style.right = 'auto';
        }
      }
    });
  });
  // Menu-inside-a-menu: opening a submenu trigger inside an already-open
  // popover (Paste special ▸, Delete ▸, …) without closing that parent
  // popover — only its sibling subpops close.
  root.querySelectorAll('[data-subtrigger]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = btn.closest('[data-subwrap]');
      const sub = wrap && wrap.querySelector(':scope > [data-subpop]');
      if (!sub) return;
      const wasOpen = sub.classList.contains('open');
      const parentPop = btn.closest('.cmdbar-popover') || root;
      parentPop.querySelectorAll('[data-subpop].open').forEach((p) => { if (p !== sub) { p.classList.remove('open'); p.style.top = p.style.left = ''; } });
      parentPop.querySelectorAll('[data-subtrigger].open').forEach((b) => { if (b !== btn) b.classList.remove('open'); });
      if (wasOpen) { sub.classList.remove('open'); btn.classList.remove('open'); return; }
      sub.classList.add('open'); btn.classList.add('open');
      const r = btn.getBoundingClientRect();
      const subW = sub.offsetWidth || 200, subH = sub.offsetHeight || 100;
      let left = r.right + 2;
      if (left + subW > innerWidth - 8) left = Math.max(8, r.left - subW - 2);
      sub.style.left = left + 'px';
      sub.style.top = Math.max(8, Math.min(r.top, innerHeight - subH - 8)) + 'px';
    });
  });
  root.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllPopovers(root);
      if (onCommand) onCommand(btn.dataset.cmd, btn);
    });
  });
  if (!wireCommandBar._docBound) {
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.cmdbar-split') && !e.target.closest('.cmdbar-popover')) document.querySelectorAll('.cmdbar-popover.open').forEach((p) => p.classList.remove('open'));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.cmdbar-popover.open').forEach((p) => p.classList.remove('open')); });
    wireCommandBar._docBound = true;
  }
}

export default { commandBarHTML, wireCommandBar };
