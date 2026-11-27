// ============================================================
//  Mono — Calendar view renderer  (Views v3)
//
//  Design: MONO_VIEWS_LOGIC_V3.md §4.2
//  · PlainDate semantics throughout — dates parse into LOCAL
//    calendar parts, never through UTC (INV-CAL-1)
//  · Optional end column → multi-day spans; moves apply the same
//    day-delta to start AND end (INV-CAL-2 — duration preserved)
//  · Writes preserve the cell's original date format family
//  · Quick-add on day click, event popover (edit/delete/open),
//    drag events between days, persisted month via host.viewState
//  · All writes resolve rowId at interaction time (INV-V3-1)
// ============================================================
import { registerViewKind } from '../registry.js';
import { icon } from '../../../ui/icons.js';
import { toast } from '../../../ui/toast.js';
import {
  escH, resolveField, viewPopover,
  parsePlainDate, dateKey, keyToDate, addDays, dayDiff, formatDateLike,
} from '../viewUtils.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_SPAN = 60; // cap runaway ranges

export function render(host, mount) {
  const mv = host.materialized;
  const spec = host.spec;
  if (!mv || !spec) { mount.innerHTML = '<div class="cv-empty">No data</div>'; return; }
  const cfg = spec.config || (spec.config = {});
  const { headers, rows, colIndices } = mv;
  const sh = host.wb.sheets.find((s) => s.id === host.sheetId);
  const st = host.viewState(spec.id);
  const label = (i) => headers[i] || `Column ${i + 1}`;

  // ── Binding: date column (setup card when unbound/invalid) ──
  const dIdx = resolveField(cfg.dateField ?? cfg.startField, headers, null);
  if (dIdx == null || !columnLooksDated(rows, dIdx)) return renderSetup(host, mount, mv);
  const dPhys = colIndices[dIdx];
  const eIdx = resolveField(cfg.endField, headers, null);
  const ePhys = eIdx != null ? colIndices[eIdx] : null;
  const tIdx = resolveField(cfg.titleField, headers, headers.map((_, i) => i).find((i) => i !== dIdx && i !== eIdx) ?? dIdx);
  const tPhys = colIndices[tIdx];

  const now = new Date();
  const yr = st.yr ?? now.getFullYear();
  const mo = st.mo ?? now.getMonth();
  st.yr = yr; st.mo = mo;

  // ── Events → day buckets (deterministic order: date, then row) ──
  const eventMap = new Map(); // 'YYYY-MM-DD' → [{row, start, end, spanPos}]
  const events = [];
  for (const row of rows) {
    const start = parsePlainDate(row.cells[dIdx]);
    if (!start) continue;
    let end = eIdx != null ? parsePlainDate(row.cells[eIdx]) : null;
    if (end && dayDiff(start, end) < 0) end = null;                 // end<start unrepresentable: ignore bad end
    if (end && dayDiff(start, end) > MAX_SPAN) end = addDays(start, MAX_SPAN);
    events.push({ row, start, end });
  }
  events.sort((a, b) => (a.start - b.start) || (a.row.rowIndex - b.row.rowIndex));
  for (const ev of events) {
    const days = ev.end ? dayDiff(ev.start, ev.end) : 0;
    for (let i = 0; i <= days; i++) {
      const k = dateKey(addDays(ev.start, i));
      if (!eventMap.has(k)) eventMap.set(k, []);
      eventMap.get(k).push({ ...ev, spanPos: days === 0 ? 'single' : i === 0 ? 'start' : i === days ? 'end' : 'mid' });
    }
  }

  // ── Month grid ──
  const firstDay = new Date(yr, mo, 1).getDay();
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  let cells = '';
  let day = 1 - firstDay;
  for (let week = 0; week < 6; week++) {
    cells += '<tr>';
    for (let dow = 0; dow < 7; dow++, day++) {
      if (day < 1 || day > daysInMonth) { cells += '<td class="cv-cell cv-outside"></td>'; continue; }
      const k = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const evts = eventMap.get(k) || [];
      const isToday = yr === now.getFullYear() && mo === now.getMonth() && day === now.getDate();
      cells += `<td class="cv-cell${isToday ? ' cv-today' : ''}" data-date="${k}">
        <span class="cv-day-num">${day}</span>
        ${evts.slice(0, 3).map((ev) => `
          <div class="cv-event cv-span-${ev.spanPos}" data-rowid="${escH(ev.row.rowId)}" title="${escH(String(ev.row.cells[tIdx] ?? ''))}">
            ${ev.spanPos === 'mid' || ev.spanPos === 'end' ? '<span class="cv-cont">‹</span>' : ''}${escH(String(ev.row.cells[tIdx] ?? '')) || '<i>Untitled</i>'}
          </div>`).join('')}
        ${evts.length > 3 ? `<div class="cv-more" data-more="${k}">+${evts.length - 3} more</div>` : ''}
      </td>`;
    }
    cells += '</tr>';
    if (day > daysInMonth) break;
  }

  mount.innerHTML = `
    <div class="cv" id="cvRoot">
      <div class="cv-nav">
        <button class="cv-nav-btn" id="cvPrev" title="Previous month">${icon('chevron-left', { size: 16 })}</button>
        <button class="cv-nav-btn cv-today-btn" id="cvToday">Today</button>
        <button class="cv-nav-btn" id="cvNext" title="Next month">${icon('chevron-right', { size: 16 })}</button>
        <span class="cv-month-label">${MONTHS[mo]} ${yr}</span>
        <span class="vw-toolbar-note">${events.length} event${events.length === 1 ? '' : 's'} · date: ${escH(label(dIdx))}${eIdx != null ? ' → ' + escH(label(eIdx)) : ''}</span>
      </div>
      <table class="cv-table">
        <thead><tr>${DAYS.map((d) => `<th class="cv-dow">${d}</th>`).join('')}</tr></thead>
        <tbody>${cells}</tbody>
      </table>
      <div class="cv-hintbar">Click a day to add · click an event to edit · drag an event to move it</div>
    </div>`;

  // ── Navigation (state survives re-renders via host.viewState) ──
  const nav = (dyr, dmo) => { st.yr = dyr; st.mo = dmo; render(host, mount); };
  mount.querySelector('#cvPrev')?.addEventListener('click', () => nav(mo === 0 ? yr - 1 : yr, mo === 0 ? 11 : mo - 1));
  mount.querySelector('#cvNext')?.addEventListener('click', () => nav(mo === 11 ? yr + 1 : yr, mo === 11 ? 0 : mo + 1));
  mount.querySelector('#cvToday')?.addEventListener('click', () => nav(now.getFullYear(), now.getMonth()));

  // ── "+N more" → full day list ──
  mount.querySelectorAll('[data-more]').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const k = el.dataset.more;
    const evts = eventMap.get(k) || [];
    const pop = viewPopover(el.getBoundingClientRect(), `
      <div class="vw-pop-title">${escH(k)}</div>
      ${evts.map((ev) => `<button class="cv-pop-event" data-rowid="${escH(ev.row.rowId)}">${escH(String(ev.row.cells[tIdx] ?? '')) || '<i>Untitled</i>'}</button>`).join('')}`);
    pop.querySelectorAll('[data-rowid]').forEach((b) => b.addEventListener('click', () => {
      pop.remove();
      openEventEditor(host, { sh, dPhys, ePhys, tPhys, label, dIdx, eIdx, tIdx }, b.dataset.rowid, b.getBoundingClientRect());
    }));
  }));

  // ── Day click → quick add; event click/drag ──
  wireInteractions(host, mount, { sh, mv, dPhys, ePhys, tPhys, dIdx, eIdx, tIdx, label });
}

