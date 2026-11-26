/*
 * Raw-data editor: one tab of the app's data in the Mono Sheets grid.
 *
 * The grid is Mono Sheets' own (./mono, ./ui, theme.css — copied from the
 * monosheets project). This file is the glue: it loads a tab from the admin
 * API as plain text cells, and turns what the admin does in the grid into
 * cell-level edits sent back to the API. Row 1 of the grid is row 1 of the
 * data, so what is on screen lines up with the old spreadsheet cell for cell.
 *
 * Not a spreadsheet here: formulas are switched off (a value starting with
 * "=" is just text), and columns the app calculates are locked.
 */
import { MonoWorkbook, MonoSheet } from './mono/model/workbook.js';
import { CellStore } from './mono/model/columnStore.js';
import { Engine } from './mono/engine/engine.js';
import { MonoGrid } from './mono/grid.js';
import * as changes from './mono/model/changeTracker.js';
import { toast } from './ui/toast.js';

const TOKEN_KEY = 'levanto.admin.token';
const tabId = new URLSearchParams(location.search).get('tab');
const $ = (id) => document.getElementById(id);
const MAX = Number.MAX_SAFE_INTEGER;
const SID = 'data';

function token() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; } }

async function api(path, opts = {}) {
  const res = await fetch('/api/admin' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token() || ''), ...(opts.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body || body.ok === false) {
    const err = new Error((body && body.error) || ('The server answered HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return body;
}

function setState(text, cls) { const el = $('state'); el.textContent = text; el.className = cls || ''; }

/* ---- the grid as a plain data grid ------------------------------------- */

/* Formulas off. Prototype patches, because undo builds a new Engine. */
Engine.prototype.parseCellAt = function (sid, r, c) {
  const a = this.key(sid, r, c);
  this.asts.delete(a); this.graph.clear(a); this.volatile.delete(a);
};
/* Show text as it is stored: "007" and "12.50" must not turn into 7 and 12.5. */
Engine.prototype.literalValue = function (raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  return /^-?(0|[1-9]\d*)(\.\d*[1-9])?$/.test(raw) ? Number(raw) : raw;
};
/* Paste, fill and replace-all go through here: keep them out of locked cells. */
const batch = Engine.prototype.setCellsBatch;
Engine.prototype.setCellsBatch = function (sid, list) {
  const sh = this.sheetById(sid);
  if (!sh) return;
  return batch.call(this, sid, list.filter((it) => !sh.isProtected(it.r, it.c)));
};

/* ---- state -------------------------------------------------------------- */

let tab = null;            // what the server sent
let baseline = [];         // string[][] as the server has it; index = row - 1
let struct = '';           // the server's row-layout version for this tab
let grid = null;
let queue = [];            // ops waiting to be sent, in order
let sending = null;
let timer = null;
let failed = false;

const baseAt = (r, c) => { const row = baseline[r]; return row && row[c] !== undefined ? row[c] : ''; };
function setBase(r, c, v) {
  while (baseline.length <= r) baseline.push([]);
  const row = baseline[r];
  while (row.length <= c) row.push('');
  row[c] = v;
}

function build(t) {
  const cells = new CellStore();
  t.rowsData.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] !== '') cells.setAt(r, c, { raw: row[c] });
  });
  const prot = (t.computedRanges || []).map((x) => ({
    r1: x.firstRow - 1, c1: x.firstCol - 1, r2: MAX, c2: (x.lastCol || x.firstCol) - 1,
    reason: 'Calculated by the app'
  }));
  const colWidths = {};
  Object.keys(t.colWidths || {}).forEach((k) => { colWidths[+k - 1] = t.colWidths[k]; });
  return new MonoSheet({
    id: SID, name: t.name, cells,
    rows: t.rowsData.length + 200, cols: Math.max(t.cols + 6, 26),
    frozen: { rows: t.frozenRows || 0, cols: t.frozenCols || 0 },
    protectedRanges: prot, colWidths
  });
}

/* Collect cell edits the grid has made since the last look. */
function collect() {
  const taken = changes.take([SID]);
  const set = taken.sheets.get(SID);
  if (!set) return;
  const sh = grid.sheet();
  const visit = (r, c) => {
    const now = sh.getRaw(r, c) ?? '';
    const was = baseAt(r, c);
    if (String(now) === was) return;
    if (sh.isProtected(r, c)) { grid.engine.setRaw(SID, r, c, was); return; }   // a leak past the lock: put it back
    queue.push({ op: 'set', row: r + 1, col: c + 1, value: String(now), expect: was });
    setBase(r, c, String(now));
  };
  if (set === 'full') {
    const rows = Math.max(sh.rows, baseline.length);
    for (let r = 0; r < rows; r++) {
      const width = Math.max(sh.cols, (baseline[r] || []).length);
      for (let c = 0; c < width; c++) visit(r, c);
    }
  } else {
    for (const k of set) { const i = k.indexOf(','); visit(+k.slice(0, i), +k.slice(i + 1)); }
  }
  changes.take([SID]);       // drop the echoes of anything put back above
}

