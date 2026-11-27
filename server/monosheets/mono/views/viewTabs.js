// ============================================================
//  Mono — View Tabs strip  (P9)
//
//  Renders a tab strip showing all views for the active sheet.
//  A "Grid" default tab is always first (kind='grid', no spec).
//  Each entry in sh.views[] gets its own tab.
//  A "+" button opens the new-view kind selector.
// ============================================================
import { listViewKinds, getViewKind } from './registry.js';
import { icon } from '../../ui/icons.js';
import { panel } from './viewEditor.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Render the tab strip into `el`.
 * @param {MonoGrid} grid
 * @param {HTMLElement} el — #msViewTabs
 */
export function renderTabs(grid, el) {
  if (!el) return;
  const sh = grid.sheet();
  const views = sh.views || [];
  const activeSpec = grid.activeViewSpec;

  // Build tab HTML
  let html = '';

  // Default grid tab (no spec)
  const gridActive = activeSpec === null;
  html += `<button class="ms-vtab${gridActive ? ' active' : ''}" data-vtab="default" title="Default grid view">
    ${icon('grid', { size: 13 })}<span>Grid</span>
  </button>`;

  // User-defined views
  views.forEach((spec) => {
    const isActive = activeSpec && activeSpec.id === spec.id;
    const def = getViewKind(spec.kind);
    const ico = def ? icon(def.icon || 'layers', { size: 13 }) : '';
    html += `<button class="ms-vtab${isActive ? ' active' : ''}" data-vtab="${escH(spec.id)}" title="${escH(spec.name)}">
      ${ico}<span>${escH(spec.name)}</span>
    </button>`;
  });

  // Add-view button
  html += `<button class="ms-vtab ms-vtab-add" data-vtab-add title="Add view">${icon('plus', { size: 13 })}</button>`;

  el.innerHTML = html;

  // Wire tab clicks
  el.querySelectorAll('.ms-vtab:not(.ms-vtab-add)').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.vtab;
      if (id === 'default') {
        grid.switchToViewKind('grid', null);
      } else {
        const spec = views.find((v) => v.id === id);
        if (spec) grid.switchToViewKind(spec.kind, spec);
      }
    });
    // Right-click on user view → edit
    btn.addEventListener('contextmenu', (e) => {
      const id = btn.dataset.vtab;
      if (id === 'default') return;
      e.preventDefault();
      const spec = views.find((v) => v.id === id);
      if (spec) panel.open(grid, spec);
    });
  });

  // Wire add-view button
  el.querySelector('.ms-vtab-add')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddViewPopover(grid, el);
  });
}

// ── New-view kind selector popover ────────────────────────────────────────────

let _popoverEl = null;

function openAddViewPopover(grid, anchor) {
  closePopover();
  const kinds = listViewKinds().filter((k) => k.kind !== 'grid'); // grid is always present
  if (!kinds.length) return;

  const pop = document.createElement('div');
  pop.className = 'ms-vtab-popover';
  pop.innerHTML = `<div class="ms-vtab-popover-title">Add view</div>
    ${kinds.map((k) => `<button class="ms-vtab-popover-item" data-kind="${escH(k.kind)}">
      ${icon(k.icon || 'layers', { size: 14 })}<span>${escH(k.label)}</span>
    </button>`).join('')}`;

  // Position below the anchor
  const rect = anchor.getBoundingClientRect();
  pop.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:300`;
  document.body.appendChild(pop);
  _popoverEl = pop;

  pop.querySelectorAll('.ms-vtab-popover-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      closePopover();
      addView(grid, btn.dataset.kind);
    });
  });

  setTimeout(() => document.addEventListener('click', closePopover, { once: true }), 0);
}

function closePopover() {
  _popoverEl?.remove();
  _popoverEl = null;
}

function addView(grid, kind) {
  const sh = grid.sheet();
  if (!sh.views) sh.views = [];
  const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  const def = getViewKind(kind);
  const newSpec = {
    id,
    kind,
    name: def ? def.label : kind,
    config: { filters: [], sorts: [], groupBy: null, hiddenCols: [], rowHeight: 'medium' },
  };
  sh.views.push(newSpec);
  grid.save();
  grid.switchToViewKind(kind, newSpec);
}

/** Called by grid.command('viewsPanel') — opens the add-view picker anchored to #msViewTabs */
export function openAddView(grid, anchor) {
  if (!anchor) anchor = document.getElementById('msViewTabs');
  openAddViewPopover(grid, anchor || document.body);
}
