/**
 * The workbook: every tab of operational data, held in memory and written
 * through to Postgres.
 *
 * Why in memory. The whole plant's data is a few megabytes, and every screen
 * in the forms app is a handful of column scans (which slabs has Q.C. not
 * seen, is this bag already used). Against a spreadsheet each scan cost
 * seconds; against rows already in memory it costs microseconds, and there is
 * no cache to go stale. Postgres stays the source of truth: a request's
 * changes are committed in one transaction before the request is answered,
 * and the process reloads from it on start.
 *
 * Rows and columns are 1-based on the public methods, like a sheet.
 */
import type pg from 'pg';
import {
  type Cell, type StoredCell, decodeCell, encodeCell, displayValue, parseEntered, isEmpty
} from './values.js';

export type RowFormats = Record<number, string>;      // 0-based column -> number format

export interface ComputedRange {
  /** 1-based, inclusive. lastCol/lastRow of 0 mean "to the end". */
  firstRow: number; firstCol: number; lastCol: number;
}

export class Tab {
  id: number | null = null;
  name: string;
  position = 0;
  hidden = false;
  frozenRows = 0;
  frozenCols = 0;
  maxCols = 26;
  colFmt: Record<number, string> = {};                // 1-based column -> number format
  colWidths: Record<number, number> = {};
  rows: Cell[][] = [];
  fmts: (RowFormats | undefined)[] = [];

  /** Bumped on every stored change; computed columns key off it. */
  version = 0;
  /** Bumped when rows or columns are inserted or removed (row numbers moved). */
  structVersion = 0;
  /** Cells owned by a computed column: shown, never stored or edited. */
  computed: ComputedRange[] = [];
  /** Formula text reported for a computed column's anchor cell. */
  formulas = new Map<string, string>();

  dirtyRows = new Set<number>();                       // 0-based
  dirtyAll = false;
  dirtyMeta = false;
  deleted = false;

  private lastColCache = { version: -1, value: 0 };
  private cver = 0;                                    // bumps on computed writes too

  constructor(name: string) { this.name = name; }

  /* ----------------------------------------------------------- reads -- */

  get(row: number, col: number): Cell {
    const r = this.rows[row - 1];
    if (!r) return '';
    const v = r[col - 1];
    return v === undefined || v === null ? '' : v;
  }

  format(row: number, col: number): string | undefined {
    const f = this.fmts[row - 1];
    if (f && f[col - 1] !== undefined) return f[col - 1];
    return this.colFmt[col];
  }

  display(row: number, col: number): string {
    return displayValue(this.get(row, col), this.format(row, col));
  }

  lastRow(): number { return this.rows.length; }

  lastCol(): number {
    const key = this.version * 100003 + this.cver;
    if (this.lastColCache.version === key) return this.lastColCache.value;
    let max = 0;
    for (const r of this.rows) {
      if (!r) continue;
      let n = r.length;
      while (n > max && isEmpty(r[n - 1])) n--;
      if (n > max) max = n;
    }
    this.lastColCache = { version: key, value: max };
    return max;
  }

  gridCols(): number { return Math.max(this.maxCols, this.lastCol(), 1); }
  gridRows(): number { return Math.max(this.rows.length + 200, 1000); }

