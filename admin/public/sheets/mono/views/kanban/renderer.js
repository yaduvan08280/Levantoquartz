// ============================================================
//  Mono — Kanban view renderer  (Views v3)
//
//  Design: MONO_VIEWS_LOGIC_V3.md §4.1
//  · Lanes = list-validation options ∪ data values ∪ "No value"
//    (empty lanes persist — INV-V3-3 style binding via setup card)
//  · Drag state machine: Idle → Lifting (6px threshold) → Dragging
//    with ghost + placeholder; Esc cancels; lane set fenced at lift
//  · A drop writes ONE group cell (+ ONE rank cell when an order
//    column is bound) — sibling cards never rewritten (INV-KAN-1)
//  · WIP limit: full lanes lock at gesture time (INV-KAN-2)
//  · All writes resolve rowId → physical row at drop time (INV-V3-1)
// ============================================================
import { registerViewKind } from '../registry.js';
import { icon } from '../../../ui/icons.js';
import { toast } from '../../../ui/toast.js';
import { escH, resolveField, listValidationFor, hashColor, hashColorInk, viewPopover } from '../viewUtils.js';

const BLANK = '__kvblank__';

export function render(host, mount) {
  const mv = host.materialized;
  const spec = host.spec;
  if (!mv || !spec) { mount.innerHTML = '<div class="kv-empty">No data</div>'; return; }
  const cfg = spec.config || (spec.config = {});
  const { headers, rows, colIndices } = mv;
  const sh = host.wb.sheets.find((s) => s.id === host.sheetId);
  const st = host.viewState(spec.id);

  const label = (i) => headers[i] || `Column ${i + 1}`;

  // ── Binding: group column (setup card when unbound/invalid) ──
  const gIdx = resolveField(cfg.groupBy, headers, null);
  if (gIdx == null) return renderSetup(host, mount, mv, sh);
  const gPhys = colIndices[gIdx];

  const oIdx = resolveField(cfg.orderBy, headers, null);
  const oPhys = oIdx != null ? colIndices[oIdx] : null;
  const wip = +cfg.wipLimit > 0 ? +cfg.wipLimit : null;

  // ── Lane set: validation options first (so empty lanes persist) ──
  const dv = listValidationFor(sh, gPhys);
  const laneKeys = [];
  const seen = new Set();
  for (const v of (dv?.values || [])) { const k = String(v); if (!seen.has(k)) { seen.add(k); laneKeys.push(k); } }
  let hasBlank = false;
  for (const row of rows) {
    const v = String(row.cells[gIdx] ?? '').trim();
    if (v === '') { hasBlank = true; continue; }
    if (!seen.has(v)) { seen.add(v); laneKeys.push(v); }
  }
  if (hasBlank || !laneKeys.length) laneKeys.push(BLANK);

  const lanes = new Map(laneKeys.map((k) => [k, []]));
  for (const row of rows) {
    const v = String(row.cells[gIdx] ?? '').trim();
    lanes.get(v === '' ? BLANK : v)?.push(row);
  }
  // Manual ordering: sort each lane by the rank column (numbers first, stable)
  if (oIdx != null) {
    for (const list of lanes.values()) {
      list.sort((a, b) => {
        const x = Number(a.cells[oIdx]), y = Number(b.cells[oIdx]);
        const xo = Number.isFinite(x), yo = Number.isFinite(y);
        if (xo && yo) return x - y;
        if (xo) return -1; if (yo) return 1;
        return a.rowIndex - b.rowIndex;
      });
    }
  }

  // ── Card fields: title = first non-group column, then up to 4 more ──
  const others = headers.map((_, i) => i).filter((i) => i !== gIdx && i !== oIdx);
  const tIdx = resolveField(cfg.titleField, headers, others[0] ?? gIdx);
  const bodyFields = (cfg.cardFields || others.filter((i) => i !== tIdx)).filter((i) => i !== tIdx && i < headers.length).slice(0, 4);

  const collapsed = st.collapsed || (st.collapsed = {});

  const cardHTML = (row) => `
    <div class="kv-card" data-rowid="${escH(row.rowId)}" data-lane="${escH(laneOf(row))}">
      <div class="kv-card-title">${escH(String(row.cells[tIdx] ?? '')) || '<span class="kv-untitled">Untitled</span>'}</div>
      ${bodyFields.map((f) => {
        const v = row.cells[f];
        if (v == null || v === '') return '';
        return `<div class="kv-card-field"><span class="kv-field-label">${escH(label(f))}</span><span class="kv-field-value">${escH(String(v))}</span></div>`;
      }).join('')}
    </div>`;
  const laneOf = (row) => { const v = String(row.cells[gIdx] ?? '').trim(); return v === '' ? BLANK : v; };

  mount.innerHTML = `
    <div class="kv-wrap">
      <div class="vw-toolbar">
        <span class="vw-toolbar-label">Group by</span>
        <select class="vw-toolbar-select" id="kvGroupSel">${headers.map((h, i) => `<option value="${i}"${i === gIdx ? ' selected' : ''}>${escH(label(i))}</option>`).join('')}</select>
        ${oIdx != null ? `<span class="vw-toolbar-note">order: ${escH(label(oIdx))}</span>` : ''}
        ${wip ? `<span class="vw-toolbar-note">WIP limit ${wip}</span>` : ''}
        <span class="vw-toolbar-note">${rows.length} card${rows.length === 1 ? '' : 's'}</span>
      </div>
      <div class="kv" id="kvBoard">
        ${laneKeys.map((k) => {
          const list = lanes.get(k) || [];
          const isCol = !!collapsed[k];
          const over = wip && list.length > wip;
          const full = wip && list.length >= wip;
          return `
          <div class="kv-col${isCol ? ' kv-collapsed' : ''}${full ? ' kv-full' : ''}" data-colkey="${escH(k)}">
            <div class="kv-col-header" style="border-top:3px solid ${hashColorInk(k === BLANK ? 'blank' : k)}">
              <button class="kv-collapse" data-collapse="${escH(k)}" title="${isCol ? 'Expand' : 'Collapse'}">${icon(isCol ? 'chevron-right' : 'chevron-down', { size: 12 })}</button>
              <span class="kv-col-title">${k === BLANK ? '<i>No value</i>' : escH(k)}</span>
              <span class="kv-col-count${over ? ' kv-over' : ''}">${list.length}${wip ? '/' + wip : ''}</span>
              <button class="kv-add" data-add="${escH(k)}" title="Add card">${icon('plus', { size: 12 })}</button>
            </div>
            <div class="kv-cards" data-colkey="${escH(k)}">${isCol ? '' : list.map(cardHTML).join('')}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  // ── Toolbar ──
  mount.querySelector('#kvGroupSel')?.addEventListener('change', (e) => {
    const i = +e.target.value;
    cfg.groupBy = headers[i] || i;   // header name when it has one, index otherwise
    host.saveSpec();
  });

  // ── Collapse / add-card ──
  mount.querySelectorAll('[data-collapse]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const k = b.dataset.collapse;
    collapsed[k] = !collapsed[k];
    render(host, mount); // in-memory state only — no save needed
  }));
  mount.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddCard(host, mv, b, { laneKey: b.dataset.add, gPhys, tPhys: colIndices[tIdx], oPhys, lanes });
  }));

  // ── Drag state machine + card click ──
  wireDnD(host, mount, {
    gIdx, gPhys, oIdx, oPhys, wip, lanes, laneKeys, headers, colIndices, tIdx, bodyFields, label, dv,
  });
}