function schedule() {
  collect();
  if (!queue.length) return;
  setState('Saving…', 'busy');
  clearTimeout(timer);
  timer = setTimeout(flush, 350);
}

async function flush() {
  clearTimeout(timer);
  if (sending) { await sending; }
  collect();
  if (!queue.length) { if (!failed) setState('All changes saved', 'ok'); return; }
  const ops = queue; queue = [];
  setState('Saving…', 'busy');
  sending = (async () => {
    try {
      const res = await api('/tabs/' + tab.id + '/ops', { method: 'POST', body: JSON.stringify({ struct, ops }) });
      struct = res.struct;
      failed = false;
      let touched = false;
      /* The server stores "5" as a number and "1/2/2026" as a date; show what it kept. */
      for (const a of res.applied) {
        const r = a.row - 1, c = a.col - 1;
        if (baseAt(r, c) !== a.value) { setBase(r, c, a.value); }
        if (String(grid.sheet().getRaw(r, c) ?? '') !== a.value && !queue.length) { grid.engine.setRaw(SID, r, c, a.value); touched = true; }
      }
      for (const x of res.conflicts) {
        const r = x.row - 1, c = x.col - 1;
        setBase(r, c, x.value);
        grid.engine.setRaw(SID, r, c, x.value);
        touched = true;
      }
      if (touched) { changes.take([SID]); if (!grid.editing) grid.render(); }
      if (res.conflicts.length) {
        toast(res.conflicts.length + (res.conflicts.length === 1 ? ' cell was' : ' cells were') +
              ' changed by someone else in the meantime. The latest value is shown; nothing was overwritten.');
      }
      setState(queue.length ? 'Saving…' : 'All changes saved', queue.length ? 'busy' : 'ok');
      tellParent();
    } catch (e) {
      failed = true;
      if (e.status === 409 || e.status === 401 || e.status === 403 || e.status === 404) {
        setState('Not saved', 'bad');
        toast(e.message);
        if (e.status === 409) { queue = []; setTimeout(() => load(true), 1500); }
        return;
      }
      queue = ops.concat(queue);                 // keep order; try again
      setState('Not saved — retrying', 'bad');
      timer = setTimeout(flush, 3000);
    }
  })().finally(() => { sending = null; });
  await sending;
  if (queue.length && !failed) schedule();
}

function tellParent() {
  try { parent.postMessage({ type: 'levanto:saved', tab: tab.id }, location.origin); } catch { /* standalone */ }
}

/* ---- mounting ----------------------------------------------------------- */

function mount(t) {
  tab = t;
  baseline = t.rowsData.map((r) => r.slice());
  struct = t.struct;
  queue = [];
  const wb = new MonoWorkbook({ id: 'levanto', name: 'Raw data', sheets: [build(t)] });
  changes.dropSheets([SID]);
  if (!grid) {
    grid = new MonoGrid($('sheetHost'), new Engine(wb), { onChange: schedule });
    harden(grid);
  } else {
    grid.wb = wb;
    grid.engine = new Engine(wb);
    grid.undoStack = []; grid.redoStack = [];
    grid.active = { r: 0, c: 0 }; grid.anchor = { r: 0, c: 0 };
    grid.editing = false;
  }
  grid.access = { role: 'editor', isOwner: false, canEdit: true, canComment: false };
  grid.render();
  $('tabName').textContent = t.name;
  $('dims').textContent = t.rows.toLocaleString('en-IN') + ' rows · ' + t.cols + ' columns';
  $('note').textContent = t.computed ? 'Shaded columns are calculated by the app and cannot be edited.' : '';
  setState('All changes saved', 'ok');
}

