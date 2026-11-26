/**
 * Import a Google Sheets workbook (File > Download > Microsoft Excel) as the
 * app's data. Every tab comes across as it is: values, dates, number formats,
 * hidden state and frozen rows. Formula cells bring their last calculated
 * value; the few formula columns the app depends on are recalculated by
 * store/computed.ts as soon as the import lands.
 */
import ExcelJS from 'exceljs';
import { type Cell, normaliseDateFormat, isDateFormat, timeOfDay } from '../store/values.js';
import { Tab } from '../store/workbook.js';

function wallClock(d: Date): Cell {
  /* The file stores local wall-clock time; the library hands it back as if it
     were UTC. Re-read the same clock reading in the app's own zone. */
  if (d.getUTCFullYear() < 1901) return timeOfDay(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

function plain(v: any): Cell {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : wallClock(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'object') {
    if ('error' in v) return String(v.error);
    if ('richText' in v) return (v.richText || []).map((p: any) => p.text).join('');
    if ('result' in v || 'formula' in v || 'sharedFormula' in v) return plain(v.result);
    if ('text' in v) return plain(v.text);
  }
  return String(v);
}

export interface ImportSummary { name: string; rows: number; cols: number; cells: number }

export async function readXlsx(input: string | Buffer): Promise<{ tabs: Tab[]; summary: ImportSummary[] }> {
  const book = new ExcelJS.Workbook();
  if (typeof input === 'string') await book.xlsx.readFile(input);
  else await book.xlsx.load(input as any);

  const tabs: Tab[] = [];
  const summary: ImportSummary[] = [];
  for (const ws of book.worksheets) {
    const tab = new Tab(ws.name);
    tab.hidden = ws.state === 'hidden' || ws.state === 'veryHidden';
    const view: any = (ws.views || [])[0];
    if (view && view.state === 'frozen') {
      tab.frozenRows = view.ySplit || 0;
      tab.frozenCols = view.xSplit || 0;
    }
    tab.maxCols = Math.max(ws.columnCount || 0, 1);

    let cells = 0, lastCol = 0;
    /* number format -> how many cells use it, per column, to find formats
       that were applied to a whole column rather than cell by cell */
    const numFmtCount = new Map<number, Map<string, number>>();
    const numCount = new Map<number, number>();

    ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
      const line: Cell[] = [];
      let fmts: Record<number, string> | undefined;
      row.eachCell({ includeEmpty: false }, (cell, colNo) => {
        const v = plain(cell.value);
        if (v === '') return;
        while (line.length < colNo - 1) line.push('');
        line[colNo - 1] = v;
        cells++;
        if (colNo > lastCol) lastCol = colNo;
        const raw = cell.numFmt || '';
        if (v instanceof Date) {
          const f = normaliseDateFormat(raw);
          if (f && isDateFormat(f)) (fmts || (fmts = {}))[colNo - 1] = f;
        } else if (typeof v === 'number' && rowNo > 1) {
          numCount.set(colNo, (numCount.get(colNo) || 0) + 1);
          if (raw && !/^general$/i.test(raw) && raw !== '@') {
            (fmts || (fmts = {}))[colNo - 1] = raw;
            let m = numFmtCount.get(colNo);
            if (!m) { m = new Map(); numFmtCount.set(colNo, m); }
            m.set(raw, (m.get(raw) || 0) + 1);
          }
        }
      });
      if (!line.length) return;
      while (tab.rows.length < rowNo - 1) tab.rows.push([]);
      tab.rows[rowNo - 1] = line;
      if (fmts) {
        while (tab.fmts.length < rowNo - 1) tab.fmts.push(undefined);
        tab.fmts[rowNo - 1] = fmts;
      }
    });

    /* A number format on (nearly) every number in a column was a column
       format: new rows must show the same way, so keep it on the column and
       drop the per-cell copies. */
    for (const [col, m] of numFmtCount) {
      const total = numCount.get(col) || 0;
      for (const [fmt, n] of m) {
        if (total >= 5 && n / total >= 0.9) {
          tab.colFmt[col] = fmt;
          for (let i = 0; i < tab.rows.length; i++) {
            const f = tab.fmts[i];
            if (f && f[col - 1] === fmt) { delete f[col - 1]; if (!Object.keys(f).length) tab.fmts[i] = undefined; }
            else if (typeof (tab.rows[i] || [])[col - 1] === 'number' && i > 0 && !(f && f[col - 1])) {
              (tab.fmts[i] || (tab.fmts[i] = {}))[col - 1] = 'General';
              while (tab.fmts.length <= i) tab.fmts.push(undefined);
            }
          }
        }
      }
    }
    tab.maxCols = Math.max(tab.maxCols, lastCol);
    tabs.push(tab);
    summary.push({ name: tab.name, rows: tab.rows.length, cols: lastCol, cells });
  }
  return { tabs, summary };
}
