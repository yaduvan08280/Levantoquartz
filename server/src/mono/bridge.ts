/**
 * The bridge between the data store and Mono Sheets.
 *
 * Mono Sheets runs here as it is, unmodified. It saves through its own
 * protocol — load a workbook, send patches of changed cells, listen on an
 * event stream for what others changed — and normally a Mono Sheets server
 * answers that from JSON files. Here this module answers it from the store:
 *
 *   store -> sheets   a tab is presented as a sheet; whenever anything
 *                     changes a tab (an operator's entry, a computed column,
 *                     another admin), the changed cells are pushed to every
 *                     open sheet over the event stream.
 *   sheets -> store   a patch from Mono Sheets is written into the tabs cell
 *                     by cell, under the store's rules (values are parsed as
 *                     typed input; computed columns cannot be overwritten).
 *
 * The store holds values. What Mono Sheets keeps on top of them — column
 * widths, filters, frozen panes, cell colours and number formats — is kept
 * per tab in `tab.mono` and handed back unchanged.
 */
import type { ServerResponse } from 'node:http';
import { editValue, isEmpty } from '../store/values.js';
import { Tab, Workbook } from '../store/workbook.js';
import { refreshAll, hasComputed } from '../store/computed.js';

export const MAIN_BOOK = 'newbase';
export const LOG_BOOK = 'applog';
const COMPUTED_REASON = 'Calculated by the app';
const LIVE_PATCH_MAX = 512 * 1024;
/* Layout a sheet carries that is not cell data and not owned by the store. */
const KEPT_META = ['tabColor', 'merges', 'validations', 'filter', 'conditionalFormats', 'hiddenRows', 'hiddenCols',
  'showFormulas', 'gridlines', 'zoom', 'colWidths', 'rowHeights', 'views', 'colTypes', 'colMeta'];

export interface Change { tab: string; row: number; col: number; old: string; neu: string }
export interface Origin { clientId: string; book: string; sent: Map<Tab, Map<string, string>>; replaced: Set<Tab> }

export class BridgeError extends Error {
  constructor(public code: 'conflict' | 'unpatchable' | 'sheet_delete_forbidden', message = '') { super(message || code); }
}

export class Bridge {
  private versions = new Map<string, number>();
  private watchers = new Map<string, Set<ServerResponse>>();
  private bookMeta = new Map<string, { namedRanges?: any; activeSheetId?: string }>();
  /** Set by a request that is applying Mono Sheets' own patch. */
  origin: Origin | null = null;

  constructor(private wb: Workbook, private logTab: () => string) {
    const start = Math.floor(Date.now() / 1000);
    this.versions.set(MAIN_BOOK, start);
    this.versions.set(LOG_BOOK, start);
  }

  /* ------------------------------------------------------------ books -- */

  bookOf(tab: Tab): string { return tab.name === this.logTab() ? LOG_BOOK : MAIN_BOOK; }
  bookName(id: string): string { return id === LOG_BOOK ? 'App Submission Log' : 'New Base'; }
  hasBook(id: string): boolean { return id === MAIN_BOOK || (id === LOG_BOOK && !!this.wb.rawTab(this.logTab())); }
  version(id: string): number { return this.versions.get(id) || 0; }
  books(): string[] { return [MAIN_BOOK, LOG_BOOK].filter((b) => this.hasBook(b)); }

  private tabsOf(book: string): Tab[] {
    return this.wb.tabs.filter((t) => this.bookOf(t) === book).sort((a, b) => a.position - b.position)
      .map((t) => this.wb.tab(t.name)!);
  }

  sheetId(tab: Tab): string { return tab.mono.id || 't' + tab.id; }

  private tabBySheet(book: string, sid: string): Tab | null {
    return this.tabsOf(book).find((t) => this.sheetId(t) === sid) || null;
  }

  /* ---------------------------------------------------- store -> sheet -- */

  private cellJson(tab: Tab, row: number, col: number): any | null {
    const v = tab.get(row, col);
    const extra = tab.mono.cellx && tab.mono.cellx[(row - 1) + ',' + (col - 1)];
    if (isEmpty(v)) return extra ? { ...extra } : null;
    return extra ? { ...extra, raw: editValue(v) } : { raw: editValue(v) };
  }

  private protectedRanges(tab: Tab): any[] {
    const mine = tab.computed.map((x) => ({
      r1: x.firstRow - 1, c1: x.firstCol - 1, r2: 9007199254740991, c2: (x.lastCol || x.firstCol) - 1, reason: COMPUTED_REASON
    }));
    const theirs = ((tab.mono.meta && tab.mono.meta.protectedRanges) || []).filter((p: any) => p && p.reason !== COMPUTED_REASON);
    return mine.concat(theirs);
  }

