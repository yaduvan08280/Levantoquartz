// ============================================================
//  Mono — Gallery view renderer  (Views v3)
//
//  Design: MONO_VIEWS_LOGIC_V3.md §4.3
//  · CLS = 0 by construction: every card reserves a fixed 4:3
//    cover box BEFORE any image loads; onerror swaps content
//    inside the same box (INV-GAL-1) — deterministic pastel +
//    initial fallback, no broken-image icons, no layout shift
//  · Cover column auto-detected once (first column whose sample
//    values look like image URLs), then persisted to config
//  · In-view toolbar: live search, card size S/M/L, cover select
//  · Click → quick-view modal: big cover + every field editable,
//    Save as one batch, Delete, Open in grid (rowId-resolved)
// ============================================================
import { registerViewKind } from '../registry.js';
import { icon } from '../../../ui/icons.js';
import { toast } from '../../../ui/toast.js';
import { escH, resolveField, hashColor, hashColorInk, isImageUrl, isUrl, viewModal } from '../viewUtils.js';

const SIZES = { s: 160, m: 210, l: 280 };

export function render(host, mount) {
  const mv = host.materialized;
  const spec = host.spec;
  if (!mv || !spec) { mount.innerHTML = '<div class="gv-empty">No data</div>'; return; }
  const cfg = spec.config || (spec.config = {});
  const { headers, rows, colIndices } = mv;
  const st = host.viewState(spec.id);
  const label = (i) => headers[i] || `Column ${i + 1}`;

  // ── Cover auto-detection (once): first column that looks like image URLs ──
  let cIdx = resolveField(cfg.coverField, headers, null);
  if (cfg.coverField === undefined) {
    for (let i = 0; i < headers.length && cIdx == null; i++) {
      let seen = 0, hits = 0;
      for (const r of rows) { const v = r.cells[i]; if (v == null || v === '') continue; seen++; if (isImageUrl(String(v))) hits++; if (seen >= 12) break; }
      if (seen && hits / seen >= 0.5) cIdx = i;
    }
    cfg.coverField = cIdx == null ? null : (headers[cIdx] || cIdx);   // persist the decision (null = "no cover")
  }
  const tIdx = resolveField(cfg.titleField, headers, headers.map((_, i) => i).find((i) => i !== cIdx) ?? 0);
  const bodyFields = headers.map((_, i) => i).filter((i) => i !== tIdx && i !== cIdx).slice(0, 4);

  const size = SIZES[cfg.cardSize] ? cfg.cardSize : 'm';
  const q = String(st.search || '').toLowerCase();
  const visible = q
    ? rows.filter((r) => r.cells.some((v) => String(v ?? '').toLowerCase().includes(q)))
    : rows;

  const coverHTML = (row) => {
    const title = String(row.cells[tIdx] ?? '');
    const initial = (title.trim()[0] || '?').toUpperCase();
    const fallback = `<div class="gv-fallback" style="background:${hashColor(title)};color:${hashColorInk(title)}">${escH(initial)}</div>`;
    if (cIdx == null) return `<div class="gv-cover">${fallback}</div>`;
    const v = row.cells[cIdx];
    if (isImageUrl(String(v ?? ''))) {
      // Box is reserved by CSS aspect-ratio; the img fades in, errors swap to fallback in-place.
      return `<div class="gv-cover">${fallback}<img src="${escH(String(v))}" alt="" loading="lazy" class="gv-img" onerror="this.remove()" onload="this.classList.add('gv-loaded')"></div>`;
    }
    if (isUrl(String(v ?? ''))) return `<div class="gv-cover">${fallback}<span class="gv-linkchip">${icon('link', { size: 11 })} link</span></div>`;
    if (v != null && v !== '') return `<div class="gv-cover gv-cover-text" style="background:${hashColor(String(v))};color:${hashColorInk(String(v))}">${escH(String(v))}</div>`;
    return `<div class="gv-cover">${fallback}</div>`;
  };

  mount.innerHTML = `
    <div class="gv" id="gvRoot">
      <div class="vw-toolbar">
        <input class="vw-toolbar-input" id="gvSearch" placeholder="Search cards…" value="${escH(st.search || '')}" />
        <span class="vw-toolbar-label">Cover</span>
        <select class="vw-toolbar-select" id="gvCoverSel">
          <option value=""${cIdx == null ? ' selected' : ''}>— none —</option>
          ${headers.map((h, i) => `<option value="${i}"${i === cIdx ? ' selected' : ''}>${escH(label(i))}</option>`).join('')}
        </select>
        <span class="vw-toolbar-label">Size</span>
        <select class="vw-toolbar-select" id="gvSizeSel">
          ${['s', 'm', 'l'].map((s) => `<option value="${s}"${s === size ? ' selected' : ''}>${{ s: 'Small', m: 'Medium', l: 'Large' }[s]}</option>`).join('')}
        </select>
        <span class="vw-toolbar-note">${visible.length}${q ? ' of ' + rows.length : ''} card${visible.length === 1 ? '' : 's'}</span>
      </div>
      <div class="gv-grid" style="grid-template-columns:repeat(auto-fill,minmax(${SIZES[size]}px,1fr))">
        ${visible.map((row) => `
          <div class="gv-card" data-rowid="${escH(row.rowId)}">
            ${coverHTML(row)}
            <div class="gv-card-body">
              <div class="gv-card-title">${escH(String(row.cells[tIdx] ?? '')) || '<i>Untitled</i>'}</div>
              ${bodyFields.map((f) => {
                const v = row.cells[f];
                if (v == null || v === '') return '';
                return `<div class="gv-field"><span class="gv-field-label">${escH(label(f))}</span><span class="gv-field-value">${escH(String(v))}</span></div>`;
              }).join('')}
            </div>
          </div>`).join('')}
        ${!visible.length ? `<div class="gv-empty">${q ? 'No cards match your search' : 'No rows yet — add data in the grid'}</div>` : ''}
      </div>
    </div>`;

  // ── Toolbar ──
  const search = mount.querySelector('#gvSearch');
  search?.addEventListener('input', () => { st.search = search.value; render(host, mount); const s2 = mount.querySelector('#gvSearch'); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); });
  mount.querySelector('#gvCoverSel')?.addEventListener('change', (e) => {
    const v = e.target.value;
    cfg.coverField = v === '' ? null : (headers[+v] || +v);
    host.saveSpec();
  });
  mount.querySelector('#gvSizeSel')?.addEventListener('change', (e) => { cfg.cardSize = e.target.value; host.saveSpec(); });

  // ── Quick view (editable) ──
  const sh = host.wb.sheets.find((s) => s.id === host.sheetId);
  mount.querySelectorAll('.gv-card').forEach((card) => card.addEventListener('click', () => {
    const rowId = card.dataset.rowid;
    const r = host.rowIndexById(rowId);
    if (r == null) { toast('That row no longer exists'); return; }
    const coverBox = card.querySelector('.gv-cover')?.cloneNode(true);
    const m = viewModal(`
      <div class="gv-qv">
        <div class="gv-qv-cover"></div>
        <div class="gv-qv-fields">
          ${headers.map((_, i) => `<label class="vw-pop-label">${escH(label(i))}<input class="vw-pop-input" data-qv="${colIndices[i]}" value="${escH(sh.getRaw(r, colIndices[i]))}" /></label>`).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="gvQvOpen">Open in grid</button>
        <button class="btn btn-ghost" id="gvQvDel">Delete</button>
        <button class="btn btn-ghost" id="gvQvClose">Cancel</button>
        <button class="btn btn-primary" id="gvQvSave">Save</button>
      </div>`);
    if (coverBox) m.querySelector('.gv-qv-cover').appendChild(coverBox);
    m.querySelector('#gvQvClose').onclick = () => m.remove();
    m.querySelector('#gvQvSave').onclick = () => {
      const rr = host.rowIndexById(rowId);
      if (rr == null) { m.remove(); toast('That row no longer exists'); return; }
      const cells = [];
      m.querySelectorAll('[data-qv]').forEach((inp) => {
        const phys = +inp.dataset.qv;
        if (inp.value !== sh.getRaw(rr, phys)) cells.push({ r: rr, c: phys, raw: inp.value });
      });
      m.remove();
      if (cells.length) host.applyEdit({ type: 'batch', cells });
    };
    m.querySelector('#gvQvDel').onclick = () => {
      const rr = host.rowIndexById(rowId);
      m.remove();
      if (rr != null) host.applyEdit({ type: 'deleteRow', r: rr });
    };
    m.querySelector('#gvQvOpen').onclick = () => {
      const rr = host.rowIndexById(rowId);
      m.remove();
      if (rr != null) host.openRowInGrid(rr);
    };
  }));
}

export function commandBarConfig(_spec) { return null; }

registerViewKind({ kind: 'gallery', label: 'Gallery', icon: 'image', render, commandBarConfig });
