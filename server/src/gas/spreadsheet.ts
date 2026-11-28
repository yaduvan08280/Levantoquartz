/**
 * The spreadsheet interface the forms logic was written against, served from
 * the workbook store.
 *
 * The production logic in legacy/ (form definitions, validation, duplicate
 * rules, alerts) is the code that ran the plant on Apps Script and is run
 * here unchanged. It talks to "a sheet"; this file is that sheet. Only the
 * calls the logic actually makes are implemented, and they follow Google's
 * documented behaviour — including the parts the logic leans on, such as a
 * written "14:30" becoming a time and getLastRow() meaning the last row with
 * anything in it.
 */
import { type Cell, colNumber, isEmpty, normaliseDateFormat } from '../store/values.js';
import { MAIN, Tab, Workbook } from '../store/workbook.js';

/** Formatting calls are accepted and ignored: looks are the admin grid's job now. */
const COSMETIC = [
  'setFontWeight', 'setBackground', 'setFontColor', 'setFontSize', 'setFontFamily', 'setFontStyle',
  'setVerticalAlignment', 'setHorizontalAlignment', 'setWrap', 'setWrapStrategy', 'setNote',
  'setDataValidation', 'clearDataValidations', 'setBorder', 'setBackgrounds', 'setFontColors',
  'setFontWeights', 'activate', 'protect', 'merge', 'setShowHyperlink', 'clearNote', 'clearFormat'
];

export class Range {
  constructor(private tab: Tab, private row: number, private col: number,
              private numRows: number, private numCols: number, private wholeCols = false) {}

  getRow(): number { return this.row; }
  getColumn(): number { return this.col; }
  getNumRows(): number { return this.numRows; }
  getNumColumns(): number { return this.numCols; }
  getLastRow(): number { return this.row + this.numRows - 1; }
  getLastColumn(): number { return this.col + this.numCols - 1; }
  getSheet(): Sheet { return new Sheet(this.tab, null); }

  getValues(): Cell[][] {
    const out: Cell[][] = new Array(this.numRows);
    for (let r = 0; r < this.numRows; r++) {
      const src = this.tab.rows[this.row - 1 + r];
      const line: Cell[] = new Array(this.numCols);
      for (let c = 0; c < this.numCols; c++) {
        const v = src ? src[this.col - 1 + c] : '';
        line[c] = v === undefined || v === null ? '' : (v instanceof Date ? new Date(v.getTime()) : v);
      }
      out[r] = line;
    }
    return out;
  }

  getValue(): Cell {
    const v = this.tab.get(this.row, this.col);
    return v instanceof Date ? new Date(v.getTime()) : v;
  }

  getDisplayValues(): string[][] {
    const out: string[][] = new Array(this.numRows);
    for (let r = 0; r < this.numRows; r++) {
      const line: string[] = new Array(this.numCols);
      for (let c = 0; c < this.numCols; c++) line[c] = this.tab.display(this.row + r, this.col + c);
      out[r] = line;
    }
    return out;
  }

  getDisplayValue(): string { return this.tab.display(this.row, this.col); }

  getFormulas(): string[][] {
    const out: string[][] = [];
    for (let r = 0; r < this.numRows; r++) {
      const line: string[] = [];
      for (let c = 0; c < this.numCols; c++) {
        line.push(this.tab.formulas.get((this.row + r) + ':' + (this.col + c)) || '');
      }
      out.push(line);
    }
    return out;
  }

  /** Only header-row fills are kept; every other cell reports white. */
  getBackgrounds(): string[][] {
    const out: string[][] = [];
    for (let r = 0; r < this.numRows; r++) {
      const line: string[] = [];
      for (let c = 0; c < this.numCols; c++) {
        line.push(this.row + r === 1 ? (this.tab.headerBg[this.col + c] || '#ffffff') : '#ffffff');
      }
      out.push(line);
    }
    return out;
  }
  getBackground(): string { return this.getBackgrounds()[0][0]; }