  sheetJson(tab: Tab): any {
    const cells: Record<string, any> = {};
    for (let r = 0; r < tab.rows.length; r++) {
      const row = tab.rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (!isEmpty(row[c])) cells[r + ',' + c] = { raw: editValue(row[c]) };
      }
    }
    const cx = tab.mono.cellx || {};
    for (const k of Object.keys(cx)) cells[k] = cells[k] ? { ...cx[k], raw: cells[k].raw } : { ...cx[k] };
    const meta = tab.mono.meta || {};
    const out: any = {
      id: this.sheetId(tab), name: tab.name, hidden: tab.hidden,
      rows: Math.max(tab.lastRow() + 200, 100), cols: Math.max(tab.lastCol() + 6, 26),
      cells, frozen: { rows: tab.frozenRows, cols: tab.frozenCols },
      protectedRanges: this.protectedRanges(tab)
    };
    for (const k of KEPT_META) if (meta[k] !== undefined) out[k] = meta[k];
    return out;
  }

  workbookJson(book: string): any {
    const tabs = this.tabsOf(book);
    const bm = this.bookMeta.get(book) || {};
    return {
      schema: 2, id: book, name: this.bookName(book),
      activeSheetId: bm.activeSheetId && tabs.some((t) => this.sheetId(t) === bm.activeSheetId) ? bm.activeSheetId : undefined,
      namedRanges: bm.namedRanges || {},
      scripts: { files: [], props: { script: {}, document: {} } }, aiLog: [],
      sheets: tabs.map((t) => this.sheetJson(t))
    };
  }

  /* -------------------------------------------------- the event stream -- */

  watch(book: string, res: ServerResponse): void {
    let set = this.watchers.get(book);
    if (!set) { set = new Set(); this.watchers.set(book, set); }
    set.add(res);
  }
  unwatch(res: ServerResponse): void {
    for (const set of this.watchers.values()) set.delete(res);
  }
  watching(): number {
    let n = 0;
    for (const set of this.watchers.values()) n += set.size;
    return n;
  }

  private send(book: string, event: any): void {
    const set = this.watchers.get(book);
    if (!set || !set.size) return;
    const line = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const res of set) { try { res.write(line); } catch { /* closed; cleaned up on 'close' */ } }
  }

  /** Everything changed at once (an import, a reload): open sheets start over. */
  reloadAll(): void {
    for (const t of this.wb.tabs) { t.touched.clear(); t.reshaped = false; }
    for (const book of [MAIN_BOOK, LOG_BOOK]) {
      const v = this.version(book) + 1;
      this.versions.set(book, v);
      this.send(book, { id: book, v, from: '', reload: true });
    }
  }

  /** Forget changes made while starting up — nobody was watching yet. */
  settle(): void {
    refreshAll(this.wb);
    for (const t of this.wb.tabs) { t.touched.clear(); t.reshaped = false; }
  }

  /**
   * Tell open sheets what has changed in the store since the last call.
   * Runs after every commit, whoever made it.
   */
  publish(): void {
    const origin = this.origin;
    this.origin = null;
    refreshAll(this.wb);                           // computed columns follow their inputs first

    for (const book of [MAIN_BOOK, LOG_BOOK]) {
      const sheets: Record<string, { cells: Record<string, any> }> = {};
      const fix: Record<string, { cells: Record<string, any> }> = {};
      let any = false, reload = false, fixes = 0;

      for (const tab of this.wb.tabs) {
        if (this.bookOf(tab) !== book || (!tab.touched.size && !tab.reshaped)) continue;
        any = true;
        const mine = !!origin && origin.book === book;
        if (tab.reshaped && !(mine && origin!.replaced.has(tab))) reload = true;
        const sid = this.sheetId(tab);
        const sent = mine ? origin!.sent.get(tab) : undefined;
        const cells: Record<string, any> = {};
        for (const n of tab.touched) {
          const row = Math.floor(n / 8192), col = n % 8192;
          const key = (row - 1) + ',' + (col - 1);
          const cell = this.cellJson(tab, row, col);
          cells[key] = cell;
          /* What the sender does not already have: a value the store read
             differently from how it was typed, or a cell it did not write. */
          if (mine) {
            const typed = sent ? sent.get(key) : undefined;
            const now = cell && cell.raw !== undefined ? String(cell.raw) : '';
            if (typed === undefined || typed !== now) { (fix[sid] || (fix[sid] = { cells: {} })).cells[key] = cell; fixes++; }
          }
        }
        if (Object.keys(cells).length) sheets[sid] = { cells };
        tab.touched.clear();
        tab.reshaped = false;
      }
      if (!any) continue;

      const v = this.version(book) + 1;
      this.versions.set(book, v);
      const from = origin && origin.book === book ? origin.clientId : '';
      let event: any = { id: book, v, from, patch: { sheets } };
      if (reload || JSON.stringify(event).length > LIVE_PATCH_MAX) event = { id: book, v, from, reload: true };
      this.send(book, event);

      if (fixes) {
        /* After the sender has had its answer: until then it treats these
           cells as still in flight and would ignore the correction. */
        setTimeout(() => {
          const v2 = this.version(book) + 1;
          this.versions.set(book, v2);
          this.send(book, { id: book, v: v2, from: '', patch: { sheets: fix } });
        }, 700).unref();
      }
    }
  }

  /* ---------------------------------------------------- sheet -> store -- */

  private splitCell(cell: any, palette?: any[]): { raw: string; extra: any | null } {
    if (cell === null || cell === undefined) return { raw: '', extra: null };
    const { raw, s, ...rest } = cell;
    if (s !== undefined && palette && palette[s] && rest.st === undefined) rest.st = palette[s];
    return { raw: raw === undefined || raw === null ? '' : String(raw), extra: Object.keys(rest).length ? rest : null };
  }

  private writeCell(tab: Tab, key: string, cell: any, changes: Change[], palette?: any[]): void {
    const i = key.indexOf(',');
    const row = +key.slice(0, i) + 1, col = +key.slice(i + 1) + 1;
    if (!(row >= 1) || !(col >= 1) || col > 8000 || row > 2000000) return;
    const { raw, extra } = this.splitCell(cell, palette);
    const cx = tab.mono.cellx || (tab.mono.cellx = {});
    const had = JSON.stringify(cx[key] || null);
    if (extra) cx[key] = extra; else delete cx[key];
    if (had !== JSON.stringify(extra)) tab.dirtyMeta = true;

    const now = editValue(tab.get(row, col));
    if (raw === now) return;
    if (tab.isComputed(row, col)) { tab.touched.add(row * 8192 + col); return; }   // refused: sender gets the real value back
    tab.setEntered(row, col, raw);
    changes.push({ tab: tab.name, row, col, old: now, neu: editValue(tab.get(row, col)) });
  }

  private applyMeta(tab: Tab, meta: any): void {
    if (!meta || typeof meta !== 'object') return;
    if (typeof meta.name === 'string' && meta.name.trim() && meta.name !== tab.name && !hasComputed(tab.name)) {
      try { this.wb.renameTab(tab, meta.name); } catch { /* name taken: keep ours */ }
    }
    if (meta.hidden !== undefined && !!meta.hidden !== tab.hidden) { tab.hidden = !!meta.hidden; tab.dirtyMeta = true; }
    if (meta.frozen && typeof meta.frozen === 'object') {
      const r = Math.max(0, +meta.frozen.rows || 0), c = Math.max(0, +meta.frozen.cols || 0);
      if (r !== tab.frozenRows || c !== tab.frozenCols) { tab.frozenRows = r; tab.frozenCols = c; tab.dirtyMeta = true; }
    }
    const kept = tab.mono.meta || (tab.mono.meta = {});
    for (const k of KEPT_META.concat(['protectedRanges'])) {
      if (!(k in meta)) continue;
      if (JSON.stringify(kept[k]) !== JSON.stringify(meta[k])) { kept[k] = meta[k]; tab.dirtyMeta = true; }
    }
  }

  /** A sheet arriving whole: rows were inserted, deleted or sorted in the editor. */
  private applyWhole(tab: Tab, sheet: any, changes: Change[], origin: Origin): void {
    const palette = Array.isArray(sheet.styles) ? sheet.styles : undefined;
    const incoming: Record<string, any> = sheet.cells || {};
    const sent = new Map<string, string>();
    const before = tab.lastRow();
    const cx: Record<string, any> = {};
    const want = new Map<number, Map<number, string>>();
    for (const key of Object.keys(incoming)) {
      const { raw, extra } = this.splitCell(incoming[key], palette);
      if (extra) cx[key] = extra;
      sent.set(key, raw);
      if (raw === '') continue;
      const i = key.indexOf(',');
      const r = +key.slice(0, i), c = +key.slice(i + 1);
      let line = want.get(r);
      if (!line) { line = new Map(); want.set(r, line); }
      line.set(c, raw);
    }
    let maxRow = tab.lastRow();
    for (const r of want.keys()) if (r + 1 > maxRow) maxRow = r + 1;
    let n = 0;
    for (let row = 1; row <= maxRow; row++) {
      const line = want.get(row - 1);
      const width = Math.max((tab.rows[row - 1] || []).length, line ? Math.max(...line.keys()) + 1 : 0);
      for (let col = 1; col <= width; col++) {
        const raw = (line && line.get(col - 1)) || '';
        const now = editValue(tab.get(row, col));
        if (raw === now) continue;
        if (tab.isComputed(row, col)) { tab.touched.add(row * 8192 + col); continue; }
        tab.setEntered(row, col, raw);
        if (n++ < 400) changes.push({ tab: tab.name, row, col, old: now, neu: editValue(tab.get(row, col)) });
      }
    }
    if (n >= 400) changes.push({ tab: tab.name, row: 0, col: 0, old: '', neu: n + ' cells rewritten (rows inserted, deleted or sorted; ' + before + ' rows before, ' + tab.lastRow() + ' after)' });
    tab.mono.cellx = cx;
    tab.dirtyMeta = true;
    tab.structVersion++;
    tab.reshaped = true;
    origin.replaced.add(tab);
    origin.sent.set(tab, sent);
    this.applyMeta(tab, sheet);
  }

  /** Mono Sheets' PATCH. Throws BridgeError for the cases its client handles itself. */
  applyPatch(book: string, patch: any, baseVersion: number | null, clientId: string): Change[] {
    const entries = Object.entries((patch && patch.sheets) || {}) as [string, any][];
    const stale = Number(baseVersion) !== this.version(book);
    /* A whole-sheet replacement built from an old copy would undo whatever
       happened since — an operator's new row included. That one must be
       redone on the latest data; plain cell edits never conflict. */
    if (stale && entries.some(([, d]) => d && d.replace)) throw new BridgeError('conflict');
    const targets: [Tab, any][] = [];
    for (const [sid, delta] of entries) {
      const tab = this.tabBySheet(book, sid);
      if (!tab) throw new BridgeError('unpatchable', 'unknown sheet ' + sid);
      targets.push([tab, delta]);
    }
    if (patch && Array.isArray(patch.removeSheets) && patch.removeSheets.length) throw new BridgeError('sheet_delete_forbidden');

    const origin: Origin = { clientId, book, sent: new Map(), replaced: new Set() };
    const changes: Change[] = [];
    for (const [tab, delta] of targets) {
      if (!delta) continue;
      if (delta.replace) { this.applyWhole(tab, delta.replace, changes, origin); continue; }
      if (delta.cells) {
        const sent = new Map<string, string>();
        for (const key of Object.keys(delta.cells)) {
          sent.set(key, this.splitCell(delta.cells[key]).raw);
          this.writeCell(tab, key, delta.cells[key], changes);
        }
        origin.sent.set(tab, sent);
      }
      if (delta.meta) this.applyMeta(tab, delta.meta);
    }
    const bm = this.bookMeta.get(book) || {};
    if (patch && patch.namedRanges && typeof patch.namedRanges === 'object') bm.namedRanges = patch.namedRanges;
    if (patch && typeof patch.activeSheetId === 'string') bm.activeSheetId = patch.activeSheetId;
    this.bookMeta.set(book, bm);
    this.origin = origin;
    return changes;
  }

  /** Mono Sheets' full save: sheets were added or reordered, or a patch could not describe the change. */
  applyFull(book: string, json: any, baseVersion: number | null, clientId: string): Change[] {
    const sheets: any[] = Array.isArray(json && json.sheets) ? json.sheets : [];
    const mine = this.tabsOf(book);
    const ids = new Set(sheets.map((s) => String(s.id)));
    /* Tabs are the plant's records. Removing one is not something a stray
       click in the sheet editor may do. */
    if (mine.some((t) => !ids.has(this.sheetId(t)))) throw new BridgeError('sheet_delete_forbidden');
    if (baseVersion !== null && Number(baseVersion) !== this.version(book)) throw new BridgeError('conflict');

    const origin: Origin = { clientId, book, sent: new Map(), replaced: new Set() };
    const changes: Change[] = [];
    sheets.forEach((sheet, i) => {
      let tab = this.tabBySheet(book, String(sheet.id));
      if (!tab) {
        if (book !== MAIN_BOOK) return;
        let name = String(sheet.name || 'Sheet').trim() || 'Sheet';
        for (let n = 2; this.wb.rawTab(name); n++) name = String(sheet.name || 'Sheet') + ' ' + n;
        tab = this.wb.createTab(name);
        tab.mono.id = String(sheet.id);
        changes.push({ tab: name, row: 0, col: 0, old: '', neu: 'tab added' });
      }
      this.applyWhole(tab, sheet, changes, origin);
      if (book === MAIN_BOOK && tab.position !== i) { tab.position = i; tab.dirtyMeta = true; }
    });
    const bm = this.bookMeta.get(book) || {};
    if (json && json.namedRanges) bm.namedRanges = json.namedRanges;
    if (json && typeof json.activeSheetId === 'string') bm.activeSheetId = json.activeSheetId;
    this.bookMeta.set(book, bm);
    this.origin = origin;
    return changes;
  }
}