/* ---------- setup wizard ---------- */
function renderSetup(host, mount, mv, sh) {
  const { headers, rows, colIndices } = mv;
  const label = (i) => headers[i] || `Column ${i + 1}`;
  // Fitness: list validation > low-cardinality > anything else
  const scored = headers.map((_, i) => {
    const phys = colIndices[i];
    if (listValidationFor(sh, phys)) return { i, score: 3 };
    const vals = new Set();
    for (const r of rows) { const v = String(r.cells[i] ?? '').trim(); if (v) vals.add(v); }
    const n = vals.size;
    if (n && n <= 12 && n <= Math.max(3, rows.length * 0.5)) return { i, score: 2 };
    return { i, score: n && n <= 24 ? 1 : 0 };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0]?.i ?? 0;
  mount.innerHTML = `<div class="vw-setup">
    <div class="vw-setup-title">${icon('kanban', { size: 16 })} Set up the board</div>
    <div class="vw-setup-hint">Pick the column whose values become the lanes. Columns with a dropdown validation or few distinct values work best.</div>
    <label class="vw-setup-label">Group by
      <select class="vw-setup-select" id="kvSetupCol">${scored.map(({ i, score }) => `<option value="${i}"${i === best ? ' selected' : ''}>${escH(label(i))}${score === 3 ? ' · dropdown' : score === 2 ? ' · good fit' : ''}</option>`).join('')}</select>
    </label>
    <button class="btn btn-primary vw-setup-apply" data-setup-apply>Build board</button>
  </div>`;
  mount.querySelector('[data-setup-apply]')?.addEventListener('click', () => {
    const i = +mount.querySelector('#kvSetupCol').value;
    host.spec.config.groupBy = headers[i] || i;
    host.saveSpec();
  });
}

/* ---------- add card ---------- */
function openAddCard(host, mv, anchor, { laneKey, gPhys, tPhys, oPhys, lanes }) {
  const pop = viewPopover(anchor.getBoundingClientRect(), `
    <div class="vw-pop-title">New card${laneKey === BLANK ? '' : ' in “' + escH(laneKey) + '”'}</div>
    <input class="vw-pop-input" id="kvNewTitle" placeholder="Title" />
    <div class="vw-pop-actions"><button class="btn btn-primary xmini" id="kvNewOk">Add</button></div>`);
  const inp = pop.querySelector('#kvNewTitle'); inp.focus();
  const commit = () => {
    const title = inp.value.trim(); if (!title) { pop.remove(); return; }
    const last = mv.rows.length ? Math.max(...mv.rows.map((r) => r.rowIndex)) : 0;
    const cells = [{ c: tPhys, raw: title }];
    if (laneKey !== BLANK) cells.push({ c: gPhys, raw: laneKey });
    if (oPhys != null) {
      const list = lanes.get(laneKey) || [];
      const oIdx = oPhysIdx(mv, oPhys);
      let mx = 0; for (const r of list) { const n = Number(r.cells[oIdx]); if (Number.isFinite(n) && n > mx) mx = n; }
      cells.push({ c: oPhys, raw: String(mx + 1000) });
    }
    pop.remove();
    host.applyEdit({ type: 'insertRow', afterR: last, cells });
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') pop.remove(); });
  pop.querySelector('#kvNewOk').addEventListener('click', commit);
}
function oPhysIdx(mv, oPhys) { return mv.colIndices.indexOf(oPhys); }

/* ---------- card editor popover ---------- */
function openCardEditor(host, ctx, card) {
  const rowId = card.dataset.rowid;
  const r = host.rowIndexById(rowId);
  if (r == null) { toast('That row no longer exists'); return; }
  const { headers, colIndices, label, gIdx, dv } = ctx;
  const sh = host.wb.sheets.find((s) => s.id === host.sheetId);
  const fields = headers.map((_, i) => i);
  const pop = viewPopover(card.getBoundingClientRect(), `
    <div class="vw-pop-title">Edit card</div>
    ${fields.map((i) => {
      const phys = colIndices[i];
      const raw = sh.getRaw(r, phys);
      if (i === gIdx && dv && dv.values?.length) {
        return `<label class="vw-pop-label">${escH(label(i))}
          <select class="vw-pop-input" data-ed="${phys}"><option value=""></option>${dv.values.map((v) => `<option${String(v) === raw ? ' selected' : ''}>${escH(v)}</option>`).join('')}</select></label>`;
      }
      return `<label class="vw-pop-label">${escH(label(i))}<input class="vw-pop-input" data-ed="${phys}" value="${escH(raw)}" /></label>`;
    }).join('')}
    <div class="vw-pop-actions">
      <button class="btn btn-ghost xmini" id="kvEdOpen">Open in grid</button>
      <button class="btn btn-ghost xmini" id="kvEdDel">Delete</button>
      <button class="btn btn-primary xmini" id="kvEdSave">Save</button>
    </div>`, { width: 300 });
  pop.querySelector('#kvEdSave').addEventListener('click', () => {
    const rr = host.rowIndexById(rowId);
    if (rr == null) { pop.remove(); toast('That row no longer exists'); return; }
    const cells = [];
    pop.querySelectorAll('[data-ed]').forEach((inp) => {
      const phys = +inp.dataset.ed;
      const cur = sh.getRaw(rr, phys);
      if (inp.value !== cur) cells.push({ r: rr, c: phys, raw: inp.value });
    });
    pop.remove();
    if (cells.length) host.applyEdit({ type: 'batch', cells });
  });
  pop.querySelector('#kvEdDel').addEventListener('click', () => {
    const rr = host.rowIndexById(rowId);
    pop.remove();
    if (rr != null) host.applyEdit({ type: 'deleteRow', r: rr });
  });
  pop.querySelector('#kvEdOpen').addEventListener('click', () => {
    const rr = host.rowIndexById(rowId);
    pop.remove();
    if (rr != null) host.openRowInGrid(rr);
  });
}

/* ---------- drag & drop ---------- */
function wireDnD(host, mount, ctx) {
  const board = mount.querySelector('#kvBoard');
  if (!board) return;
  let drag = null; // { card, rowId, fromLane, startX, startY, started, ghost, ph, fullLanes }

  const cleanup = () => {
    if (!drag) return;
    drag.ghost?.remove(); drag.ph?.remove();
    drag.card?.classList.remove('kv-drag-src');
    board.querySelectorAll('.kv-locked').forEach((el) => el.classList.remove('kv-locked'));
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    drag = null;
  };
  const onKey = (e) => { if (e.key === 'Escape' && drag) { const wasStarted = drag.started; cleanup(); if (!wasStarted) return; } };

  const onMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < 6) return; // Lifting → still a click
      // → Dragging: ghost + placeholder; fence: lock lanes at WIP now
      drag.started = true;
      const rect = drag.card.getBoundingClientRect();
      drag.ghost = drag.card.cloneNode(true);
      drag.ghost.className = 'kv-card kv-ghost';
      drag.ghost.style.width = rect.width + 'px';
      document.body.appendChild(drag.ghost);
      drag.ph = document.createElement('div');
      drag.ph.className = 'kv-placeholder';
      drag.ph.style.height = rect.height + 'px';
      drag.card.after(drag.ph);
      drag.card.classList.add('kv-drag-src');
      if (ctx.wip) {
        board.querySelectorAll('.kv-col').forEach((col) => {
          const k = col.dataset.colkey;
          const n = col.querySelectorAll('.kv-card:not(.kv-drag-src)').length;
          if (k !== drag.fromLane && n >= ctx.wip) col.classList.add('kv-locked');
        });
      }
    }
    drag.ghost.style.left = (e.clientX + 8) + 'px';
    drag.ghost.style.top = (e.clientY + 8) + 'px';
    // Hit test for target lane + slot
    drag.ghost.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const col = el?.closest('.kv-col');
    if (!col || col.classList.contains('kv-locked') || col.classList.contains('kv-collapsed')) return;
    const list = col.querySelector('.kv-cards'); if (!list) return;
    const cards = [...list.querySelectorAll('.kv-card:not(.kv-drag-src)')];
    let before = null;
    for (const c of cards) { const r = c.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = c; break; } }
    if (before) list.insertBefore(drag.ph, before); else list.appendChild(drag.ph);
  };

  const onUp = () => {
    if (!drag) return;
    const d = drag;
    if (!d.started) { cleanup(); openCardEditor(host, ctx, d.card); return; }
    const list = d.ph.parentElement;
    const toLane = list?.dataset.colkey;
    // Slot index among non-source cards
    let slot = 0;
    if (list) for (const el of list.children) { if (el === d.ph) break; if (el.classList.contains('kv-card') && !el.classList.contains('kv-drag-src')) slot++; }
    const rowId = d.rowId, fromLane = d.fromLane;
    cleanup();
    if (!toLane) return;
    const r = host.rowIndexById(rowId);
    if (r == null) { toast('That row no longer exists'); return; }
    const cells = [];
    if (toLane !== fromLane) cells.push({ r, c: ctx.gPhys, raw: toLane === BLANK ? '' : toLane });
    if (ctx.oPhys != null) {
      // INV-KAN-1: one midpoint rank write; siblings untouched
      const target = (ctx.lanes.get(toLane) || []).filter((x) => x.rowId !== rowId);
      const rankOf = (row) => { const n = Number(row.cells[ctx.oIdx]); return Number.isFinite(n) ? n : null; };
      const prev = slot > 0 ? rankOf(target[slot - 1]) : null;
      const next = slot < target.length ? rankOf(target[slot]) : null;
      let rank;
      if (prev != null && next != null) rank = (prev + next) / 2;
      else if (prev != null) rank = prev + 1000;
      else if (next != null) rank = next - 1000;
      else rank = 1000;
      if (prev != null && next != null && next - prev < 1e-7) {
        // Rank exhaustion → lazy per-lane rebalance (the one case siblings are rewritten)
        target.splice(slot, 0, { rowId, rowIndex: r, cells: [] });
        target.forEach((row, i) => {
          const rr = row.rowId === rowId ? r : host.rowIndexById(row.rowId);
          if (rr != null) cells.push({ r: rr, c: ctx.oPhys, raw: String((i + 1) * 1000) });
        });
      } else {
        cells.push({ r, c: ctx.oPhys, raw: String(rank) });
      }
    }
    if (!cells.length) return; // dropped back where it was
    host.applyEdit({ type: 'batch', cells });
  };

  board.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const card = e.target.closest('.kv-card');
    if (!card) return;
    e.preventDefault();
    drag = { card, rowId: card.dataset.rowid, fromLane: card.dataset.lane, startX: e.clientX, startY: e.clientY, started: false };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey);
  });
}

export function commandBarConfig(_spec) { return null; }

registerViewKind({ kind: 'kanban', label: 'Kanban', icon: 'kanban', render, commandBarConfig });