  getFormula(): string { return this.tab.formulas.get(this.row + ':' + this.col) || ''; }

  setValue(value: unknown): this {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.write(this.row + r, this.col + c, value);
    }
    return this;
  }

  setValues(values: unknown[][]): this {
    if (!Array.isArray(values) || values.length !== this.numRows) {
      throw new Error('The number of rows in the data does not match the number of rows in the range. ' +
        'The data has ' + (values ? values.length : 0) + ' but the range has ' + this.numRows + '.');
    }
    for (let r = 0; r < this.numRows; r++) {
      const line = values[r];
      if (!Array.isArray(line) || line.length !== this.numCols) {
        throw new Error('The number of columns in the data does not match the number of columns in the range. ' +
          'The data has ' + (line ? line.length : 0) + ' but the range has ' + this.numCols + '.');
      }
      for (let c = 0; c < this.numCols; c++) this.write(this.row + r, this.col + c, line[c]);
    }
    return this;
  }

  private write(row: number, col: number, value: unknown): void {
    if (this.tab.isComputed(row, col)) return;            // a formula owns this cell
    this.tab.setEntered(row, col, value);
  }

  clearContent(): this { return this.setValue(''); }
  clear(): this { return this.setValue(''); }

  setNumberFormat(fmt: string): this {
    /* Sheets' own pattern language ("dd-mmm-yyyy hh:mm") says month and minute
       with the same letter; store the unambiguous form. */
    if (fmt && fmt !== '@' && /[dmyhs]/i.test(fmt) && !/[0#]/.test(fmt)) fmt = normaliseDateFormat(fmt);
    if (this.wholeCols) {
      for (let c = 0; c < this.numCols; c++) this.tab.setColFormat(this.col + c, fmt);
      return this;
    }
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.tab.setFormat(this.row + r, this.col + c, fmt);
    }
    return this;
  }

  getNumberFormat(): string { return this.tab.format(this.row, this.col) || ''; }

  /** Ctrl+Arrow from this cell. Only the directions the logic uses matter, but all four work. */
  getNextDataCell(direction: string): Range {
    let r = this.row, c = this.col;
    const filled = (rr: number, cc: number) => !isEmpty(this.tab.get(rr, cc));
    if (direction === 'UP') {
      r--;
      while (r > 1 && !filled(r, c)) r--;
      if (r < 1) r = 1;
    } else if (direction === 'DOWN') {
      const last = this.tab.lastRow();
      r++;
      while (r < last && !filled(r, c)) r++;
    } else if (direction === 'PREVIOUS') {
      c--;
      while (c > 1 && !filled(r, c)) c--;
      if (c < 1) c = 1;
    } else {
      const last = this.tab.lastCol();
      c++;
      while (c < last && !filled(r, c)) c++;
    }
    return new Range(this.tab, r, c, 1, 1);
  }

  /** Values and formats; there are no per-row formulas left to copy. */
  copyTo(dest: Range, type?: string): void {
    if (type === 'PASTE_FORMULA') return;
    const src = this.getValues();
    for (let r = 0; r < dest.numRows; r++) {
      for (let c = 0; c < dest.numCols; c++) {
        const v = src[r % src.length][c % src[0].length];
        dest.tab.set(dest.row + r, dest.col + c, v, this.tab.format(this.row + (r % src.length), this.col + (c % src[0].length)));
      }
    }
  }

  offset(rowOffset: number, colOffset: number, numRows?: number, numCols?: number): Range {
    return new Range(this.tab, this.row + rowOffset, this.col + colOffset,
      numRows === undefined ? this.numRows : numRows, numCols === undefined ? this.numCols : numCols);
  }

  getA1Notation(): string { return ''; }
}

for (const name of COSMETIC) {
  (Range.prototype as any)[name] = function () { return this; };
}