  isComputed(row: number, col: number): boolean {
    for (const c of this.computed) {
      if (row >= c.firstRow && col >= c.firstCol && (c.lastCol === 0 || col <= c.lastCol)) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------- writes -- */

  private rowFor(row: number): Cell[] {
    while (this.rows.length < row) this.rows.push([]);
    return this.rows[row - 1] || (this.rows[row - 1] = []);
  }

  private trim(): void {
    let n = this.rows.length;
    while (n > 0) {
      const r = this.rows[n - 1];
      let empty = true;
      if (r) for (let i = 0; i < r.length; i++) if (!isEmpty(r[i])) { empty = false; break; }
      if (!empty) break;
      n--;
    }
    if (n < this.rows.length) {
      for (let i = n; i < this.rows.length; i++) this.dirtyRows.add(i);
      this.rows.length = n;
      if (this.fmts.length > n) this.fmts.length = n;
    }
  }

  /** Store a value exactly as given (no parsing). */
  set(row: number, col: number, v: Cell, fmt?: string): void {
    if (row < 1 || col < 1) throw new Error('Cell out of range');
    const empty = isEmpty(v);
    if (empty && row > this.rows.length && fmt === undefined) return;
    const r = this.rowFor(row);
    while (r.length < col - 1) r.push('');
    r[col - 1] = empty ? '' : v;
    if (fmt !== undefined) this.setFormat(row, col, fmt);
    this.dirtyRows.add(row - 1);
    this.version++;
    if (empty) this.trim();
  }

  /** Store a value the way typing it into the cell would (see values.ts). */
  setEntered(row: number, col: number, value: unknown): void {
    const current = this.format(row, col);
    if (current === '@') {
      this.set(row, col, value === null || value === undefined ? '' : String(value));
      return;
    }
    const p = parseEntered(value);
    this.set(row, col, p.v, p.f && !current ? p.f : undefined);
  }

  setFormat(row: number, col: number, fmt: string): void {
    if (row > this.rows.length) return;                 // formats never create rows
    while (this.fmts.length < row) this.fmts.push(undefined);
    const f = this.fmts[row - 1] || (this.fmts[row - 1] = {});
    if (fmt === '' || fmt === undefined) delete f[col - 1]; else f[col - 1] = fmt;
    this.dirtyRows.add(row - 1);
  }

  setColFormat(col: number, fmt: string): void {
    if (fmt) this.colFmt[col] = fmt; else delete this.colFmt[col];
    this.dirtyMeta = true;
  }

  /** Write a cell a computed column owns: visible, but not stored. */
  setComputed(row: number, col: number, v: Cell): void {
    const empty = isEmpty(v);
    if (empty && row > this.rows.length) return;
    const r = this.rowFor(row);
    while (r.length < col - 1) r.push('');
    r[col - 1] = empty ? '' : v;
    this.cver++;
  }

  /** Replace a computed column from `firstRow` down with `values`, clearing the rest. */
  setComputedColumn(col: number, firstRow: number, values: Cell[]): void {
    for (let i = 0; i < values.length; i++) this.setComputed(firstRow + i, col, values[i]);
    for (let r = firstRow + values.length; r <= this.rows.length; r++) {
      const row = this.rows[r - 1];
      if (row && !isEmpty(row[col - 1])) row[col - 1] = '';
    }
    this.cver++;
  }

  /** Drop trailing rows left empty after computed columns shrank. */
  trimComputed(): void {
    let n = this.rows.length;
    while (n > 0) {
      const r = this.rows[n - 1];
      let empty = true;
      if (r) for (let i = 0; i < r.length; i++) if (!isEmpty(r[i])) { empty = false; break; }
      if (!empty) break;
      n--;
    }
    this.rows.length = n;
    if (this.fmts.length > n) this.fmts.length = n;
  }

  appendRow(values: unknown[]): number {
    const row = this.rows.length + 1;
    values.forEach((v, i) => { if (!isEmpty(v)) this.setEntered(row, i + 1, v); });
    return row;
  }

  insertRows(beforeRow: number, n: number): void {
    if (beforeRow > this.rows.length || n < 1) return;
    const blank: Cell[][] = [];
    const blankF: undefined[] = [];
    for (let i = 0; i < n; i++) { blank.push([]); blankF.push(undefined); }
    this.rows.splice(beforeRow - 1, 0, ...blank);
    while (this.fmts.length < beforeRow - 1) this.fmts.push(undefined);
    this.fmts.splice(beforeRow - 1, 0, ...blankF);
    this.structural();
  }

  deleteRows(row: number, n: number): void {
    if (row > this.rows.length || n < 1) return;
    this.rows.splice(row - 1, n);
    this.fmts.splice(row - 1, n);
    this.structural();
    this.trim();
  }

  insertCols(afterCol: number, n: number): void {
    const blanks = () => Array.from({ length: n }, () => '' as Cell);
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r && r.length > afterCol) r.splice(afterCol, 0, ...blanks());
      const f = this.fmts[i];
      if (f) this.fmts[i] = shiftKeys(f, afterCol, n);
    }
    this.colFmt = shiftKeys(this.colFmt, afterCol + 1, n);
    this.colWidths = shiftKeys(this.colWidths, afterCol + 1, n);
    this.maxCols += n;
    this.structural();
  }

