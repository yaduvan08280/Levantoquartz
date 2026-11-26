// ============================================================
//  Mono — View Editor panel  (P9, extended by Views v3)
//
//  Right-side drawer for editing a ViewSpec: rename, filters,
//  sorts, delete — plus kind-specific settings:
//    kanban   → group by · order column · WIP limit
//    calendar → date / end / title columns
//    gallery  → cover / title columns · card size
//    form     → title · description · submit label ·
//               exposed fields + required flags
//
//  Usage:  import { panel } from './viewEditor.js';
//          panel.open(grid, spec);
// ============================================================
import { openPanel, panelBodyEl } from '../../ui/panel.js';
import { icon } from '../../ui/icons.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Columns as {value, label} — value is the header name when present, else the index. */
function columnOptions(sh) {
  const out = [];
  if (!sh) return out;
  let maxC = 0;
  for (const key of sh.cells.keys()) { const c = +key.split(',')[1]; if (c + 1 > maxC) maxC = c + 1; }
  for (let c = 0; c < Math.max(maxC, 1); c++) {
    const raw = sh.getRaw(0, c);
    out.push({ value: raw !== '' ? raw : c, label: raw !== '' ? raw : `Column ${c + 1}` });
  }
  return out;
}

function sel(id, cols, current, { allowNone = true, noneLabel = '— none —' } = {}) {
  return `<select class="vep-select" id="${id}">
    ${allowNone ? `<option value="">${escH(noneLabel)}</option>` : ''}
    ${cols.map((o) => `<option value="${escH(o.value)}"${String(o.value) === String(current ?? '') ? ' selected' : ''}>${escH(o.label)}</option>`).join('')}
  </select>`;
}

function kindSectionHTML(spec, cols) {
  const cfg = spec.config || {};
  switch (spec.kind) {
    case 'kanban': return `
      <div class="vep-kind-title">Kanban</div>
      <label class="vep-label">Group by (lanes)</label>
      ${sel('vepKGroup', cols, cfg.groupBy, { allowNone: false })}
      <label class="vep-label">Manual order column <small>(numeric ranks — enables card reordering)</small></label>
      ${sel('vepKOrder', cols, cfg.orderBy)}
      <label class="vep-label">WIP limit per lane <small>(blank = none)</small></label>
      <input class="vep-input" id="vepKWip" type="number" min="1" value="${cfg.wipLimit || ''}" />`;
    case 'calendar': return `
      <div class="vep-kind-title">Calendar</div>
      <label class="vep-label">Date column</label>
      ${sel('vepCDate', cols, cfg.dateField ?? cfg.startField, { allowNone: false })}
      <label class="vep-label">End date column <small>(multi-day events)</small></label>
      ${sel('vepCEnd', cols, cfg.endField)}
      <label class="vep-label">Title column</label>
      ${sel('vepCTitle', cols, cfg.titleField)}`;
    case 'gallery': return `
      <div class="vep-kind-title">Gallery</div>
      <label class="vep-label">Cover column <small>(image URLs)</small></label>
      ${sel('vepGCover', cols, cfg.coverField)}
      <label class="vep-label">Title column</label>
      ${sel('vepGTitle', cols, cfg.titleField)}
      <label class="vep-label">Card size</label>
      <select class="vep-select" id="vepGSize">
        ${['s', 'm', 'l'].map((s) => `<option value="${s}"${(cfg.cardSize || 'm') === s ? ' selected' : ''}>${{ s: 'Small', m: 'Medium', l: 'Large' }[s]}</option>`).join('')}
      </select>`;
    case 'form': {
      const exposed = new Set((cfg.fields && cfg.fields.length ? cfg.fields : cols.map((o) => o.value)).map(String));
      const req = new Set((cfg.required || []).map(String));
      return `
      <div class="vep-kind-title">Form</div>
      <label class="vep-label">Form title</label>
      <input class="vep-input" id="vepFTitle" value="${escH(cfg.title || '')}" placeholder="${escH(spec.name)}" />
      <label class="vep-label">Description</label>
      <input class="vep-input" id="vepFDesc" value="${escH(cfg.description || '')}" />
      <label class="vep-label">Submit button label</label>
      <input class="vep-input" id="vepFSubmit" value="${escH(cfg.submitLabel || '')}" placeholder="Submit" />
      <label class="vep-label">Fields <small>(shown · required)</small></label>
      <div class="vep-fields">
        ${cols.map((o) => `
          <div class="vep-field-row">
            <label><input type="checkbox" class="vepFShow" data-col="${escH(o.value)}"${exposed.has(String(o.value)) ? ' checked' : ''}> ${escH(o.label)}</label>
            <label class="vep-req"><input type="checkbox" class="vepFReq" data-col="${escH(o.value)}"${req.has(String(o.value)) ? ' checked' : ''}> req</label>
          </div>`).join('')}
      </div>`;
    }
    default: return '';
  }
}