export class Sheet {
  constructor(private tab: Tab, private wb: Workbook | null) {}

  /** The underlying tab, for server code that needs more than the sheet interface. */
  _tab(): Tab { return this.tab; }

  getName(): string { return this.tab.name; }
  getSheetName(): string { return this.tab.name; }
  getSheetId(): number { return this.tab.id || 0; }
  getIndex(): number { return this.tab.position + 1; }
  getLastRow(): number { return this.tab.lastRow(); }
  getLastColumn(): number { return this.tab.lastCol(); }
  getMaxColumns(): number { return this.tab.gridCols(); }
  getMaxRows(): number { return this.tab.gridRows(); }
  getFrozenRows(): number { return this.tab.frozenRows; }
  isSheetHidden(): boolean { return this.tab.hidden; }

  getRange(a: number | string, b?: number, c?: number, d?: number): Range {
    if (typeof a === 'string') return this.rangeA1(a);
    const numRows = c === undefined ? 1 : c;
    const numCols = d === undefined ? 1 : d;
    if (!(a >= 1) || !((b as number) >= 1) || numRows < 1 || numCols < 1) {
      throw new Error('The starting row or column of the range is too small, or the range is empty.');
    }
    return new Range(this.tab, a, b as number, numRows, numCols);
  }

  private rangeA1(a1: string): Range {
    const ref = a1.includes('!') ? a1.slice(a1.lastIndexOf('!') + 1) : a1;
    const m = /^\$?([A-Za-z]*)\$?(\d*)(?::\$?([A-Za-z]*)\$?(\d*))?$/.exec(ref.trim());
    if (!m) throw new Error('Range not found: ' + a1);
    const c1 = m[1] ? colNumber(m[1]) : 1;
    const r1 = m[2] ? parseInt(m[2], 10) : 1;
    const hasEnd = m[3] !== undefined;
    const c2 = hasEnd ? (m[3] ? colNumber(m[3]) : this.getMaxColumns()) : c1;
    const r2 = hasEnd ? (m[4] ? parseInt(m[4], 10) : this.getMaxRows()) : r1;
    /* "A:A" and "C2:C" both mean the column to the bottom: a format set on
       one is the column's format, so rows added later take it too. */
    const whole = hasEnd && !m[4];
    return new Range(this.tab, r1, c1, Math.max(1, r2 - r1 + 1), Math.max(1, c2 - c1 + 1), whole);
  }

  getRangeList(a1s: string[]) {
    const ranges = (a1s || []).map((a) => this.getRange(a));
    const list: any = {
      getRanges: () => ranges,
      setNumberFormat(f: string) { ranges.forEach((r) => r.setNumberFormat(f)); return list; }
    };
    for (const n of COSMETIC) if (!list[n]) list[n] = () => list;
    return list;
  }
  /* Sheet protection was a warning shown in Google Sheets; nothing to enforce here. */
  getProtections(): any[] { return [{}]; }
  protect(): any { const p: any = { setDescription: () => p, setWarningOnly: () => p, remove: () => p }; return p; }

  getDataRange(): Range {
    return new Range(this.tab, 1, 1, Math.max(1, this.tab.lastRow()), Math.max(1, this.tab.lastCol()));
  }

  appendRow(values: unknown[]): this {
    this.tab.appendRow(values);
    return this;
  }

  deleteRow(row: number): this { this.tab.deleteRows(row, 1); return this; }
  deleteRows(row: number, n: number): this { this.tab.deleteRows(row, n); return this; }
  insertRowsAfter(row: number, n: number): this { this.tab.insertRows(row + 1, n); return this; }
  insertRowAfter(row: number): this { this.tab.insertRows(row + 1, 1); return this; }
  insertRowBefore(row: number): this { this.tab.insertRows(row, 1); return this; }
  insertColumnsAfter(col: number, n: number): this { this.tab.insertCols(col, n); return this; }
  insertColumnAfter(col: number): this { this.tab.insertCols(col, 1); return this; }
  deleteColumns(col: number, n: number): this { this.tab.deleteCols(col, n === undefined ? 1 : n); return this; }
  deleteColumn(col: number): this { this.tab.deleteCols(col, 1); return this; }