  deleteCols(col: number, n: number): void {
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r && r.length >= col) r.splice(col - 1, n);
      const f = this.fmts[i];
      if (f) this.fmts[i] = dropKeys(f, col - 1, n);
    }
    this.colFmt = dropKeys(this.colFmt, col, n);
    this.colWidths = dropKeys(this.colWidths, col, n);
    this.maxCols = Math.max(1, this.maxCols - n);
    this.structural();
    this.trim();
  }

  private structural(): void {
    this.dirtyAll = true;
    this.dirtyMeta = true;
    this.version++;
    this.structVersion++;
  }

  /* ------------------------------------------------------ serialising -- */

  encodeRow(i: number): { cells: string; fmts: string | null } | null {
    const r = this.rows[i];
    if (!r) return null;
    let n = r.length;
    while (n > 0 && isEmpty(r[n - 1])) n--;
    const f = this.fmts[i];
    const hasFmt = !!f && Object.keys(f).length > 0;
    if (n === 0 && !hasFmt) return null;
    const out: StoredCell[] = new Array(n);
    for (let c = 0; c < n; c++) {
      out[c] = this.isComputed(i + 1, c + 1) ? '' : encodeCell(r[c]);
    }
    let m = out.length;
    while (m > 0 && (out[m - 1] === '' || out[m - 1] === null)) m--;
    out.length = m;
    if (m === 0 && !hasFmt) return null;
    return { cells: JSON.stringify(out), fmts: hasFmt ? JSON.stringify(f) : null };
  }
}

function shiftKeys<T>(o: Record<number, T>, from: number, by: number): Record<number, T> {
  const out: Record<number, T> = {};
  for (const k of Object.keys(o)) {
    const n = +k;
    out[n >= from ? n + by : n] = o[n];
  }
  return out;
}

function dropKeys<T>(o: Record<number, T>, from: number, count: number): Record<number, T> {
  const out: Record<number, T> = {};
  for (const k of Object.keys(o)) {
    const n = +k;
    if (n >= from && n < from + count) continue;
    out[n >= from + count ? n - count : n] = o[n];
  }
  return out;
}

/* ====================================================================== */

export type FreshHook = (wb: Workbook, tab: Tab) => void;

export class Workbook {
  tabs: Tab[] = [];
  private byName = new Map<string, Tab>();

  /** kv store: scope -> key -> value. 'prop' is the app's own settings. */
  private kv = new Map<string, Map<string, string>>();
  private dirtyKv = new Set<string>();                 // "scope\u0000key"
  private removedTabs: number[] = [];

  private chain: Promise<void> = Promise.resolve();
  /** Set by computed.ts: brings a tab's computed columns up to date. */
  freshHook: FreshHook | null = null;
  loadedAt = 0;

  constructor(private pool: pg.Pool) {}

  /* ------------------------------------------------------------ tabs -- */

  tab(name: string): Tab | null {
    const t = this.byName.get(name);
    if (!t) return null;
    if (this.freshHook) this.freshHook(this, t);
    return t;
  }

  /** The tab without recomputing — for code that is itself computing. */
  rawTab(name: string): Tab | null { return this.byName.get(name) || null; }

  tabById(id: number): Tab | null {
    const t = this.tabs.find((x) => x.id === id) || null;
    if (t && this.freshHook) this.freshHook(this, t);
    return t;
  }

  createTab(name: string): Tab {
    if (this.byName.has(name)) throw new Error('A tab named "' + name + '" already exists.');
    const t = new Tab(name);
    t.position = this.tabs.reduce((m, x) => Math.max(m, x.position), -1) + 1;
    t.dirtyMeta = true;
    this.tabs.push(t);
    this.byName.set(name, t);
    return t;
  }

  renameTab(tab: Tab, name: string): void {
    name = String(name || '').trim();
    if (!name) throw new Error('A tab needs a name.');
    if (this.byName.has(name) && this.byName.get(name) !== tab) {
      throw new Error('A tab named "' + name + '" already exists.');
    }
    this.byName.delete(tab.name);
    tab.name = name;
    tab.dirtyMeta = true;
    this.byName.set(name, tab);
  }

  deleteTab(tab: Tab): void {
    this.tabs = this.tabs.filter((t) => t !== tab);
    this.byName.delete(tab.name);
    tab.deleted = true;
    if (tab.id !== null) this.removedTabs.push(tab.id);
  }

  /* -------------------------------------------------------------- kv -- */