function columnLooksDated(rows, idx) {
  let seen = 0, ok = 0;
  for (const r of rows) {
    const v = r.cells[idx];
    if (v == null || v === '') continue;
    seen++; if (parsePlainDate(v)) ok++;
    if (seen >= 20) break;
  }
  return seen === 0 ? true : ok / seen >= 0.4;
}

/* ---------- setup wizard (type inference over sampled values) ---------- */
function renderSetup(host, mount, mv) {
  const { headers, rows } = mv;
  const label = (i) => headers[i] || `Column ${i + 1}`;
  const scored = headers.map((_, i) => {
    let seen = 0, ok = 0;
    for (const r of rows) { const v = r.cells[i]; if (v == null || v === '') continue; seen++; if (parsePlainDate(v)) ok++; if (seen >= 20) break; }
    return { i, fit: seen ? ok / seen : 0 };
  }).sort((a, b) => b.fit - a.fit);
  const best = scored[0]?.i ?? 0;
  mount.innerHTML = `<div class="vw-setup">
    <div class="vw-setup-title">${icon('calendar', { size: 16 })} Set up the calendar</div>
    <div class="vw-setup-hint">Pick the column that holds each row's date. Add an optional end-date column for multi-day events.</div>
    <label class="vw-setup-label">Date column
      <select class="vw-setup-select" id="cvSetupDate">${scored.map(({ i, fit }) => `<option value="${i}"${i === best ? ' selected' : ''}>${escH(label(i))}${fit >= 0.4 ? ' · looks like dates' : ''}</option>`).join('')}</select>
    </label>
    <label class="vw-setup-label">End date (optional)
      <select class="vw-setup-select" id="cvSetupEnd"><option value="">— none —</option>${headers.map((_, i) => `<option value="${i}">${escH(label(i))}</option>`).join('')}</select>
    </label>
    <button class="btn btn-primary vw-setup-apply" data-setup-apply>Build calendar</button>
  </div>`;
  mount.querySelector('[data-setup-apply]')?.addEventListener('click', () => {
    const di = +mount.querySelector('#cvSetupDate').value;
    const ei = mount.querySelector('#cvSetupEnd').value;
    host.spec.config.dateField = mv.headers[di] || di;
    host.spec.config.endField = ei === '' ? null : (mv.headers[+ei] || +ei);
    host.saveSpec();
  });
}