  setFrozenRows(n: number): this { this.tab.frozenRows = n; this.tab.dirtyMeta = true; return this; }
  setFrozenColumns(n: number): this { this.tab.frozenCols = n; this.tab.dirtyMeta = true; return this; }
  setColumnWidth(col: number, w: number): this { this.tab.colWidths[col] = w; this.tab.dirtyMeta = true; return this; }
  setColumnWidths(col: number, n: number, w: number): this {
    for (let i = 0; i < n; i++) this.tab.colWidths[col + i] = w;
    this.tab.dirtyMeta = true;
    return this;
  }
  setRowHeight(): this { return this; }
  setRowHeights(): this { return this; }
  autoResizeColumn(): this { return this; }
  autoResizeColumns(): this { return this; }
  setTabColor(): this { return this; }
  hideSheet(): this { this.tab.hidden = true; this.tab.dirtyMeta = true; return this; }
  showSheet(): this { this.tab.hidden = false; this.tab.dirtyMeta = true; return this; }
  hideColumns(): this { return this; }
  activate(): this { return this; }
  clear(): this { this.tab.deleteRows(1, this.tab.lastRow()); return this; }
  setName(name: string): this { if (this.wb) this.wb.renameTab(this.tab, name); return this; }
}

class DataValidationBuilder {
  requireValueInList() { return this; }
  setAllowInvalid() { return this; }
  setHelpText() { return this; }
  build() { return {}; }
}

export class Spreadsheet {
  constructor(private wb: Workbook, private id: string, private book: string = MAIN, private title = 'New Base') {}
  getId(): string { return this.id; }
  getName(): string { return this.title; }
  setSpreadsheetTimeZone(): this { return this; }
  rename(): this { return this; }
  getUrl(): string { return ''; }
  getSpreadsheetTimeZone(): string { return process.env.TZ || 'Asia/Kolkata'; }
  getSheetByName(name: string): Sheet | null {
    const t = this.wb.tab(name, this.book);
    return t ? new Sheet(t, this.wb) : null;
  }
  getSheets(): Sheet[] {
    return this.wb.tabsOf(this.book).sort((a, b) => a.position - b.position).map((t) => new Sheet(this.wb.tab(t.name, this.book)!, this.wb));
  }
  insertSheet(name: string): Sheet {
    return new Sheet(this.wb.createTab(name, this.book), this.wb);
  }
  deleteSheet(sheet: Sheet): void { this.wb.deleteTab(sheet._tab()); }
  toast(): void { /* no editor to show it in */ }
}

export function makeSpreadsheetApp(wb: Workbook, book: string = MAIN, title = 'New Base') {
  const open = (id?: string) => new Spreadsheet(wb, id || book, book, title);
  return {
    openById: open,
    getActiveSpreadsheet: () => open(),
    getActive: () => open(),
    create: () => open(),
    ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
    flush() { /* nothing is buffered */ },
    newDataValidation: () => new DataValidationBuilder(),
    Direction: { UP: 'UP', DOWN: 'DOWN', PREVIOUS: 'PREVIOUS', NEXT: 'NEXT' },
    CopyPasteType: {
      PASTE_NORMAL: 'PASTE_NORMAL', PASTE_FORMULA: 'PASTE_FORMULA',
      PASTE_VALUES: 'PASTE_VALUES', PASTE_FORMAT: 'PASTE_FORMAT'
    },
    WrapStrategy: { WRAP: 'WRAP', CLIP: 'CLIP', OVERFLOW: 'OVERFLOW' },
    BorderStyle: { SOLID: 'SOLID' }
  };
}