function buildHTML(spec, sh) {
  const cfg = spec.config || {};
  const filters = cfg.filters || [];
  const sorts = cfg.sorts || [];
  const cols = columnOptions(sh);

  return `
    <div class="vep">
      <label class="vep-label">Name</label>
      <input class="vep-input" id="vepName" value="${escH(spec.name)}" />

      ${kindSectionHTML(spec, cols)}

      <label class="vep-label">Filters <small>(${filters.length})</small></label>
      <div id="vepFilters" class="vep-filters">
        ${filters.length
          ? filters.map((f, i) => `
            <div class="vep-filter-row">
              <span>${escH(String(f.colId))} ${escH(f.op)} ${escH(String(f.value ?? ''))}</span>
              <button class="vep-del" data-fi="${i}" title="Remove">${icon('x', { size: 11 })}</button>
            </div>`).join('')
          : '<span class="vep-empty">No filters</span>'}
      </div>

      <label class="vep-label">Sorts <small>(${sorts.length})</small></label>
      <div id="vepSorts" class="vep-sorts">
        ${sorts.length
          ? sorts.map((s, i) => `
            <div class="vep-sort-row">
              <span>${escH(String(s.colId))} ${s.dir === 'asc' ? '↑' : '↓'}</span>
              <button class="vep-dels" data-si="${i}" title="Remove">${icon('x', { size: 11 })}</button>
            </div>`).join('')
          : '<span class="vep-empty">No sorts</span>'}
      </div>

      <div class="vep-footer">
        <button class="ms-btn ms-btn-primary" id="vepSave">Save</button>
        <button class="ms-btn ms-btn-danger" id="vepDelete">Delete view</button>
      </div>
    </div>`;
}

/** '' → null; numeric strings back to numbers so resolveField treats them as indices */
function readSel(body, id) {
  const v = body.querySelector(id)?.value;
  if (v == null || v === '') return null;
  return /^\d+$/.test(v) ? +v : v;
}

function wirePanel(grid, spec, rebuildFn) {
  const body = panelBodyEl();
  if (!body) return;

  body.querySelector('#vepSave')?.addEventListener('click', () => {
    const newName = body.querySelector('#vepName')?.value?.trim();
    if (!newName) return;
    spec.name = newName;
    const cfg = spec.config || (spec.config = {});
    switch (spec.kind) {
      case 'kanban': {
        cfg.groupBy = readSel(body, '#vepKGroup');
        cfg.orderBy = readSel(body, '#vepKOrder');
        const w = parseInt(body.querySelector('#vepKWip')?.value, 10);
        cfg.wipLimit = w > 0 ? w : null;
        break;
      }
      case 'calendar':
        cfg.dateField = readSel(body, '#vepCDate');
        cfg.endField = readSel(body, '#vepCEnd');
        cfg.titleField = readSel(body, '#vepCTitle');
        break;
      case 'gallery':
        cfg.coverField = readSel(body, '#vepGCover');
        cfg.titleField = readSel(body, '#vepGTitle');
        cfg.cardSize = body.querySelector('#vepGSize')?.value || 'm';
        break;
      case 'form': {
        cfg.title = body.querySelector('#vepFTitle')?.value?.trim() || null;
        cfg.description = body.querySelector('#vepFDesc')?.value?.trim() || null;
        cfg.submitLabel = body.querySelector('#vepFSubmit')?.value?.trim() || null;
        const parse = (v) => (/^\d+$/.test(v) ? +v : v);
        cfg.fields = [...body.querySelectorAll('.vepFShow:checked')].map((el) => parse(el.dataset.col));
        cfg.required = [...body.querySelectorAll('.vepFReq:checked')].map((el) => parse(el.dataset.col))
          .filter((c) => cfg.fields.some((f) => String(f) === String(c)));
        break;
      }
    }
    grid.save();
    grid.render();
  });

  body.querySelector('#vepDelete')?.addEventListener('click', () => {
    const sh = grid.sheet();
    sh.views = (sh.views || []).filter((v) => v.id !== spec.id);
    grid.save();
    grid.switchToViewKind('grid', null);
  });

  body.querySelectorAll('.vep-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fi = +btn.dataset.fi;
      if (!spec.config) spec.config = {};
      spec.config.filters.splice(fi, 1);
      rebuildFn();
    });
  });

  body.querySelectorAll('.vep-dels').forEach((btn) => {
    btn.addEventListener('click', () => {
      const si = +btn.dataset.si;
      if (!spec.config) spec.config = {};
      spec.config.sorts.splice(si, 1);
      rebuildFn();
    });
  });
}

export const panel = {
  open(grid, spec) {
    const sh = grid.sheet();
    const rebuild = () => {
      const body = panelBodyEl();
      if (body) { body.innerHTML = buildHTML(spec, sh); wirePanel(grid, spec, rebuild); }
    };

    openPanel({
      title: 'Edit view',
      width: 340,
      body: buildHTML(spec, sh),
      onClose: () => {},
    });

    wirePanel(grid, spec, rebuild);
  },
};
