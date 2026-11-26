// ============================================================
//  Mono Sheets — editable grid UI (Phase 2.5)
//  Range/header selection, Ctrl/Shift+Arrow nav, clipboard with
//  relative-formula adjust, insert/delete rows/cols (ref-shifting),
//  undo/redo, right-click menu, menu+tool bar, formula autocomplete,
//  and in-formula range-picking (cross-tab + foreign IMPORTRANGE hook).
// ============================================================
import { colToLetters, addrToA1, MonoWorkbook, MonoSheet, isNumericRaw, canonicalJson } from './model/workbook.js';
import { UndoJournal, applyInverse, setActiveJournal, setStrictJournal } from './model/undoJournal.js';
import { widgetFor } from './views/grid/cellWidgets.js';
import * as gridRenderer from './views/grid/renderer.js';
import { getViewKind } from './views/registry.js';
import { makeHost } from './views/host.js';
import { materialize } from './views/materialize.js';
import * as viewTabs from './views/viewTabs.js';
import { Engine } from './engine/engine.js';
import { FormulaAutocomplete } from './autocomplete.js';
import * as menus from './menus.js';
import { withDecimals } from './engine/numberFormat.js';
import { cfStyleFor } from './features/conditionalFormat.js';
import { toast } from '../ui/toast.js';
import { registerCommands } from '../ui/commandRegistry.js';
import { icon } from '../ui/icons.js';
import { importFileImage, appendImageSheets } from './import/index.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
const hx = (h) => { h = String(h).replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
const compare2 = (a, b) => { if (typeof a === 'number' && typeof b === 'number') return a - b; const x = String(a ?? ''), y = String(b ?? ''); return x < y ? -1 : x > y ? 1 : 0; };
function lerpHex(a, b, t) { const pa = hx(a), pb = hx(b); t = Math.max(0, Math.min(1, t)); const ch = (i) => Math.round(pa[i] + (pb[i] - pa[i]) * t).toString(16).padStart(2, '0'); return '#' + ch(0) + ch(1) + ch(2); }

/* Legacy style dialect written by the xlsx importer before it spoke the
   app's own names: l|c|r and t|m|b went straight into a style attribute as
   "text-align:c", which no browser accepts. */
const HA = { l: 'left', c: 'center', r: 'right' };
const VA = { t: 'top', m: 'middle', b: 'bottom' };

export class MonoGrid {
  /* Commands still allowed in Comment/View mode (UI Plan v3 §5): reading,
     copying out, printing/exporting, help, comments. Everything else is
     filtered from the toolbar (CSS), the palette (registration) and blocked
     here as the final chokepoint. */
  static RO_COMMANDS = new Set(['copy', 'print', 'exportCSV', 'csv', 'shortcutsHelp', 'insertComment', 'zoomIn', 'zoomOut']);

  /* C1 (performance_resolution_report.md): virtual scrolling thresholds.
     Sheets with ≤ VIRT_MIN_ROWS visible rows always render fully — zero
     behavior change for typical sheets; only big sheets get windowed. */
  /* Undo depth. Entries are deltas now, so this costs almost nothing. */
  static UNDO_DEPTH = 200;

  /* C1b: columns are windowed exactly like rows. A spreadsheet pasted out to
     Excel's last column (XFD = 16,384) emitted 16,384 <td> PER ROW, so a
     viewport of 40 rows meant ~655,000 nodes and the tab simply stopped
     responding. Real user data lives out there, so the answer is to render a
     window of it rather than to throw the columns away. */
  static VIRT_MIN_COLS = 80;         // below this, render every column
  static VIRT_BUFFER_COLS = 12;      // columns rendered beyond the viewport, each side
  static VIRT_SLACK_COL_PX = 300;    // horizontal scroll before re-windowing

  static VIRT_MIN_ROWS = 300;
  // A selection at or below this many cells is painted by looking those cells
  // up directly; above it, one pass over the rendered cells is cheaper. A
  // rendered viewport is ~2,600 cells, so the common one-cell selection skips
  // the full walk while Select All still takes the bounded path.
  static SEL_DIRECT_MAX = 256;
  static VIRT_BUFFER_ROWS = 40;   // rows rendered beyond the viewport, each side
  static VIRT_SLACK_PX = 400;     // scrolled distance before re-windowing

  constructor(host, engine, { onChange } = {}) {
    this.host = host;
    this.engine = engine;
    this.wb = engine.wb;
    this.onChange = onChange || (() => {});
    this.active = { r: 0, c: 0 };
    this.anchor = { r: 0, c: 0 };
    this.selKind = 'cell';                 // 'cell' | 'cols' | 'rows' | 'all'
    this.editing = false; this.editOrigin = null; this.crossSheet = false;
    this.point = null;                     // {start,end,input} span of an inserted ref
    this.picking = null; this.dragging = false; this.dragKind = null;
    this.clip = null; this.undoStack = []; this.redoStack = [];
    // Undo self-check. Add ?verifyUndo=1 to the URL (or call
    // grid.setVerifyUndo(true)) and every action is checked against a real
    // snapshot, with any cell changed outside a transaction reported the
    // moment it happens. Off by default - it doubles the cost of an edit.
    try { if (typeof location !== 'undefined' && /[?&]verifyUndo=1/.test(location.search)) this.setVerifyUndo(true); } catch {} this.scripts = null; this.onUseInDashboard = null; this.onSheetListChange = null; this.onImportImage = null; // P20: import-as-new-workbook hook
    // Multi-user (UI Plan v3 §5): role-derived UI mode. monoSheets.js
    // overwrites this right after construction; the default keeps the
    // local/offline single-user build behaving exactly as before.
    this.access = { role: 'owner', isOwner: true, canEdit: true, canComment: true };
    this.commentApi = null;            // server-backed comments (Commenter role) when signed in
    this.onSaveConflict = null;
    this.paintClip = null; // Paint format (format painter) one-shot clipboard: {st, nf}
    this._lastPointer = null; this._scrollRAF = null; // drag-select auto-scroll (see startAutoScroll)
    this._colResize = null; this._rowResize = null;   // mouse column/row resize state (see startColResize/startRowResize)
    this._virt = null; this._gridCtx = null; this._scrollWin = null; this._printAll = false; // C1 virtualization state
    this._fontCache = null;                           // M8: per-sheet font sets (see _fontsForSheet)
    // C1: the browser's print path must see ALL rows — the virtualized grid
    // renders only the viewport window, so print renders fully, then restores.
    window.addEventListener('beforeprint', () => { if (this._virt) { this._printAll = true; this.render(); } });
    window.addEventListener('afterprint', () => { if (this._printAll) { this._printAll = false; this.render(); } });
    this.ac = new FormulaAutocomplete();
    this.ac.onPick = () => this.syncFromInput(this.editor);
    this.activeRenderer = gridRenderer;   // P9 — current renderer def
    this.activeViewSpec = null;           // P9 — active ViewSpec or null (null = default grid)
    document.addEventListener('mousemove', (e) => this.onDocMove(e));
    document.addEventListener('mouseup', () => {
      if (this.dragKind === 'fill') this.commitFill();
      else if (this.dragKind === 'colmove' || this.dragKind === 'rowmove') this.commitHeaderMove();
      if (this.paintClip && this.dragKind && this.dragKind !== 'pick') this.applyPaintFormat();
      this.dragging = false; this.dragKind = null; this.picking = null;
      this.stopAutoScroll();
      this.endColResize(); this.endRowResize();
    });
    document.addEventListener('keydown', (e) => this.onGlobalKey(e));
    this.render();
  }

  sheet() { return this.wb.active; }
  sid() { return this.wb.active.id; }

  /* ---------- P9: view switching ---------- */

  /**
   * Switch the active renderer to the given kind + optional ViewSpec.
   * @param {string} kind   — 'grid'|'kanban'|'calendar'|'gallery'|'form'
   * @param {ViewSpec|null} spec — the ViewSpec to activate (null = default grid)
   */
  switchToViewKind(kind, spec = null) {
    const def = getViewKind(kind);
    if (!def) { console.warn('switchToViewKind: unknown kind', kind); return; }
    this.activeRenderer = def;
    this.activeViewSpec = spec;
    this.render();
  }

  /* ---------- render ---------- */
  render() {
    const sh = this.sheet();
    // Save scroll position before rebuilding DOM — restored below so that
    // formatting actions (font size, bold, etc.) don't jump the viewport.
    const _savedScrollTop  = this.scrollEl?.scrollTop  ?? 0;
    const _savedScrollLeft = this.scrollEl?.scrollLeft ?? 0;
    // Formula bar is its own row (name box + fx + input), directly under the
    // toolbar — like Sheets. It used to be crammed into the toolbar's own
    // flex row via a stretchy center slot, which is what produced the big
    // empty gap and made the toolbar not match the reference screenshot.
    const fxHTML = `<span class="ms-ref mono" id="msRef">${addrToA1(this.active.r, this.active.c)}</span><span class="ms-fx">fx</span><input class="ms-fxinput" id="msFx" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-lpignore="true" data-form-type="other" name="ms-fx-${Math.random().toString(36).slice(2, 8)}" placeholder="${this.access && !this.access.canEdit ? 'read-only — select cells to inspect' : 'value, text, or =formula'}" ${this.access && !this.access.canEdit ? 'disabled' : ''} /><div id="msCellBadges" class="ms-cell-badges"></div>`;
    const activeSt = sh.getStyle(this.active.r, this.active.c) || {};
    const _ro = this.access && !this.access.canEdit;
    const _banner = !_ro ? '' : `<div class="ms-role-banner">${icon(this.access.role === 'commenter' ? 'message-square' : 'eye', { size: 13 })}<span>${this.access.role === 'commenter'
      ? '<b>Comment access</b> — you can view, comment, and ask AI.'
      : '<b>View only</b> — you can ask AI about this data.'}</span></div>`;
    this.host.innerHTML = `
      <div class="ms${_ro ? ' ms-readonly' : ''}">
        <div class="ms-menubar-row" id="msMenuBar">${menus.menuBarHTML()}</div>
        ${menus.barsHTML(activeSt)}
        ${_banner}
        <div class="ms-formulabar">${fxHTML}</div>
        <div class="ms-viewtabs" id="msViewTabs"></div>
        <div class="ms-scroll" id="msScroll"></div>
      </div>`;
    this.scrollEl = this.host.querySelector('#msScroll');
    // NOTE: scroll restore is deferred to AFTER the table is materialized into
    // #msScroll (see below, just before applySelection). Setting scrollTop here
    // is a no-op because #msScroll has no scrollable content yet — the browser
    // clamps it to 0 — which is what caused the viewport to jump on every
    // render (backspace, font-size change, etc.).
    // Ctrl+F1 chrome toggle must survive re-renders (render() rebuilds .ms).
    if (this._chromeHidden) this.host.querySelector('.ms')?.classList.add('ms-chrome-hidden');
    this.scrollEl.style.zoom = (sh.zoom || 100) / 100;
    this.fx = this.host.querySelector('#msFx');
    this.refEl = this.host.querySelector('#msRef');
    menus.wireBars(this, this.host);
    menus.wireMenuBar(this, this.host);
    // Lazy-load any Google Fonts referenced by cells in this sheet.
    // M8 (performance_resolution_report.md): the full-cell scan used to run
    // on EVERY render; the font set is now cached per sheet and rescanned
    // only after a mutation (pushUndo/restore invalidate it).
    for (const _ff of this._fontsForSheet(sh)) menus.loadGoogleFont(_ff);
    this.renderExtMenus();
    // P9: render view tabs strip
    viewTabs.renderTabs(this, this.host.querySelector('#msViewTabs'));
    // P9: build host, materialize the active spec, delegate to active renderer
    const _host = makeHost(this);
    // Materialising is what Kanban/Calendar/Gallery/Form consume - the GRID
    // renderer never touches it. Computing it eagerly meant every grid render
    // built rows x columns of view data and threw it away: on a sheet pasted
    // out to Excel's last column that was 21.6 SECONDS of pure waste per
    // render. Lazy, so only the renderers that need it pay for it.
    Object.defineProperty(_host, 'materialized', {
      configurable: true,
      get: () => {
        if (_host._mat === undefined) _host._mat = materialize(this.engine, this.sid(), this.activeViewSpec || {});
        return _host._mat;
      },
    });
    // C1: gridHTML must window the rows around the scroll position we are
    // about to RESTORE (the fresh #msScroll is still at 0 while it renders).
    this._pendingScrollTop = _savedScrollTop;
    this._pendingScrollLeft = _savedScrollLeft;
    this.activeRenderer.render(_host, this.scrollEl);
    this._pendingScrollTop = null;
    this._pendingScrollLeft = null;
    // C1: re-window the virtualized grid on scroll. The listener is attached
    // to the freshly created #msScroll each render, so it never stacks; it is
    // a cheap no-op while the grid isn't virtualized or a view is active.
    if (this.tableEl) this.scrollEl.addEventListener('scroll', () => this.onViewportScroll(), { passive: true });
    // Restore scroll position now that #msScroll actually contains the table
    // (and after style.zoom has been applied, so the scroll metrics are in the
    // correct scale). applySelection() below then only scrolls if the active
    // cell is genuinely outside this restored viewport.
    this.scrollEl.scrollTop  = _savedScrollTop;
    this.scrollEl.scrollLeft = _savedScrollLeft;
    this.applySelection();
    {
      const ro = this.access && !this.access.canEdit;
      const meta = menus.allCommandMeta().filter((m) => !ro || MonoGrid.RO_COMMANDS.has(m.cmd));
      registerCommands('Sheet', meta.map((m) => ({ id: 'sheet:' + m.cmd, label: m.label, icon: m.icon, kbd: m.kbd, run: () => this.command(m.cmd) })));
    }
    // render() replaces #msScroll's entire DOM subtree on nearly every
    // command, which silently drops keyboard focus — the bug where you
    // have to click a cell again before typing works. Put focus back
    // unless the fx/cell-editor input is (or is about to be) focused.
    if (!this.editing) this.focusGrid();
  }

  /* Which columns to actually emit. Mirrors the row window: everything for a
     normal sheet, and for a very wide one the viewport plus a buffer, with the
     skipped width replaced by filler cells so the scrollbar geometry, sticky
     headers and frozen panes are all unchanged. A merge that straddles an edge
     widens the window, so a merge never renders half of itself. */
  colWindow(sh, visCols, cLeft, colW) {
    const total = visCols.length;
    const fr = sh.frozen || { rows: 0, cols: 0 };
    if (total <= MonoGrid.VIRT_MIN_COLS) return { on: false, first: 0, last: sh.cols - 1, left: 0, right: 0, emit: visCols, renderedAt: 0 };

    // render() rebuilds #msScroll, so while this runs the fresh element is
    // still at 0 - the same trap the row window documents. Use the position we
    // are about to restore, or the window lands on column A every time and you
    // can never scroll right into your data.
    const scrollLeft = this._pendingScrollLeft != null
      ? this._pendingScrollLeft
      : (this.scrollEl ? this.scrollEl.scrollLeft : 0);
    const width = (this.scrollEl && this.scrollEl.clientWidth) || 1200;
    const from = scrollLeft, to = scrollLeft + width;

    let i0 = 0, i1 = total - 1;
    for (let i = 0; i < total; i++) { if (cLeft(visCols[i]) + colW(visCols[i]) >= from) { i0 = i; break; } }
    for (let i = i0; i < total; i++) { i1 = i; if (cLeft(visCols[i]) > to) break; }
    i0 = Math.max(0, i0 - MonoGrid.VIRT_BUFFER_COLS);
    i1 = Math.min(total - 1, i1 + MonoGrid.VIRT_BUFFER_COLS);

    let first = visCols[i0], last = visCols[i1];
    // never split a merge across the edge
    for (const m of (sh.merges || [])) {
      if (m.c1 < first && m.c2 >= first) first = m.c1;
      if (m.c2 > last && m.c1 <= last) last = m.c2;
    }
    // frozen columns are always drawn, so they must not also be padded over
    if (fr.cols > 0 && first < fr.cols) first = 0;

    let left = 0, right = 0;
    const emit = [];
    for (const c of visCols) {
      if (c < fr.cols) { emit.push(c); continue; }          // frozen: always drawn
      if (c < first) { left += colW(c); continue; }
      if (c > last) { right += colW(c); continue; }
      emit.push(c);
    }
    return { on: true, first, last, left, right, emit, renderedAt: scrollLeft };
  }

  gridHTML(sh) {
    const sid = sh.id; this._csCache = {};
    const fr = sh.frozen || { rows: 0, cols: 0 };
    const flt = sh.filter; const hiddenRows = this.hiddenRowSet(sh); const hiddenCols = new Set(sh.hiddenCols || []);
    const covered = new Set(); const span = new Map();
    for (const m of (sh.merges || [])) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) { if (r === m.r1 && c === m.c1) span.set(r + ',' + c, { rs: m.r2 - m.r1 + 1, cs: m.c2 - m.c1 + 1 }); else covered.add(r + ',' + c); }
    // Column/row sizing: cumulative offsets built from each column's/row's
    // actual (possibly mouse-resized, see startColResize/startRowResize)
    // width/height instead of the old flat "every column is 92px, every row
    // is 30px" assumption — that hardcoding is *why* resize had nowhere to
    // persist to before. Offsets still only count visible (non-hidden) rows
    // and columns, same as before.
    const colW = (c) => sh.getColWidth(c), rowH = (r) => sh.getRowHeight(r);
    const colLeftMap = new Map(); { let acc = 46; for (let c = 0; c < sh.cols; c++) { if (hiddenCols.has(c)) continue; colLeftMap.set(c, acc); acc += colW(c); } }
    const rowTopMap = new Map(); { let acc = 30; for (let r = 0; r < sh.rows; r++) { if (hiddenRows.has(r)) continue; rowTopMap.set(r, acc); acc += rowH(r); } }
    const cLeft = (c) => colLeftMap.get(c) ?? 46, rTop = (r) => rowTopMap.get(r) ?? 30;
    // C1: geometry context, reused by scroll-driven re-windowing. Anything
    // that changes geometry (resize, hide, merge, edit…) goes through
    // render(), which rebuilds this object.
    const visRows = []; for (let r = 0; r < sh.rows; r++) if (!hiddenRows.has(r)) visRows.push(r);
    const visCols = []; for (let c = 0; c < sh.cols; c++) if (!hiddenCols.has(c)) visCols.push(c);
    const visColCount = visCols.length;
    const cw = this.colWindow(sh, visCols, cLeft, colW);
    this._gridCtx = { sid, fr, flt, hiddenRows, hiddenCols, covered, span, colW, rowH, cLeft, rTop, visRows, visCols, visColCount, cw };
    return `<table class="ms-table${sh.gridlines === false ? ' ms-no-gridlines' : ''}" id="msTable"><thead>${this._theadHTML(sh, this._gridCtx)}</thead><tbody>${this._tbodyHTML(sh, this._gridCtx)}</tbody></table>`;
  }

  _theadHTML(sh, ctx) {
    const { fr, hiddenCols, colW, cLeft, cw } = ctx;
    let head = `<tr><th class="ms-corner" id="msCorner"></th>`;
    // Walk ONLY the columns being emitted. Looping 0..sh.cols and skipping
    // meant 16,384 iterations per row on a wide sheet - which is what made
    // re-windowing cost seconds instead of milliseconds.
    for (const c of cw.emit) {
      if (cw.on && c === cw.first && cw.left > 0) head += `<th class="ms-pad" style="width:${cw.left}px;min-width:${cw.left}px"></th>`;
      const style = `width:${colW(c)}px;min-width:${colW(c)}px` + (c < fr.cols ? `;position:sticky;left:${cLeft(c)}px;z-index:7` : '');
      head += `<th class="ms-colh${c < fr.cols ? ' ms-frz' : ''}" data-c="${c}" style="${style}"><span class="ms-colh-label">${colToLetters(c)}</span><span class="ms-col-resize" data-resize-c="${c}" title="Drag to resize · double-click to fit"></span></th>`;
    }
    if (cw.on && cw.right > 0) head += `<th class="ms-pad" style="width:${cw.right}px;min-width:${cw.right}px"></th>`;
    head += `</tr>`;
    return head;
  }

  /* Horizontal re-windowing. A full render() tears down and rebuilds #msScroll,
     which at ~340ms per 300px of scroll makes a wide sheet feel broken. Only
     the table's contents change when the column window moves, so rebuild just
     that - the scroll container, its position and its listeners all survive. */
  _renderColumnWindow() {
    const ctx = this._gridCtx; if (!ctx || !this.tableEl || !this.scrollEl) return;
    const sh = this.sheet(); if (!sh || sh.id !== ctx.sid) return;
    ctx.cw = this.colWindow(sh, ctx.visCols, ctx.cLeft, ctx.colW);
    this.tableEl.innerHTML = `<thead>${this._theadHTML(sh, ctx)}</thead><tbody>${this._tbodyHTML(sh, ctx)}</tbody>`;
    this.applySelection({ scroll: false });
  }

  /* C1 (performance_resolution_report.md, Phase 1): windowed tbody.
     Sheets with ≤ VIRT_MIN_ROWS visible rows render every row — output is
     byte-identical to the pre-virtualization builder. Bigger sheets render
     the viewport ± VIRT_BUFFER_ROWS inside height-preserving filler rows, so
     scrollbar geometry, sticky headers and frozen panes are unchanged.
     Frozen rows are ALWAYS rendered; a merge straddling a window edge
     extends the window so merges never render partially. Copy, find, CSV
     export and column autofit read the data model — not the DOM — so they
     are unaffected; browser print re-renders fully via the beforeprint hook. */
  /* Which rows the tbody should contain right now. Also (re)sets this._virt,
     which onViewportScroll reads to decide whether the view has drifted far
     enough to repaint. Split out of _tbodyHTML so _patchRows can ask the same
     question without building any HTML. */
  _rowWindow(sh, ctx) {
    const { fr, rowH, rTop, visRows } = ctx;
    let winStart = 0, winEnd = sh.rows - 1;
    this._virt = null;
    if (!this._printAll && visRows.length > MonoGrid.VIRT_MIN_ROWS && this.scrollEl) {
      const zoom = (sh.zoom || 100) / 100;
      // scrollTop is in content units (same coordinate space as rTop — the
      // same convention as positionFillHandle/beginEdit); clientHeight needs
      // the zoom divided out.
      const stTop = this._pendingScrollTop != null ? this._pendingScrollTop : this.scrollEl.scrollTop;
      const vh = (this.scrollEl.clientHeight || 600) / zoom;
      const B = MonoGrid.VIRT_BUFFER_ROWS;
      let lo = 0, hi = visRows.length - 1, i0 = visRows.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; const r = visRows[mid]; if (rTop(r) + rowH(r) >= stTop) { i0 = mid; hi = mid - 1; } else lo = mid + 1; }
      lo = 0; hi = visRows.length - 1; let i1 = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (rTop(visRows[mid]) <= stTop + vh) { i1 = mid; lo = mid + 1; } else hi = mid - 1; }
      i0 = Math.max(0, i0 - B); i1 = Math.min(visRows.length - 1, i1 + B);
      winStart = visRows[i0]; winEnd = visRows[i1];
      for (const m of (sh.merges || [])) {           // never split a merge across the window edge
        if (m.r1 < winStart && m.r2 >= winStart) winStart = m.r1;
        if (m.r1 <= winEnd && m.r2 > winEnd) winEnd = m.r2;
      }
      this._virt = { renderedAt: stTop, winStart, winEnd };
    }
    return { winStart, winEnd };
  }

  _tbodyHTML(sh, ctx) {
    const cw = ctx.cw || { on: false, first: 0, last: sh.cols - 1, left: 0, right: 0 };
    const { fr, hiddenRows, rowH, visColCount } = ctx;
    const { winStart, winEnd } = this._rowWindow(sh, ctx);
    let body = ''; let pad = 0;
    const flushPad = () => { if (pad > 0) { body += `<tr class="ms-vfill" style="height:${pad}px"><td colspan="${visColCount + 1}"></td></tr>`; pad = 0; } };
    for (let r = 0; r < sh.rows; r++) {
      if (hiddenRows.has(r)) continue;
      if (this._virt && r >= fr.rows && (r < winStart || r > winEnd)) { pad += rowH(r); continue; }
      flushPad();
      body += this._rowHTML(sh, ctx, cw, r);
    }
    flushPad();
    return body;
  }

  /* One <tr>. Carries data-r so _patchRows can tell which rows the tbody
     already holds by reading the DOM rather than trusting a cache. */
  _rowHTML(sh, ctx, cw, r) {
    const { sid, fr, flt, covered, span, rowH, cLeft, rTop } = ctx;
    let body = '';
      const rowStyle = `height:${rowH(r)}px` + (r < fr.rows ? `;position:sticky;top:${rTop(r)}px;z-index:6` : '');
      body += `<tr data-r="${r}"><th class="ms-rowh${r < fr.rows ? ' ms-frz' : ''}" data-r="${r}" style="${rowStyle}"><span class="ms-rowh-label">${r + 1}</span><span class="ms-row-resize" data-resize-r="${r}" title="Drag to resize · double-click to fit"></span></th>`;
      for (const c of cw.emit) {
        if (cw.on && c === cw.first && cw.left > 0) body += `<td class="ms-pad" style="width:${cw.left}px;min-width:${cw.left}px"></td>`;
        if (covered.has(r + ',' + c)) continue;
        const sp = span.get(r + ',' + c);
        const note = sh.getNote(r, c); const cms = sh.getComments(r, c); const prot = sh.isProtected(r, c);
        const stObj = sh.getStyle(r, c);
        // H9: frozen-pane position/z-index live in CSS classes (ms-frzc /
        // ms-frzr) — only the per-column/per-row pixel offset stays inline.
        let cls = 'ms-cell' + (this.engine.isNumberAt(sid, r, c) ? ' ms-num' : '') + (this.engine.isErrorAt(sid, r, c) ? ' ms-err' : '') + (this.engine.isSpillCell(sid, r, c) ? ' ms-spill' : '') + (this.engine.isSpillAnchor(sid, r, c) ? ' ms-spill-anchor' : '') + (prot ? ' ms-protected' : '') + (stObj && stObj.bdg ? ' ms-bd-glow' : '');
        let style = this.cellStyleAttr(sid, r, c, stObj || undefined);
        const cs = this.colorScaleBg(sid, r, c); if (cs) style += (style ? ';' : '') + 'background:' + cs;
        const db = this.dataBarBg(sid, r, c); if (db) style += (style ? ';' : '') + 'background:' + db;
        if (c < fr.cols) { cls += ' ms-frzc'; style += (style ? ';' : '') + 'left:' + cLeft(c) + 'px'; }
        if (r < fr.rows) { cls += ' ms-frzr'; style += (style ? ';' : '') + 'top:' + rTop(r) + 'px'; }
        const inner = this.cellInnerHtml(sid, r, c, { sh, note, cms, stObj, flt });
        const spanAttr = sp ? ` colspan="${sp.cs}" rowspan="${sp.rs}"` : '';
        body += `<td class="${cls}" data-r="${r}" data-c="${c}"${spanAttr}${style ? ` style="${style}"` : ''}>${inner}</td>`;
      }
      if (cw.on && cw.right > 0) body += `<td class="ms-pad" style="width:${cw.right}px;min-width:${cw.right}px"></td>`;
      body += `</tr>`;
    return body;
  }

  /* C1: scroll handler — re-windows the tbody at most once per animation
     frame, and only after the viewport left the rendered buffer. */
  onViewportScroll() {
    const wide = this._gridCtx && this._gridCtx.cw && this._gridCtx.cw.on;
    if ((!this._virt && !wide) || this._scrollWin) return;
    this._scrollWin = requestAnimationFrame(() => {
      this._scrollWin = null;
      if (!this.scrollEl) return;
      const movedDown = this._virt && Math.abs(this.scrollEl.scrollTop - this._virt.renderedAt) >= MonoGrid.VIRT_SLACK_PX;
      // A very wide sheet re-windows on HORIZONTAL scroll as well - without
      // this you would scroll right into an empty expanse instead of your data.
      const cwNow = this._gridCtx && this._gridCtx.cw;
      const movedAcross = cwNow && cwNow.on && Math.abs(this.scrollEl.scrollLeft - cwNow.renderedAt) >= MonoGrid.VIRT_SLACK_COL_PX;
      if (!movedDown && !movedAcross) return;
      if (movedAcross) { this._renderColumnWindow(); return; }   // cheap: only the table changes
      this._renderViewport();
    });
  }
  /* A scroll repaint changes only the rows that crossed the window edge - a
     400px scroll is ~13 rows out of ~110 rendered. Replacing the whole tbody
     made the browser restyle and lay out every rendered cell: measured on the
     production workbook, 12.9 ms of style+layout per repaint for 2,678 cells,
     on top of 7.4 ms building the HTML and 3.8 ms parsing it. Rows still in
     the window are never detached here, so they keep their computed style and
     their layout boxes, and only the arriving rows cost anything.

     Which rows the tbody holds is read back from the DOM (data-r on each
     <tr>) rather than from a cache, so an edit or a full render between two
     scroll frames cannot desynchronise it. Returns false whenever the tbody
     is not the shape this expects - first paint, a window disjoint from the
     previous one, a sheet that is not virtualized - and the caller then
     rebuilds the whole tbody, which is always correct, just slower. */
  _patchRows(tb, sh, ctx) {
    const prev = this._virt;
    if (!prev || !tb.firstChild || !ctx.cw || !ctx.cw.emit) return false;
    const { winStart, winEnd } = this._rowWindow(sh, ctx);
    if (!this._virt) return false;                                       // no longer windowed
    if (winStart > prev.winEnd || winEnd < prev.winStart) return false;  // disjoint: a rebuild is cheaper
    const { fr, hiddenRows, rowH, visColCount, cw } = ctx;
    // Drop the rows that left the window, and the height fillers, which are
    // rebuilt below at their new sizes.
    for (const tr of [...tb.children]) {
      const a = tr.getAttribute('data-r');
      if (a === null) { tr.remove(); continue; }                         // tr.ms-vfill
      const r = +a;
      if (r >= fr.rows && (r < winStart || r > winEnd)) tr.remove();
    }
    const tpl = document.createElement('template');
    const node = (html) => { tpl.innerHTML = html; return tpl.content.firstChild; };
    let cursor = tb.firstChild, pad = 0;
    const flushPad = () => {
      if (pad > 0) { tb.insertBefore(node(`<tr class="ms-vfill" style="height:${pad}px"><td colspan="${visColCount + 1}"></td></tr>`), cursor); pad = 0; }
    };
    for (let r = 0; r < sh.rows; r++) {
      if (hiddenRows.has(r)) continue;
      if (r >= fr.rows && (r < winStart || r > winEnd)) { pad += rowH(r); continue; }
      flushPad();
      if (cursor && cursor.nodeType === 1 && cursor.getAttribute('data-r') === String(r)) { cursor = cursor.nextSibling; continue; }
      tb.insertBefore(node(this._rowHTML(sh, ctx, cw, r)), cursor);
    }
    flushPad();
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    return true;
  }
  _renderViewport() {
    const tb = this.tableEl && this.tableEl.querySelector('tbody');
    if (!tb || !this._gridCtx) return;
    const sh = this.sheet();
    if (!this._patchRows(tb, sh, this._gridCtx)) tb.innerHTML = this._tbodyHTML(sh, this._gridCtx);
    // Repaint selection classes on the fresh rows WITHOUT scroll-into-view —
    // snapping back to the active cell mid-scroll would fight the user.
    this.applySelection({ scroll: false });
  }

  /* M8: per-sheet font set, cached; invalidated on mutation (pushUndo/restore). */
  _fontsForSheet(sh) {
    this._fontCache ||= new Map();
    let set = this._fontCache.get(sh.id);
    if (!set) {
      set = new Set();
      // ponytail: O(cells) scan, cached per sheet so it is paid once — 58 ms
      // at 600,000 cells, but linear, so ~10 s at 10 crore and that IS a
      // freeze. Upgrade path: only a cell carrying .st can contribute a font,
      // and in a tiled CellStore those all live in the sparse overlay, so ask
      // the store for just those rather than walking every value.
      for (const c of sh.cells.values()) if (c.st?.ff) set.add(c.st.ff);
      this._fontCache.set(sh.id, set);
    }
    return set;
  }
  // Insert link [Ctrl+K] writes =HYPERLINK("url","label") — detect it for
  // click-through rendering. Only literal string-URL calls are recognised
  // (matches the common case of typing/pasting a real link); formula-driven
  // URLs still *evaluate* correctly via the HYPERLINK() builtin, they just
  // won't render as a clickable <a> since the URL isn't known until runtime.
  hyperlinkUrlFor(raw) { if (!raw || raw[0] !== '=') return null; const m = /^=\s*HYPERLINK\s*\(\s*"((?:[^"\\]|\\.)*)"/i.exec(raw); return m ? m[1] : null; }
  tabsHTML() {
    return this.wb.sheets.map((s) => `<button class="ms-tab ${s.id === this.wb.activeSheetId ? 'active' : ''}" data-id="${s.id}">${escH(s.name)}</button>`).join('')
      + `<button class="ms-tab ms-addtab" data-act="addsheet" title="Add sheet">${icon('plus', { size: 13 })}</button>`;
  }

  /* ---------- events ---------- */
  bind() {
    this.tableEl.addEventListener('mousedown', (e) => {
      // Column/row resize handles sit *inside* th.ms-colh/th.ms-rowh, so they
      // must be checked before the header-select logic below (closest('th')
      // would otherwise match the handle too and start a column/row select
      // drag instead of a resize).
      const colRz = e.target.closest('.ms-col-resize'); if (colRz) { e.preventDefault(); e.stopPropagation(); return this.startColResize(+colRz.dataset.resizeC, e.clientX); }
      const rowRz = e.target.closest('.ms-row-resize'); if (rowRz) { e.preventDefault(); e.stopPropagation(); return this.startRowResize(+rowRz.dataset.resizeR, e.clientY); }
      const colh = e.target.closest('th.ms-colh'); const rowh = e.target.closest('th.ms-rowh'); const corner = e.target.closest('#msCorner');
      // Dragging across cells to build a range selection was also starting the
      // *browser's* native text-selection drag (bleeding into the sidebar, row
      // numbers, toolbar text, etc., and popping the browser's selection mini
      // toolbar). preventDefault() on the initiating mousedown stops native
      // selection from ever starting, without disabling normal clicks on real
      // interactive controls (checkbox/dropdown/link) inside a cell.
      if (!e.target.closest('input, button, a, .ms-dv, .ms-filt')) e.preventDefault();
      if (corner) { this.commitIfEditing(); this.selKind = 'all'; this.anchor = { r: 0, c: 0 }; this.active = { r: 0, c: 0 }; this.applySelection(); this.focusGrid(); return; }
      if (colh) return this.onHeadDown('col', +colh.dataset.c, e);
      if (rowh) return this.onHeadDown('row', +rowh.dataset.r, e);
      const td = e.target.closest('td.ms-cell'); if (!td) return;
      // Right-click on a cell already inside the current selection → preserve the
      // selection so the context menu can operate on the whole range.
      if (e.button === 2 && this.inSel(+td.dataset.r, +td.dataset.c)) return;
      this.onCellDown(+td.dataset.r, +td.dataset.c, e);
    });
    this.tableEl.addEventListener('dblclick', (e) => {
      const colRz = e.target.closest('.ms-col-resize'); if (colRz) { e.stopPropagation(); return this.autoFitCol(+colRz.dataset.resizeC); }
      const rowRz = e.target.closest('.ms-row-resize'); if (rowRz) { e.stopPropagation(); return this.autoFitRow(+rowRz.dataset.resizeR); }
      const td = e.target.closest('td.ms-cell'); if (td) { this.select(+td.dataset.r, +td.dataset.c); this.beginEdit(); }
    });
    this.tableEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Right-click reacts differently depending on what was clicked — a
      // plain cell, a row number, or a column letter — matching Google
      // Sheets' three distinct context-menu variants (§12/12.1/12.2).
      const colh = e.target.closest('th.ms-colh');
      if (colh) {
        const c = +colh.dataset.c;
        if (!(this.selKind === 'cols' && this.inSel(0, c))) { this.anchor = { r: 0, c }; this.active = { r: 0, c }; this.selKind = 'cols'; this.applySelection(); }
        return menus.showContextMenu(this, e.clientX, e.clientY, 'col');
      }
      const rowh = e.target.closest('th.ms-rowh');
      if (rowh) {
        const r = +rowh.dataset.r;
        if (!(this.selKind === 'rows' && this.inSel(r, 0))) { this.anchor = { r, c: 0 }; this.active = { r, c: 0 }; this.selKind = 'rows'; this.applySelection(); }
        return menus.showContextMenu(this, e.clientX, e.clientY, 'row');
      }
      const td = e.target.closest('td.ms-cell');
      if (td) { const r = +td.dataset.r, c = +td.dataset.c; if (!this.inSel(r, c)) this.select(r, c); }
      menus.showContextMenu(this, e.clientX, e.clientY, 'cell');
    });
    this.tableEl.addEventListener('change', (e) => { const chk = e.target.closest('input.ms-chk'); if (chk) { const td = chk.closest('td.ms-cell'); const r = +td.dataset.r, c = +td.dataset.c; if (this.guardProtected(r, c)) { chk.checked = !chk.checked; return; } this.pushUndo(); this.engine.setRaw(this.sid(), r, c, chk.checked ? 'TRUE' : 'FALSE'); this.save(); this.render(); } });
    this.tableEl.addEventListener('click', (e) => {
      const dv = e.target.closest('.ms-dv'); if (dv) { const td = dv.closest('td.ms-cell'); this.openListDropdown(+td.dataset.r, +td.dataset.c, td); return; }
      const ft = e.target.closest('.ms-filt'); if (ft) { const td = ft.closest('td.ms-cell'); this.openFilterMenu(+td.dataset.c, ft); return; }
      const flag = e.target.closest('.ms-note-flag,.ms-comment-flag'); if (flag) { const td = flag.closest('td.ms-cell'); this.openCellFlag(+td.dataset.r, +td.dataset.c); return; }
    });
    this.fx.addEventListener('focus', () => { if (!this.editing) { this.editing = true; this.editOrigin = { sid: this.sid(), r: this.active.r, c: this.active.c }; this.point = null; } });
    this.fx.addEventListener('input', () => { if (this.editing) { this.point = null; this.syncFromInput(this.fx); this.ac.update(this.fx, this.fx.getBoundingClientRect()); } });
    this.fx.addEventListener('keydown', (e) => this.onEditorKey(e, this.fx));
    this.fx.addEventListener('blur', () => setTimeout(() => { if (this.editing && !this.picking && document.activeElement !== this.editor && !this.ac.visible()) this.commitEdit(); }, 0));

    this.editor.addEventListener('input', () => { this.point = null; this.syncFromInput(this.editor); this.ac.update(this.editor, this.editor.getBoundingClientRect()); });
    this.editor.addEventListener('keydown', (e) => this.onEditorKey(e, this.editor));
    this.editor.addEventListener('blur', () => setTimeout(() => { if (this.editing && !this.picking && document.activeElement !== this.fx && !this.ac.visible()) this.commitEdit(); }, 0));

    this.scrollEl.tabIndex = 0;
    this.scrollEl.addEventListener('keydown', (e) => this.onKey(e));
  }

  focusGrid() { this.scrollEl.focus({ preventScroll: true }); }
  _activeInput() { return (this.editing && this.editor.style.display !== 'none' && document.activeElement === this.editor) ? this.editor : this.fx; }

  /* ---------- mouse ---------- */
  onCellDown(r, c, e) {
    if (this.editing && this.canInsertRef()) { this.startPick(r, c); e.preventDefault(); return; }
    this.commitIfEditing();
    this.dragging = true; this.dragKind = 'cell';
    if (e.shiftKey) this.active = { r, c }; else { this.anchor = { r, c }; this.active = { r, c }; }
    this.selKind = 'cell'; this.applySelection(); this.focusGrid();
  }
  onHeadDown(kind, idx, e) {
    if (this.editing && this.canInsertRef()) { this.startPickAxis(kind, idx); e.preventDefault?.(); return; }
    this.commitIfEditing();
    // Mousedown on a header already inside the current col/row selection starts
    // a reorder-drag (Google Sheets behaviour); otherwise it starts a select.
    const selK = kind === 'col' ? 'cols' : 'rows';
    const inThisSel = this.selKind === selK && this.inSel(kind === 'col' ? 0 : idx, kind === 'col' ? idx : 0);
    if (inThisSel && !e.shiftKey && e.button !== 2) {
      const s = this.rect();
      this._headerMove = { kind, from: kind === 'col' ? s.c1 : s.r1, count: kind === 'col' ? (s.c2 - s.c1 + 1) : (s.r2 - s.r1 + 1), hover: null };
      this.dragging = true; this.dragKind = kind === 'col' ? 'colmove' : 'rowmove';
      this.focusGrid(); return;
    }
    this.dragging = true; this.dragKind = kind;
    const a = kind === 'col' ? { r: 0, c: idx } : { r: idx, c: 0 };
    if (e.shiftKey) this.active = a; else { this.anchor = a; this.active = a; }
    this.selKind = selK;
    this.applySelection(); this.focusGrid();
  }
  updateHeaderMoveTarget(axis, idx) {
    const m = this._headerMove; if (!m || m.kind !== axis) return;
    m.hover = idx; this.showHeaderMoveIndicator(axis, idx);
  }
  // Drop-position: block goes before `hover` if left/above it, else after.
  _headerMoveTo(m) {
    const h = m.hover; if (h == null) return null;
    if (h < m.from) return h;
    if (h >= m.from + m.count) return h + 1;
    return null; // inside the moving block → no-op
  }
  showHeaderMoveIndicator(axis, hover) {
    if (!this.scrollEl) return;
    let ind = this.scrollEl.querySelector('#msMoveInd');
    if (!ind) { ind = document.createElement('div'); ind.id = 'msMoveInd'; ind.className = 'ms-move-ind'; this.scrollEl.appendChild(ind); }
    const m = this._headerMove; const to = this._headerMoveTo(m);
    if (to == null) { ind.style.display = 'none'; return; }
    const zoom = (this.sheet().zoom || 100) / 100;
    const cRect = this.scrollEl.getBoundingClientRect();
    if (axis === 'col') {
      const before = to < this.sheet().cols;
      const th = this.tableEl.querySelector(`th.ms-colh[data-c="${before ? to : this.sheet().cols - 1}"]`); if (!th) { ind.style.display = 'none'; return; }
      const tr = th.getBoundingClientRect();
      const x = ((before ? tr.left : tr.right) - cRect.left) / zoom + this.scrollEl.scrollLeft;
      Object.assign(ind.style, { display: 'block', left: (x - 1) + 'px', top: this.scrollEl.scrollTop + 'px', width: '2px', height: this.tableEl.offsetHeight + 'px' });
    } else {
      const before = to < this.sheet().rows;
      const th = this.tableEl.querySelector(`th.ms-rowh[data-r="${before ? to : this.sheet().rows - 1}"]`); if (!th) { ind.style.display = 'none'; return; }
      const tr = th.getBoundingClientRect();
      const y = ((before ? tr.top : tr.bottom) - cRect.top) / zoom + this.scrollEl.scrollTop;
      Object.assign(ind.style, { display: 'block', top: (y - 1) + 'px', left: this.scrollEl.scrollLeft + 'px', height: '2px', width: this.tableEl.offsetWidth + 'px' });
    }
  }
  hideHeaderMoveIndicator() { const ind = this.scrollEl?.querySelector('#msMoveInd'); if (ind) ind.style.display = 'none'; }
  commitHeaderMove() {
    const m = this._headerMove; this._headerMove = null; this.hideHeaderMoveIndicator();
    if (!m) return;
    const to = this._headerMoveTo(m); if (to == null || to === m.from) return;
    const sid = this.sid();
    this.pushUndo();
    if (m.kind === 'col') this.engine.moveCols(sid, m.from, m.count, to);
    else this.engine.moveRows(sid, m.from, m.count, to);
    const dest = to > m.from ? to - m.count : to;   // new start of the moved block
    if (m.kind === 'col') { this.selKind = 'cols'; this.anchor = { r: 0, c: dest }; this.active = { r: 0, c: dest + m.count - 1 }; }
    else { this.selKind = 'rows'; this.anchor = { r: dest, c: 0 }; this.active = { r: dest + m.count - 1, c: 0 }; }
    this.save(); this.render();
  }
  onDocMove(e) {
    if (this._colResize) return this.moveColResize(e);
    if (this._rowResize) return this.moveRowResize(e);
    if (!this.dragging) return;
    this._lastPointer = { x: e.clientX, y: e.clientY };
    this.updateDragTarget(e.clientX, e.clientY);
    this.startAutoScroll();
  }
  // Shared by onDocMove (live mousemove) and the auto-scroll loop below
  // (synthetic "the view scrolled under a stationary pointer" updates) —
  // both need to re-resolve which cell/row/col is now under the last known
  // pointer position and extend the selection/range-pick to it.
  updateDragTarget(x, y) {
    const el = document.elementFromPoint(x, y); if (!el || !el.closest) return;
    if (this.dragKind === 'pick') { const td = el.closest('td.ms-cell'); if (td) this.extendPick(+td.dataset.r, +td.dataset.c); return; }
    if (this.dragKind === 'fill') { const td = el.closest('td.ms-cell'); if (td) this.updateFillTarget(+td.dataset.r, +td.dataset.c); return; }
    if (this.dragKind === 'colmove') { const th = el.closest('th.ms-colh'); if (th) this.updateHeaderMoveTarget('col', +th.dataset.c); return; }
    if (this.dragKind === 'rowmove') { const th = el.closest('th.ms-rowh'); if (th) this.updateHeaderMoveTarget('row', +th.dataset.r); return; }
    if (this.dragKind === 'cell') { const td = el.closest('td.ms-cell'); if (td) { this.active = { r: +td.dataset.r, c: +td.dataset.c }; this.applySelection(); } }
    else if (this.dragKind === 'col') { const th = el.closest('th.ms-colh'); if (th) { this.active = { r: 0, c: +th.dataset.c }; this.applySelection(); } }
    else if (this.dragKind === 'row') { const th = el.closest('th.ms-rowh'); if (th) { this.active = { r: +th.dataset.r, c: 0 }; this.applySelection(); } }
  }
  // Drag-select auto-scroll — holding (or dragging) the pointer at/past the
  // edge of #msScroll while selecting a range used to do nothing: plain
  // mousemove-driven selection only runs when a mousemove event actually
  // fires, so once the pointer left the scrollable area (or just stopped
  // moving right at the edge) the selection could never grow further and
  // the view never scrolled — the reported "can't drag-select across the
  // sheet" bug. This runs on its own requestAnimationFrame loop, independent
  // of mousemove, scrolling #msScroll toward the pointer at a speed that
  // ramps up the further past the edge it is, and re-derives the selection
  // target after every scroll step since the content just moved under an
  // unmoving pointer.
  startAutoScroll() {
    if (this._scrollRAF || !this.scrollEl) return;
    const EDGE = 32, MAXSPEED = 26;
    const step = () => {
      this._scrollRAF = null;
      if (!this.dragging || !this._lastPointer || !this.scrollEl) return;
      const rect = this.scrollEl.getBoundingClientRect();
      const { x, y } = this._lastPointer;
      let dx = 0, dy = 0;
      if (x < rect.left + EDGE) dx = -MAXSPEED * (1 - Math.max(0, x - rect.left) / EDGE);
      else if (x > rect.right - EDGE) dx = MAXSPEED * (1 - Math.max(0, rect.right - x) / EDGE);
      if (y < rect.top + EDGE) dy = -MAXSPEED * (1 - Math.max(0, y - rect.top) / EDGE);
      else if (y > rect.bottom - EDGE) dy = MAXSPEED * (1 - Math.max(0, rect.bottom - y) / EDGE);
      if (dx || dy) {
        const before = { l: this.scrollEl.scrollLeft, t: this.scrollEl.scrollTop };
        this.scrollEl.scrollLeft += dx; this.scrollEl.scrollTop += dy;
        if (this.scrollEl.scrollLeft !== before.l || this.scrollEl.scrollTop !== before.t) this.updateDragTarget(x, y);
      }
      this._scrollRAF = requestAnimationFrame(step);
    };
    this._scrollRAF = requestAnimationFrame(step);
  }
  stopAutoScroll() { if (this._scrollRAF) { cancelAnimationFrame(this._scrollRAF); this._scrollRAF = null; } }

  /* ---------- Mouse column width / row height resize ----------
   * Right-click header → Resize column/row (menus.js) drive the same
   * underlying sh.setColWidth/setRowHeight as dragging the little edge
   * handle rendered on every header cell (.ms-col-resize/.ms-row-resize,
   * added in gridHTML). Dragging only touches the live DOM (the one header
   * cell's inline width/height — table-layout:fixed recomputes the whole
   * column from that immediately) so it stays smooth even on a big sheet;
   * the model is only written once, on mouseup, which is also when undo
   * gets a checkpoint and sticky frozen-header offsets get trued up via a
   * normal render().
   */
  startColResize(c, clientX) {
    this.commitIfEditing();
    const th = this.tableEl.querySelector(`th.ms-colh[data-c="${c}"]`); if (!th) return;
    this._colResize = { c, startX: clientX, startW: this.sheet().getColWidth(c), th };
    document.body.classList.add('ms-resizing-col');
    this.showResizeGuide('v', clientX);
  }
  moveColResize(e) {
    const rs = this._colResize; if (!rs) return;
    const w = Math.max(24, Math.round(rs.startW + (e.clientX - rs.startX)));
    rs.liveW = w; rs.th.style.width = w + 'px'; rs.th.style.minWidth = w + 'px';
    this.showResizeGuide('v', e.clientX);
  }
  endColResize() {
    const rs = this._colResize; if (!rs) return;
    this._colResize = null; document.body.classList.remove('ms-resizing-col'); this.hideResizeGuide();
    if (rs.liveW != null && rs.liveW !== rs.startW) { this.pushUndo(); this.sheet().setColWidth(rs.c, rs.liveW); this.save(); this.render(); }
  }
  startRowResize(r, clientY) {
    this.commitIfEditing();
    const th = this.tableEl.querySelector(`th.ms-rowh[data-r="${r}"]`); if (!th) return;
    this._rowResize = { r, startY: clientY, startH: this.sheet().getRowHeight(r), th };
    document.body.classList.add('ms-resizing-row');
    this.showResizeGuide('h', clientY);
  }
  moveRowResize(e) {
    const rs = this._rowResize; if (!rs) return;
    const h = Math.max(16, Math.round(rs.startH + (e.clientY - rs.startY)));
    rs.liveH = h; rs.th.style.height = h + 'px';
    this.showResizeGuide('h', e.clientY);
  }
  endRowResize() {
    const rs = this._rowResize; if (!rs) return;
    this._rowResize = null; document.body.classList.remove('ms-resizing-row'); this.hideResizeGuide();
    if (rs.liveH != null && rs.liveH !== rs.startH) { this.pushUndo(); this.sheet().setRowHeight(rs.r, rs.liveH); this.save(); this.render(); }
  }
  showResizeGuide(axis, pos) {
    if (!this.scrollEl) return;
    let g = document.getElementById('msResizeGuide');
    if (!g) { g = document.createElement('div'); g.id = 'msResizeGuide'; g.className = 'ms-resize-guide'; document.body.appendChild(g); }
    const rect = this.scrollEl.getBoundingClientRect();
    if (axis === 'v') Object.assign(g.style, { left: pos + 'px', top: rect.top + 'px', width: '2px', height: rect.height + 'px' });
    else Object.assign(g.style, { left: rect.left + 'px', top: pos + 'px', width: rect.width + 'px', height: '2px' });
  }
  hideResizeGuide() { document.getElementById('msResizeGuide')?.remove(); }
  // Google Sheets' "Resize to fit data" — measure the widest rendered value
  // in the column with a scratch canvas (fast, no DOM layout thrash) and
  // size the column to match. measureFitWidth() is the pure measurement so
  // multi-column fits (resizeColFitSel) can loop it without re-rendering
  // between every column.
  measureFitWidth(c) {
    const sh = this.sheet(); const sid = sh.id;
    const ctx = this._measureCtx || (this._measureCtx = document.createElement('canvas').getContext('2d'));
    ctx.font = '13px Inter, system-ui, sans-serif';
    let max = 0;
    for (let r = 0; r < sh.rows; r++) { const s = this.engine.getDisplay(sid, r, c); if (s) max = Math.max(max, ctx.measureText(String(s)).width); }
    const header = ctx.measureText(colToLetters(c)).width;
    return Math.max(36, Math.min(480, Math.round(Math.max(max, header) + 24)));
  }
  autoFitCol(c) { this.pushUndo(); this.sheet().setColWidth(c, this.measureFitWidth(c)); this.save(); this.render(); }
  // Rows in Mono are single-line by default (Format → Wrap text is what
  // makes a row need extra height) — "fit" for a row without wrap is just
  // its default height; a wrapped row's fit height would need a real
  // layout measurement pass, out of scope here (same class of disclosed
  // simplification as pasteTransposed above).
  autoFitRow(r) { this.pushUndo(); this.sheet().setRowHeight(r, MonoSheet.DEFAULT_ROW_H); this.save(); this.render(); }
  // Right-click header → Resize row/column (menus.js rowHeaderItems/colHeaderItems).
  resizeRowPrompt() {
    const { r1, r2 } = this.rect(); const cur = this.sheet().getRowHeight(r1);
    const v = prompt(r2 > r1 ? `Row height (px) for rows ${r1 + 1}-${r2 + 1}` : `Row height (px) for row ${r1 + 1}`, cur);
    if (v == null) return; const h = Math.max(16, Math.min(500, parseInt(v, 10) || cur));
    this.pushUndo(); const sh = this.sheet(); for (let r = r1; r <= r2; r++) sh.setRowHeight(r, h); this.save(); this.render();
  }
  resizeRowFitSel() { const { r1, r2 } = this.rect(); this.pushUndo(); const sh = this.sheet(); for (let r = r1; r <= r2; r++) sh.setRowHeight(r, MonoSheet.DEFAULT_ROW_H); this.save(); this.render(); }
  resizeColPrompt() {
    const { c1, c2 } = this.rect(); const cur = this.sheet().getColWidth(c1);
    const v = prompt(c2 > c1 ? `Column width (px) for columns ${colToLetters(c1)}-${colToLetters(c2)}` : `Column width (px) for column ${colToLetters(c1)}`, cur);
    if (v == null) return; const w = Math.max(24, Math.min(600, parseInt(v, 10) || cur));
    this.pushUndo(); const sh = this.sheet(); for (let c = c1; c <= c2; c++) sh.setColWidth(c, w); this.save(); this.render();
  }
  resizeColFitSel() { const { c1, c2 } = this.rect(); this.pushUndo(); const sh = this.sheet(); for (let c = c1; c <= c2; c++) sh.setColWidth(c, this.measureFitWidth(c)); this.save(); this.render(); }
  resizeAllColsSel() {
    const { c1 } = this.rect(); const sh = this.sheet(); const cur = sh.getColWidth(c1);
    const v = prompt('Set width (px) for every column', cur); if (v == null) return;
    const w = Math.max(24, Math.min(600, parseInt(v, 10) || cur));
    this.pushUndo(); for (let c = 0; c < sh.cols; c++) sh.setColWidth(c, w); this.save(); this.render();
  }

  /* ---------- selection ---------- */
  rect() {
    const sh = this.sheet(); let r1 = Math.min(this.anchor.r, this.active.r), r2 = Math.max(this.anchor.r, this.active.r), c1 = Math.min(this.anchor.c, this.active.c), c2 = Math.max(this.anchor.c, this.active.c);
    if (this.selKind === 'cols') { r1 = 0; r2 = sh.rows - 1; } else if (this.selKind === 'rows') { c1 = 0; c2 = sh.cols - 1; } else if (this.selKind === 'all') { r1 = 0; c1 = 0; r2 = sh.rows - 1; c2 = sh.cols - 1; }
    return { r1, c1, r2, c2 };
  }
  inSel(r, c) { const s = this.rect(); return r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2; }
  cellAt(r, c) { return this.tableEl.querySelector(`td.ms-cell[data-r="${r}"][data-c="${c}"]`); }
  // Inner HTML for one cell — shared by the full table renderer and paintCell.
  // paintCell previously did `td.textContent = display`, which destroyed every
  // child element in the cell (border overlay, note/comment flags, dropdown
  // chevrons, checkboxes, hyperlinks, rich widgets) on the fast repaint path
  // after commitEdit — the "border disappears on double-click / formula-bar
  // enter, reappears on next full render" bug. One builder, no divergence.
  cellInnerHtml(sid, r, c, pre = {}) {
    const sh = pre.sh || this.sheet();
    const note = pre.note !== undefined ? pre.note : sh.getNote(r, c);
    const cms = pre.cms !== undefined ? pre.cms : sh.getComments(r, c);
    const stObj = pre.stObj !== undefined ? pre.stObj : sh.getStyle(r, c);
    const flt = pre.flt !== undefined ? pre.flt : sh.filter;
    const dv = this.validationAt(sid, r, c);
    const raw = this.engine.getRaw(sid, r, c);
    let inner;
    if (sh.showFormulas && raw && raw[0] === '=') inner = escH(raw);
    else inner = escH(this.engine.getDisplay(sid, r, c)).replace(/\n/g, '<br>'); // Alt+Enter in-cell newlines
    if (dv && dv.kind === 'checkbox') inner = `<input type="checkbox" class="ms-chk"${String(this.engine.getValue(sid, r, c)).toUpperCase() === 'TRUE' ? ' checked' : ''}>`;
    else if (dv && dv.kind === 'list') inner += `<span class="ms-dv">${icon('chevron-down', { size: 9 })}</span>`;
    else {
      // P10: check for rich cell type widget (rating, progress, email, url, phone…)
      const ctHtml = !sh.showFormulas ? widgetFor(sh, c, this.engine.getValue(sid, r, c), this.engine) : null;
      if (ctHtml) inner = ctHtml;
      else { const url = this.hyperlinkUrlFor(raw); if (url) inner = `<a href="${escH(url)}" target="_blank" rel="noopener" class="ms-link" onclick="event.stopPropagation()">${inner}</a>`; }
    }
    if (flt && r === flt.range.r1 && c >= flt.range.c1 && c <= flt.range.c2) inner += `<span class="ms-filt${(flt.cols[c] && (flt.cols[c].hidden || []).length) ? ' on' : ''}" data-fc="${c}">${icon('chevron-down', { size: 9 })}</span>`;
    if (note) inner += `<span class="ms-note-flag" title="${escH(note)}"></span>`;
    if (cms && cms.length) inner += `<span class="ms-comment-flag" data-cm="1"></span>`;
    if (stObj) inner += this.borderOverlayHtml(stObj);
    return inner;
  }
  paintCell(r, c) {
    const td = this.cellAt(r, c); if (!td) return; const sid = this.sid();
    const stObj = this.sheet().getStyle(r, c);
    td.innerHTML = this.cellInnerHtml(sid, r, c, { stObj });
    td.classList.toggle('ms-num', this.engine.isNumberAt(sid, r, c));
    td.classList.toggle('ms-err', this.engine.isErrorAt(sid, r, c));
    td.classList.toggle('ms-bd-glow', !!(stObj && stObj.bdg));
  }
  applySelection(opts = {}) {
    if (!this.tableEl) return; // non-grid renderer active — no table to update
    this.tableEl.querySelectorAll('.insel,.sel,.hl,.sel-row').forEach((el) => el.classList.remove('insel', 'sel', 'hl', 'sel-row'));
    const aa = this.mergeAnchor(this.active.r, this.active.c) || this.active;
    // C1: with a virtualized grid the active cell may be OUTSIDE the rendered
    // window (Ctrl+End, Ctrl+arrow, Name-box jump…). Scroll it in and
    // re-window BEFORE painting so the classes land on real nodes. Skipped
    // for scroll-driven repaints (opts.scroll === false) — yanking the view
    // back to the active cell mid-scroll would fight the user.
    const windowed = this._virt || !!(this._gridCtx && this._gridCtx.cw && this._gridCtx.cw.on);
    if (opts.scroll !== false && windowed && this._gridCtx && !this.cellAt(aa.r, aa.c)) {
      const zoom = (this.sheet().zoom || 100) / 100;
      const vh = (this.scrollEl?.clientHeight || 600) / zoom;
      this.scrollEl.scrollTop = Math.max(0, this._gridCtx.rTop(aa.r) - vh / 2);
      const tb = this.tableEl.querySelector('tbody');
      if (tb) tb.innerHTML = this._tbodyHTML(this.sheet(), this._gridCtx);
    }
    const { r1, c1, r2, c2 } = this.rect();
    // Always walk the RENDERED cells, never the selected range. Only rendered
    // cells can carry a class, so this is equivalent - and it is the only
    // version that is bounded. The old code took this path only when ROW
    // virtualization was on, so a 261-row x 16,384-column sheet (rows below
    // the row threshold, columns far above it) fell into the range loop and
    // did 4.28 MILLION cellAt() lookups on Select All. The tab locked up hard
    // enough that DevTools could not be opened.
    // Walk whichever side is smaller, same rule as getBadgesForSelection.
    //
    // Walking every rendered cell is what keeps Select All bounded (see the
    // note above), but it is also what runs on EVERY SCROLL FRAME, because
    // _renderViewport replaces the tbody and repaints the selection onto the
    // fresh nodes. Measured on a real scroll: applySelection was 367 ms of a
    // 745 ms _renderViewport — more than building the HTML — spent reading
    // td.dataset.r/.c on ~2,600 cells to find the ONE that is selected.
    // dataset is a DOMStringMap proxy, so that is 5,200 slow property reads
    // a frame. A selection is almost always one cell.
    const selCount = (r2 - r1 + 1) * (c2 - c1 + 1);
    if (selCount <= MonoGrid.SEL_DIRECT_MAX) {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const td = this.cellAt(r, c);
        if (td) td.classList.add('insel');
      }
    } else {
      this.tableEl.querySelectorAll('td.ms-cell').forEach((td) => {
        const r = +td.getAttribute('data-r'), c = +td.getAttribute('data-c');
        if (r >= r1 && r <= r2 && c >= c1 && c <= c2) td.classList.add('insel');
      });
    }
    const at = this.cellAt(aa.r, aa.c);
    if (at) {
      at.classList.add('sel');
      if (opts.scroll !== false) {
        // Scroll only within ms-scroll — never the page — so the topbar stays visible.
        // scrollIntoView() picks the nearest scrollable ancestor which can be the page
        // body when ms-scroll is sized to show all rows (height:auto before the flex
        // constraint kicks in, or after a sync render resets the layout).
        const cr = at.getBoundingClientRect(), sr = this.scrollEl.getBoundingClientRect();
        const hdrH = 30, hdrW = 46; // sticky column/row header sizes
        if (cr.bottom > sr.bottom) this.scrollEl.scrollTop += cr.bottom - sr.bottom;
        else if (cr.top < sr.top + hdrH) this.scrollEl.scrollTop -= (sr.top + hdrH) - cr.top;
        if (cr.right > sr.right) this.scrollEl.scrollLeft += cr.right - sr.right;
        else if (cr.left < sr.left + hdrW) this.scrollEl.scrollLeft -= (sr.left + hdrW) - cr.left;
      }
    }
    // Highlight the entire active row with sel-row (keyboard-driven, distinct from mouse hover)
    const sh = this.sheet();
    this.tableEl.querySelectorAll(`td.ms-cell[data-r="${this.active.r}"]`).forEach((td) => td.classList.add('sel-row'));
    // Same rule as the cells above: walk the RENDERED headers, never the
    // selected range. Select All on a 16,384-column sheet meant 16,384
    // querySelector calls for the column headers alone.
    this.tableEl.querySelectorAll('th.ms-colh').forEach((th) => { const c = +th.dataset.c; if (c >= c1 && c <= c2) th.classList.add('hl'); });
    this.tableEl.querySelectorAll('th.ms-rowh').forEach((th) => { const r = +th.dataset.r; if (r >= r1 && r <= r2) th.classList.add('hl'); });
    this.refEl.textContent = (r1 === r2 && c1 === c2) ? addrToA1(r1, c1) : addrToA1(r1, c1) + ':' + addrToA1(r2, c2);
    if (!this.editing) this.fx.value = this.engine.getRaw(this.sid(), aa.r, aa.c);
    this.refreshBadges();
    this.positionFillHandle();
    // Sync font family button + size input with active cell's style
    { const _st = sh.getStyle(this.active.r, this.active.c) || {};
      const _btn = this.host?.querySelector('#cbFontFamilyBtn');
      if (_btn) { const _ff = _st.ff || ''; _btn.textContent = _ff || 'Default'; _btn.style.fontFamily = _ff ? `'${_ff}',sans-serif` : ''; _btn.dataset.ff = _ff; }
      const _fs = this.host?.querySelector('#cbFontSize');
      if (_fs && document.activeElement !== _fs) _fs.value = _st.fs || 12; }
  }
  select(r, c, extend) { const sh = this.sheet(); r = clamp(r, 0, sh.rows - 1); c = clamp(c, 0, sh.cols - 1); this.active = { r, c }; if (!extend) { this.anchor = { r, c }; this.selKind = 'cell'; } this.applySelection(); }

  /* ---------- keyboard ---------- */
  onGlobalKey(e) {
    if (this.editing) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.target.id !== 'msScroll') return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); return this.undo(); }
    if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); return this.redo(); }
    // Ctrl+S anywhere — force a save and suppress the browser's Save dialog.
    if (ctrl && !e.shiftKey && (k === 's' || k === 'S')) { e.preventDefault(); this.save(); toast('Workbook saved'); return; }
  }

  // ============================================================
  //  Excel-parity keyboard map (MONOSHEETS_Shortcuts_Complete_Guide).
  //  Ordering matters: Ctrl+Shift+<key> combos are checked BEFORE their
  //  plain Ctrl+<key> siblings (e.g. Ctrl+Shift+X clear-formatting must
  //  win over Ctrl+X cut). Browser-reserved chords (Ctrl+N/O/W, Alt+F4,
  //  Ctrl+F9/F10) are intentionally left to the browser.
  // ============================================================
  onKey(e) {
    if (this.editing) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey, code = e.code;

    /* ---- Alt ribbon chords: a sequence is pending (Alt+H, O, I …) ---- */
    if (this._chordNode) {
      e.preventDefault();
      if (k === 'Escape') return this.clearChord();
      const K = k.length === 1 ? k.toUpperCase() : k;
      const next = this._chordNode[K];
      if (next == null) { const path = [...this._chordKeys, K].join(', '); this.clearChord(); toast('No command for Alt+' + path); return; }
      this._chordKeys.push(K);
      if (typeof next === 'string') { this.clearChord(); return this.runChord(next); }
      this._chordNode = next; this.showChordHint(); return;
    }

    /* ---- Alt+Down: open the active cell's dropdown / filter menu ---- */
    if (alt && !ctrl && k === 'ArrowDown') { e.preventDefault(); return this.openActiveDropdown(); }

    /* ---- arrows: move · Ctrl jumps to data edge · Shift extends ---- */
    const D = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (k in D) { e.preventDefault(); const [dr, dc] = D[k]; if (ctrl) this.jumpEdge(dr, dc, shift); else this.moveActive(dr, dc, shift); return; }

    /* ---- Page keys: one screen at a time · Alt = sideways · Shift extends ---- */
    if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); const dir = k === 'PageDown' ? 1 : -1; return alt ? this.movePage(0, dir, shift) : this.movePage(dir, 0, shift); }

    /* ---- selection ---- */
    if (ctrl && shift && (k === ' ' || code === 'Space')) { e.preventDefault(); return this.selectDataRegion(); }
    if (!ctrl && !alt && shift && k === ' ') { e.preventDefault(); return this.selectEntireRow(); }
    if (ctrl && !alt && k === ' ') { e.preventDefault(); return this.selectEntireCol(); }
    if (ctrl && (k === 'a' || k === 'A')) { e.preventDefault(); this.selKind = 'all'; this.anchor = { r: 0, c: 0 }; this.active = { r: 0, c: 0 }; this.applySelection(); return; }

    /* ---- Ctrl+Shift combos that must beat their plain-Ctrl siblings ---- */
    if (ctrl && shift && (k === 'x' || k === 'X')) { e.preventDefault(); return this.clearFormatting(); }      // Excel: remove all formatting
    if (ctrl && shift && (k === 'v' || k === 'V')) { e.preventDefault(); return this.openPasteSpecial(); }     // Excel: Paste Special dialog
    if (ctrl && shift && (k === 'f' || k === 'F')) { e.preventDefault(); return this.openFindReplace(); }      // advanced find & replace
    if (ctrl && shift && (k === 'p' || k === 'P')) { e.preventDefault(); return this.printSheet(); }           // print preview
    if (ctrl && shift && (k === 'l' || k === 'L')) { e.preventDefault(); return this.toggleFilter(); }         // toggle AutoFilter
    if (ctrl && shift && (k === 't' || k === 'T')) { e.preventDefault(); return this.createFilter(); }         // create table → filtered range
    if (ctrl && shift && (k === '?' || k === '/')) { e.preventDefault(); return this.openShortcutsHelp(); }

    /* ---- clipboard ---- */
    if (ctrl && alt && (k === 'v' || k === 'V')) { e.preventDefault(); return this.openPasteSpecial(); }       // Alt+Ctrl+V: Paste Special dialog
    if (ctrl && !alt && (k === 'c' || k === 'C')) { e.preventDefault(); return this.copy(); }                  // !alt: Ctrl+Alt+C is Insert comment
    if (ctrl && !alt && (k === 'x' || k === 'X')) { e.preventDefault(); return this.cut(); }
    if (ctrl && !alt && (k === 'v' || k === 'V')) { e.preventDefault(); return this.paste(); }

    /* ---- text style ---- */
    if (ctrl && (k === 'b' || k === 'B')) { e.preventDefault(); return this.toggleStyle('b'); }
    if (ctrl && (k === 'i' || k === 'I')) { e.preventDefault(); return this.toggleStyle('i'); }
    if (ctrl && (k === 'u' || k === 'U')) { e.preventDefault(); return this.toggleStyle('u'); }
    if (alt && shift && code === 'Digit5') { e.preventDefault(); return this.toggleStyle('s'); }

    /* ---- number formats (Excel Ctrl+Shift+1..6 / ~) + Format cells (Ctrl+1) ---- */
    if (ctrl && shift && code === 'Digit1') { e.preventDefault(); return this.setNumberFormat('number'); }
    if (ctrl && shift && code === 'Digit2') { e.preventDefault(); return this.setNumberFormat('time'); }
    if (ctrl && shift && code === 'Digit3') { e.preventDefault(); return this.setNumberFormat('date'); }
    if (ctrl && shift && code === 'Digit4') { e.preventDefault(); return this.setNumberFormat('currency'); }
    if (ctrl && shift && code === 'Digit5') { e.preventDefault(); return this.setNumberFormat('percent'); }
    if (ctrl && shift && code === 'Digit6') { e.preventDefault(); return this.setNumberFormat('scientific'); }
    if (ctrl && shift && code === 'Backquote') { e.preventDefault(); return this.setNumberFormat('auto'); }    // Ctrl+Shift+~: General
    if (ctrl && shift && code === 'Digit7') { e.preventDefault(); return this.applyBorderPreset('outer', 'thin', '#000000'); } // Ctrl+Shift+&: outline border
    if (ctrl && !shift && !alt && code === 'Digit1') { e.preventDefault(); return this.openNumberFormatDlg(); }               // Ctrl+1: Format cells

    /* ---- hide / unhide rows & columns ---- */
    if (ctrl && shift && code === 'Digit9') { e.preventDefault(); return this.showAllRowsCmd(); }
    if (ctrl && shift && code === 'Digit0') { e.preventDefault(); return this.showAllColsCmd(); }
    if (ctrl && !shift && !alt && code === 'Digit9') { e.preventDefault(); return this.hideSelRows(); }
    if (ctrl && !shift && !alt && code === 'Digit0') { e.preventDefault(); return this.hideSelCols(); }

    /* ---- insert / delete cells dialogs + border removal ---- */
    if (ctrl && shift && (code === 'Minus' || code === 'NumpadSubtract')) { e.preventDefault(); return this.applyBorderPreset('none', 'thin', '#000000'); } // Ctrl+Shift+-: remove borders
    if (ctrl && ((shift && code === 'Equal') || code === 'NumpadAdd')) { e.preventDefault(); return this.insertCellsDialog(); }   // Ctrl+Shift+Plus: Insert dialog
    if (ctrl && (code === 'Minus' || code === 'NumpadSubtract')) { e.preventDefault(); return this.deleteCellsDialog(); }         // Ctrl+Minus: Delete dialog
    if (shift && k === 'Delete') { e.preventDefault(); return this.deleteCellsDialog(); }                                          // Shift+Delete: Delete dialog

    /* ---- quick entry: date/time, copy from above, fill ---- */
    if (ctrl && code === 'Semicolon') { e.preventDefault(); return this.insertToday(shift ? 'time' : 'date'); } // Ctrl+; / Ctrl+Shift+;
    if (ctrl && code === 'Quote') { e.preventDefault(); return this.copyFromAbove(shift); }                     // Ctrl+' formula · Ctrl+" value
    if (ctrl && k === 'Enter') { e.preventDefault(); return this.fillSelectionWithActive(); }                   // fill range with active cell
    if (ctrl && !shift && !alt && (k === 'd' || k === 'D')) { e.preventDefault(); return this.fillDown(); }
    if (ctrl && !shift && !alt && (k === 'r' || k === 'R')) { e.preventDefault(); return this.fillRight(); }
    if (ctrl && alt && (k === 'd' || k === 'D')) { e.preventDefault(); return this.removeDuplicatesSel(); }
    if (alt && !ctrl && (k === '=' || code === 'Equal')) { e.preventDefault(); return this.autosum(); }         // Alt+=: AutoSum

    /* ---- Alt+1..9: quick access — Nth toolbar button ---- */
    if (alt && !ctrl && !shift && /^[1-9]$/.test(k)) { e.preventDefault(); return this.quickAccess(+k); }
    /* ---- Alt+letter: start a ribbon chord (Alt+H,O,I / Alt+D,F,F / …) ---- */
    if (alt && !ctrl && !shift && /^[a-z]$/i.test(k)) { e.preventDefault(); return this.startChord(k.toUpperCase()); }

    /* ---- links / comments / notes ---- */
    if (ctrl && !shift && !alt && (k === 'k' || k === 'K')) { e.preventDefault(); e.stopPropagation(); return this.insertLinkPrompt(); }
    if (ctrl && alt && (k === 'm' || k === 'M' || k === 'c' || k === 'C')) { e.preventDefault(); return this.insertCommentPrompt(); } // Ctrl+Alt+C (Excel) / Ctrl+Alt+M
    if (!ctrl && !alt && shift && k === 'F2') { e.preventDefault(); return this.insertNotePrompt(); }

    /* ---- misc formatting / view toggles ---- */
    if (ctrl && (k === '\\' || code === 'Backslash')) { e.preventDefault(); return this.clearFormatting(); }
    if (ctrl && !shift && (k === '`' || k === '~' || code === 'Backquote')) { e.preventDefault(); return this.toggleShowFormulas(); } // Ctrl+`: show formulas

    /* ---- find / goto ---- */
    if (ctrl && (k === 'f' || k === 'F')) { e.preventDefault(); return this.openFindReplace(); }                // Ctrl+F: Find
    if (ctrl && (k === 'h' || k === 'H')) { e.preventDefault(); return this.openFindReplace(); }                // Ctrl+H: Find & Replace
    if (ctrl && (k === 'g' || k === 'G')) { e.preventDefault(); return this.jumpToCell(); }                     // Ctrl+G: Go To

    /* ---- file ---- */
    if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); this.save(); toast('Workbook saved'); return; }
    if (ctrl && (k === 'p' || k === 'P')) { e.preventDefault(); return this.printSheet(); }
    if (ctrl && !shift && !alt && (k === 'o' || k === 'O')) { e.preventDefault(); return this.importFilePrompt(); } // Ctrl+O: open/import CSV
    if (ctrl && !shift && !alt && (k === 'n' || k === 'N')) { e.preventDefault(); return this.addSheet(); }         // Ctrl+N: new sheet (browser may reserve)

    /* ---- function keys ---- */
    if (k === 'F1' && ctrl) { e.preventDefault(); return this.toggleToolbarChrome(); }                          // Ctrl+F1: toggle toolbar (ribbon)
    if (k === 'F2' && ctrl) { e.preventDefault(); return this.printSheet(); }                                   // Ctrl+F2: print preview
    if (k === 'F2') { e.preventDefault(); return this.beginEdit(); }
    if (k === 'F3') { e.preventDefault(); return this.openNamedRanges(); }                                      // F3 / Ctrl+F3 / Ctrl+Shift+F3: names
    if (k === 'F5' && !ctrl) { e.preventDefault(); return this.jumpToCell(); }                                  // F5: Go To
    if (k === 'F9') { e.preventDefault(); return this.recalc(); }                                               // F9 / Shift+F9: recalculate
    if (k === 'F10' && shift) { e.preventDefault(); return this.openContextAtActive(); }                        // Shift+F10: context menu
    if (k === 'F11' && shift) { e.preventDefault(); return this.addSheet(); }                                   // Shift+F11: new sheet
    if (k === 'F11' && !ctrl && !alt) { e.preventDefault(); return this.onUseInDashboard && this.onUseInDashboard(); } // F11 / Alt+F1: chart

    /* ---- navigation ---- */
    if (k === 'Home') { e.preventDefault(); return ctrl ? this.moveDocHome(shift) : this.moveHome(shift); }
    if (ctrl && k === 'End') { e.preventDefault(); return this.moveDocEnd(shift); }                             // Ctrl+End: last used cell
    if (ctrl && k === 'Backspace') { e.preventDefault(); return this.scrollToActive(); }                        // Ctrl+Backspace: scroll to active

    /* ---- entry ---- */
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); return this.clearSelection(); }
    if (k === 'Enter') { e.preventDefault(); return this.moveActive(shift ? -1 : 1, 0, false); }                // Shift+Enter moves up
    if (k === 'Tab') { e.preventDefault(); return this.moveActive(0, shift ? -1 : 1, false); }
    if (k.length === 1 && !ctrl && !alt) { e.preventDefault(); this.beginEdit(k); }
  }
  moveActive(dr, dc, extend) {
    const sh = this.sheet(); let r = this.active.r + dr, c = this.active.c + dc; let grew = false;
    if (r >= sh.rows) { sh.addRows(1); grew = true; } if (c >= sh.cols) { sh.addCols(1); grew = true; }
    r = clamp(r, 0, sh.rows - 1); c = clamp(c, 0, sh.cols - 1);
    this.active = { r, c }; if (!extend) { this.anchor = { r, c }; } this.selKind = 'cell';
    if (grew) this.render(); else this.applySelection();
  }
  jumpEdge(dr, dc, extend) { const t = this.dataEdge(this.sid(), this.active.r, this.active.c, dr, dc); this.active = t; if (!extend) this.anchor = { ...t }; this.selKind = 'cell'; this.applySelection(); }
  dataEdge(sid, r, c, dr, dc) {
    const sh = this.sheet(); const maxR = sh.rows - 1, maxC = sh.cols - 1;
    const inb = (rr, cc) => rr >= 0 && rr <= maxR && cc >= 0 && cc <= maxC;
    const has = (rr, cc) => this.engine.getRaw(sid, rr, cc) !== '';
    let nr = r, nc = c;
    if (!inb(r + dr, c + dc)) return { r, c };
    if (has(r, c) && has(r + dr, c + dc)) { while (inb(nr + dr, nc + dc) && has(nr + dr, nc + dc)) { nr += dr; nc += dc; } }
    else { nr += dr; nc += dc; while (inb(nr + dr, nc + dc) && !has(nr, nc)) { nr += dr; nc += dc; } }
    return { r: nr, c: nc };
  }

  /* ---------- editing ---------- */
  commitIfEditing() { if (this.editing) this.commitEdit(); }
  beginEdit(initial) {
    if (this.guardEdit()) return;
    const ma = this.mergeAnchor(this.active.r, this.active.c); if (ma) this.active = ma;
    if (this.guardProtected(this.active.r, this.active.c)) return;
    const sid = this.sid(); this.editOrigin = { sid, r: this.active.r, c: this.active.c }; this.editing = true; this.crossSheet = false; this.point = null;
    const td = this.cellAt(this.active.r, this.active.c); if (!td) return;
    const cRect = this.scrollEl.getBoundingClientRect(), tRect = td.getBoundingClientRect();
    const zoom = (this.sheet().zoom || 100) / 100;
    Object.assign(this.editor.style, { display: 'block', left: ((tRect.left - cRect.left) / zoom + this.scrollEl.scrollLeft) + 'px', top: ((tRect.top - cRect.top) / zoom + this.scrollEl.scrollTop) + 'px', width: (tRect.width / zoom) + 'px', height: (tRect.height / zoom) + 'px' });
    const cur = initial != null ? initial : this.engine.getRaw(sid, this.active.r, this.active.c);
    this.editor.value = cur; this.fx.value = cur; this.editor.focus();
    // Multiline content (Alt+Enter newlines) — grow the textarea to fit.
    if (String(cur).includes('\n')) { this.editor.style.height = 'auto'; this.editor.style.height = Math.min(this.editor.scrollHeight + 4, 300) + 'px'; }
    if (initial == null) this.editor.select(); else this.editor.setSelectionRange(cur.length, cur.length);
  }
  syncFromInput(inp) { if (inp === this.editor) this.fx.value = this.editor.value; else if (this.editor.style.display !== 'none') this.editor.value = this.fx.value; }
  onEditorKey(e, inp) {
    if (this.ac.onKeyDown(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    // Alt+Enter — newline inside the cell (Excel). Only in the floating cell
    // editor (a textarea); the fx bar stays single-line.
    if (e.key === 'Enter' && e.altKey && !ctrl && inp === this.editor) {
      e.preventDefault();
      const s = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, s) + '\n' + inp.value.slice(inp.selectionEnd ?? s);
      inp.setSelectionRange(s + 1, s + 1);
      inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight + 4, 300) + 'px'; // grow with content
      this.syncFromInput(inp);
      return;
    }
    if (e.key === 'Enter' && ctrl) { e.preventDefault(); this.commitFillSelection(); this.focusGrid(); }        // Ctrl+Enter: fill whole selection
    else if (e.key === 'Enter') { e.preventDefault(); this.commitEdit(); this.moveActive(e.shiftKey ? -1 : 1, 0, false); this.focusGrid(); } // Shift+Enter moves up
    else if (e.key === 'Tab') { e.preventDefault(); this.commitEdit(); this.moveActive(0, e.shiftKey ? -1 : 1, false); this.focusGrid(); }
    else if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); }
    else if (e.key === 'F4' && inp.value.startsWith('=')) { e.preventDefault(); this.cycleAbsRef(inp); }
    else if (ctrl && e.code === 'Semicolon') { e.preventDefault(); this.insertToday(e.shiftKey ? 'time' : 'date'); } // Ctrl+; / Ctrl+Shift+; at the caret
    if (inp === this.editor) e.stopPropagation();
  }
  commitEdit() {
    if (!this.editing) return;
    const o = this.editOrigin, val = this.fx.value;
    if (o.sid === this.sid() && this.sheet().isProtected(o.r, o.c) && val !== this.engine.getRaw(o.sid, o.r, o.c)) { this.editing = false; this.crossSheet = false; this.editor.style.display = 'none'; this.point = null; this.ac.hide(); this.fx.value = this.engine.getRaw(o.sid, o.r, o.c); this.focusGrid(); toast('This range is protected — Data ▸ Unprotect range to edit it'); return; }
    if (o.sid === this.sid() && !this.validateValue(o.sid, o.r, o.c, val)) { const dv = this.validationAt(o.sid, o.r, o.c); this.editing = false; this.crossSheet = false; this.editor.style.display = 'none'; this.point = null; this.ac.hide(); this.fx.value = this.engine.getRaw(o.sid, o.r, o.c); this.focusGrid(); toast('Invalid entry' + (dv && dv.values ? ' — choose: ' + dv.values.join(', ') : '')); return; }
    this.editing = false; this.crossSheet = false; this.editor.style.display = 'none'; this.point = null; this.ac.hide();
    this.pushUndo();
    const { changed } = this.engine.setRaw(o.sid, o.r, o.c, val);
    if (o.sid !== this.sid()) { this.wb.setActive(o.sid); this.save(); this.render(); }
    else { if (this.engine.spills.size || this.sheet().conditionalFormats.length) this.render(); else { for (const ch of changed) if (ch.sid === this.sid()) this.paintCell(ch.r, ch.c); this.save(); this.focusGrid(); } }
    if (this.scripts) this.scripts.fireEdit({ range: addrToA1(o.r, o.c), value: this.engine.getValue(o.sid, o.r, o.c) });
  }
  cancelEdit() { this.editing = false; this.crossSheet = false; this.editor.style.display = 'none'; this.point = null; this.ac.hide(); this.fx.value = this.engine.getRaw(this.sid(), this.active.r, this.active.c); this.focusGrid(); }

  /* ---------- in-formula range picking ---------- */
  canInsertRef() { const inp = this._activeInput(); const v = inp.value; if (!v.startsWith('=')) return false; const left = v.slice(0, inp.selectionStart).replace(/\s+$/, ''); return left === '=' || /[=+\-*/^&(,<>%:]$/.test(left); }
  sheetPrefixFor(sid) { const sh = this.wb.sheets.find((s) => s.id === sid); if (!sh) return ''; const nm = sh.name; return (/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm) ? nm : "'" + nm.replace(/'/g, "''") + "'") + '!'; }
  refText(sid, r1, c1, r2, c2) {
    // Foreign-workbook pick -> auto-wrap in IMPORTRANGE (latent until multi-workbook UI).
    if (this.pickForeign) { const a = addrToA1(r1, c1); const core = (r1 === r2 && c1 === c2) ? a : a + ':' + addrToA1(r2, c2); return `IMPORTRANGE("${this.pickForeign.key}","${this.pickForeign.sheet}!${core}")`; }
    const pre = sid === this.editOrigin.sid ? '' : this.sheetPrefixFor(sid);
    const a = addrToA1(r1, c1); return pre + ((r1 === r2 && c1 === c2) ? a : a + ':' + addrToA1(r2, c2));
  }
  startPick(r, c) { this.picking = { anchor: { r, c }, sid: this.sid(), input: this._activeInput() }; this.dragging = true; this.dragKind = 'pick'; this.writePick(r, c, r, c); }
  startPickAxis(kind, idx) {
    const sh = this.sheet(); this.picking = { sid: this.sid(), input: this._activeInput(), axis: kind };
    this.dragging = true; this.dragKind = 'pick';
    if (kind === 'col') this.writePickRange(this.sheetPrefixFor(this.sid() === this.editOrigin.sid ? null : this.sid()) + colToLetters(idx) + ':' + colToLetters(idx), idx, idx, 'col');
    else this.writePickRange((this.sid() === this.editOrigin.sid ? '' : this.sheetPrefixFor(this.sid())) + (idx + 1) + ':' + (idx + 1));
    this.picking.anchorIdx = idx;
  }
  extendPick(r, c) { if (!this.picking) return; if (this.picking.axis) { const i = this.picking.axis === 'col' ? c : r; const a = Math.min(this.picking.anchorIdx, i), b = Math.max(this.picking.anchorIdx, i); const pre = this.sid() === this.editOrigin.sid ? '' : this.sheetPrefixFor(this.sid()); this.writePickRange(this.picking.axis === 'col' ? pre + colToLetters(a) + ':' + colToLetters(b) : pre + (a + 1) + ':' + (b + 1)); return; } const a = this.picking.anchor; this.writePick(a.r, a.c, r, c); }
  writePick(r1, c1, r2, c2) { this.writePickRange(this.refText(this.picking.sid, Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2))); }
  writePickRange(text) {
    const inp = this.picking.input; const v = inp.value; let s, e;
    if (this.point && this.point.input === inp && this.point.end <= v.length) { s = this.point.start; e = this.point.end; } else { s = e = inp.selectionStart; }
    inp.value = v.slice(0, s) + text + v.slice(e); const ne = s + text.length; inp.setSelectionRange(ne, ne); this.point = { start: s, end: ne, input: inp };
    inp.focus(); this.syncFromInput(inp);
  }

  /* ---------- clipboard ---------- */
  copy() {
    const { r1, c1, r2, c2 } = this.rect(); const sid = this.sid(); const sh = this.sheet(); const rows = []; const vals = []; const styles = [];
    for (let r = r1; r <= r2; r++) {
      const row = []; const vrow = []; const srow = [];
      for (let c = c1; c <= c2; c++) { row.push(this.engine.getRaw(sid, r, c)); vrow.push(this.engine.getValue(sid, r, c)); srow.push(sh.getCellObj(r, c)); }
      rows.push(row); vals.push(vrow); styles.push(srow);
    }
    this.clip = { rows, vals, styles, r1, c1 };
    try { const tsv = []; for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(this.engine.getDisplay(sid, r, c)); tsv.push(row.join('\t')); } navigator.clipboard?.writeText(tsv.join('\n')); } catch {}
  }
  cut() { this.copy(); this.clearSelection(); }
  paste() {
    if (!this.clip) return;
    this.pushUndo();
    const sid = this.sid(); const { rows, r1: sr, c1: sc } = this.clip; const tr = this.active.r, tc = this.active.c; const dRow = tr - sr, dCol = tc - sc;
    const list = [];
    for (let i = 0; i < rows.length; i++) for (let j = 0; j < rows[i].length; j++) { let raw = rows[i][j]; if (raw && raw[0] === '=') raw = this.engine.translateFormula(raw, dRow, dCol); list.push({ r: tr + i, c: tc + j, raw }); }
    this.engine.setCellsBatch(sid, list);
    this.anchor = { r: tr, c: tc }; this.active = { r: tr + rows.length - 1, c: tc + (rows[0] ? rows[0].length : 1) - 1 }; this.selKind = 'cell';
    this.save(); this.render();
  }
  // Edit → Paste special → Values only [Ctrl+Shift+V] — computed values,
  // no formulas, no formatting.
  pasteValuesOnly() {
    if (!this.clip) return;
    this.pushUndo(); const sid = this.sid(); const { vals, r1: sr, c1: sc } = this.clip; const tr = this.active.r, tc = this.active.c;
    const list = [];
    for (let i = 0; i < vals.length; i++) for (let j = 0; j < vals[i].length; j++) { const v = vals[i][j]; list.push({ r: tr + i, c: tc + j, raw: (v == null || v === '') ? '' : String(v) }); }
    this.engine.setCellsBatch(sid, list);
    this.anchor = { r: tr, c: tc }; this.active = { r: tr + vals.length - 1, c: tc + (vals[0] ? vals[0].length : 1) - 1 }; this.selKind = 'cell';
    this.save(); this.render();
  }
  // Edit → Paste special → Format only [Ctrl+Alt+V] — style + number format,
  // untouched values.
  pasteFormatOnly() {
    if (!this.clip || !this.clip.styles) return;
    this.pushUndo(); const sh = this.sheet(); const { styles, r1: sr, c1: sc } = this.clip; const tr = this.active.r, tc = this.active.c;
    for (let i = 0; i < styles.length; i++) for (let j = 0; j < styles[i].length; j++) { const cell = styles[i][j] || {}; sh.setStyle(tr + i, tc + j, null); if (cell.st) sh.setStyle(tr + i, tc + j, cell.st); sh.setFormat(tr + i, tc + j, cell.nf || null); }
    this.save(); this.render();
  }
  // Edit → Paste special → Formulas only — pastes exactly what was copied
  // with no relative-reference translation (distinct from a normal paste).
  pasteFormulasOnly() {
    if (!this.clip) return;
    this.pushUndo(); const sid = this.sid(); const { rows } = this.clip; const tr = this.active.r, tc = this.active.c;
    const list = [];
    for (let i = 0; i < rows.length; i++) for (let j = 0; j < rows[i].length; j++) list.push({ r: tr + i, c: tc + j, raw: rows[i][j] });
    this.engine.setCellsBatch(sid, list);
    this.save(); this.render();
  }
  // Edit → Paste special → Transposed — swaps rows/columns on paste. Plain
  // values transpose correctly; formulas are relative-translated the same
  // way a normal paste would be (a true transpose would need to swap each
  // reference's row/column deltas individually, which the engine doesn't
  // model yet — a known, disclosed simplification rather than a silent gap).
  pasteTransposed() {
    if (!this.clip) return;
    this.pushUndo(); const sid = this.sid(); const { rows, r1: sr, c1: sc } = this.clip; const tr = this.active.r, tc = this.active.c; const dRow = tr - sr, dCol = tc - sc;
    const list = [];
    for (let i = 0; i < rows.length; i++) for (let j = 0; j < rows[i].length; j++) { let raw = rows[i][j]; if (raw && raw[0] === '=') raw = this.engine.translateFormula(raw, dRow, dCol); list.push({ r: tr + j, c: tc + i, raw }); }
    this.engine.setCellsBatch(sid, list);
    this.save(); this.render();
  }
  // Edit → Paste special → Values & formatting — values (no formulas) + style
  pasteValuesAndFormat() {
    if (!this.clip) return;
    this.pushUndo(); const sid = this.sid(); const sh = this.sheet();
    const { vals, styles, r1: sr, c1: sc } = this.clip; const tr = this.active.r, tc = this.active.c;
    for (let i = 0; i < vals.length; i++) for (let j = 0; j < (vals[i] ? vals[i].length : 0); j++) {
      const r = tr + i, c = tc + j; this.engine.setRaw(sid, r, c, String(vals[i][j] ?? ''));
      const cell = styles[i]?.[j] || {};
      sh.setStyle(r, c, null); if (cell.st) sh.setStyle(r, c, cell.st); sh.setFormat(r, c, cell.nf || null);
    }
    this.engine.recalcAll(); this.save(); this.render();
  }
  // Edit → Paste special → All except borders — paste everything, strip bd
  pasteAllExceptBorders() {
    if (!this.clip) return;
    this.pushUndo(); const sid = this.sid(); const sh = this.sheet();
    const { rows, styles, r1: sr, c1: sc } = this.clip; const tr = this.active.r, tc = this.active.c; const dRow = tr - sr, dCol = tc - sc;
    for (let i = 0; i < rows.length; i++) for (let j = 0; j < (rows[i] ? rows[i].length : 0); j++) {
      let raw = rows[i][j]; if (raw && raw[0] === '=') raw = this.engine.translateFormula(raw, dRow, dCol);
      this.engine.setRaw(sid, tr + i, tc + j, raw ?? '');
      const cell = styles[i]?.[j] || {};
      sh.setStyle(tr + i, tc + j, null);
      if (cell.st) { const stCopy = { ...cell.st }; delete stCopy.bd; sh.setStyle(tr + i, tc + j, stCopy); }
      sh.setFormat(tr + i, tc + j, cell.nf || null);
    }
    this.engine.recalcAll(); this.save(); this.render();
  }
  // Insert → Insert cells — shift existing cells down (insert blank row-segment)
  insertCellsShiftDown() {
    const { r1, c1, r2, c2 } = this.rect(); const sh = this.sheet(); const height = r2 - r1 + 1;
    this.pushUndo();
    for (let c = c1; c <= c2; c++) for (let r = sh.rows - 1; r >= r1; r--) sh.setCellObj(r + height <= sh.rows - 1 ? r + height : r, c, r >= r1 + height ? sh.getCellObj(r - height, c) : null);
    // shift down: move rows r1..end down by height within columns c1..c2
    for (let c = c1; c <= c2; c++) {
      for (let r = sh.rows - 1; r >= r1 + height; r--) sh.setCellObj(r, c, sh.getCellObj(r - height, c));
      for (let r = r1; r <= r2; r++) sh.setCellObj(r, c, null);
    }
    this.engine.recalcAll(); this.save(); this.render();
  }
  // Insert → Insert cells — shift existing cells right (insert blank col-segment)
  insertCellsShiftRight() {
    const { r1, c1, r2, c2 } = this.rect(); const sh = this.sheet(); const width = c2 - c1 + 1;
    this.pushUndo();
    for (let r = r1; r <= r2; r++) {
      for (let c = sh.cols - 1; c >= c1 + width; c--) sh.setCellObj(r, c, sh.getCellObj(r, c - width));
      for (let c = c1; c <= c2; c++) sh.setCellObj(r, c, null);
    }
    this.engine.recalcAll(); this.save(); this.render();
  }
  // Write one filled cell: translated formula (or literal / series value) from
  // source (sr,sc) into (r,c), carrying style/format. Single setCellObj write —
  // no clobber, since translated raw + style are merged into one object before
  // recalcAll re-parses it.
  _writeFilledCell(sid, sh, sr, sc, r, c, seriesVal) {
    let raw = this.engine.getRaw(sid, sr, sc);
    if (raw && raw[0] === '=') raw = this.engine.translateFormula(raw, r - sr, c - sc);
    else if (seriesVal != null) raw = String(seriesVal);
    const src = sh.getCellObj(sr, sc);
    const obj = src ? { ...src } : {};
    delete obj.v;
    if (raw === '' || raw == null) delete obj.raw; else obj.raw = String(raw);
    sh.setCellObj(r, c, obj);
  }
  // Arithmetic-series step across a line of source raws, or null if not a clean
  // numeric progression (formulas / non-numbers / <2 points → copy instead).
  _seriesInfo(raws) {
    const nums = []; for (const rw of raws) { if (rw !== '' && rw != null && rw[0] !== '=' && isNumericRaw(rw)) nums.push(Number(String(rw).replace(/[,%\s₹$€£]/g, ''))); else return null; }
    if (nums.length < 2) return null;
    const step = (nums[nums.length - 1] - nums[0]) / (nums.length - 1);
    for (let i = 1; i < nums.length; i++) if (Math.abs((nums[i] - nums[i - 1]) - step) > 1e-9) return null;
    return { first: nums[0], step };
  }
  // Edit → Fill down [Ctrl+D] — copy top row of selection down to all rows
  fillDown() {
    const { r1, c1, r2, c2 } = this.rect(); if (r1 === r2) return;
    const sid = this.sid(); const sh = this.sheet();
    this.pushUndo();
    for (let c = c1; c <= c2; c++) for (let r = r1 + 1; r <= r2; r++) this._writeFilledCell(sid, sh, r1, c, r, c);
    this.engine.recalcAll(); this.save(); this.render();
  }
  // Edit → Fill right [Ctrl+R] — copy left col of selection right to all cols
  fillRight() {
    const { r1, c1, r2, c2 } = this.rect(); if (c1 === c2) return;
    const sid = this.sid(); const sh = this.sheet();
    this.pushUndo();
    for (let r = r1; r <= r2; r++) for (let c = c1 + 1; c <= c2; c++) this._writeFilledCell(sid, sh, r, c1, r, c);
    this.engine.recalcAll(); this.save(); this.render();
  }

  /* ---------- fill handle (Google-Sheets corner drag) ---------- */
  // Reposition (or create) the little square handle at the selection's
  // bottom-right corner. Lives inside #msScroll as a sibling of the table so
  // it shares the scroll/zoom coordinate space (same math as beginEdit).
  // getBoundingClientRect() below forces a synchronous layout, and this runs
  // at the end of applySelection() - microseconds after _tbodyHTML replaced
  // the entire tbody, so the browser must lay the whole new table out before
  // it can answer. Measured on a real scroll of the production workbook:
  // 13.3 ms per call, 266 ms of a 20-repaint scroll - essentially ALL of
  // applySelection's 13.1 ms/call, more than building the HTML.
  // The handle is a 4px square at the selection corner; one frame late is
  // invisible. Deferring to rAF lets the browser lay out once in its own
  // phase, where the rects are free. Coalesced, so a fast scroll schedules
  // one placement, not one per frame.
  positionFillHandle() {
    if (this._fhPending) return;
    if (typeof requestAnimationFrame !== 'function') return this._placeFillHandle();
    this._fhPending = requestAnimationFrame(() => { this._fhPending = 0; this._placeFillHandle(); });
  }
  _placeFillHandle() {
    if (!this.scrollEl || !this.tableEl) return;
    let h = this.scrollEl.querySelector('#msFillHandle');
    if (this.dragKind === 'fill') { if (h) h.style.display = 'none'; return; }
    const { r2, c2 } = this.rect();
    const td = this.cellAt(r2, c2);
    if (!td) { if (h) h.style.display = 'none'; return; }
    if (!h) { h = document.createElement('div'); h.id = 'msFillHandle'; h.className = 'ms-fill-handle'; h.addEventListener('mousedown', (e) => this.startFill(e)); this.scrollEl.appendChild(h); }
    const cRect = this.scrollEl.getBoundingClientRect(), tRect = td.getBoundingClientRect();
    const zoom = (this.sheet().zoom || 100) / 100;
    const left = (tRect.right - cRect.left) / zoom + this.scrollEl.scrollLeft;
    const top = (tRect.bottom - cRect.top) / zoom + this.scrollEl.scrollTop;
    Object.assign(h.style, { display: 'block', left: (left - 4) + 'px', top: (top - 4) + 'px' });
  }
  startFill(e) {
    e.preventDefault(); e.stopPropagation();
    this.commitIfEditing();
    this._fillSrc = this.rect(); this._fillTarget = { ...this._fillSrc };
    this.dragging = true; this.dragKind = 'fill';
  }
  // Extend the fill target to the cell under the pointer, constrained to the
  // single dominant axis (like Sheets — you fill down OR right, not both).
  updateFillTarget(r, c) {
    const s = this._fillSrc; if (!s) return;
    const downBy = r > s.r2 ? r - s.r2 : (r < s.r1 ? r - s.r1 : 0);
    const rightBy = c > s.c2 ? c - s.c2 : (c < s.c1 ? c - s.c1 : 0);
    let t;
    if (Math.abs(downBy) >= Math.abs(rightBy)) t = { r1: Math.min(s.r1, r), r2: Math.max(s.r2, r), c1: s.c1, c2: s.c2 };
    else t = { r1: s.r1, r2: s.r2, c1: Math.min(s.c1, c), c2: Math.max(s.c2, c) };
    this._fillTarget = t;
    this.paintFillPreview();
  }
  paintFillPreview() {
    this.tableEl.querySelectorAll('.ms-fill-prev').forEach((el) => el.classList.remove('ms-fill-prev'));
    const s = this._fillSrc, t = this._fillTarget; if (!s || !t) return;
    for (let r = t.r1; r <= t.r2; r++) for (let c = t.c1; c <= t.c2; c++) {
      if (r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2) continue;
      this.cellAt(r, c)?.classList.add('ms-fill-prev');
    }
  }
  clearFillPreview() { this.tableEl?.querySelectorAll('.ms-fill-prev').forEach((el) => el.classList.remove('ms-fill-prev')); }
  commitFill() {
    if (this.access && !this.access.canEdit) { this.dragging = false; this.dragKind = null; return; }
    const s = this._fillSrc, t = this._fillTarget;
    this._fillSrc = null; this._fillTarget = null; this.clearFillPreview();
    if (!s || !t) return;
    if (t.r1 === s.r1 && t.r2 === s.r2 && t.c1 === s.c1 && t.c2 === s.c2) return;
    const sid = this.sid(), sh = this.sheet();
    const srcH = s.r2 - s.r1 + 1, srcW = s.c2 - s.c1 + 1;
    const vertical = (t.c1 === s.c1 && t.c2 === s.c2);
    this.pushUndo();
    // Precompute per-line arithmetic series (only when the source spans the fill
    // axis and holds a clean numeric progression).
    const series = new Map();
    if (vertical) { for (let c = s.c1; c <= s.c2; c++) { const raws = []; for (let r = s.r1; r <= s.r2; r++) raws.push(this.engine.getRaw(sid, r, c)); series.set(c, this._seriesInfo(raws)); } }
    else { for (let r = s.r1; r <= s.r2; r++) { const raws = []; for (let c = s.c1; c <= s.c2; c++) raws.push(this.engine.getRaw(sid, r, c)); series.set(r, this._seriesInfo(raws)); } }
    for (let r = t.r1; r <= t.r2; r++) for (let c = t.c1; c <= t.c2; c++) {
      if (r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2) continue; // leave source intact
      const sr = s.r1 + (((r - s.r1) % srcH) + srcH) % srcH;
      const sc = s.c1 + (((c - s.c1) % srcW) + srcW) % srcW;
      let seriesVal = null;
      const info = series.get(vertical ? c : r);
      if (info) seriesVal = info.first + (vertical ? (r - s.r1) : (c - s.c1)) * info.step;
      this._writeFilledCell(sid, sh, sr, sc, r, c, seriesVal);
    }
    this.anchor = { r: t.r1, c: t.c1 }; this.active = { r: t.r2, c: t.c2 }; this.selKind = 'cell';
    this.engine.recalcAll(); this.save(); this.render();
  }
  // Open categorized function browser modal
  openFunctionBrowser() {
    const cats = {
      Math: ['ABS','CEILING','EVEN','EXP','FLOOR','GCD','INT','LCM','LN','LOG','MOD','MROUND','ODD','PI','POWER','PRODUCT','QUOTIENT','RAND','RANDBETWEEN','ROUND','ROUNDDOWN','ROUNDUP','SIGN','SQRT','SUM','SUMIF','SUMIFS','SUMPRODUCT','TRUNC'],
      Statistical: ['AVERAGE','AVERAGEIF','COUNT','COUNTA','COUNTBLANK','COUNTIF','COUNTIFS','LARGE','MAX','MEDIAN','MIN','MODE','SMALL'],
      Logical: ['AND','FALSE','IF','IFERROR','IFNA','IFS','NOT','OR','SWITCH','TRUE','XOR'],
      Text: ['CHAR','CODE','CONCAT','CONCATENATE','EXACT','FIND','LEFT','LEN','LOWER','MID','PROPER','REPLACE','REPT','RIGHT','SEARCH','SUBSTITUTE','TEXT','TEXTJOIN','TRIM','UPPER','VALUE','HYPERLINK'],
      'Lookup & Reference': ['CHOOSE','COLUMN','COLUMNS','HLOOKUP','INDEX','INDIRECT','MATCH','ROW','ROWS','VLOOKUP'],
      'Date & Time': ['DATE','DAY','DAYS','EDATE','EOMONTH','HOUR','MINUTE','MONTH','NOW','SECOND','TODAY','WEEKDAY','YEAR'],
      Info: ['ISBLANK','ISERROR','ISNA','ISNUMBER','ISTEXT'],
    };
    const allFns = [...new Set(Object.values(cats).flat())].sort();
    const catList = ['All', ...Object.keys(cats)];
    const renderFns = (fns) => fns.map((fn) => `<button class="ms-fn-item" data-fn="${fn}">${fn}</button>`).join('');
    const m = this.modal(`<h3 style="margin-bottom:4px">Insert function</h3>
      <div class="ms-fn-browser">
        <div class="ms-fn-cats">${catList.map((c, i) => `<button class="ms-fn-cat${i === 0 ? ' active' : ''}" data-cat="${c}">${c}</button>`).join('')}</div>
        <div class="ms-fn-list" id="msFnList">${renderFns(allFns)}</div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="fnClose">Cancel</button></div>`);
    m.querySelector('#fnClose').onclick = () => m.remove();
    const listEl = m.querySelector('#msFnList');
    const wireList = () => listEl.querySelectorAll('.ms-fn-item').forEach((btn) => btn.addEventListener('click', () => {
      m.remove(); this.beginEdit('=' + btn.dataset.fn + '(');
    }));
    wireList();
    m.querySelectorAll('.ms-fn-cat').forEach((btn) => {
      btn.addEventListener('click', () => {
        m.querySelectorAll('.ms-fn-cat').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const fns = btn.dataset.cat === 'All' ? allFns : (cats[btn.dataset.cat] || []).slice().sort();
        listEl.innerHTML = renderFns(fns); wireList();
      });
    });
  }
  // Format → Number → Custom number format dialog
  openNumberFormatDlg() {
    const { r, c } = this.active; const curFmt = this.sheet().getFormat(r, c) || '';
    const presets = [
      { label: 'Automatic', fmt: null },
      { label: 'Number (1,234.00)', fmt: 'number' },
      { label: 'Percent (12.34%)', fmt: 'percent' },
      { label: 'Currency ($1,234)', fmt: 'currency' },
      { label: 'Date (DD/MM/YYYY)', fmt: 'date' },
      { label: 'Time (HH:MM:SS)', fmt: 'time' },
      { label: 'Scientific (1.23E+2)', fmt: 'scientific' },
    ];
    const presetHTML = presets.map((p) => `<button class="ms-nf-opt${curFmt === (p.fmt || '') ? ' active' : ''}" data-fmt="${p.fmt || ''}">${p.label}</button>`).join('');
    const m = this.modal(`<h3>Number format</h3>
      <div class="ms-nf-options">${presetHTML}</div>
      <hr style="border:none;border-top:1px solid var(--line);margin:8px 0">
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:6px">Custom format code:</div>
      <div class="ms-nf-custom-row"><input id="nfCustom" placeholder='e.g. DD/MM/YYYY or #,##0.00 or "£"#,##0' value="${curFmt}"></div>
      <div class="ms-nf-preview" id="nfPreview">Preview: —</div>
      <div class="modal-actions"><button class="btn btn-ghost" id="nfClose">Cancel</button><button class="btn btn-primary" id="nfApply">Apply</button></div>`);
    const inp = m.querySelector('#nfCustom'); const prev = m.querySelector('#nfPreview');
    const sampleVal = this.engine.getValue(this.sid(), r, c);
    const updatePreview = () => {
      try { const v = inp.value.trim(); const display = v ? this.engine.formatValue?.(sampleVal, v) ?? sampleVal : sampleVal; prev.textContent = 'Preview: ' + (display ?? '—'); } catch { prev.textContent = 'Preview: —'; }
    };
    inp.addEventListener('input', updatePreview); updatePreview();
    m.querySelectorAll('.ms-nf-opt').forEach((btn) => btn.addEventListener('click', () => {
      m.querySelectorAll('.ms-nf-opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      inp.value = btn.dataset.fmt; updatePreview();
    }));
    m.querySelector('#nfClose').onclick = () => m.remove();
    m.querySelector('#nfApply').onclick = () => { const v = inp.value.trim(); this.setNumberFormat(v || 'auto'); m.remove(); };
  }
  /* ---------- Border studio popover (design: "Border Menu 1D" / opt4) ---------- */
  // Border config presets — edges use logical keys incl. inner grid lines.
  bdPresets() {
    return {
      all:       { edges: { top: 1, right: 1, bottom: 1, left: 1, innerV: 1, innerH: 1 } },
      outer:     { edges: { top: 1, right: 1, bottom: 1, left: 1, innerV: 0, innerH: 0 } },
      inner:     { edges: { top: 0, right: 0, bottom: 0, left: 0, innerV: 1, innerH: 1 } },
      none:      { edges: { top: 0, right: 0, bottom: 0, left: 0, innerV: 0, innerH: 0 } },
      invoice:   { edges: { top: 1, right: 1, bottom: 1, left: 1, innerV: 0, innerH: 1 }, thickness: 1,   style: 'solid',  color: '#1B1915', radius: 0 },
      header:    { edges: { top: 0, right: 0, bottom: 1, left: 0, innerV: 0, innerH: 0 }, thickness: 2.5, style: 'solid',  color: '#C6A366', radius: 0 },
      total:     { edges: { top: 1, right: 0, bottom: 1, left: 0, innerV: 0, innerH: 0 }, thickness: 3,   style: 'double', color: '#1B1915', radius: 0 },
      ledger:    { edges: { top: 0, right: 0, bottom: 0, left: 0, innerV: 0, innerH: 1 }, thickness: 1,   style: 'solid',  color: '#B9AE97', radius: 0 },
      minimal:   { edges: { top: 1, right: 1, bottom: 1, left: 1, innerV: 0, innerH: 0 }, thickness: 1,   style: 'solid',  color: '#8B8271', radius: 8 },
      'box-dash':{ edges: { top: 1, right: 1, bottom: 1, left: 1, innerV: 0, innerH: 0 }, thickness: 1.5, style: 'dashed', color: '#C6A366', radius: 0 },
    };
  }
  // Apply a full border config to the selection. Overwrites bd/bdr/bdg on
  // every cell in the range (deterministic — matches the live-preview model).
  applyBorderConfig(cfg, opts = {}) {
    const { r1, c1, r2, c2 } = opts.rect || this.rect(); const sh = this.sheet();
    if (!opts.noUndo) this.pushUndo();
    const e = cfg.edges;
    const mk = () => ({ style: cfg.style || 'solid', color: cfg.color || '#000000', w: cfg.thickness || 1 });
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const bd = {};
      if (r === r1 ? e.top : e.innerH) bd.t = mk();
      if (c === c1 ? e.left : e.innerV) bd.l = mk();
      if (r === r2 && e.bottom) bd.b = mk();
      if (c === c2 && e.right) bd.r = mk();
      const on = Object.keys(bd).length > 0;
      const patch = { bd: on ? bd : false, bdg: false, bdr: false };
      if (cfg.glow && on) patch.bdg = cfg.color || '#C6A366';
      if (cfg.radius) {
        const bdr = {};
        if (r === r1 && c === c1) bdr.tl = cfg.radius;
        if (r === r1 && c === c2) bdr.tr = cfg.radius;
        if (r === r2 && c === c2) bdr.br = cfg.radius;
        if (r === r2 && c === c1) bdr.bl = cfg.radius;
        if (Object.keys(bdr).length) patch.bdr = bdr;
      }
      sh.setStyle(r, c, patch);
    }
    if (!opts.noSave) this.save();
    this.render();
  }
  // Smart Snap: grow the selection to the contiguous non-empty block.
  bdSmartDetect() {
    const sid = this.sid(); const sh = this.sheet();
    const filled = (r, c) => String(this.engine.getRaw(sid, r, c) ?? '').trim() !== '';
    const anyIn = (rr1, cc1, rr2, cc2) => { for (let r = rr1; r <= rr2; r++) for (let c = cc1; c <= cc2; c++) if (filled(r, c)) return true; return false; };
    let { r1, c1, r2, c2 } = this.rect();
    if (!anyIn(r1, c1, r2, c2)) return null;
    let grown = true;
    while (grown) {
      grown = false;
      if (r1 > 0 && anyIn(r1 - 1, c1, r1 - 1, c2)) { r1--; grown = true; }
      if (r2 < sh.rows - 1 && anyIn(r2 + 1, c1, r2 + 1, c2)) { r2++; grown = true; }
      if (c1 > 0 && anyIn(r1, c1 - 1, r2, c1 - 1)) { c1--; grown = true; }
      if (c2 < sh.cols - 1 && anyIn(r1, c2 + 1, r2, c2 + 1)) { c2++; grown = true; }
    }
    return { r1, c1, r2, c2 };
  }
  // Open the border studio anchored to the borders toolbar button.
  openBorderPicker(anchor) {
    document.getElementById('msBdrPan')?.remove();
    const PRESETS = this.bdPresets();
    const PRESET_LIST = [['all', 'All'], ['outer', 'Outer'], ['inner', 'Inner'], ['invoice', 'Invoice'], ['header', 'Table header'], ['total', 'Total row'], ['ledger', 'Ledger'], ['minimal', 'Minimal'], ['box-dash', 'Dashed box']];
    const FIXED5 = ['#1B1915', '#C6A366', '#3B6FB0', '#C24A4A', '#4E9A6A'];
    let recent; try { recent = JSON.parse(localStorage.getItem('msBdRecent') || 'null'); } catch { recent = null; }
    if (!Array.isArray(recent) || !recent.length) recent = FIXED5.slice();
    // Session config survives reopen within this grid instance.
    const cfg = this._bdCfg || (this._bdCfg = { edges: { top: 1, right: 1, bottom: 1, left: 1, innerV: 1, innerH: 1 }, thickness: 1, style: 'solid', color: '#1B1915', radius: 0, glow: false, preset: 'all' });
    cfg.recent = recent;
    let undoPushed = false; let raf = 0;
    const commit = (saveNow = true) => {
      if (!undoPushed) { this.pushUndo(); undoPushed = true; }
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; this.applyBorderConfig(cfg, { noUndo: true, noSave: !saveNow }); });
    };
    const thickName = (t) => (t <= 0.5 ? 'Hairline' : t <= 1 ? 'Thin' : t <= 2 ? 'Medium' : t <= 3 ? 'Bold' : 'Thick');
    /* --- svg builders (ported 1:1 from the reference design) --- */
    const posSvg = (kind, on, off) => {
      const S = { t: 'M5 5H19', b: 'M5 19H19', l: 'M5 5V19', r: 'M19 5V19', iv: 'M12 5V19', ih: 'M5 12H19' };
      const B = { all: ['t', 'b', 'l', 'r', 'iv', 'ih'], outer: ['t', 'b', 'l', 'r'], inner: ['iv', 'ih'], top: ['t'], bottom: ['b'], left: ['l'], right: ['r'], none: [] };
      const bold = B[kind] || [];
      let out = Object.keys(S).map((k) => `<path d="${S[k]}" stroke="${bold.includes(k) ? on : off}" stroke-width="${bold.includes(k) ? 2 : 1}" stroke-linecap="round"/>`).join('');
      if (kind === 'none') out += `<path d="M7 7L17 17" stroke="${on}" stroke-width="2" stroke-linecap="round"/><path d="M17 7L7 17" stroke="${on}" stroke-width="2" stroke-linecap="round"/>`;
      return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">${out}</svg>`;
    };
    const stySvg = (style, color) => {
      if (style === 'double') return `<svg width="32" height="22" viewBox="0 0 32 22" fill="none"><line x1="3" y1="8.5" x2="29" y2="8.5" stroke="${color}" stroke-width="1.6"/><line x1="3" y1="13.5" x2="29" y2="13.5" stroke="${color}" stroke-width="1.6"/></svg>`;
      const dash = style === 'dashed' ? ' stroke-dasharray="6 4"' : style === 'dotted' ? ' stroke-dasharray="0.5 5"' : '';
      return `<svg width="32" height="22" viewBox="0 0 32 22" fill="none"><line x1="3" y1="11" x2="29" y2="11" stroke="${color}" stroke-width="${style === 'dotted' ? 3 : 2.2}"${dash} stroke-linecap="round"/></svg>`;
    };
    const sparkle = '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 2.5l2 5.6 5.6 2-5.6 2-2 5.6-2-5.6-5.6-2 5.6-2z" fill="currentColor"/></svg>';
    const eyeSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M17 3.5a2.1 2.1 0 0 1 3 3L9 17.5l-4 1 1-4z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 6.5l3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const closeSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const miniIcon = (p) => {
      const e = p.edges; const col = p.color || 'var(--ink)'; const sw = Math.min(2, (p.thickness || 1) + 0.4); const sty = p.style || 'solid';
      const bd = (on) => (on ? `${sw}px ${sty} ${col}` : '1px solid var(--line)');
      return `<span class="ms-bdx-mini" style="border-top:${bd(e.top)};border-bottom:${bd(e.bottom)};border-left:${bd(e.left)};border-right:${bd(e.right)};border-radius:${p.radius ? 4 : 2}px">${e.innerH ? `<i style="left:0;right:0;top:50%;border-top:${sw}px ${sty} ${col}"></i>` : ''}${e.innerV ? `<i style="top:0;bottom:0;left:50%;border-left:${sw}px ${sty} ${col}"></i>` : ''}</span>`;
    };
    /* --- dynamic section renderers --- */
    const POS_LIST = ['all', 'outer', 'inner', 'top', 'bottom', 'left', 'right', 'none'];
    const isPosPreset = (k) => ['all', 'outer', 'inner', 'none'].includes(k);
    const posHtml = () => POS_LIST.map((k) => {
      const a = isPosPreset(k) ? cfg.preset === k : !!cfg.edges[k];
      return `<button class="ms-bdx-posbtn${a ? ' active' : ''}" data-pos="${k}" title="${k}">${posSvg(k, a ? 'var(--gold-deep)' : 'var(--ink)', 'var(--ink-faint)')}</button>`;
    }).join('');
    const styHtml = () => ['solid', 'dashed', 'dotted', 'double'].map((s) => `<button class="ms-bdx-stybtn${cfg.style === s ? ' active' : ''}" data-sty="${s}" title="${s}">${stySvg(s, cfg.style === s ? 'var(--ink)' : 'var(--ink-faint)')}</button>`).join('');
    const presetsHtml = () => PRESET_LIST.map(([k, label]) => `<button class="ms-bdx-chip${cfg.preset === k ? ' active' : ''}" data-preset="${k}">${miniIcon(PRESETS[k])}${label}</button>`).join('');
    const recentsHtml = () => [cfg.color, ...FIXED5.filter((c) => c.toLowerCase() !== cfg.color.toLowerCase())].slice(0, 6).map((c, i) => `<button class="ms-bdx-rsw${i === 0 ? ' cur' : ''}" data-col="${c}" title="${i === 0 ? 'Selected color' : c}" style="background:${c}"></button>`).join('');
    const prevHtml = () => {
      const data = [['Item', 'Qty', 'Price', 'Total'], ['Granite', 12, 4500, 54000], ['Marble', 70, 6200, 434000], ['Quartz', 20, 5100, 102000]];
      const R = 4, C = 4, cw = 56; const e = cfg.edges;
      const w = cfg.style === 'double' ? Math.max(3, cfg.thickness * 1.6) : cfg.thickness;
      const bs = `${w}px ${cfg.style} ${cfg.color}`;
      let cells = '';
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
        const top = r === 0 ? e.top : e.innerH, left = c === 0 ? e.left : e.innerV, bottom = r === R - 1 && e.bottom, right = c === C - 1 && e.right;
        const head = r === 0;
        let cs = `justify-content:${c === 0 ? 'flex-start' : 'flex-end'};font-weight:${head ? 600 : 400};font-family:${c === 0 ? 'inherit' : 'var(--mono, ui-monospace)'};color:${head ? 'var(--ink)' : 'var(--ink-soft)'};background:${head ? 'var(--surface)' : 'var(--surface2)'};border-top:${top ? bs : '1px solid var(--line-soft)'};border-left:${left ? bs : '1px solid var(--line-soft)'};border-bottom:${bottom ? bs : '1px solid var(--line-soft)'};border-right:${right ? bs : '1px solid var(--line-soft)'}`;
        if (cfg.radius) {
          if (r === 0 && c === 0) cs += `;border-top-left-radius:${cfg.radius}px`;
          if (r === 0 && c === C - 1) cs += `;border-top-right-radius:${cfg.radius}px`;
          if (r === R - 1 && c === 0) cs += `;border-bottom-left-radius:${cfg.radius}px`;
          if (r === R - 1 && c === C - 1) cs += `;border-bottom-right-radius:${cfg.radius}px`;
        }
        cells += `<span style="${cs}">${data[r][c]}</span>`;
      }
      const glow = cfg.glow ? `<i class="ms-bdx-prevglow" style="border:${Math.max(2, cfg.thickness)}px solid ${cfg.color};border-radius:${(cfg.radius || 6) + 2}px;box-shadow:0 0 16px ${cfg.color}88,0 0 4px ${cfg.color}aa"></i>` : '';
      return `<span class="ms-bdx-prevgrid" style="grid-template-columns:repeat(${C},${cw}px)">${cells}</span>${glow}`;
    };
    /* --- panel shell --- */
    const pan = document.createElement('div'); pan.className = 'ms-bdx'; pan.id = 'msBdrPan';
    pan.innerHTML = `
      <div class="ms-bdx-head">
        <div><div class="ms-bdx-title">Border</div><div class="ms-bdx-sub">Start from a style, refine on the right</div></div>
        <button class="ms-bdx-close" data-close>${closeSvg}</button>
      </div>
      <div class="ms-bdx-body">
        <div class="ms-bdx-left">
          <button class="ms-bdx-snap" data-snap>
            <span class="ms-bdx-snap-ic">${sparkle}</span>
            <span class="ms-bdx-snap-tx"><b>Smart Snap</b><i id="bdxSnapMsg">Detect table &amp; auto-border</i></span>
          </button>
          <div class="ms-bdx-label">Saved styles</div>
          <div class="ms-bdx-presets" id="bdxPresets">${presetsHtml()}</div>
        </div>
        <div class="ms-bdx-vd"></div>
        <div class="ms-bdx-right">
          <div class="ms-bdx-label">Position</div>
          <div class="ms-bdx-pos" id="bdxPos">${posHtml()}</div>
          <div class="ms-bdx-row">
            <div class="ms-bdx-col">
              <div class="ms-bdx-label">Thickness</div>
              <input type="range" id="bdxTh" min="0.5" max="5" step="0.5" value="${cfg.thickness}">
              <div class="ms-bdx-thmeta"><span id="bdxThName">${thickName(cfg.thickness)}</span><span id="bdxThPx">${cfg.thickness}px</span></div>
            </div>
            <div class="ms-bdx-col">
              <div class="ms-bdx-label">Style</div>
              <div class="ms-bdx-styles" id="bdxSty">${styHtml()}</div>
            </div>
          </div>
          <div class="ms-bdx-row">
            <div class="ms-bdx-col">
              <div class="ms-bdx-label">Color</div>
              <div class="ms-bdx-color">
                <span class="ms-bdx-sw" id="bdxSw" style="background:${cfg.color}"><input type="color" id="bdxColIn" value="${cfg.color}"></span>
                <span class="ms-bdx-hex" id="bdxHex">${cfg.color}</span>
                <button class="ms-bdx-eye" id="bdxEye" title="Eyedropper">${eyeSvg}</button>
              </div>
              <div class="ms-bdx-recents" id="bdxRecents">${recentsHtml()}</div>
            </div>
            <div class="ms-bdx-col ms-bdx-narrow">
              <div class="ms-bdx-label">Radius</div>
              <div class="ms-bdx-step"><button data-rd="-2">–</button><span id="bdxRad">${cfg.radius}px</span><button data-rd="2">+</button></div>
              <button class="ms-bdx-glowbtn${cfg.glow ? ' on' : ''}" id="bdxGlow"><span class="ms-bdx-tog"><span></span></span>Glow</button>
            </div>
          </div>
          <div class="ms-bdx-prevwrap">
            <div class="ms-bdx-label">Preview</div>
            <div class="ms-bdx-prev" id="bdxPrev">${prevHtml()}</div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(pan);
    const rect = anchor ? anchor.getBoundingClientRect() : { left: 100, bottom: 80 };
    pan.style.left = Math.max(8, Math.min(rect.left, innerWidth - pan.offsetWidth - 8)) + 'px';
    pan.style.top = Math.max(8, Math.min(rect.bottom + 6, innerHeight - pan.offsetHeight - 8)) + 'px';
    /* --- sync + wiring --- */
    const $ = (sel) => pan.querySelector(sel);
    const sync = () => {
      $('#bdxPos').innerHTML = posHtml();
      $('#bdxSty').innerHTML = styHtml();
      $('#bdxPresets').innerHTML = presetsHtml();
      $('#bdxRecents').innerHTML = recentsHtml();
      $('#bdxPrev').innerHTML = prevHtml();
      $('#bdxTh').value = cfg.thickness;
      $('#bdxThName').textContent = thickName(cfg.thickness);
      $('#bdxThPx').textContent = cfg.thickness + 'px';
      $('#bdxRad').textContent = cfg.radius + 'px';
      $('#bdxSw').style.background = cfg.color; $('#bdxColIn').value = cfg.color; $('#bdxHex').textContent = cfg.color.toUpperCase();
      $('#bdxGlow').classList.toggle('on', !!cfg.glow);
    };
    const setColor = (val) => {
      cfg.color = val;
      cfg.recent = [val, ...cfg.recent.filter((c) => c.toLowerCase() !== val.toLowerCase())].slice(0, 6);
      try { localStorage.setItem('msBdRecent', JSON.stringify(cfg.recent)); } catch {}
      sync(); commit();
    };
    const applyPreset = (name) => {
      const p = PRESETS[name]; if (!p) return;
      cfg.edges = { ...p.edges }; cfg.preset = name;
      ['thickness', 'style', 'color', 'radius'].forEach((k) => { if (p[k] !== undefined) cfg[k] = p[k]; });
      sync(); commit();
    };
    pan.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.closest('[data-close]')) { pan.remove(); document.removeEventListener('keydown', onKey); return; }
      const pos = t.closest('[data-pos]');
      if (pos) {
        const k = pos.dataset.pos;
        if (isPosPreset(k)) applyPreset(k);
        else { cfg.edges[k] = cfg.edges[k] ? 0 : 1; cfg.preset = 'custom'; sync(); commit(); }
        return;
      }
      const sty = t.closest('[data-sty]'); if (sty) { cfg.style = sty.dataset.sty; sync(); commit(); return; }
      const chip = t.closest('[data-preset]'); if (chip) { applyPreset(chip.dataset.preset); return; }
      const rsw = t.closest('[data-col]'); if (rsw) { setColor(rsw.dataset.col); return; }
      const rd = t.closest('[data-rd]'); if (rd) { cfg.radius = Math.min(16, Math.max(0, cfg.radius + (+rd.dataset.rd))); sync(); commit(); return; }
      if (t.closest('#bdxGlow')) { cfg.glow = !cfg.glow; sync(); commit(); return; }
      if (t.closest('#bdxEye')) {
        if (window.EyeDropper) { try { new window.EyeDropper().open().then((r) => setColor(r.sRGBHex)).catch(() => {}); } catch {} }
        else toast('Eyedropper not supported in this browser');
        return;
      }
      if (t.closest('[data-snap]')) {
        const blk = this.bdSmartDetect();
        const msg = $('#bdxSnapMsg');
        if (!blk) { msg.textContent = 'No table found here'; msg.classList.add('pop'); setTimeout(() => { msg.textContent = 'Detect table & auto-border'; msg.classList.remove('pop'); }, 2800); return; }
        this.anchor = { r: blk.r1, c: blk.c1 }; this.active = { r: blk.r2, c: blk.c2 }; this.selKind = 'cell';
        Object.assign(cfg, { edges: { top: 1, right: 1, bottom: 1, left: 1, innerV: 0, innerH: 1 }, thickness: 1.25, style: 'solid', color: '#1B1915', preset: 'custom' });
        sync(); commit();
        msg.textContent = `Table detected · ${blk.r2 - blk.r1 + 1}×${blk.c2 - blk.c1 + 1} · bordered`; msg.classList.add('pop');
        setTimeout(() => { if (pan.isConnected) { msg.textContent = 'Detect table & auto-border'; msg.classList.remove('pop'); } }, 2800);
        return;
      }
    });
    const th = $('#bdxTh');
    th.addEventListener('input', () => {
      cfg.thickness = parseFloat(th.value); cfg.preset = 'custom';
      $('#bdxThName').textContent = thickName(cfg.thickness); $('#bdxThPx').textContent = cfg.thickness + 'px';
      $('#bdxPrev').innerHTML = prevHtml();
      commit(false); // live but unsaved while dragging
    });
    th.addEventListener('change', () => { sync(); commit(true); });
    $('#bdxColIn').addEventListener('input', (ev) => setColor(ev.target.value));
    const onKey = (ev) => { if (ev.key === 'Escape') { pan.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    setTimeout(() => document.addEventListener('mousedown', function h(ev) { if (!pan.contains(ev.target)) { pan.remove(); document.removeEventListener('mousedown', h); document.removeEventListener('keydown', onKey); } }), 0);
  }
  applyBorderPreset(preset, style, color) {
    const makeSide = () => ({ style, color });
    const { r1, c1, r2, c2 } = this.rect(); const sh = this.sheet();
    this.pushUndo();
    if (preset === 'none') { this.forEachSel((r, c) => sh.setStyle(r, c, { bd: false })); this.save(); this.render(); return; }
    if (preset === 'all')  { this.forEachSel((r, c) => sh.setStyle(r, c, { bd: { t: makeSide(), b: makeSide(), l: makeSide(), r: makeSide() } })); this.save(); this.render(); return; }
    if (preset === 'outer') {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const bd = {}; if (r === r1) bd.t = makeSide(); if (r === r2) bd.b = makeSide(); if (c === c1) bd.l = makeSide(); if (c === c2) bd.r = makeSide();
        if (Object.keys(bd).length) sh.setStyle(r, c, { bd });
      }
      this.save(); this.render(); return;
    }
    if (preset === 'inner') {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const bd = {}; if (r > r1) bd.t = makeSide(); if (r < r2) bd.b = makeSide(); if (c > c1) bd.l = makeSide(); if (c < c2) bd.r = makeSide();
        if (Object.keys(bd).length) sh.setStyle(r, c, { bd });
      }
      this.save(); this.render(); return;
    }
    const sideMap = { top: 't', bottom: 'b', left: 'l', right: 'r' };
    const side = sideMap[preset]; if (!side) return;
    this.forEachSel((r, c) => { const cur = sh.getStyle(r, c) || {}; const bd = (cur.bd && typeof cur.bd === 'object') ? { ...cur.bd } : {}; bd[side] = makeSide(); sh.setStyle(r, c, { bd }); });
    this.save(); this.render();
  }
  clearSelection() {
    if (this.guardEdit()) return;
    const { r1, c1, r2, c2 } = this.rect(); const sid = this.sid(); const sh = this.sheet(); const list = []; let blocked = false;
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { if (this.engine.getRaw(sid, r, c) === '') continue; if (sh.isProtected(r, c)) { blocked = true; continue; } list.push({ r, c, raw: '' }); }
    if (blocked && !list.length) { toast('This range is protected — Data ▸ Unprotect range to edit it'); return; }
    if (!list.length) return; this.pushUndo(); this.engine.setCellsBatch(sid, list); this.save(); this.render();
  }

  /* ---------- structural ---------- */
  insertRowAbove() { const { r1 } = this.rect(); this.pushUndo(); this.engine.insertRows(this.sid(), r1, this.selRows()); this.afterStruct(); }
  insertRowBelow() { const { r2 } = this.rect(); this.pushUndo(); this.engine.insertRows(this.sid(), r2 + 1, this.selRows()); this.afterStruct(); }
  insertColLeft() { const { c1 } = this.rect(); this.pushUndo(); this.engine.insertCols(this.sid(), c1, this.selCols()); this.afterStruct(); }
  insertColRight() { const { c2 } = this.rect(); this.pushUndo(); this.engine.insertCols(this.sid(), c2 + 1, this.selCols()); this.afterStruct(); }
  deleteSelRows() { const { r1, r2 } = this.rect(); this.pushUndo(); this.engine.deleteRows(this.sid(), r1, r2 - r1 + 1); this.afterStruct(); }
  deleteSelCols() { const { c1, c2 } = this.rect(); this.pushUndo(); this.engine.deleteCols(this.sid(), c1, c2 - c1 + 1); this.afterStruct(); }
  selRows() { const { r1, r2 } = this.rect(); return r2 - r1 + 1; }
  selCols() { const { c1, c2 } = this.rect(); return c2 - c1 + 1; }
  afterStruct() { const sh = this.sheet(); this.active = { r: clamp(this.active.r, 0, sh.rows - 1), c: clamp(this.active.c, 0, sh.cols - 1) }; this.anchor = { ...this.active }; this.selKind = 'cell'; this.save(); this.render(); }
  // Edit → Delete → Cells and shift up/left. Shifts cell *content* only —
  // formulas elsewhere that reference the shifted cells are not renumbered
  // (that would need dependency-graph-aware reference rewriting, out of
  // scope here), same disclosed simplification as pasteTransposed above.
  deleteCellsShiftUp() {
    const { r1, c1, r2, c2 } = this.rect(); const sh = this.sheet(); const height = r2 - r1 + 1;
    this.pushUndo();
    for (let c = c1; c <= c2; c++) for (let r = r1; r <= sh.rows - 1; r++) sh.setCellObj(r, c, (r + height <= sh.rows - 1) ? sh.getCellObj(r + height, c) : null);
    this.engine.recalcAll(); this.save(); this.render();
  }
  deleteCellsShiftLeft() {
    const { r1, c1, r2, c2 } = this.rect(); const sh = this.sheet(); const width = c2 - c1 + 1;
    this.pushUndo();
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= sh.cols - 1; c++) sh.setCellObj(r, c, (c + width <= sh.cols - 1) ? sh.getCellObj(r, c + width) : null);
    this.engine.recalcAll(); this.save(); this.render();
  }

  /* ---------- undo/redo ----------
     Delta undo. pushUndo() closes the previous transaction and opens the next,
     so the 95 call sites need no changes at all: whatever they mutate between
     one pushUndo and the following one IS the transaction. A microtask also
     closes it, so a transaction never spans an await.

     Cost is proportional to the EDIT, not the workbook: typing in one cell
     records ~100 bytes whatever the sheet size. The old model serialised the
     whole workbook every keystroke - 80 MB and 4.2 s on a 155k-row sheet.

     verifyUndo (dev) keeps a real snapshot beside each delta and checks the
     inverse reproduces it exactly. A missed journal hook would otherwise fail
     silently, which is the one failure mode worth engineering against. */
  pushUndo() {
    this._fontCache?.delete(this.sid());   // M8: any mutation may add fonts — rescan on next render
    this._closeTx();
    this._openTx();
  }

  _openTx() {
    if (!this._journal) this._journal = new UndoJournal();
    this._journal.begin(this.wb);
    setActiveJournal(this._journal);
    if (this.verifyUndo) this._verifyBefore = canonicalJson(this.wb);
    // Close on the microtask too, so an operation that awaits cannot keep the
    // transaction open across unrelated work.
    if (!this._txScheduled) {
      this._txScheduled = true;
      Promise.resolve().then(() => { this._txScheduled = false; this._closeTx(); });
    }
  }

  _closeTx() {
    if (!this._journal || !this._journal.open) return;
    const tx = this._journal.commit(this.wb);
    setActiveJournal(null);
    const before = this._verifyBefore; this._verifyBefore = null;
    if (!tx) return;
    if (this.verifyUndo && before) this._verifyInverse(tx, before);
    this.undoStack.push(tx);
    while (this.undoStack.length > MonoGrid.UNDO_DEPTH) this.undoStack.shift();
    this.redoStack = [];
  }

  // Replay the inverse onto a throwaway copy and compare with a genuine
  // snapshot. Any mutation path that is not journalled shows up here.
  _verifyInverse(tx, beforeJson) {
    try {
      const copy = MonoWorkbook.fromJSON(JSON.parse(JSON.stringify(this.wb.toJSON())));
      applyInverse(copy, tx, (json) => new MonoSheet(json));
      const got = canonicalJson(copy);
      if (got !== beforeJson) {
        // eslint-disable-next-line no-console
        console.error('[undo] the recorded inverse does NOT reproduce the previous state', { expected: JSON.parse(beforeJson), got: JSON.parse(got) });
        toast('Undo verification failed for the last action - see the console.');
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[undo] verification threw', e);
    }
  }

  /** Turn on the dev oracle: every action is checked, and any cell changed
   *  outside a transaction is reported the moment it happens. */
  setVerifyUndo(on) { this.verifyUndo = !!on; setStrictJournal(!!on); }

  // Undo and redo are the same operation: apply an inverse while journalling,
  // and the transaction that falls out is the step back the other way.
  undo() { this._step(this.undoStack, this.redoStack); }
  redo() { this._step(this.redoStack, this.undoStack); }

  _step(from, to) {
    this._closeTx();
    if (!from.length) return;
    const tx = from.pop();
    if (!this._journal) this._journal = new UndoJournal();
    this._journal.begin(this.wb);
    setActiveJournal(this._journal);
    let back = null;
    try {
      applyInverse(this.wb, tx, (json) => new MonoSheet(json), this._journal);
      back = this._journal.commit(this.wb);
    } finally { setActiveJournal(null); }
    if (back) to.push(back);
    this._afterRestore();
  }

  _afterRestore() {
    this.engine = new Engine(this.wb);
    this._fontCache = null;   // M8: sheets may have been replaced
    const sh = this.sheet();
    this.active = { r: clamp(this.active.r, 0, sh.rows - 1), c: clamp(this.active.c, 0, sh.cols - 1) };
    this.anchor = { ...this.active };
    this.editing = false;
    this.save(); this.render();
  }

  restore(tx) {
    if (!tx) return;
    applyInverse(this.wb, tx, (json) => new MonoSheet(json));
    this._afterRestore();
  }

  /* ---------- sheets / tabs ---------- */
  onTab(id) {
    if (this.editing && id !== this.sid()) { const text = this.fx.value; this.crossSheet = true; this.wb.setActive(id); this.render(); this.editing = true; this.fx.value = text; this.fx.focus(); this.ac.hide(); this.notifySheetListChange(); return; }
    this.commitIfEditing(); this.wb.setActive(id); this.active = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 }; this.selKind = 'cell'; this.save(); this.render(); this.notifySheetListChange();
  }
  // U3: sidebar's sheet list needs to know whenever the sheet *list itself*
  // changes (switch/add/rename/duplicate/delete) — not on every cell edit,
  // which would be wasteful. Kept separate from onChange/save.
  notifySheetListChange() { if (this.onSheetListChange) this.onSheetListChange(); }
  addSheet() { if (this.guardEdit()) return; this.commitIfEditing(); this.pushUndo(); this.wb.addSheet(); this.active = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 }; this.selKind = 'cell'; this.engine.recalcAll(); this.save(); this.render(); this.notifySheetListChange(); }
  // U3: shared by the tab-strip dblclick AND the sidebar row-menu "Rename" —
  // one rename implementation instead of two.
  renameSheetPrompt(id) {
    if (this.guardEdit()) return;
    const sh = this.wb.sheets.find((s) => s.id === id); if (!sh) return;
    const name = prompt('Rename sheet', sh.name);
    if (name && name.trim()) { this.pushUndo(); this.wb.renameSheet(id, name.trim()); this.engine.recalcAll(); this.save(); this.render(); this.notifySheetListChange(); }
  }
  duplicateSheet(id) {
    if (this.guardEdit()) return;
    const sh = this.wb.sheets.find((s) => s.id === id); if (!sh) return;
    this.commitIfEditing(); this.pushUndo();
    const json = sh.toJSON(); delete json.id;
    const used = new Set(this.wb.sheets.map((s) => s.name)); let n = sh.name + ' copy', i = 2;
    while (used.has(n)) n = sh.name + ' copy ' + (i++);
    json.name = n;
    const clone = new (Object.getPrototypeOf(sh)).constructor(json);
    this.wb.sheets.push(clone); this.wb.activeSheetId = clone.id;
    this.active = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 }; this.selKind = 'cell';
    this.engine.recalcAll(); this.save(); this.render(); this.notifySheetListChange();
  }
  deleteSheetPrompt(id) {
    if (this.access && !this.access.isOwner) { toast('Only the owner can delete sheets.'); return; }
    const sh = this.wb.sheets.find((s) => s.id === id); if (!sh) return;
    if (this.wb.sheets.length <= 1) { toast('A workbook needs at least one sheet'); return; }
    if (!confirm(`Delete sheet "${sh.name}"? This can't be undone once you leave this session.`)) return;
    this.pushUndo(); this.wb.removeSheet(id);
    this.active = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 }; this.selKind = 'cell';
    this.engine.recalcAll(); this.save(); this.render(); this.notifySheetListChange();
  }

  /* ---------- misc ---------- */
  exportCSV() {
    const sh = this.sheet(); const sid = sh.id; const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = []; for (let r = 0; r < sh.rows; r++) { const row = []; for (let c = 0; c < sh.cols; c++) row.push(esc(this.engine.getDisplay(sid, r, c))); lines.push(row.join(',')); }
    while (lines.length && lines[lines.length - 1].replace(/,/g, '') === '') lines.pop();
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${sh.name}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
  /* ---------- Phase 3: formatting + data tools ---------- */
  cellStyleAttr(sid, r, c, stPre) {
    const sh = this.sheet(); const st0 = stPre || sh.getStyle(r, c);
    const cfs = sh.conditionalFormats; const hasCf = !!(cfs && cfs.length);
    // H9 fast path (performance_resolution_report.md): the overwhelmingly
    // common cell has no style on a sheet with no conditional formats —
    // skip cf evaluation and string building entirely.
    if (!hasCf && (!st0 || Object.keys(st0).length === 0)) return '';
    const st = st0 || {};
    const cf = hasCf ? (cfStyleFor(this.engine.getValue(sid, r, c), cfs, r, c) || {}) : {};
    const p = [];
    if (cf.bold || st.b) p.push('font-weight:700');
    if (st.i) p.push('font-style:italic');
    const dec = []; if (st.u) dec.push('underline'); if (st.s) dec.push('line-through'); if (dec.length) p.push('text-decoration:' + dec.join(' '));
    // `st.fc` and the l|c|r / t|m|b initials are what the xlsx importer used
    // to write. Nothing ever rendered them: this read st.fg, and 'c' produced
    // "text-align:c", which is invalid CSS and silently dropped. The importer
    // now writes fg and full words; these fallbacks heal workbooks already
    // saved from an earlier import, which is every xlsx opened until now.
    const fg = cf.fg || st.fg || st.fc; if (fg) p.push('color:' + fg);
    const bg = cf.bg || st.bg; if (bg) p.push('background:' + bg);
    if (st.ha) p.push('text-align:' + (HA[st.ha] || st.ha));
    if (st.fs) p.push('font-size:' + st.fs + 'px');
    if (st.ff) { const _ff = st.ff; p.push('font-family:' + ((!_ff.startsWith("'") && !_ff.startsWith('"') && _ff.includes(' ')) ? "'" + _ff + "'" : _ff)); }
    if (st.va) p.push('vertical-align:' + (VA[st.va] || st.va));
    // Format → Wrapping [overflow(default) / wrap / clip]. Legacy boolean
    // `st.wrap` (pre-parity) is treated as an alias for 'wrap'.
    const ws = st.ws || (st.wrap ? 'wrap' : 'overflow');
    if (ws === 'wrap') p.push('white-space:normal;overflow-wrap:anywhere');
    else if (ws === 'clip') p.push('white-space:nowrap;overflow:hidden;text-overflow:clip');
    if (st.bd === 'all') {
      p.push('box-shadow:inset 0 0 0 1px var(--ink-faint)');
    } else if (st.bd && typeof st.bd === 'object') {
      // Per-side border object: { t, b, l, r } each { style, color, w? }.
      // Fast path: all-solid borders render as inset box-shadows (no extra DOM,
      // avoids border-collapse conflicts). Dashed/dotted/double lines, corner
      // radius and glow need real CSS borders → rendered by an absolutely
      // positioned overlay <i class="ms-bd-ov"> injected in the cell (see
      // borderOverlayHtml), because box-shadow cannot draw non-solid lines.
      if (this.bdNeedsOverlay(st)) {
        p.push('position:relative');
      } else {
        const shadows = [];
        const side = (s, dx, dy) => { const n = this.bdSide(s); if (!n) return; shadows.push(`inset ${dx * n.w}px ${dy * n.w}px 0 0 ${n.col}`); };
        side(st.bd.t, 0, 1); side(st.bd.b, 0, -1); side(st.bd.l, 1, 0); side(st.bd.r, -1, 0);
        if (shadows.length) p.push('box-shadow:' + shadows.join(','));
      }
      if (st.bdr) { const r = st.bdr; p.push(`border-radius:${r.tl || 0}px ${r.tr || 0}px ${r.br || 0}px ${r.bl || 0}px`); }
      if (st.bdg) p.push('--ms-bdg:' + (typeof st.bdg === 'string' ? st.bdg : '#C6A366'));
    }
    return p.join(';');
  }
  // Normalize a border side to { sty, col, w }. Legacy style names
  // (thin/medium/thick) map to solid with widths 1/2/3px; new sides carry an
  // explicit px width in `w` (0.5–6) and style solid/dashed/dotted/double.
  bdSide(s) {
    if (!s) return null;
    const legacy = { thin: 1, medium: 2, thick: 3 };
    let sty = s.style || 'solid'; let w = s.w;
    if (legacy[sty]) { if (w == null) w = legacy[sty]; sty = 'solid'; }
    if (w == null) w = sty === 'double' ? 3 : 1;
    return { sty, col: s.color || '#000', w: Math.max(0.5, Math.min(6, +w || 1)) };
  }
  bdNeedsOverlay(st) {
    if (!st) return false;
    if (st.bdr || st.bdg) return !!(st.bd && typeof st.bd === 'object');
    const bd = st.bd; if (!bd || typeof bd !== 'object') return false;
    for (const k of ['t', 'b', 'l', 'r']) { const s = bd[k]; if (s && s.style && s.style !== 'solid' && s.style !== 'thin' && s.style !== 'medium' && s.style !== 'thick') return true; }
    return false;
  }
  // Overlay element for cells whose borders can't be drawn with box-shadow.
  // Zero layout impact: absolutely positioned, pointer-events:none. Double
  // lines get a wider effective stroke so both lines stay visible at 30px rows.
  borderOverlayHtml(st) {
    if (!this.bdNeedsOverlay(st)) return '';
    const s = [];
    const side = (k, name) => { const n = this.bdSide(st.bd[k]); if (!n) return; const w = n.sty === 'double' ? Math.max(3, n.w * 1.6) : n.w; s.push(`border-${name}:${w}px ${n.sty} ${n.col}`); };
    side('t', 'top'); side('b', 'bottom'); side('l', 'left'); side('r', 'right');
    if (st.bdr) { const r = st.bdr; s.push(`border-radius:${r.tl || 0}px ${r.tr || 0}px ${r.br || 0}px ${r.bl || 0}px`); }
    return `<i class="ms-bd-ov" style="${s.join(';')}"></i>`;
  }
  forEachSel(fn) { const { r1, c1, r2, c2 } = this.rect(); for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) fn(r, c); }
  applyStyle(patch) { this.pushUndo(); const sh = this.sheet(); this.forEachSel((r, c) => sh.setStyle(r, c, patch)); this.save(); this.render(); }
  toggleStyle(key) { const cur = this.sheet().getStyle(this.active.r, this.active.c) || {}; this.applyStyle({ [key]: cur[key] ? false : 1 }); }
  setAlign(a) { const cur = this.sheet().getStyle(this.active.r, this.active.c) || {}; this.applyStyle({ ha: cur.ha === a ? false : a }); }
  toggleWrap() { const cur = this.sheet().getStyle(this.active.r, this.active.c) || {}; this.applyStyle({ wrap: cur.wrap ? false : 1 }); }
  setBorders(kind) { this.applyStyle({ bd: kind === 'none' ? false : kind }); }
  applyColor(kind, color) { this.applyStyle(kind === 'fg' ? { fg: color || false } : { bg: color || false }); }
  setNumberFormat(nf) { this.pushUndo(); const sh = this.sheet(); this.forEachSel((r, c) => sh.setFormat(r, c, nf === 'auto' ? null : nf)); this.save(); this.render(); }
  decimals(delta) { this.pushUndo(); const sh = this.sheet(); this.forEachSel((r, c) => sh.setFormat(r, c, withDecimals(sh.getFormat(r, c), delta))); this.save(); this.render(); }
  openColorPalette(kind, anchor) {
    document.getElementById('msPal')?.remove();
    const colors = ['#1B1A17', '#6C685D', '#CF4F33', '#E0892F', '#D4A76A', '#B8944F', '#4F9D69', '#5E7FA6', '#A98EC0', '#FFFFFF', '#F4F1E9', '#FBEFCB', '#E4F0E6', '#E6ECF3', '#F8E2DB'];
    const el = document.createElement('div'); el.className = 'ms-pal'; el.id = 'msPal';
    el.innerHTML = `<div class="ms-pal-grid">${colors.map((c) => `<button class="ms-sw" style="background:${c}" data-col="${c}"></button>`).join('')}</div><div class="ms-pal-row"><label>Custom <input type="color" id="msPalCustom"></label><button class="ms-pal-reset">Reset</button></div>`;
    document.body.appendChild(el);
    const rect = anchor ? anchor.getBoundingClientRect() : { left: 200, bottom: 120 };
    el.style.left = Math.min(rect.left, innerWidth - el.offsetWidth - 6) + 'px'; el.style.top = (rect.bottom + 4) + 'px';
    el.querySelectorAll('.ms-sw').forEach((b) => b.addEventListener('click', () => { this.applyColor(kind, b.dataset.col); el.remove(); }));
    el.querySelector('#msPalCustom').addEventListener('input', (e) => this.applyColor(kind, e.target.value));
    el.querySelector('.ms-pal-reset').addEventListener('click', () => { this.applyColor(kind, null); el.remove(); });
    setTimeout(() => document.addEventListener('mousedown', function h(ev) { if (!el.contains(ev.target)) { el.remove(); document.removeEventListener('mousedown', h); } }), 0);
  }
  sortSel(dir) {
    this.pushUndo(); const { r1, c1, r2, c2 } = this.rect(); const sid = this.sid(); const sh = this.sheet();
    const keyCol = (this.active.c >= c1 && this.active.c <= c2) ? this.active.c : c1;
    const rows = [];
    for (let r = r1; r <= r2; r++) { const o = { k: this.engine.getValue(sid, r, keyCol), cells: {} }; for (let c = c1; c <= c2; c++) o.cells[c] = sh.getCellObj(r, c); rows.push(o); }
    rows.sort((a, b) => { const x = a.k, y = b.k; let cmp; if (typeof x === 'number' && typeof y === 'number') cmp = x - y; else cmp = String(x ?? '').toLowerCase() < String(y ?? '').toLowerCase() ? -1 : (String(x ?? '') > String(y ?? '') ? 1 : 0); return dir === 'desc' ? -cmp : cmp; });
    for (let i = 0; i < rows.length; i++) for (let c = c1; c <= c2; c++) sh.setCellObj(r1 + i, c, rows[i].cells[c]);
    this.engine.recalcAll(); this.save(); this.render();
  }
  modal(html) { const back = document.createElement('div'); back.className = 'modal-backdrop'; back.innerHTML = `<div class="modal">${html}</div>`; document.body.appendChild(back); back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); }); return back; }
  openFindReplace() {
    const m = this.modal(`<h3>Find &amp; replace</h3><div class="form-row"><label>Find</label><input id="frFind"></div><div class="form-row"><label>Replace with</label><input id="frRepl"></div><div class="form-row"><label style="font-weight:400"><input type="checkbox" id="frCase"> Match case</label></div><div id="frStat" class="muted"></div><div class="modal-actions"><button class="btn btn-ghost" id="frFindBtn">Find next</button><button class="btn btn-ghost" id="frAll">Replace all</button><button class="btn btn-primary" id="frClose">Done</button></div>`);
    const find = m.querySelector('#frFind'); find.focus();
    m.querySelector('#frClose').onclick = () => m.remove();
    m.querySelector('#frFindBtn').onclick = () => { const ok = this.findNext(find.value, m.querySelector('#frCase').checked); m.querySelector('#frStat').textContent = ok ? '' : 'No match'; };
    m.querySelector('#frAll').onclick = () => { const k = this.replaceAll(find.value, m.querySelector('#frRepl').value, m.querySelector('#frCase').checked); m.querySelector('#frStat').textContent = k + ' replaced'; };
  }
  findNext(q, matchCase) {
    if (!q) return false; const sh = this.sheet(); const sid = sh.id; const norm = (s) => matchCase ? s : s.toLowerCase(); const Q = norm(q); const tot = sh.rows * sh.cols;
    const start = this.active.r * sh.cols + this.active.c + 1;
    for (let i = 0; i < tot; i++) { const idx = (start + i) % tot; const r = Math.floor(idx / sh.cols), c = idx % sh.cols; const d = this.engine.getDisplay(sid, r, c); if (d && norm(String(d)).includes(Q)) { this.select(r, c); return true; } }
    return false;
  }
  replaceAll(q, repl, matchCase) {
    if (!q) return 0; const sh = this.sheet(); const sid = sh.id; const list = []; let n = 0;
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
    for (let r = 0; r < sh.rows; r++) for (let c = 0; c < sh.cols; c++) { const raw = sh.getRaw(r, c); if (raw) { const matches = raw.match(rx); if (matches) { list.push({ r, c, raw: raw.replace(rx, repl) }); n += matches.length; } } }
    if (list.length) { this.pushUndo(); this.engine.setCellsBatch(sid, list); this.save(); this.render(); }
    return n;
  }
  openNamedRanges() {
    const { r1, c1, r2, c2 } = this.rect(); const sel = addrToA1(r1, c1) + (r1 === r2 && c1 === c2 ? '' : ':' + addrToA1(r2, c2));
    const list = Object.entries(this.wb.namedRanges);
    const m = this.modal(`<h3>Named ranges</h3><div class="form-row"><label>Name</label><input id="nrName" placeholder="e.g. sales"></div><div class="form-row"><label>Range</label><input id="nrRange" value="${this.sheet().name}!${sel}"></div><div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-primary" id="nrAdd">Add / update</button></div><div class="form-row"><label>Existing</label><div id="nrList">${list.length ? list.map(([k, v]) => `<div class="ms-nr-item"><span class="mono">${k}</span><button data-del="${k}" class="xmini">${icon('x', { size: 11 })}</button></div>`).join('') : '<span class="muted">none</span>'}</div></div><div class="modal-actions"><button class="btn btn-ghost" id="nrClose">Close</button></div>`);
    m.querySelector('#nrClose').onclick = () => m.remove();
    m.querySelector('#nrAdd').onclick = () => { const name = m.querySelector('#nrName').value.trim(); if (!name) return; const spec = this.parseRangeSpec(m.querySelector('#nrRange').value); if (!spec) return toast('Bad range'); this.pushUndo(); this.wb.addNamedRange(name, spec); this.engine.recalcAll(); this.save(); m.remove(); this.render(); };
    m.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { this.pushUndo(); this.wb.removeNamedRange(b.dataset.del); this.engine.recalcAll(); this.save(); m.remove(); this.render(); this.openNamedRanges(); });
  }
  parseRangeSpec(text) {
    let s = String(text).trim(); let sid = this.sid(); const bang = s.indexOf('!'); if (bang >= 0) { const nm = s.slice(0, bang).replace(/^'|'$/g, ''); const sh = this.wb.sheets.find((x) => x.name.toLowerCase() === nm.toLowerCase()); if (sh) sid = sh.id; s = s.slice(bang + 1); }
    const parts = s.split(':'); const A = /([A-Za-z]+)(\d+)/.exec(parts[0]); if (!A) return null;
    const col = (L) => { let n = 0; for (const ch of L.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
    let r1 = +A[2] - 1, c1 = col(A[1]), r2 = r1, c2 = c1;
    if (parts[1]) { const B = /([A-Za-z]+)(\d+)/.exec(parts[1]); if (B) { r2 = +B[2] - 1; c2 = col(B[1]); } }
    return { sid, r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  }
  openCondFormat() {
    const { r1, c1, r2, c2 } = this.rect();
    const m = this.modal(`<h3>Conditional formatting</h3><div class="form-row"><label>For ${addrToA1(r1, c1)}:${addrToA1(r2, c2)}, format when cell is</label><select id="cfOp"><option value="gt">greater than</option><option value="lt">less than</option><option value="gte">&ge;</option><option value="lte">&le;</option><option value="between">between</option><option value="eq">equal to</option><option value="contains">text contains</option><option value="notEmpty">not empty</option></select></div><div class="form-row" id="cfVals"><input id="cfV1" placeholder="value"><input id="cfV2" placeholder="and" style="display:none"></div><div class="form-row"><label>Format</label><select id="cfStyle"><option value="g">Green fill</option><option value="r">Red fill</option><option value="a">Amber fill</option><option value="bo">Bold red text</option></select></div><div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-primary" id="cfAdd">Add rule</button></div><div class="form-row"><label>Rules on this sheet</label><div id="cfList">${this.sheet().conditionalFormats.map((rl, i) => `<div class="ms-nr-item"><span class="muted">${rl.cond ? rl.cond.op + ' ' + (rl.cond.v1 ?? '') : (rl.type || 'imported rule')}</span><button data-del="${i}" class="xmini">${icon('x', { size: 11 })}</button></div>`).join('') || '<span class="muted">none</span>'}</div></div><div class="modal-actions"><button class="btn btn-ghost" id="cfClose">Close</button></div>`);
    const op = m.querySelector('#cfOp'); op.onchange = () => { m.querySelector('#cfV2').style.display = op.value === 'between' ? '' : 'none'; m.querySelector('#cfV1').style.display = op.value === 'notEmpty' ? 'none' : ''; };
    m.querySelector('#cfClose').onclick = () => m.remove();
    const styles = { g: { bg: '#E4F0E6' }, r: { bg: '#F8E2DB' }, a: { bg: '#FBEAD3' }, bo: { fg: '#CF4F33', bold: 1 } };
    m.querySelector('#cfAdd').onclick = () => { const rule = { range: { r1, c1, r2, c2 }, cond: { op: op.value, v1: m.querySelector('#cfV1').value, v2: m.querySelector('#cfV2').value }, style: styles[m.querySelector('#cfStyle').value] }; this.pushUndo(); this.sheet().conditionalFormats.push(rule); this.save(); m.remove(); this.render(); };
    m.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { this.pushUndo(); this.sheet().conditionalFormats.splice(+b.dataset.del, 1); this.save(); m.remove(); this.render(); this.openCondFormat(); });
  }
  command(cmd) {
    if (this.access && !this.access.canEdit && !MonoGrid.RO_COMMANDS.has(cmd)) { this.guardEdit(); return; }
    if (this.editing && cmd !== 'copy') this.commitEdit();
    switch (cmd) {
      case 'bold': return this.toggleStyle('b');
      case 'italic': return this.toggleStyle('i');
      case 'underline': return this.toggleStyle('u');
      case 'strike': return this.toggleStyle('s');
      case 'alignL': return this.setAlign('left');
      case 'alignC': return this.setAlign('center');
      case 'alignR': return this.setAlign('right');
      case 'wrap': return this.toggleWrap();
      case 'borderAll':    return this.applyBorderPreset('all',    'thin', '#000000');
      case 'borderNone':   return this.applyBorderPreset('none',   'thin', '#000000');
      case 'borderOuter':  return this.applyBorderPreset('outer',  'thin', '#000000');
      case 'borderInner':  return this.applyBorderPreset('inner',  'thin', '#000000');
      case 'borderTop':    return this.applyBorderPreset('top',    'thin', '#000000');
      case 'borderBottom': return this.applyBorderPreset('bottom', 'thin', '#000000');
      case 'borderLeft':   return this.applyBorderPreset('left',   'thin', '#000000');
      case 'borderRight':  return this.applyBorderPreset('right',  'thin', '#000000');
      case 'borders':      return this.openBorderPicker(this.host.querySelector('[data-cmd="borders"]'));
      case 'textColor': return this.openColorPalette('fg', this.host.querySelector('[data-cmd="textColor"]'));
      case 'fillColor': return this.openColorPalette('bg', this.host.querySelector('[data-cmd="fillColor"]'));
      case 'nfAuto': return this.setNumberFormat('auto');
      case 'nfNumber': return this.setNumberFormat('number');
      case 'nfPercent': return this.setNumberFormat('percent');
      case 'nfCurrency': return this.setNumberFormat('currency');
      case 'nfDate': return this.setNumberFormat('date');
      case 'nfTime': return this.setNumberFormat('time');
      case 'nfScientific': return this.setNumberFormat('scientific');
      case 'decInc': return this.decimals(1);
      case 'decDec': return this.decimals(-1);
      case 'sortAsc': return this.sortSel('asc');
      case 'sortDesc': return this.sortSel('desc');
      case 'named': return this.openNamedRanges();
      case 'find': return this.openFindReplace();
      case 'cond': return this.openCondFormat();
      case 'useInDashboard': return this.onUseInDashboard && this.onUseInDashboard();
      case 'createFilter': return this.createFilter();
      case 'removeFilter': return this.removeFilter();
      case 'condBar': return this.openDataBar();
      case 'condScale': return this.openCondScale();
      case 'merge': return this.mergeSel('all');
      case 'mergeHoriz': return this.mergeSel('h');
      case 'mergeVert': return this.mergeSel('v');
      case 'unmerge': return this.unmergeSel();
      case 'freezeRow': return this.freezeRows(this.active.r + 1);
      case 'freezeCol': return this.freezeCols(this.active.c + 1);
      case 'freezeNoRows': return this.freezeRows(0);
      case 'freeze1Row': return this.freezeRows(1);
      case 'freeze2Rows': return this.freezeRows(2);
      case 'freezeUpToRow': return this.freezeRows(this.active.r + 1);
      case 'freezeNoCols': return this.freezeCols(0);
      case 'freeze1Col': return this.freezeCols(1);
      case 'freeze2Cols': return this.freezeCols(2);
      case 'freezeUpToCol': return this.freezeCols(this.active.c + 1);
      case 'unfreeze': return this.unfreeze();
      case 'validation': return this.openValidation();
      // ---- Google-parity commands ----
      case 'paintFormat': return this.paintFormatStart();
      case 'clearFormat': return this.clearFormatting();
      case 'print': return this.printSheet();
      case 'insertLink': return this.insertLinkPrompt();
      case 'insertComment': return this.insertCommentPrompt();
      case 'insertNote': return this.insertNotePrompt();
      case 'insertCheckbox': return this.insertCheckboxCmd();
      case 'insertDropdown': return this.insertDropdownCmd();
      case 'insertChart': return this.onUseInDashboard && this.onUseInDashboard();
      case 'clearNotes': return this.clearNotesSel();
      case 'hideRow': return this.hideSelRows();
      case 'hideCol': return this.hideSelCols();
      case 'resizeRowPrompt': return this.resizeRowPrompt();
      case 'resizeRowFit': return this.resizeRowFitSel();
      case 'resizeColPrompt': return this.resizeColPrompt();
      case 'resizeColFit': return this.resizeColFitSel();
      case 'resizeAllCols': return this.resizeAllColsSel();
      case 'showAllRows': return this.showAllRowsCmd();
      case 'showAllCols': return this.showAllColsCmd();
      case 'protectRange': return this.protectSel();
      case 'unprotectRange': return this.unprotectSel();
      case 'vAlignTop': return this.setVAlign('top');
      case 'vAlignMiddle': return this.setVAlign('middle');
      case 'vAlignBottom': return this.setVAlign('bottom');
      case 'wrapOverflow': return this.setWrapMode('overflow');
      case 'wrapWrap': return this.setWrapMode('wrap');
      case 'wrapClip': return this.setWrapMode('clip');
      case 'toggleGridlines': return this.toggleGridlines();
      case 'toggleShowFormulas': return this.toggleShowFormulas();
      case 'toggleFullScreen': return this.toggleFullScreen();
      case 'jumpToCell': return this.jumpToCell();
      case 'trimWhitespace': return this.trimWhitespaceSel();
      case 'removeDuplicates': return this.removeDuplicatesSel();
      case 'randomizeRange': return this.randomizeSel();
      case 'splitTextToCols': return this.splitTextToColumns();
      case 'autosum': return this.autosum();
      case 'fnSum': return this.insertFunction('SUM');
      case 'fnAverage': return this.insertFunction('AVERAGE');
      case 'fnCount': return this.insertFunction('COUNT');
      case 'fnMax': return this.insertFunction('MAX');
      case 'fnMin': return this.insertFunction('MIN');
      case 'shortcutsHelp': return this.openShortcutsHelp();
      case 'deleteValues': return this.clearSelection();
      case 'filterByCellValue': return this.filterByCellValue(this.active.r, this.active.c);
      case 'sortColAsc': return this.sortColumnHeader(this.active.c, 'asc');
      case 'sortColDesc': return this.sortColumnHeader(this.active.c, 'desc');
      case 'getCellRef': return this.copyCellReference(this.active.r, this.active.c);
      case 'trimWhitespaceSel': return this.trimWhitespaceSel();
      case 'pasteValuesOnly':       return this.pasteValuesOnly();
      case 'pasteFormatOnly':       return this.pasteFormatOnly();
      case 'pasteFormulasOnly':     return this.pasteFormulasOnly();
      case 'pasteTransposed':       return this.pasteTransposed();
      case 'pasteValuesAndFormat':  return this.pasteValuesAndFormat();
      case 'pasteAllExceptBorders': return this.pasteAllExceptBorders();
      case 'insertCellsShiftDown':  return this.insertCellsShiftDown();
      case 'insertCellsShiftRight': return this.insertCellsShiftRight();
      case 'fillDown':              return this.fillDown();
      case 'fillRight':             return this.fillRight();
      case 'openFunctionBrowser':   return this.openFunctionBrowser();
      case 'openNumberFormatDlg':   return this.openNumberFormatDlg();
      case 'openSettings':          return window.dispatchEvent(new CustomEvent('mono:openSettings'));
      case 'viewsPanel':            return viewTabs.openAddView(this, this.host.querySelector('#msViewTabs'));
      case 'copilot':               return window.ChatUI?.toggle();
      case 'setColType':            return this.openColTypePicker();
      case 'openScripts':           return this.scripts?.openEditor();
      case 'downloadXlsx':          return this.downloadXlsx();
      case 'deleteCellsShiftUp': return this.deleteCellsShiftUp();
      case 'deleteCellsShiftLeft': return this.deleteCellsShiftLeft();
      case 'zoom50': return this.setZoom(50);
      case 'zoom75': return this.setZoom(75);
      case 'zoom90': return this.setZoom(90);
      case 'zoom100': return this.setZoom(100);
      case 'zoom125': return this.setZoom(125);
      case 'zoom150': return this.setZoom(150);
      case 'zoom200': return this.setZoom(200);
      case 'zoomFit': return this.setZoom(100);
      // ---- Excel-parity commands (rebuilt keyboard map) ----
      case 'pasteSpecial':      return this.openPasteSpecial();
      case 'insertCellsDialog': return this.insertCellsDialog();
      case 'deleteCellsDialog': return this.deleteCellsDialog();
      case 'insertDate':        return this.insertToday('date');
      case 'insertTime':        return this.insertToday('time');
      case 'recalc':            return this.recalc();
      case 'saveNow':           this.save(); return toast('Workbook saved');
      case 'toggleFilter':      return this.toggleFilter();
      case 'toggleChrome':      return this.toggleToolbarChrome();
      case 'selectDataRegion':  return this.selectDataRegion();
      case 'goToLastCell':      return this.moveDocEnd(false);
      case 'importFile':        return this.importFilePrompt();
      case 'sortDialog':        return this.openSortDialog();
    }
    const map = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', clear: 'clearSelection', insRowAbove: 'insertRowAbove', insRowBelow: 'insertRowBelow', insColLeft: 'insertColLeft', insColRight: 'insertColRight', delRow: 'deleteSelRows', delCol: 'deleteSelCols', addSheet: 'addSheet', csv: 'exportCSV' };
    const fn = map[cmd]; if (fn && this[fn]) this[fn]();
  }
  /* ---------- Phase 3B: merge / freeze / validation / color-scale ---------- */
  mergeAnchor(r, c) { for (const m of (this.sheet().merges || [])) if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return { r: m.r1, c: m.c1 }; return null; }
  // mergeSel(mode) lives in the Google-parity block below (all/h/v variants) —
  // the old single-mode version was removed here to avoid two definitions of
  // the same method (the later one would've won silently either way).
  unmergeSel() { const { r1, c1, r2, c2 } = this.rect(); const sh = this.sheet(); this.pushUndo(); sh.merges = (sh.merges || []).filter((m) => !(m.r1 <= r2 && m.r2 >= r1 && m.c1 <= c2 && m.c2 >= c1)); this.save(); this.render(); }
  freezeRows(n) { this.pushUndo(); const f = this.sheet().frozen || { rows: 0, cols: 0 }; this.sheet().frozen = { rows: n, cols: f.cols }; this.save(); this.render(); }
  freezeCols(n) { this.pushUndo(); const f = this.sheet().frozen || { rows: 0, cols: 0 }; this.sheet().frozen = { rows: f.rows, cols: n }; this.save(); this.render(); }
  unfreeze() { this.pushUndo(); this.sheet().frozen = { rows: 0, cols: 0 }; this.save(); this.render(); }
  validationAt(sid, r, c) { for (const v of (this.sheet().validations || [])) { const rg = v && v.range; if (!rg) continue; if (r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2) return v; } return null; }
  validateValue(sid, r, c, value) { const dv = this.validationAt(sid, r, c); if (!dv || dv.kind !== 'list' || !dv.reject) return true; if (value === '' || value == null) return true; return (dv.values || []).some((v) => v.toLowerCase() === String(value).toLowerCase()); }
  colorScaleBg(sid, r, c) {
    const v = this.engine.getValue(sid, r, c); if (typeof v !== 'number') return null;
    for (const rule of (this.sheet().conditionalFormats || [])) {
      if (rule.type !== 'scale') continue; const rg = rule.range; if (r < rg.r1 || r > rg.r2 || c < rg.c1 || c > rg.c2) continue;
      const key = rg.r1 + '_' + rg.c1 + '_' + rg.r2 + '_' + rg.c2; this._csCache = this._csCache || {};
      let mm = this._csCache[key];
      if (!mm) { let mn = Infinity, mx = -Infinity; for (let rr = rg.r1; rr <= rg.r2; rr++) for (let cc = rg.c1; cc <= rg.c2; cc++) { const x = this.engine.getValue(sid, rr, cc); if (typeof x === 'number') { if (x < mn) mn = x; if (x > mx) mx = x; } } mm = { mn, mx }; this._csCache[key] = mm; }
      if (mm.mx === mm.mn) return rule.hi;
      return lerpHex(rule.lo, rule.hi, (v - mm.mn) / (mm.mx - mm.mn));
    }
    return null;
  }
  openValidation() {
    const { r1, c1, r2, c2 } = this.rect();
    const m = this.modal(`<h3>Data validation</h3><div class="form-row"><label>Criteria for ${addrToA1(r1, c1)}:${addrToA1(r2, c2)}</label><select id="dvKind"><option value="list">Dropdown (list of items)</option><option value="checkbox">Checkbox</option></select></div><div class="form-row" id="dvListRow"><label>Items (comma separated)</label><input id="dvItems" placeholder="Yes, No, Maybe"></div><div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-primary" id="dvAdd">Set</button><button class="btn btn-ghost" id="dvClear">Remove</button></div><div class="modal-actions"><button class="btn btn-ghost" id="dvClose">Close</button></div>`);
    const kind = m.querySelector('#dvKind'); kind.onchange = () => { m.querySelector('#dvListRow').style.display = kind.value === 'list' ? '' : 'none'; };
    m.querySelector('#dvClose').onclick = () => m.remove();
    m.querySelector('#dvClear').onclick = () => { this.pushUndo(); const sh = this.sheet(); sh.validations = (sh.validations || []).filter((v) => !(v.range && v.range.r1 <= r2 && v.range.r2 >= r1 && v.range.c1 <= c2 && v.range.c2 >= c1)); this.save(); m.remove(); this.render(); };
    m.querySelector('#dvAdd').onclick = () => {
      this.pushUndo(); const sh = this.sheet(); sh.validations = sh.validations || [];
      const rule = { range: { r1, c1, r2, c2 }, kind: kind.value, reject: true };
      if (kind.value === 'list') rule.values = m.querySelector('#dvItems').value.split(',').map((s) => s.trim()).filter(Boolean);
      if (kind.value === 'checkbox') { const sid = this.sid(); const list = []; for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (this.engine.getRaw(sid, r, c) === '') list.push({ r, c, raw: 'FALSE' }); if (list.length) this.engine.setCellsBatch(sid, list); }
      sh.validations.push(rule); this.save(); m.remove(); this.render();
    };
  }
  // Insert → Checkbox / Insert → Dropdown — one-click shortcuts for the two
  // most common Data validation rules (checkbox / list), matching the
  // reference PDF's Insert menu, which lists these as their own top-level
  // items rather than something you'd only reach through the validation
  // dialog (openValidation() below still covers the general case).
  insertCheckboxCmd() {
    const { r1, c1, r2, c2 } = this.rect(); const sh = this.sheet(); const sid = this.sid();
    this.pushUndo();
    sh.validations = (sh.validations || []).filter((v) => !(v.range && v.range.r1 <= r2 && v.range.r2 >= r1 && v.range.c1 <= c2 && v.range.c2 >= c1));
    sh.validations.push({ range: { r1, c1, r2, c2 }, kind: 'checkbox', reject: true });
    const list = []; for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (this.engine.getRaw(sid, r, c) === '') list.push({ r, c, raw: 'FALSE' });
    if (list.length) this.engine.setCellsBatch(sid, list);
    this.save(); this.render();
  }
  insertDropdownCmd() {
    const { r1, c1, r2, c2 } = this.rect();
    const items = prompt('Dropdown items (comma separated)', 'Yes, No, Maybe'); if (items == null) return;
    const values = items.split(',').map((s) => s.trim()).filter(Boolean); if (!values.length) return;
    this.pushUndo(); const sh = this.sheet();
    sh.validations = (sh.validations || []).filter((v) => !(v.range && v.range.r1 <= r2 && v.range.r2 >= r1 && v.range.c1 <= c2 && v.range.c2 >= c1));
    sh.validations.push({ range: { r1, c1, r2, c2 }, kind: 'list', values, reject: true });
    this.save(); this.render();
  }
  openListDropdown(r, c, td) {
    const dv = this.validationAt(this.sid(), r, c); if (!dv || dv.kind !== 'list') return;
    document.getElementById('msDv')?.remove();
    const el = document.createElement('div'); el.className = 'ms-dvpop'; el.id = 'msDv';
    el.innerHTML = (dv.values || []).map((v) => `<button class="ms-dvopt" data-v="${escH(v)}">${escH(v)}</button>`).join('');
    document.body.appendChild(el); const rect = td.getBoundingClientRect(); el.style.left = rect.left + 'px'; el.style.top = rect.bottom + 'px';
    el.querySelectorAll('.ms-dvopt').forEach((b) => b.onclick = () => { this.pushUndo(); this.engine.setRaw(this.sid(), r, c, b.dataset.v); this.save(); el.remove(); this.render(); });
    setTimeout(() => document.addEventListener('mousedown', function h(ev) { if (!el.contains(ev.target)) { el.remove(); document.removeEventListener('mousedown', h); } }), 0);
  }
  openCondScale() {
    const { r1, c1, r2, c2 } = this.rect();
    const m = this.modal(`<h3>Color scale</h3><div class="form-row"><label>Apply to ${addrToA1(r1, c1)}:${addrToA1(r2, c2)}</label></div><div class="form-row"><label>Low color <input type="color" id="csLo" value="#F8E2DB"></label></div><div class="form-row"><label>High color <input type="color" id="csHi" value="#4F9D69"></label></div><div class="modal-actions"><button class="btn btn-ghost" id="csClose">Cancel</button><button class="btn btn-primary" id="csAdd">Add</button></div>`);
    m.querySelector('#csClose').onclick = () => m.remove();
    m.querySelector('#csAdd').onclick = () => { this.pushUndo(); this.sheet().conditionalFormats.push({ range: { r1, c1, r2, c2 }, type: 'scale', lo: m.querySelector('#csLo').value, hi: m.querySelector('#csHi').value }); this.save(); m.remove(); this.render(); };
  }
  renderExtMenus() {
    if (!this.scripts) return; const bar = this.host.querySelector('.ms-menubar'); if (!bar) return;
    const mk = (name, items) => {
      const d = document.createElement('div'); d.className = 'ms-menu';
      const pop = items.map((it) => it === 'sep' ? '<div class="ms-menu-sep"></div>' : `<button class="ms-menu-item">${escH(it.label)}</button>`).join('');
      d.innerHTML = `<button class="ms-menu-btn">${escH(name)}</button><div class="ms-menu-pop">${pop}</div>`;
      d.querySelector('.ms-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); const pp = d.querySelector('.ms-menu-pop'); const open = pp.classList.contains('open'); document.querySelectorAll('.ms-menu-pop.open').forEach((x) => x.classList.remove('open')); if (!open) pp.classList.add('open'); });
      const real = items.filter((i) => i !== 'sep'); const btns = [...d.querySelectorAll('.ms-menu-item')];
      real.forEach((it, i) => btns[i].addEventListener('click', () => { d.querySelector('.ms-menu-pop').classList.remove('open'); it.run(); }));
      return d;
    };
    bar.appendChild(mk('Extensions', [{ label: 'Mono Scripts editor', run: () => this.scripts.openEditor() }]));
    for (const m of this.scripts.menus()) bar.appendChild(mk(m.name, m.items.map((it) => it === 'sep' ? 'sep' : { label: it.label, run: () => this.scripts.runMenu(it.fn) })));
  }
  /* ---------- Filter views + data bars ---------- */
  // View → Hide rows (manual) merged with the active filter's hidden rows —
  // rendering skips a row for either reason, exactly like Google Sheets.
  hiddenRowSet(sh) {
    const hidden = new Set(sh.hiddenRows || []);
    const f = sh.filter; if (!f) return hidden;
    const sid = sh.id; const cols = f.cols || {}; const keys = Object.keys(cols);
    for (let r = f.range.r1 + 1; r <= f.range.r2; r++) { for (const ck of keys) { const hl = cols[ck].hidden || []; if (hl.length && hl.includes(this.engine.getDisplay(sid, r, +ck))) { hidden.add(r); break; } } }
    return hidden;
  }
  createFilter() { const { r1, c1, r2, c2 } = this.rect(); this.pushUndo(); this.sheet().filter = { range: { r1, c1, r2, c2 }, cols: {} }; this.save(); this.render(); }
  removeFilter() { this.pushUndo(); this.sheet().filter = null; this.save(); this.render(); }
  sortRangeBy(range, col, dir) { const sh = this.sheet(); const sid = sh.id; const { r1, c1, r2, c2 } = range; const rows = []; for (let r = r1 + 1; r <= r2; r++) { const o = { k: this.engine.getValue(sid, r, col), cells: {} }; for (let c = c1; c <= c2; c++) o.cells[c] = sh.getCellObj(r, c); rows.push(o); } rows.sort((a, b) => { const cmp = compare2(a.k, b.k); return dir === 'desc' ? -cmp : cmp; }); this.pushUndo(); for (let i = 0; i < rows.length; i++) for (let c = c1; c <= c2; c++) sh.setCellObj(r1 + 1 + i, c, rows[i].cells[c]); this.engine.recalcAll(); this.save(); this.render(); }
  // P10 — Column type picker (right-click column header → "Set column type…")
  openColTypePicker() {
    const c = this.active.c;
    const sh = this.sheet();
    // Import lazily to avoid circular deps — cellTypes.js is already loaded as a module
    import('./model/cellTypes.js').then(({ listCellTypes, getCellType }) => {
      const types = listCellTypes();
      const current = sh.colTypes?.[c] || '';
      document.getElementById('msColTypePicker')?.remove();
      const el = document.createElement('div');
      el.className = 'ms-ctx ms-coltype-picker'; el.id = 'msColTypePicker';
      el.innerHTML = `<div class="ms-ctx-title">Column type</div>
        <button class="ms-ctx-item${!current ? ' active' : ''}" data-type="">
          <span class="ms-ctx-noicon"></span><span class="ms-ctx-label">Default (auto)</span>
        </button>
        ${types.map((t) => `<button class="ms-ctx-item${current === t.id ? ' active' : ''}" data-type="${t.id}">
          <span class="ms-ctx-noicon"></span><span class="ms-ctx-label">${escH(t.displayName)}</span>
        </button>`).join('')}`;

      // Position below the active column header
      const th = this.tableEl?.querySelector(`th.ms-colh[data-c="${c}"]`);
      const rect = th ? th.getBoundingClientRect() : { left: 100, bottom: 60 };
      el.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:500;min-width:180px`;
      document.body.appendChild(el);

      el.querySelectorAll('[data-type]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const newType = btn.dataset.type;
          el.remove();
          // If there's existing data and we're changing from a declared type, confirm
          const oldType = sh.colTypes?.[c] || '';
          if (oldType && oldType !== newType) {
            // Spreading the keys built an array of EVERY key in the sheet just
            // to answer "is anything in this column?" — 149 ms on 600,000
            // cells, against 17.9 ms iterating with an early exit. Same answer.
            let hasData = false;
            for (const k of sh.cells.keys()) {
              const i = k.indexOf(',');
              if (+k.slice(i + 1) === c) { hasData = true; break; }
            }
            if (hasData && !confirm(`Change column type from "${getCellType(oldType)?.displayName || oldType}" to "${getCellType(newType)?.displayName || 'Default'}"? Existing cell values will be coerced.`)) return;
          }
          this.pushUndo();
          if (!sh.colTypes) sh.colTypes = {};
          if (newType) sh.colTypes[c] = newType;
          else delete sh.colTypes[c];
          this.save(); this.render();
        });
      });

      setTimeout(() => document.addEventListener('mousedown', function h(ev) {
        if (!el.contains(ev.target)) { el.remove(); document.removeEventListener('mousedown', h); }
      }), 0);
    });
  }

  openFilterMenu(c, anchor) {
    const sh = this.sheet(); const f = sh.filter; if (!f) return; const sid = sh.id;
    const vals = []; const seen = new Set(); for (let r = f.range.r1 + 1; r <= f.range.r2; r++) { const v = this.engine.getDisplay(sid, r, c); if (!seen.has(v)) { seen.add(v); vals.push(v); } }
    vals.sort(); const hidden = new Set((f.cols[c] && f.cols[c].hidden) || []);
    document.getElementById('msFilt')?.remove();
    const el = document.createElement('div'); el.className = 'ms-filtpop'; el.id = 'msFilt';
    el.innerHTML = `<div class="ms-filt-row"><button class="xmini" data-sort="asc">A → Z</button><button class="xmini" data-sort="desc">Z → A</button></div><div class="ms-filt-row"><button class="xmini" data-all="1">Select all</button><button class="xmini" data-all="0">Clear</button></div><div class="ms-filt-list">${vals.map((v, i) => `<label><input type="checkbox" data-v="${i}" ${hidden.has(v) ? '' : 'checked'}> ${escH(v === '' ? '(blank)' : v)}</label>`).join('')}</div><div class="ms-filt-row" style="justify-content:flex-end"><button class="btn btn-primary xmini" data-ok="1">OK</button></div>`;
    document.body.appendChild(el); const rect = anchor.getBoundingClientRect(); el.style.left = Math.min(rect.left, innerWidth - 230) + 'px'; el.style.top = rect.bottom + 'px';
    el.querySelectorAll('[data-all]').forEach((b) => b.onclick = () => el.querySelectorAll('.ms-filt-list input').forEach((i) => { i.checked = b.dataset.all === '1'; }));
    el.querySelectorAll('[data-sort]').forEach((b) => b.onclick = () => { el.remove(); this.sortRangeBy(f.range, c, b.dataset.sort); });
    el.querySelector('[data-ok]').onclick = () => { const hide = []; el.querySelectorAll('.ms-filt-list input').forEach((inp) => { if (!inp.checked) hide.push(vals[+inp.dataset.v]); }); this.pushUndo(); f.cols[c] = { hidden: hide }; this.save(); el.remove(); this.render(); };
    setTimeout(() => document.addEventListener('mousedown', function h(ev) { if (!el.contains(ev.target)) { el.remove(); document.removeEventListener('mousedown', h); } }), 0);
  }
  dataBarBg(sid, r, c) {
    const v = this.engine.getValue(sid, r, c); if (typeof v !== 'number') return null;
    for (const rule of (this.sheet().conditionalFormats || [])) {
      if (rule.type !== 'databar') continue; const rg = rule.range; if (r < rg.r1 || r > rg.r2 || c < rg.c1 || c > rg.c2) continue;
      const key = 'db_' + rg.r1 + '_' + rg.c1 + '_' + rg.r2 + '_' + rg.c2; this._csCache = this._csCache || {}; let mm = this._csCache[key];
      if (!mm) { let mn = Infinity, mx = -Infinity; for (let rr = rg.r1; rr <= rg.r2; rr++) for (let cc = rg.c1; cc <= rg.c2; cc++) { const x = this.engine.getValue(sid, rr, cc); if (typeof x === 'number') { if (x < mn) mn = x; if (x > mx) mx = x; } } mm = { mn, mx }; this._csCache[key] = mm; }
      const max = Math.max(Math.abs(mm.mn), Math.abs(mm.mx)) || 1; const pct = Math.max(0, Math.min(100, (v / max) * 100));
      return `linear-gradient(90deg, ${rule.color}55 ${pct}%, transparent ${pct}%)`;
    }
    return null;
  }
  openDataBar() {
    const { r1, c1, r2, c2 } = this.rect();
    const m = this.modal(`<h3>Data bars</h3><div class="form-row"><label>Apply to ${addrToA1(r1, c1)}:${addrToA1(r2, c2)}</label></div><div class="form-row"><label>Bar color <input type="color" id="dbColor" value="#5E7FA6"></label></div><div class="modal-actions"><button class="btn btn-ghost" id="dbClose">Cancel</button><button class="btn btn-primary" id="dbAdd">Add</button></div>`);
    m.querySelector('#dbClose').onclick = () => m.remove();
    m.querySelector('#dbAdd').onclick = () => { this.pushUndo(); this.sheet().conditionalFormats.push({ range: { r1, c1, r2, c2 }, type: 'databar', color: m.querySelector('#dbColor').value }); this.save(); m.remove(); this.render(); };
  }
  /* ============================================================
   *  Google-Sheets-parity pass — new real features driven by the
   *  uploaded menu/toolbar/right-click reference. Every method here
   *  backs an actual command reachable from the toolbar, a menu, a
   *  right-click variant, or a keyboard shortcut — nothing is a stub.
   * ============================================================ */

  /* ---------- Paint format (format painter) ---------- */
  paintFormatStart() {
    const sh = this.sheet(); const { r, c } = this.active;
    this.paintClip = { st: sh.getStyle(r, c), nf: sh.getFormat(r, c) };
    document.body.classList.add('ms-painting');
    toast('Paint format: select a cell or range to apply it, Esc to cancel');
    const onKeyEsc = (e) => { if (e.key === 'Escape') { this.cancelPaintFormat(); document.removeEventListener('keydown', onKeyEsc); } };
    document.addEventListener('keydown', onKeyEsc);
  }
  cancelPaintFormat() { this.paintClip = null; document.body.classList.remove('ms-painting'); }
  applyPaintFormat() {
    const clip = this.paintClip; if (!clip) return;
    this.pushUndo(); const sh = this.sheet();
    this.forEachSel((r, c) => { sh.setStyle(r, c, null); if (clip.st) sh.setStyle(r, c, clip.st); sh.setFormat(r, c, clip.nf || null); });
    this.cancelPaintFormat(); this.save(); this.render();
  }

  /* ---------- Clear formatting [Ctrl+\] — keeps values, drops style+format ---------- */
  clearFormatting() {
    this.pushUndo(); const sh = this.sheet();
    this.forEachSel((r, c) => { sh.setStyle(r, c, null); sh.setFormat(r, c, null); });
    this.save(); this.render();
  }

  /* ---------- Print [Ctrl+P] ---------- */
  printSheet() { window.print(); }

  /* ---------- Insert link [Ctrl+K] ---------- */
  insertLinkPrompt() {
    const { r, c } = this.active; const sid = this.sid();
    const existingUrl = this.hyperlinkUrlFor(this.engine.getRaw(sid, r, c));
    const url = prompt('Link URL', existingUrl || 'https://');
    if (url == null || !url.trim()) return;
    const defaultLabel = existingUrl ? this.engine.getDisplay(sid, r, c) : (this.engine.getDisplay(sid, r, c) || url.trim());
    const label = prompt('Text to display', defaultLabel);
    if (label == null) return;
    const esc = (s) => String(s).replace(/"/g, '""');
    this.pushUndo();
    this.engine.setRaw(sid, r, c, `=HYPERLINK("${esc(url.trim())}","${esc(label)}")`);
    this.save(); this.render();
  }

  /* ---------- Insert note [Shift+F2] — single private text ---------- */
  insertNotePrompt() {
    const { r, c } = this.active; const sh = this.sheet();
    const ro = this.access && !this.access.canEdit;
    if (ro) {
      const m = this.modal(`<h3>Note</h3><div class="form-row"><textarea rows="4" style="width:100%;resize:vertical" disabled>${escH(sh.getNote(r, c))}</textarea></div><div class="modal-actions"><button class="btn btn-primary" id="noteClose">Close</button></div>`);
      m.querySelector('#noteClose').onclick = () => m.remove();
      return;
    }
    const m = this.modal(`<h3>Note</h3><div class="form-row"><textarea id="noteTxt" rows="4" style="width:100%;resize:vertical" placeholder="Add a private note…">${escH(sh.getNote(r, c))}</textarea></div><div class="modal-actions"><button class="btn btn-ghost" id="noteClear">Remove note</button><button class="btn btn-ghost" id="noteClose">Cancel</button><button class="btn btn-primary" id="noteSave">Save</button></div>`);
    m.querySelector('#noteTxt').focus();
    m.querySelector('#noteClose').onclick = () => m.remove();
    m.querySelector('#noteClear').onclick = () => { this.pushUndo(); sh.setNote(r, c, ''); this.save(); m.remove(); this.render(); };
    m.querySelector('#noteSave').onclick = () => { this.pushUndo(); sh.setNote(r, c, m.querySelector('#noteTxt').value.trim()); this.save(); m.remove(); this.render(); };
  }
  /* ---------- Insert comment [Ctrl+Alt+M] — a small discussion thread ---------- */
  insertCommentPrompt() {
    // Multi-user comments (UI Plan v3 §6): author + timestamp on every entry,
    // own-comment delete, Clear-all owner-only, composer disabled for Viewer.
    // With a signed-in server session the thread is written server-side
    // (that's what lets a Commenter write without workbook-write access);
    // local/offline mode keeps the original single-user behavior.
    const { r, c } = this.active; const sh = this.sheet();
    const api = this.commentApi;
    const acc = api ? api.access() : (this.access || { role: 'owner', isOwner: true, canEdit: true, canComment: true });
    const me = api ? api.me() : null;
    const canDel = (t) => acc.isOwner || !t.authorId || (me && t.authorId === me.userId);
    const composer = acc.canComment
      ? `<div class="form-row"><textarea id="cmTxt" rows="2" style="width:100%;resize:vertical" placeholder="Reply…"></textarea></div>`
      : `<div class="ms-cm-disabled">Viewers can’t comment — you can read the thread and ask AI about the data.</div>`;
    const m = this.modal(`<h3>Comments</h3><div id="cmList" style="max-height:200px;overflow:auto;margin-bottom:8px"></div>${composer}<div class="modal-actions">${acc.isOwner ? '<button class="btn btn-ghost" id="cmClear">Clear all</button>' : ''}<button class="btn btn-ghost" id="cmClose">Close</button>${acc.canComment ? '<button class="btn btn-primary" id="cmAdd">Comment</button>' : ''}</div>`);

    const mutateLocal = (fn) => {
      const obj = sh.getCellObj(r, c) || {};
      obj.cm = fn([...(obj.cm || [])]);
      if (obj.cm && !obj.cm.length) delete obj.cm;
      sh.setCellObj(r, c, obj);
    };
    const paint = () => {
      const thread = sh.getComments(r, c);
      const list = thread.length ? thread.map((t, i) => `
        <div class="ms-cm-item">
          <div class="ms-cm-head">
            <span class="ms-cm-author">${escH(t.authorName || (me ? me.username : 'You'))}</span>
            <span class="ms-cm-time">${new Date(t.ts).toLocaleString()}</span>
            ${canDel(t) ? `<button class="xmini ms-cm-del" data-delc="${escH(t.cid || String(i))}" title="Delete comment">&#x2715;</button>` : ''}
          </div>
          <div>${escH(t.text)}</div>
        </div>`).join('') : '<span class="muted">No comments yet</span>';
      m.querySelector('#cmList').innerHTML = list;
      m.querySelectorAll('[data-delc]').forEach((b) => b.addEventListener('click', async () => {
        const key = b.dataset.delc;
        if (api) {
          const res = await api.remove(sh.id, r, c, key);
          if (res.ok) { mutateLocal((cm) => cm.filter((x) => x.cid !== key)); paint(); this.render(); }
          else if (res.code === 'conflict') { m.remove(); this.onSaveConflict?.(); }
          else toast('You don’t have permission to delete that comment');
        } else {
          this.pushUndo();
          mutateLocal((cm) => cm.filter((x, i) => (x.cid || String(i)) !== key));
          this.save(); paint(); this.render();
        }
      }));
    };
    paint();

    m.querySelector('#cmTxt')?.focus();
    m.querySelector('#cmClose').onclick = () => m.remove();
    m.querySelector('#cmClear')?.addEventListener('click', async () => {
      if (!confirm('Clear the whole comment thread on this cell?')) return;
      if (api) {
        const res = await api.remove(sh.id, r, c, '*');
        if (res.ok) { mutateLocal(() => []); m.remove(); this.render(); }
        else toast('Only the owner can clear all comments');
      } else {
        this.pushUndo(); sh.clearComments(r, c); this.save(); m.remove(); this.render();
      }
    });
    m.querySelector('#cmAdd')?.addEventListener('click', async () => {
      const v = m.querySelector('#cmTxt').value.trim(); if (!v) return;
      if (api) {
        const res = await api.add(sh.id, r, c, v);
        if (res.ok) { mutateLocal((cm) => [...cm, res.comment]); m.querySelector('#cmTxt').value = ''; paint(); this.render(); }
        else if (res.code === 'conflict') { m.remove(); this.onSaveConflict?.(); }
        else toast('You don’t have permission to comment here');
      } else {
        this.pushUndo(); sh.addComment(r, c, v); this.save(); m.remove(); this.render();
      }
    });
  }
  clearNotesSel() { this.pushUndo(); this.forEachSel((r, c) => this.sheet().setNote(r, c, '')); this.save(); this.render(); }
  openCellFlag(r, c) { this.select(r, c); if (this.sheet().getComments(r, c).length) this.insertCommentPrompt(); else this.insertNotePrompt(); }

  /* ---------- Hide / show rows & columns (View menu) ---------- */
  hideSelRows() {
    const { r1, r2 } = this.rect(); const sh = this.sheet();
    const list = []; for (let r = r1; r <= r2; r++) list.push(r);
    this.pushUndo(); sh.hideRows(list);
    if (sh.isRowHidden(this.active.r)) { let r = r2 + 1; while (r < sh.rows && sh.isRowHidden(r)) r++; if (r >= sh.rows) { r = r1 - 1; while (r >= 0 && sh.isRowHidden(r)) r--; } this.active = { r: Math.max(0, r), c: this.active.c }; this.anchor = { ...this.active }; }
    this.save(); this.render();
  }
  hideSelCols() {
    const { c1, c2 } = this.rect(); const sh = this.sheet();
    const list = []; for (let c = c1; c <= c2; c++) list.push(c);
    this.pushUndo(); sh.hideCols(list);
    if (sh.isColHidden(this.active.c)) { let c = c2 + 1; while (c < sh.cols && sh.isColHidden(c)) c++; if (c >= sh.cols) { c = c1 - 1; while (c >= 0 && sh.isColHidden(c)) c--; } this.active = { r: this.active.r, c: Math.max(0, c) }; this.anchor = { ...this.active }; }
    this.save(); this.render();
  }
  showAllRowsCmd() { this.pushUndo(); this.sheet().showAllRows(); this.save(); this.render(); }
  showAllColsCmd() { this.pushUndo(); this.sheet().showAllCols(); this.save(); this.render(); }

  /* ---------- Protected ranges ---------- */
  protectSel() { this.pushUndo(); this.sheet().protectRange(this.rect()); this.save(); this.render(); toast('Range protected — clear protection to edit it again'); }
  unprotectSel() {
    const { r1, c1, r2, c2 } = this.rect(); const sh = this.sheet();
    this.pushUndo(); sh.protectedRanges = sh.protectedRanges.filter((p) => !(p.r1 <= r2 && p.r2 >= r1 && p.c1 <= c2 && p.c2 >= c1));
    this.save(); this.render();
  }
  guardProtected(r, c) { if (this.sheet().isProtected(r, c)) { toast('This range is protected — Data ▸ Unprotect range to edit it'); return true; } return false; }

  /* Role gate (UI Plan v3 §5): true = blocked. The server enforces the same
     rule on the write path; this just makes the UI feel intentional. */
  guardEdit() {
    if (!this.access || this.access.canEdit) return false;
    toast(this.access.role === 'commenter'
      ? 'Comment access — you can view, comment and ask AI, but not edit.'
      : 'View only — you can’t edit this workbook.');
    return true;
  }

  /* ---------- Cell feature badge bar ---------- */

  /* Which feature badges to show for the selection.
     This used to visit every coordinate in the range and call
     getCellFeatures() on each - which itself rescans the validations,
     conditional formats and merges. Select All on a 261 x 16,384 sheet was
     4.28 MILLION of those, about 2.5 seconds, and applySelection() runs it on
     every selection change AND every scroll re-window.

     Nothing needs that scan. Validations, conditional formats and merges are
     RANGES: intersect them with the selection directly. Notes, comments and
     links only exist on cells that exist: walk the sparse cell map instead of
     the rectangle. Cost is now proportional to what the sheet actually
     contains, not to how much of it you happened to select. */
  getBadgesForSelection() {
    const { r1, c1, r2, c2 } = this.rect();
    const total = (r2 - r1 + 1) * (c2 - c1 + 1);
    const sh = this.sheet(); const sid = this.sid();
    const map = {};
    const add = (id, label, n) => { if (n <= 0) return; if (!map[id]) map[id] = { label, count: 0 }; map[id].count += n; };
    const overlap = (rg) => {
      if (!rg) return 0;
      const rows = Math.min(r2, rg.r2) - Math.max(r1, rg.r1) + 1;
      const cols = Math.min(c2, rg.c2) - Math.max(c1, rg.c1) + 1;
      return rows > 0 && cols > 0 ? rows * cols : 0;
    };

    for (const v of (sh.validations || [])) {
      const n = overlap(v.range);
      if (n) add(v.kind === 'list' ? 'dropdown' : 'validation', v.kind === 'list' ? 'Dropdown' : 'Validation', n);
    }
    for (const rl of (sh.conditionalFormats || [])) add('condformat', 'Cond. Format', overlap(rl.range));
    for (const m of (sh.merges || [])) add('merge', 'Merged', overlap(m));

    // cell-attached features: only populated cells can have them.
    //
    // Walk whichever side is smaller. This runs from applySelection(), which
    // runs after every render, so on a 10,000,000-cell sheet walking the whole
    // map to find the one selected cell cost 2.3-3.0 s PER SCROLL — the same
    // grid renders a 602,000-cell sheet in 85 ms. A selection is almost always
    // a handful of cells, and asking the store for those directly is O(range).
    const inspect = (cell) => {
      if (!cell) return;
      if (cell.note) add('note', 'Note', 1);
      if (cell.cm && cell.cm.length) add('comment', 'Comment', 1);
      if (cell.raw != null && this.hyperlinkUrlFor(cell.raw)) add('link', 'Link', 1);
    };
    if (total <= sh.cells.size) {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) inspect(sh.cells.get(r + ',' + c));
    } else for (const [k, cell] of sh.cells) {
      const i = k.indexOf(',');
      const r = +k.slice(0, i), c = +k.slice(i + 1);
      if (r < r1 || r > r2 || c < c1 || c > c2) continue;
      inspect(cell);
    }

    return Object.entries(map).map(([id, { label, count }]) => ({ id, label, count, total }));
  }

  refreshBadges() {
    const el = this.host.querySelector('#msCellBadges');
    if (!el) return;
    const badges = this.getBadgesForSelection();
    if (!badges.length) { el.innerHTML = ''; return; }
    el.innerHTML = badges.map(b => {
      const countStr = (b.total > 1 && b.count < b.total) ? ` <span class="ms-badge-count">${b.count}</span>` : '';
      return `<span class="ms-badge-chip"><span class="ms-badge-label">${b.label}${countStr}</span><button class="ms-badge-x" data-badge="${b.id}" title="Remove ${b.label}">&#x2715;</button></span>`;
    }).join('');
    el.querySelectorAll('.ms-badge-x').forEach(btn =>
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.removeBadge(btn.dataset.badge); })
    );
  }

  removeBadge(id) {
    const sh = this.sheet(); const sid = this.sid(); const { r1, c1, r2, c2 } = this.rect();
    // merge and protected have their own undo+save+render — call and return
    if (id === 'merge')     { this.unmergeSel(); return; }
    if (id === 'protected') { this.unprotectSel(); return; }
    this.pushUndo();
    switch (id) {
      case 'dropdown':
        // Only remove list-kind rules — leave checkbox/boolean/other validations alone
        sh.validations = (sh.validations || []).filter(v =>
          !(v.range.r1 <= r2 && v.range.r2 >= r1 && v.range.c1 <= c2 && v.range.c2 >= c1) || v.kind !== 'list');
        break;
      case 'validation':
        // Only remove non-list rules — leave dropdown rules alone
        sh.validations = (sh.validations || []).filter(v =>
          !(v.range.r1 <= r2 && v.range.r2 >= r1 && v.range.c1 <= c2 && v.range.c2 >= c1) || v.kind === 'list');
        break;
      case 'condformat':
        sh.conditionalFormats = (sh.conditionalFormats || []).filter(rl =>
          !(rl.range.r1 <= r2 && rl.range.r2 >= r1 && rl.range.c1 <= c2 && rl.range.c2 >= c1));
        break;
      case 'note':
        this.forEachSel((r, c) => sh.setNote(r, c, ''));
        break;
      case 'comment':
        this.forEachSel((r, c) => sh.clearComments(r, c));
        break;
      case 'link':
        this.forEachSel((r, c) => {
          const raw = this.engine.getRaw(sid, r, c);
          if (!this.hyperlinkUrlFor(raw)) return;
          // Extract display label from =HYPERLINK("url","label"), fall back to empty
          const m = /^=\s*HYPERLINK\s*\(\s*"(?:[^"\\]|\\.)*"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/i.exec(raw);
          this.engine.setRaw(sid, r, c, m ? m[1] : '');
        });
        break;
    }
    this.save(); this.render();
  }

  /* ---------- Vertical align + wrap (Format menu) ---------- */
  setVAlign(v) { const cur = this.sheet().getStyle(this.active.r, this.active.c) || {}; this.applyStyle({ va: cur.va === v ? false : v }); }
  setWrapMode(mode) { this.applyStyle({ ws: mode, wrap: false }); }

  /* ---------- Merge variants (all / horizontal / vertical) ---------- */
  mergeSel(mode = 'all') {
    const { r1, c1, r2, c2 } = this.rect(); if (r1 === r2 && c1 === c2) return;
    this.pushUndo(); const sh = this.sheet(); const sid = this.sid();
    sh.merges = (sh.merges || []).filter((m) => !(m.r1 <= r2 && m.r2 >= r1 && m.c1 <= c2 && m.c2 >= c1));
    const addMerge = (mr1, mc1, mr2, mc2) => {
      if (mr1 === mr2 && mc1 === mc2) return;
      const list = []; for (let r = mr1; r <= mr2; r++) for (let c = mc1; c <= mc2; c++) if (!(r === mr1 && c === mc1) && this.engine.getRaw(sid, r, c) !== '') list.push({ r, c, raw: '' });
      if (list.length) this.engine.setCellsBatch(sid, list);
      sh.merges.push({ r1: mr1, c1: mc1, r2: mr2, c2: mc2 });
    };
    if (mode === 'h') { for (let r = r1; r <= r2; r++) addMerge(r, c1, r, c2); }
    else if (mode === 'v') { for (let c = c1; c <= c2; c++) addMerge(r1, c, r2, c); }
    else addMerge(r1, c1, r2, c2);
    this.active = { r: r1, c: c1 }; this.anchor = { r: r1, c: c1 };
    this.save(); this.render();
  }

  /* ---------- Font family / size (Formatting Toolbar) ---------- */
  setFontFamily(ff) { this.applyStyle({ ff: ff || false }); }
  setFontSize(px) { const n = +px; this.applyStyle({ fs: n > 0 ? n : false }); }

  /* ---------- View: gridlines / show formulas / zoom / full screen ---------- */
  toggleGridlines() { const sh = this.sheet(); sh.gridlines = sh.gridlines === false; this.save(); this.render(); }
  toggleShowFormulas() { const sh = this.sheet(); sh.showFormulas = !sh.showFormulas; this.save(); this.render(); }
  setZoom(pct) { this.sheet().zoom = pct; this.save(); this.render(); }
  toggleFullScreen() { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => toast('Full screen isn\'t available here')); else document.exitFullscreen?.(); }

  /* ---------- Navigation: jump to a cell reference [Ctrl+G] ---------- */
  jumpToCell() {
    const q = prompt('Go to range (e.g. B7 or A1:C10)'); if (!q) return;
    const spec = this.parseRangeSpec(q); if (!spec) return toast('Bad range');
    if (spec.sid !== this.sid()) { this.wb.setActive(spec.sid); }
    this.anchor = { r: spec.r1, c: spec.c1 }; this.active = { r: spec.r2, c: spec.c2 }; this.selKind = 'cell';
    this.render(); this.focusGrid();
  }
  selectEntireRow() { this.selKind = 'rows'; this.anchor = { r: this.active.r, c: 0 }; this.applySelection(); }
  selectEntireCol() { this.selKind = 'cols'; this.anchor = { r: 0, c: this.active.c }; this.applySelection(); }
  moveHome(extend) { this.active = { r: this.active.r, c: 0 }; if (!extend) this.anchor = { ...this.active }; this.selKind = 'cell'; this.applySelection(); }
  moveDocHome(extend) { this.active = { r: 0, c: 0 }; if (!extend) this.anchor = { ...this.active }; this.selKind = 'cell'; this.applySelection(); }
  // Ctrl+End — jump to the last cell of the USED range (Excel), not the
  // sheet's absolute bottom-right corner.
  moveDocEnd(extend) { const t = this.usedExtent(); this.active = { ...t }; if (!extend) this.anchor = { ...t }; this.selKind = 'cell'; this.applySelection(); }
  usedExtent() {
    const sh = this.sheet(); let mr = 0, mc = 0;
    for (const key of sh.cells.keys()) { const i = key.indexOf(','); const r = +key.slice(0, i), c = +key.slice(i + 1); if (r > mr) mr = r; if (c > mc) mc = c; }
    return { r: clamp(mr, 0, sh.rows - 1), c: clamp(mc, 0, sh.cols - 1) };
  }
  // Page Up/Down (vdir) and Alt+Page Up/Down (hdir) — one screenful at a
  // time, sized from the live viewport; Shift extends the selection.
  movePage(vdir, hdir, extend) {
    const sh = this.sheet();
    const rows = Math.max(1, Math.floor((this.scrollEl?.clientHeight || 600) / 30) - 2);
    const cols = Math.max(1, Math.floor((this.scrollEl?.clientWidth || 900) / 92) - 1);
    const r = clamp(this.active.r + vdir * rows, 0, sh.rows - 1);
    const c = clamp(this.active.c + hdir * cols, 0, sh.cols - 1);
    this.active = { r, c }; if (!extend) this.anchor = { r, c }; this.selKind = 'cell'; this.applySelection();
  }
  // Ctrl+Shift+Space — select the contiguous data region around the active cell.
  selectDataRegion() {
    const sid = this.sid(); const sh = this.sheet();
    const has = (r, c) => r >= 0 && c >= 0 && r < sh.rows && c < sh.cols && this.engine.getRaw(sid, r, c) !== '';
    if (!has(this.active.r, this.active.c)) { this.selKind = 'all'; this.anchor = { r: 0, c: 0 }; this.active = { r: 0, c: 0 }; return this.applySelection(); }
    let r1 = this.active.r, r2 = r1, c1 = this.active.c, c2 = c1, grown = true;
    while (grown) {
      grown = false;
      for (let c = c1; c <= c2 && !grown; c++) { if (has(r1 - 1, c)) { r1--; grown = true; } }
      for (let c = c1; c <= c2 && !grown; c++) { if (has(r2 + 1, c)) { r2++; grown = true; } }
      for (let r = r1; r <= r2 && !grown; r++) { if (has(r, c1 - 1)) { c1--; grown = true; } }
      for (let r = r1; r <= r2 && !grown; r++) { if (has(r, c2 + 1)) { c2++; grown = true; } }
    }
    this.anchor = { r: r1, c: c1 }; this.active = { r: r2, c: c2 }; this.selKind = 'cell'; this.applySelection();
  }
  // Ctrl+Backspace — bring the active cell back into view, centered.
  scrollToActive() {
    const td = this.cellAt(this.active.r, this.active.c); if (!td || !this.scrollEl) return;
    const cr = td.getBoundingClientRect(), sr = this.scrollEl.getBoundingClientRect();
    this.scrollEl.scrollTop += cr.top - (sr.top + sr.height / 2);
    this.scrollEl.scrollLeft += cr.left - (sr.left + sr.width / 2);
  }

  /* ---------- Data: trim whitespace / remove duplicates / randomize / split ---------- */
  trimWhitespaceSel() {
    const { r1, c1, r2, c2 } = this.rect(); const sid = this.sid(); const list = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const raw = this.engine.getRaw(sid, r, c); if (typeof raw === 'string' && raw.length) { const t = raw.replace(/^\s+|\s+$/g, ''); if (t !== raw) list.push({ r, c, raw: t }); } }
    if (!list.length) { toast('Nothing to trim'); return; }
    this.pushUndo(); this.engine.setCellsBatch(sid, list); this.save(); this.render();
  }
  removeDuplicatesSel() {
    const { r1, c1, r2, c2 } = this.rect();
    if (r2 <= r1) { toast('Select more than one row to remove duplicates'); return; }
    const sid = this.sid(); const seen = new Set(); const dupRows = [];
    for (let r = r1; r <= r2; r++) {
      const key = []; for (let c = c1; c <= c2; c++) key.push(this.engine.getRaw(sid, r, c));
      const k = key.join('');
      if (seen.has(k)) dupRows.push(r); else seen.add(k);
    }
    if (!dupRows.length) { toast('No duplicate rows found'); return; }
    this.pushUndo();
    for (let i = dupRows.length - 1; i >= 0; i--) this.engine.deleteRows(sid, dupRows[i], 1);
    toast(`${dupRows.length} duplicate row${dupRows.length > 1 ? 's' : ''} removed`);
    this.afterStruct();
  }
  insertSum() {
    const { r1, c1, r2, c2 } = this.rect(); const sid = this.sid();
    let range = null;
    for (let r = r1 - 1; r >= 0; r--) { if (this.engine.isNumberAt(sid, r, c1)) { range = addrToA1(r, c1) + ':' + addrToA1(r2 - 1, c2); break; } }
    if (!range) for (let c = c1 - 1; c >= 0; c--) { if (this.engine.isNumberAt(sid, r1, c)) { range = addrToA1(r1, c) + ':' + addrToA1(r2, c2 - 1); break; } }
    const formula = range ? `=SUM(${range})` : '=SUM(';
    this.beginEdit(formula);
    if (!range) this.editor.setSelectionRange(formula.length, formula.length);
  }
  insertFunction(name) {
    const formula = `=${name}(`;
    this.beginEdit(formula + ')');
    this.editor.setSelectionRange(formula.length, formula.length);
  }
  cycleAbsRef(inp) {
    const v = inp.value; const pos = inp.selectionStart;
    const re = /\$?[A-Za-z]{1,3}\$?[0-9]+/g; let m; let hit = null;
    while ((m = re.exec(v))) { if (m.index <= pos && pos <= m.index + m[0].length) { hit = m; break; } }
    if (!hit) return;
    const mm = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$/.exec(hit[0]); if (!mm) return;
    const [, cd, col, rd, row] = mm;
    let next;
    if (!cd && !rd) next = `$${col}$${row}`;
    else if (cd && rd) next = `${col}$${row}`;
    else if (!cd && rd) next = `$${col}${row}`;
    else next = `${col}${row}`;
    inp.value = v.slice(0, hit.index) + next + v.slice(hit.index + hit[0].length);
    inp.setSelectionRange(hit.index + next.length, hit.index + next.length);
  }

  /* ============================================================
   *  Excel-parity pass — methods backing the rebuilt keyboard map
   *  and the toolbar/menu commands added alongside it. Several of
   *  these (autosum, openShortcutsHelp, sortColumnHeader, …) were
   *  referenced by command() / onKey but never implemented — the
   *  "most shortcuts don't exist" bug.
   * ============================================================ */

  /* ---- Alt+= — AutoSum (was referenced but undefined) ---- */
  autosum() { return this.insertSum(); }

  /* ---- F9 — recalculate all formulas ---- */
  recalc() { this.engine.recalcAll(); this.save(); this.render(); toast('Recalculated'); }

  /* ---- Ctrl+Shift+L — toggle AutoFilter on/off like Excel ---- */
  toggleFilter() { if (this.sheet().filter) return this.removeFilter(); this.createFilter(); }

  /* ---- Alt+Down — open dropdown validation or filter menu on active cell ---- */
  openActiveDropdown() {
    const { r, c } = this.active; const td = this.cellAt(r, c);
    const dv = this.validationAt(this.sid(), r, c);
    if (dv && dv.kind === 'list' && td) return this.openListDropdown(r, c, td);
    const f = this.sheet().filter;
    if (f && r === f.range.r1 && c >= f.range.c1 && c <= f.range.c2) { const ft = td?.querySelector('.ms-filt'); if (ft) return this.openFilterMenu(c, ft); }
  }

  /* ---- Shift+F10 — context menu at the active cell ---- */
  openContextAtActive() {
    const td = this.cellAt(this.active.r, this.active.c);
    const r = td ? td.getBoundingClientRect() : this.scrollEl.getBoundingClientRect();
    menus.showContextMenu(this, r.left + 8, r.bottom - 2, 'cell');
  }

  /* ---- Ctrl+F1 — hide/show the menu bar + toolbar (Excel's ribbon toggle) ---- */
  toggleToolbarChrome() {
    this._chromeHidden = !this._chromeHidden;
    this.host.querySelector('.ms')?.classList.toggle('ms-chrome-hidden', this._chromeHidden);
    toast(this._chromeHidden ? 'Toolbar hidden — Ctrl+F1 to bring it back' : 'Toolbar shown');
  }

  /* ---- Ctrl+; / Ctrl+Shift+; — insert today's date / current time ---- */
  insertToday(kind) {
    const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
    const val = kind === 'time' ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    if (this.editing) { const inp = this._activeInput(); const s = inp.selectionStart ?? inp.value.length; inp.value = inp.value.slice(0, s) + val + inp.value.slice(inp.selectionEnd ?? s); inp.setSelectionRange(s + val.length, s + val.length); this.syncFromInput(inp); return; }
    if (this.guardProtected(this.active.r, this.active.c)) return;
    this.pushUndo(); this.engine.setRaw(this.sid(), this.active.r, this.active.c, val); this.save(); this.render();
  }

  /* ---- Ctrl+' / Ctrl+" — copy formula / value from the cell above ---- */
  copyFromAbove(values) {
    const { r, c } = this.active; if (r === 0) return;
    if (this.guardProtected(r, c)) return;
    const sid = this.sid();
    const raw = values ? String(this.engine.getValue(sid, r - 1, c) ?? '') : this.engine.getRaw(sid, r - 1, c);
    this.pushUndo(); this.engine.setRaw(sid, r, c, raw ?? ''); this.save(); this.render();
  }

  /* ---- Ctrl+Enter (grid mode) — fill selection with the active cell ---- */
  fillSelectionWithActive() {
    const { r1, c1, r2, c2 } = this.rect(); if (r1 === r2 && c1 === c2) return this.beginEdit();
    const sid = this.sid(); const src = this.active; const sh = this.sheet();
    const raw0 = this.engine.getRaw(sid, src.r, src.c);
    const list = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      if ((r === src.r && c === src.c) || sh.isProtected(r, c)) continue;
      let raw = raw0; if (raw && raw[0] === '=') raw = this.engine.translateFormula(raw, r - src.r, c - src.c);
      list.push({ r, c, raw });
    }
    if (!list.length) return;
    this.pushUndo(); this.engine.setCellsBatch(sid, list); this.save(); this.render();
  }

  /* ---- Ctrl+Enter (edit mode) — commit the entry to every selected cell ---- */
  commitFillSelection() {
    if (!this.editing) return;
    if (this.crossSheet) return this.commitEdit();
    const o = this.editOrigin, val = this.fx.value; const sh = this.sheet();
    const { r1, c1, r2, c2 } = this.rect();
    this.editing = false; this.editor.style.display = 'none'; this.point = null; this.ac.hide();
    this.pushUndo(); const list = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      if (sh.isProtected(r, c)) continue;
      let raw = val; if (raw && raw[0] === '=') raw = this.engine.translateFormula(raw, r - o.r, c - o.c);
      list.push({ r, c, raw });
    }
    this.engine.setCellsBatch(o.sid, list); this.save(); this.render();
  }

  /* ---- Ctrl+Shift+V / Ctrl+Alt+V — Paste Special dialog (Excel) ---- */
  openPasteSpecial() {
    if (!this.clip) { toast('Nothing to paste — copy a range first (Ctrl+C)'); return; }
    const opts = [
      ['paste',                 'All',                'Formulas, values and formatting'],
      ['pasteValuesOnly',       'Values only',        'Computed values — no formulas, no formatting'],
      ['pasteFormatOnly',       'Formats only',       'Style and number format, values untouched'],
      ['pasteFormulasOnly',     'Formulas only',      'Exactly as copied, no reference shifting'],
      ['pasteTransposed',       'Transpose',          'Swap rows and columns'],
      ['pasteValuesAndFormat',  'Values & formats',   'Values plus styling, no formulas'],
      ['pasteAllExceptBorders', 'All except borders', 'Everything but border styling'],
    ];
    const m = this.modal(`<h3>Paste special</h3><div class="ms-ps-list">${opts.map(([cmd, label, hint]) => `<button class="ms-ps-opt" data-ps="${cmd}"><b>${label}</b><span>${hint}</span></button>`).join('')}</div><div class="modal-actions"><button class="btn btn-ghost" id="psClose">Cancel</button></div>`);
    m.querySelector('#psClose').onclick = () => m.remove();
    m.querySelectorAll('[data-ps]').forEach((b) => b.onclick = () => { m.remove(); this.command(b.dataset.ps); this.focusGrid(); });
  }

  /* ---- Ctrl+Shift+Plus — Insert dialog (cells / entire row / column) ---- */
  insertCellsDialog() {
    const opts = [
      ['insertCellsShiftDown',  'Shift cells down',  'Insert blank cells, push existing ones down'],
      ['insertCellsShiftRight', 'Shift cells right', 'Insert blank cells, push existing ones right'],
      ['insRowAbove',           'Entire row',        `Insert ${this.selRows()} row(s) above the selection`],
      ['insColLeft',            'Entire column',     `Insert ${this.selCols()} column(s) left of the selection`],
    ];
    const m = this.modal(`<h3>Insert</h3><div class="ms-ps-list">${opts.map(([cmd, label, hint]) => `<button class="ms-ps-opt" data-ps="${cmd}"><b>${label}</b><span>${hint}</span></button>`).join('')}</div><div class="modal-actions"><button class="btn btn-ghost" id="icClose">Cancel</button></div>`);
    m.querySelector('#icClose').onclick = () => m.remove();
    m.querySelectorAll('[data-ps]').forEach((b) => b.onclick = () => { m.remove(); this.command(b.dataset.ps); this.focusGrid(); });
  }

  /* ---- Ctrl+Minus / Shift+Delete — Delete dialog ---- */
  deleteCellsDialog() {
    const opts = [
      ['deleteCellsShiftUp',   'Shift cells up',   'Remove cells, pull the ones below up'],
      ['deleteCellsShiftLeft', 'Shift cells left', 'Remove cells, pull the ones to the right left'],
      ['delRow',               'Entire row',       `Delete ${this.selRows()} selected row(s)`],
      ['delCol',               'Entire column',    `Delete ${this.selCols()} selected column(s)`],
    ];
    const m = this.modal(`<h3>Delete</h3><div class="ms-ps-list">${opts.map(([cmd, label, hint]) => `<button class="ms-ps-opt" data-ps="${cmd}"><b>${label}</b><span>${hint}</span></button>`).join('')}</div><div class="modal-actions"><button class="btn btn-ghost" id="dcClose">Cancel</button></div>`);
    m.querySelector('#dcClose').onclick = () => m.remove();
    m.querySelectorAll('[data-ps]').forEach((b) => b.onclick = () => { m.remove(); this.command(b.dataset.ps); this.focusGrid(); });
  }

  /* ---- Ctrl+? — searchable shortcuts reference (was undefined) ---- */
  openShortcutsHelp() {
    const G = [
      ['Navigation', [
        ['Arrow keys', 'Move one cell'], ['Ctrl+Arrow', 'Jump to edge of data'], ['Page Up / Down', 'Move one screen up / down'],
        ['Alt+Page Up / Down', 'Move one screen left / right'], ['Tab / Shift+Tab', 'Move right / left'], ['Enter / Shift+Enter', 'Move down / up'],
        ['Ctrl+Home', 'Go to A1'], ['Ctrl+End', 'Go to last used cell'], ['Home', 'Start of row'],
        ['Ctrl+G or F5', 'Go To dialog'], ['Ctrl+Backspace', 'Scroll back to active cell'],
      ]],
      ['Selection', [
        ['Shift+Arrow', 'Extend selection'], ['Ctrl+Shift+Arrow', 'Extend to edge of data'], ['Shift+Page Up / Down', 'Extend one screen'],
        ['Shift+Space', 'Select row'], ['Ctrl+Space', 'Select column'], ['Ctrl+Shift+Space', 'Select data region'],
        ['Ctrl+A', 'Select all'], ['Ctrl+Shift+Home / End', 'Extend to A1 / last cell'],
      ]],
      ['Editing', [
        ['F2', 'Edit cell'], ['Delete / Backspace', 'Clear contents'], ['Ctrl+X / C / V', 'Cut / Copy / Paste'],
        ['Ctrl+Shift+V', 'Paste special dialog'], ['Ctrl+Z / Y', 'Undo / Redo'], ['Ctrl+D / R', 'Fill down / right'],
        ['Ctrl+Enter', 'Fill selection with entry'], ['Alt+Enter', 'New line inside the cell'], ['Ctrl+;', "Insert today's date"], ['Ctrl+Shift+;', 'Insert current time'],
        ["Ctrl+'", 'Copy formula from above'], ['Ctrl+Shift+"', 'Copy value from above'], ['Alt+=', 'AutoSum'],
        ['Ctrl+Shift++', 'Insert cells dialog'], ['Ctrl+-', 'Delete cells dialog'], ['F4 (editing)', 'Cycle $A$1 reference types'],
        ['F9', 'Recalculate'], ['F3', 'Named ranges'],
      ]],
      ['Formatting', [
        ['Ctrl+B / I / U', 'Bold / Italic / Underline'], ['Alt+Shift+5', 'Strikethrough'], ['Ctrl+1', 'Format cells dialog'],
        ['Ctrl+Shift+1…6', 'Number / Time / Date / Currency / Percent / Scientific'], ['Ctrl+Shift+~', 'General format'],
        ['Ctrl+Shift+&', 'Outline border'], ['Ctrl+Shift+-', 'Remove borders'], ['Ctrl+Shift+X or Ctrl+\\', 'Clear formatting'],
      ]],
      ['Data & view', [
        ['Ctrl+Shift+L', 'Toggle filter'], ['Ctrl+Shift+T', 'Create filtered table'], ['Alt+Down', 'Open dropdown / filter menu'],
        ['Ctrl+9 / Ctrl+0', 'Hide rows / columns'], ['Ctrl+Shift+9 / 0', 'Unhide rows / columns'],
        ['Ctrl+`', 'Show formulas'], ['Ctrl+F1', 'Toggle toolbar'], ['Shift+F11', 'New sheet'], ['F11', 'Insert chart (dashboard)'],
        ['Ctrl+Alt+D', 'Remove duplicates'],
      ]],
      ['File, find & more', [
        ['Ctrl+S', 'Save workbook'], ['Ctrl+P', 'Print'], ['Ctrl+O', 'Import a CSV file'], ['Ctrl+N', 'New sheet (browser may reserve)'],
        ['Ctrl+F / Ctrl+H', 'Find / Find & replace'],
        ['Ctrl+K', 'Insert link'], ['Ctrl+Alt+C', 'Insert comment'], ['Shift+F2', 'Insert note'],
        ['Shift+F10', 'Context menu'], ['Ctrl+?', 'This dialog'],
      ]],
      ['Alt sequences (press keys one after another)', [
        ['Alt, H, O, I / H', 'Autofit column width / row height'], ['Alt, H, D, C / R', 'Delete column / row'],
        ['Alt, H, I, C / R', 'Insert column / row'], ['Alt, D, S', 'Sort dialog'],
        ['Alt, D, F, F / R', 'Filter on / off'], ['Alt, W, F, F / U', 'Freeze at cell / unfreeze'],
        ['Alt, V, Z, O', 'Zoom to exact %'], ['Alt, F, P / S / O / N', 'Print / Save / Import / New sheet'],
        ['Alt+E / I / O / A / W…', 'Open Edit / Insert / Format / Data / View menu'],
        ['Alt+1 … Alt+9', 'Trigger the Nth toolbar button'],
      ]],
    ];
    const body = G.map(([sec, rows]) => `<div class="ms-kbd-sec">${sec}</div>` + rows.map(([kb, d]) => `<div class="ms-kbd-row"><kbd>${kb}</kbd><span>${d}</span></div>`).join('')).join('');
    const m = this.modal(`<h3>Keyboard shortcuts</h3><input id="kbdFilter" placeholder="Filter shortcuts…" style="width:100%;margin-bottom:8px"><div class="ms-kbd-list" id="kbdList">${body}</div><div class="modal-actions"><button class="btn btn-primary" id="kbdClose">Done</button></div>`);
    m.querySelector('#kbdClose').onclick = () => m.remove();
    const inp = m.querySelector('#kbdFilter'); inp.focus();
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase();
      m.querySelectorAll('.ms-kbd-row').forEach((row) => { row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none'; });
      m.querySelectorAll('.ms-kbd-sec').forEach((sec) => {
        let el = sec.nextElementSibling, any = false;
        while (el && el.classList.contains('ms-kbd-row')) { if (el.style.display !== 'none') any = true; el = el.nextElementSibling; }
        sec.style.display = any ? '' : 'none';
      });
    });
  }

  /* ---- previously referenced by menus/context menus but undefined ---- */
  sortColumnHeader(c, dir) {
    const ext = this.usedExtent();
    if (ext.r < 1) { toast('Nothing to sort'); return; }
    this.sortRangeBy({ r1: 0, c1: 0, r2: ext.r, c2: ext.c }, c, dir); // row 0 treated as header
  }
  filterByCellValue(r, c) {
    const sh = this.sheet(); const sid = sh.id; const ext = this.usedExtent();
    this.pushUndo();
    if (!sh.filter) sh.filter = { range: { r1: 0, c1: 0, r2: ext.r, c2: ext.c }, cols: {} };
    const f = sh.filter; const keep = this.engine.getDisplay(sid, r, c);
    const hide = []; const seen = new Set();
    for (let rr = f.range.r1 + 1; rr <= f.range.r2; rr++) { const v = this.engine.getDisplay(sid, rr, c); if (v !== keep && !seen.has(v)) { seen.add(v); hide.push(v); } }
    f.cols[c] = { hidden: hide };
    this.save(); this.render();
  }
  copyCellReference(r, c) {
    const ref = this.sheet().name + '!' + addrToA1(r, c);
    try { navigator.clipboard?.writeText(ref); } catch {}
    toast('Copied reference ' + ref);
  }
  randomizeSel() {
    const { r1, c1, r2, c2 } = this.rect(); if (r1 === r2) { toast('Select multiple rows to randomize'); return; }
    const sh = this.sheet(); this.pushUndo();
    const rows = []; for (let r = r1; r <= r2; r++) { const o = {}; for (let c = c1; c <= c2; c++) o[c] = sh.getCellObj(r, c); rows.push(o); }
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    for (let i = 0; i < rows.length; i++) for (let c = c1; c <= c2; c++) sh.setCellObj(r1 + i, c, rows[i][c]);
    this.engine.recalcAll(); this.save(); this.render();
  }
  splitTextToColumns() {
    const sep = prompt('Separator', ','); if (sep == null || sep === '') return;
    const { r1, c1, r2 } = this.rect(); const sid = this.sid(); const sh = this.sheet(); const list = [];
    for (let r = r1; r <= r2; r++) {
      const raw = String(this.engine.getValue(sid, r, c1) ?? ''); if (!raw.includes(sep)) continue;
      raw.split(sep).forEach((part, i) => { if (c1 + i < sh.cols) list.push({ r, c: c1 + i, raw: part.trim() }); });
    }
    if (!list.length) { toast('No separator found in the selection'); return; }
    this.pushUndo(); this.engine.setCellsBatch(sid, list); this.save(); this.render();
  }
  downloadXlsx() { this.exportCSV(); toast('Exported as CSV — native .xlsx export isn’t bundled yet'); }

  /* ============================================================
   *  Alt ribbon key sequences (Excel's Alt+H,O,I style chords) +
   *  Ctrl+O import + Alt+Enter support methods.
   * ============================================================ */

  // Nested chord table. String leaf = action; nested object = more keys;
  // '' leaf = fallback when the chord times out (usually opens a menu).
  chordTable() {
    return {
      H: { O: { I: 'resizeColFit', H: 'resizeRowFit' }, D: { C: 'delCol', R: 'delRow' }, I: { C: 'insColLeft', R: 'insRowAbove' }, '': 'menu:format' },
      D: { S: 'sortDialog', F: { F: 'createFilter', R: 'removeFilter' }, '': 'menu:data' },
      A: { S: { S: 'sortDialog' }, '': 'menu:data' },
      W: { F: { F: 'freezeHere', U: 'unfreeze' }, I: 'menu:view', '': 'menu:view' },
      V: { Z: { O: 'zoomPrompt' }, '': 'menu:view' },
      F: { P: 'print', S: 'saveNow', O: 'importFile', N: 'addSheet', I: 'openSettings', T: 'print', '': 'menu:file' },
      E: { '': 'menu:edit' },
      I: { '': 'menu:insert' },
      N: { '': 'menu:insert' },
      O: { '': 'menu:format' },
      P: { '': 'menu:format' },
      M: { '': 'openFunctionBrowser' },
      R: { '': 'menu:tools' },
      T: { '': 'menu:tools' },
    };
  }
  startChord(letter) {
    const node = this.chordTable()[letter];
    if (!node) return;
    if (typeof node === 'string') return this.runChord(node);
    this._chordNode = node; this._chordKeys = [letter];
    this.showChordHint();
    // No continuation within 2s → run the fallback (open the matching menu).
    this._chordTimer = setTimeout(() => { const fb = this._chordNode && this._chordNode['']; this.clearChord(); if (fb) this.runChord(fb); }, 2000);
  }
  clearChord() {
    if (this._chordTimer) { clearTimeout(this._chordTimer); this._chordTimer = null; }
    this._chordNode = null; this._chordKeys = [];
    document.getElementById('msChordHint')?.remove();
  }
  showChordHint() {
    if (this._chordTimer) { clearTimeout(this._chordTimer); this._chordTimer = setTimeout(() => { const fb = this._chordNode && this._chordNode['']; this.clearChord(); if (fb) this.runChord(fb); }, 2000); }
    let el = document.getElementById('msChordHint');
    if (!el) { el = document.createElement('div'); el.id = 'msChordHint'; el.className = 'ms-chord-hint'; document.body.appendChild(el); }
    const nextKeys = Object.keys(this._chordNode || {}).filter((x) => x !== '');
    el.innerHTML = `<b>Alt, ${this._chordKeys.join(', ')}</b> — next: ${nextKeys.map((x) => `<kbd>${x}</kbd>`).join(' ')} <span>Esc to cancel</span>`;
  }
  runChord(action) {
    if (action.startsWith('menu:')) {
      const btn = this.host.querySelector(`.ms-menu-btn[data-menu="${action.slice(5)}"]`);
      if (btn) btn.click();
      return;
    }
    switch (action) {
      case 'sortDialog': return this.openSortDialog();
      case 'freezeHere': return this.freezeHere();
      case 'zoomPrompt': return this.zoomPrompt();
      case 'importFile': return this.importFilePrompt();
      default: return this.command(action);
    }
  }
  // Alt+1..9 — Excel's quick-access toolbar: trigger the Nth toolbar button.
  quickAccess(n) {
    const btns = [...this.host.querySelectorAll('.cmdbar-left .cmdbar-btn')];
    const b = btns[n - 1]; if (b) b.click();
  }
  // Alt+D,S / Alt+A,S,S — Excel opens the Sort dialog.
  openSortDialog() {
    const opts = [
      ['sortAsc',  'Sort A → Z', 'Ascending, by the active column of the selection'],
      ['sortDesc', 'Sort Z → A', 'Descending, by the active column of the selection'],
    ];
    const m = this.modal(`<h3>Sort</h3><div class="ms-ps-list">${opts.map(([cmd, label, hint]) => `<button class="ms-ps-opt" data-ps="${cmd}"><b>${label}</b><span>${hint}</span></button>`).join('')}</div><div class="modal-actions"><button class="btn btn-ghost" id="soClose">Cancel</button></div>`);
    m.querySelector('#soClose').onclick = () => m.remove();
    m.querySelectorAll('[data-ps]').forEach((b) => b.onclick = () => { m.remove(); this.command(b.dataset.ps); this.focusGrid(); });
  }
  // Alt+W,F,F — freeze panes at the active cell (rows above + columns left).
  freezeHere() {
    this.pushUndo();
    this.sheet().frozen = { rows: this.active.r, cols: this.active.c };
    this.save(); this.render();
    toast(this.active.r || this.active.c ? 'Panes frozen at the active cell' : 'Nothing to freeze at A1');
  }
  // Alt+V,Z,O — zoom to an exact percentage.
  zoomPrompt() {
    const v = prompt('Zoom % (25–400)', this.sheet().zoom || 100); if (v == null) return;
    this.setZoom(clamp(parseInt(v, 10) || 100, 25, 400));
  }
  // Ctrl+O / Alt+F,O — import a CSV/TSV file into a new sheet.
  // Unified file open: CSV/TSV and full-fidelity XLSX both flow through the
  // one import engine (public/mono/import). Each imported sheet is appended so
  // the user keeps their current tabs.
  importFilePrompt() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.csv,.tsv,.txt,.xlsx,.xlsm';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      try {
        toast('Importing ' + f.name + '…');
        const image = await importFileImage(f);
        const total = (image.sheets || []).reduce((n, s) => n + Object.keys(s.cells || {}).length, 0);
        if (!image.sheets || !image.sheets.length || !total) { toast('Nothing to import'); return; }
        this.commitIfEditing(); this.pushUndo();
        const ids = appendImageSheets(this.wb, image);
        if (ids.length) this.onTab(ids[0]);
        this.active = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 }; this.selKind = 'cell';
        this.engine.recalcAll(); this.save(); this.render(); this.notifySheetListChange();
        toast(`Imported ${image.sheets.length} sheet(s) from ${f.name}`);
      } catch (e) {
        toast('Import failed: ' + (e && e.message || e));
      }
    };
    inp.click();
  }
  parseCSV(text, sep = ',') {
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
      else if (ch === '\r') { /* ignore */ }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
    return rows;
  }

  save() { this.onChange(this.wb); }
}
export default MonoGrid;