/* ---------- event editor popover ---------- */
function openEventEditor(host, ctx, rowId, anchorRect) {
  const r = host.rowIndexById(rowId);
  if (r == null) { toast('That row no longer exists'); return; }
  const { sh, dPhys, ePhys, tPhys, label, dIdx, eIdx, tIdx } = ctx;
  const rawDate = sh.getRaw(r, dPhys);
  const d = parsePlainDate(host.engine.valueAt(host.sheetId, r, dPhys) ?? rawDate) || parsePlainDate(rawDate);
  const rawEnd = ePhys != null ? sh.getRaw(r, ePhys) : '';
  const de = ePhys != null ? parsePlainDate(host.engine.valueAt(host.sheetId, r, ePhys) ?? rawEnd) : null;
  const pop = viewPopover(anchorRect, `
    <div class="vw-pop-title">Edit event</div>
    <label class="vw-pop-label">${escH(label(tIdx))}<input class="vw-pop-input" id="cvEdTitle" value="${escH(sh.getRaw(r, tPhys))}" /></label>
    <label class="vw-pop-label">${escH(label(dIdx))}<input class="vw-pop-input" id="cvEdDate" type="date" value="${d ? dateKey(d) : ''}" /></label>
    ${ePhys != null ? `<label class="vw-pop-label">${escH(label(eIdx))}<input class="vw-pop-input" id="cvEdEnd" type="date" value="${de ? dateKey(de) : ''}" /></label>` : ''}
    <div class="vw-pop-actions">
      <button class="btn btn-ghost xmini" id="cvEdOpen">Open in grid</button>
      <button class="btn btn-ghost xmini" id="cvEdDel">Delete</button>
      <button class="btn btn-primary xmini" id="cvEdSave">Save</button>
    </div>`, { width: 280 });
  pop.querySelector('#cvEdSave').addEventListener('click', () => {
    const rr = host.rowIndexById(rowId);
    if (rr == null) { pop.remove(); toast('That row no longer exists'); return; }
    const cells = [];
    const title = pop.querySelector('#cvEdTitle').value;
    if (title !== sh.getRaw(rr, tPhys)) cells.push({ r: rr, c: tPhys, raw: title });
    const nd = pop.querySelector('#cvEdDate').value;                 // YYYY-MM-DD from <input type=date>
    const curRaw = sh.getRaw(rr, dPhys);
    if (nd && !(curRaw && curRaw[0] === '=')) { const raw = formatDateLike(rawDate, keyToDate(nd)); if (raw !== curRaw) cells.push({ r: rr, c: dPhys, raw }); }
    const ne = pop.querySelector('#cvEdEnd')?.value;
    if (ePhys != null && ne != null) {
      const raw = ne ? formatDateLike(rawEnd, keyToDate(ne)) : '';
      if (raw !== sh.getRaw(rr, ePhys)) cells.push({ r: rr, c: ePhys, raw });
    }
    pop.remove();
    if (cells.length) host.applyEdit({ type: 'batch', cells });
  });
  pop.querySelector('#cvEdDel').addEventListener('click', () => {
    const rr = host.rowIndexById(rowId);
    pop.remove();
    if (rr != null) host.applyEdit({ type: 'deleteRow', r: rr });
  });
  pop.querySelector('#cvEdOpen').addEventListener('click', () => {
    const rr = host.rowIndexById(rowId);
    pop.remove();
    if (rr != null) host.openRowInGrid(rr);
  });
}