  private scope(scope: string): Map<string, string> {
    let m = this.kv.get(scope);
    if (!m) { m = new Map(); this.kv.set(scope, m); }
    return m;
  }

  kvGet(scope: string, key: string): string | null {
    const v = this.scope(scope).get(key);
    return v === undefined ? null : v;
  }

  kvSet(scope: string, key: string, value: string): void {
    this.scope(scope).set(key, String(value));
    this.dirtyKv.add(scope + '\u0000' + key);
  }

  kvDelete(scope: string, key: string): void {
    if (this.scope(scope).delete(key)) this.dirtyKv.add(scope + '\u0000' + key);
  }

  kvAll(scope: string): Record<string, string> {
    const out: Record<string, string> = {};
    this.scope(scope).forEach((v, k) => { out[k] = v; });
    return out;
  }

  /* ------------------------------------------------------------ load -- */

  async load(): Promise<void> {
    const tabs = await this.pool.query('SELECT * FROM tabs ORDER BY position, id');
    const list: Tab[] = [];
    const byId = new Map<number, Tab>();
    for (const r of tabs.rows) {
      const t = new Tab(r.name);
      t.id = r.id;
      t.position = r.position;
      t.hidden = r.hidden;
      t.frozenRows = r.frozen_rows;
      t.frozenCols = r.frozen_cols;
      t.maxCols = r.max_cols;
      t.colFmt = r.col_formats || {};
      t.colWidths = r.col_widths || {};
      list.push(t);
      byId.set(t.id!, t);
    }
    const rows = await this.pool.query({
      text: 'SELECT tab_id, row_no, cells, fmts FROM tab_rows ORDER BY tab_id, row_no',
      rowMode: 'array'
    });
    for (const [tabId, rowNo, cells, fmts] of rows.rows as [number, number, StoredCell[], RowFormats | null][]) {
      const t = byId.get(tabId);
      if (!t) continue;
      while (t.rows.length < rowNo - 1) t.rows.push([]);
      t.rows[rowNo - 1] = (cells || []).map(decodeCell);
      if (fmts) {
        while (t.fmts.length < rowNo - 1) t.fmts.push(undefined);
        t.fmts[rowNo - 1] = fmts;
      }
    }
    const kv = await this.pool.query('SELECT scope, key, value FROM kv');
    const map = new Map<string, Map<string, string>>();
    for (const r of kv.rows) {
      let m = map.get(r.scope);
      if (!m) { m = new Map(); map.set(r.scope, m); }
      m.set(r.key, r.value);
    }

    this.tabs = list;
    this.byName = new Map(list.map((t) => [t.name, t]));
    this.kv = map;
    this.dirtyKv.clear();
    this.removedTabs = [];
    this.loadedAt = Date.now();
  }

  /* ----------------------------------------------------------- flush -- */

  hasPending(): boolean {
    if (this.dirtyKv.size || this.removedTabs.length) return true;
    for (const t of this.tabs) if (t.dirtyAll || t.dirtyMeta || t.dirtyRows.size || t.id === null) return true;
    return false;
  }