function harden(g) {
  const no = () => toast('Not available in the raw-data view.');

  /* Row inserts and deletes are sent as what they are, in order with the
     cell edits around them, so the server never has to guess. */
  const insertRows = (at, n) => {
    collect();
    g.pushUndo();
    g.engine.insertRows(SID, at, n);
    const blank = []; for (let i = 0; i < n; i++) blank.push([]);
    if (at < baseline.length) baseline.splice(at, 0, ...blank);
    changes.take([SID]);
    queue.push({ op: 'insertRows', row: at + 1, n });
    g.undoStack = []; g.redoStack = [];
    g.afterStruct();
    schedule(); setState('Saving…', 'busy'); clearTimeout(timer); timer = setTimeout(flush, 350);
  };
  g.insertRowAbove = () => { const { r1 } = g.rect(); insertRows(r1, g.selRows()); };
  g.insertRowBelow = () => { const { r2 } = g.rect(); insertRows(r2 + 1, g.selRows()); };
  g.deleteSelRows = () => {
    const { r1, r2 } = g.rect();
    const n = r2 - r1 + 1;
    if (r1 >= baseline.length) return;
    const last = Math.min(r2, baseline.length - 1);
    const what = n === 1 ? 'row ' + (r1 + 1) : 'rows ' + (r1 + 1) + '–' + (last + 1);
    if (!confirm('Delete ' + what + ' from "' + tab.name + '"?\n\nEvery row below moves up. This is recorded in the audit log but cannot be undone here.')) return;
    collect();
    g.pushUndo();
    g.engine.deleteRows(SID, r1, n);
    baseline.splice(r1, n);
    changes.take([SID]);
    queue.push({ op: 'deleteRows', row: r1 + 1, n });
    g.undoStack = []; g.redoStack = [];
    g.afterStruct();
    setState('Saving…', 'busy'); clearTimeout(timer); timer = setTimeout(flush, 350);
  };

  /* Things that would change the shape of the data, or that belong to the
     spreadsheet product rather than to a data editor. */
  for (const m of ['insertColLeft', 'insertColRight', 'deleteSelCols', 'insertCellsShiftDown', 'insertCellsShiftRight',
    'deleteCellsShiftUp', 'deleteCellsShiftLeft', 'insertCellsDialog', 'deleteCellsDialog', 'addSheet', 'duplicateSheet',
    'deleteSheetPrompt', 'renameSheetPrompt', 'importFilePrompt', 'protectSel', 'unprotectSel', 'openColTypePicker',
    'sortSel', 'sortRangeBy', 'sortColumnHeader', 'mergeSel', 'unmergeSel', 'commitHeaderMove']) {
    if (typeof g[m] === 'function') g[m] = no;
  }
  const blocked = new Set(['openScripts', 'copilot', 'useInDashboard', 'insertChart', 'openSettings', 'viewsPanel',
    'setColType', 'importFile', 'sortAZ', 'sortZA', 'sortRange', 'protectRange', 'unprotectRange', 'newSheet',
    'insertPivot', 'insertImage']);
  const command = g.command.bind(g);
  g.command = (cmd) => (blocked.has(cmd) ? no() : command(cmd));

  /* Undo steps back cell edits. The grid's own tracker does not see an undo,
     so tell it which cells the step touched. */
  const step = g._step.bind(g);
  g._step = (from, to) => {
    g._closeTx();
    const tx = from[from.length - 1];
    if (!tx) return;
    if (tx.struct && tx.struct.length) { toast('Inserting or deleting rows cannot be undone here.'); return; }
    step(from, to);
    for (const key of tx.cells.keys()) {
      const i = key.indexOf('|');
      changes.trackCell(key.slice(0, i), key.slice(i + 1));
    }
    schedule();
  };

  /* Ctrl+V from Excel, Google Sheets or anywhere else. The grid's own paste
     only knows what was copied inside it. */
  const paste = g.paste.bind(g);
  g.paste = async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* no permission: fall back */ }
    if (!text) return paste();
    const rows = text.replace(/\r/g, '').split('\n');
    if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
    const list = [];
    const { r, c } = g.active;
    rows.forEach((line, i) => line.split('\t').forEach((raw, j) => list.push({ r: r + i, c: c + j, raw })));
    if (!list.length) return;
    g.pushUndo();
    g.engine.setCellsBatch(SID, list);
    g.save(); g.render();
  };
}

async function load(quiet) {
  if (!quiet) $('loading').style.display = 'flex';
  try {
    const res = await api('/tabs/' + encodeURIComponent(tabId));
    mount(res.tab);
    $('loading').style.display = 'none';
  } catch (e) {
    $('loading').style.display = 'flex';
    $('loading').textContent = e.status === 401 || e.status === 403 ? 'Your sign-in has ended. Sign in again from the admin panel.' : e.message;
  }
}

$('reload').onclick = async () => {
  await flush();
  if (queue.length) { toast('There are changes that have not been saved yet.'); return; }
  load(true).then(() => toast('Showing the latest data.'));
};

/* The admin panel asks before it switches tab or page. */
window.levantoFlush = async () => { await flush(); return !queue.length && !failed; };
window.levantoPending = () => { collect(); return queue.length > 0 || !!sending; };
addEventListener('beforeunload', (e) => { if (window.levantoPending()) { e.preventDefault(); e.returnValue = ''; } });

if (!tabId) { $('loading').textContent = 'No tab chosen.'; } else { load(false); }