/* ---------- day quick-add + event click/drag ---------- */
function wireInteractions(host, mount, ctx) {
  const { sh, mv, dPhys, ePhys, tPhys } = ctx;
  const table = mount.querySelector('.cv-table');
  if (!table) return;
  let drag = null; // {rowId, fromKey, ghost, started, startX, startY}

  const cleanup = () => {
    if (!drag) return;
    drag.ghost?.remove();
    table.querySelectorAll('.cv-drop').forEach((el) => el.classList.remove('cv-drop'));
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    drag = null;
  };
  const onMove = (e) => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
      drag.started = true;
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'cv-event cv-ghost';
      drag.ghost.textContent = drag.title;
      document.body.appendChild(drag.ghost);
    }
    drag.ghost.style.left = (e.clientX + 8) + 'px';
    drag.ghost.style.top = (e.clientY + 8) + 'px';
    table.querySelectorAll('.cv-drop').forEach((el) => el.classList.remove('cv-drop'));
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cv-cell[data-date]');
    if (cell) cell.classList.add('cv-drop');
  };
  const onUp = (e) => {
    if (!drag) return;
    const d = drag;
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cv-cell[data-date]');
    cleanup();
    if (!d.started) {                                       // click → editor
      openEventEditor(host, ctx, d.rowId, d.anchorRect);
      return;
    }
    if (!cell || cell.dataset.date === d.fromKey) return;
    const r = host.rowIndexById(d.rowId);
    if (r == null) { toast('That row no longer exists'); return; }
    // INV-CAL-2: delta in DAYS applied to start AND end — duration preserved,
    // no UTC math anywhere.
    const delta = dayDiff(keyToDate(d.fromKey), keyToDate(cell.dataset.date));
    const cells = [];
    const rawS = sh.getRaw(r, dPhys);
    if (rawS && rawS[0] === '=') { toast('This date comes from a formula — edit it in the grid'); return; }
    const s = parsePlainDate(host.engine.valueAt(host.sheetId, r, dPhys) ?? rawS) || parsePlainDate(rawS);
    if (!s) return;
    cells.push({ r, c: dPhys, raw: formatDateLike(rawS, addDays(s, delta)) });
    if (ePhys != null) {
      const rawE = sh.getRaw(r, ePhys);
      const en = parsePlainDate(host.engine.valueAt(host.sheetId, r, ePhys) ?? rawE);
      if (en) cells.push({ r, c: ePhys, raw: formatDateLike(rawE, addDays(en, delta)) });
    }
    host.applyEdit({ type: 'batch', cells });
  };

  table.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const ev = e.target.closest('.cv-event');
    if (!ev) return;
    e.preventDefault(); e.stopPropagation();
    const day = ev.closest('.cv-cell')?.dataset.date;
    drag = {
      rowId: ev.dataset.rowid, fromKey: day, startX: e.clientX, startY: e.clientY,
      started: false, title: ev.textContent.trim(), anchorRect: ev.getBoundingClientRect(),
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  // Quick-add: click a day's empty area → inline title input
  table.addEventListener('click', (e) => {
    if (e.target.closest('.cv-event') || e.target.closest('.cv-more')) return;
    const cell = e.target.closest('.cv-cell[data-date]');
    if (!cell || cell.querySelector('.cv-quickadd')) return;
    const k = cell.dataset.date;
    const inp = document.createElement('input');
    inp.className = 'cv-quickadd';
    inp.placeholder = 'New event…';
    cell.appendChild(inp);
    inp.focus();
    let closed = false;   // Escape triggers remove() which can also fire blur — commit exactly once
    const done = (commit) => {
      if (closed) return;
      closed = true;
      const title = inp.value.trim();
      inp.remove();
      if (!commit || !title) return;
      const last = mv.rows.length ? Math.max(...mv.rows.map((r) => r.rowIndex)) : 0;
      const cells = [{ c: tPhys, raw: title }, { c: dPhys, raw: k }];   // ISO; engine reparses
      host.applyEdit({ type: 'insertRow', afterR: last, cells });
    };
    inp.addEventListener('keydown', (ev2) => {
      if (ev2.key === 'Enter') done(true);
      else if (ev2.key === 'Escape') done(false);
      ev2.stopPropagation();
    });
    inp.addEventListener('blur', () => done(true));
    inp.addEventListener('pointerdown', (ev2) => ev2.stopPropagation());
  });
}

export function commandBarConfig(_spec) { return null; }

registerViewKind({ kind: 'calendar', label: 'Calendar', icon: 'calendar', render, commandBarConfig });