  /**
   * Commit everything changed since the last flush, in one transaction.
   * Calls queue behind each other, so writes reach the database in the order
   * they happened.
   */
  flush(): Promise<void> {
    if (!this.hasPending()) return this.chain;
    const run = this.chain.then(() => this.flushNow());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async flushNow(): Promise<void> {
    if (!this.hasPending()) return;

    /* Snapshot synchronously: what is serialised here is one consistent
       state, and anything changed while the queries run waits for the next
       flush. */
    interface TabWork {
      tab: Tab; meta: boolean; all: boolean;
      upserts: { no: number; cells: string; fmts: string | null }[];
      deletes: number[];
    }
    const work: TabWork[] = [];
    for (const tab of this.tabs) {
      const isNew = tab.id === null;
      if (!isNew && !tab.dirtyAll && !tab.dirtyMeta && !tab.dirtyRows.size) continue;
      const w: TabWork = { tab, meta: isNew || tab.dirtyMeta, all: isNew || tab.dirtyAll, upserts: [], deletes: [] };
      const rowsToWrite = w.all ? tab.rows.map((_, i) => i) : Array.from(tab.dirtyRows);
      for (const i of rowsToWrite) {
        const enc = i < tab.rows.length ? tab.encodeRow(i) : null;
        if (enc) w.upserts.push({ no: i + 1, cells: enc.cells, fmts: enc.fmts });
        else if (!w.all) w.deletes.push(i + 1);
      }
      tab.dirtyRows = new Set();
      tab.dirtyAll = false;
      tab.dirtyMeta = false;
      work.push(w);
    }
    const kvWork = Array.from(this.dirtyKv).map((k) => {
      const [scope, key] = k.split('\u0000');
      return { scope, key, value: this.kvGet(scope, key) };
    });
    this.dirtyKv = new Set();
    const removed = this.removedTabs;
    this.removedTabs = [];

    const client = await this.pool.connect().catch((e) => { this.restore(work, kvWork, removed); throw e; });
    try {
      await client.query('BEGIN');
      for (const id of removed) await client.query('DELETE FROM tabs WHERE id = $1', [id]);
      for (const w of work) {
        const t = w.tab;
        if (t.id === null) {
          const r = await client.query(
            `INSERT INTO tabs(name, position, hidden, frozen_rows, frozen_cols, max_cols, col_formats, col_widths)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [t.name, t.position, t.hidden, t.frozenRows, t.frozenCols, t.maxCols,
             JSON.stringify(t.colFmt), JSON.stringify(t.colWidths)]);
          t.id = r.rows[0].id;
        } else if (w.meta) {
          await client.query(
            `UPDATE tabs SET name=$2, position=$3, hidden=$4, frozen_rows=$5, frozen_cols=$6,
                    max_cols=$7, col_formats=$8, col_widths=$9, updated_at=now() WHERE id=$1`,
            [t.id, t.name, t.position, t.hidden, t.frozenRows, t.frozenCols, t.maxCols,
             JSON.stringify(t.colFmt), JSON.stringify(t.colWidths)]);
        }
        if (w.all) await client.query('DELETE FROM tab_rows WHERE tab_id = $1', [t.id]);
        if (w.deletes.length) {
          await client.query('DELETE FROM tab_rows WHERE tab_id = $1 AND row_no = ANY($2::int[])', [t.id, w.deletes]);
        }
        for (let i = 0; i < w.upserts.length; i += 2000) {
          const part = w.upserts.slice(i, i + 2000);
          await client.query(
            `INSERT INTO tab_rows(tab_id, row_no, cells, fmts)
             SELECT $1, u.no, u.cells::jsonb, u.fmts::jsonb
               FROM unnest($2::int[], $3::text[], $4::text[]) AS u(no, cells, fmts)
             ON CONFLICT (tab_id, row_no) DO UPDATE SET cells = EXCLUDED.cells, fmts = EXCLUDED.fmts`,
            [t.id, part.map((p) => p.no), part.map((p) => p.cells), part.map((p) => p.fmts)]);
        }
      }
      for (const k of kvWork) {
        if (k.value === null) {
          await client.query('DELETE FROM kv WHERE scope = $1 AND key = $2', [k.scope, k.key]);
        } else {
          await client.query(
            `INSERT INTO kv(scope, key, value) VALUES ($1,$2,$3)
             ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value`, [k.scope, k.key, k.value]);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      this.restore(work, kvWork, removed);
      throw e;
    } finally {
      client.release();
    }
  }

  /** A failed commit: mark the same changes pending again so the next flush retries them. */
  private restore(work: { tab: Tab; meta: boolean; all: boolean; upserts: { no: number }[]; deletes: number[] }[],
                  kvWork: { scope: string; key: string }[], removed: number[]): void {
    for (const w of work) {
      if (w.all) w.tab.dirtyAll = true;
      if (w.meta) w.tab.dirtyMeta = true;
      w.upserts.forEach((u) => w.tab.dirtyRows.add(u.no - 1));
      w.deletes.forEach((n) => w.tab.dirtyRows.add(n - 1));
    }
    kvWork.forEach((k) => this.dirtyKv.add(k.scope + '\u0000' + k.key));
    this.removedTabs = removed.concat(this.removedTabs);
  }

  /** Replace every tab (used by the importer). */
  replaceAll(tabs: Tab[]): void {
    for (const t of this.tabs) if (t.id !== null) this.removedTabs.push(t.id);
    this.tabs = tabs;
    this.byName = new Map(tabs.map((t) => [t.name, t]));
    tabs.forEach((t, i) => { t.id = null; t.position = i; t.dirtyAll = true; t.dirtyMeta = true; });
  }
}
