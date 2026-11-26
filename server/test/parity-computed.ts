/* Compare the computed columns against the values the spreadsheet's own
   formulas had calculated at the time of the export. Run after an import. */
import '../src/config.js';
import { pool } from '../src/db.js';
import { Workbook } from '../src/store/workbook.js';
import { ensureFresh } from '../src/store/computed.js';
import { displayValue } from '../src/store/values.js';

const wb = new Workbook(pool);
await wb.load();
const checks: [string, number, number, number][] = [   // tab, firstRow, firstCol, lastCol
  ['Batching Form', 2, 3, 3], ['unique codes', 2, 3, 3],
  ['Slab Numbers', 2, 3, 4], ['Slab Numbers', 3, 6, 7], ['Slab Numbers', 2, 30, 32],
  ['Slab Numbers', 2, 34, 36], ['Slab Numbers', 2, 38, 39],
  ['Bundles', 2, 2, 3], ['Bundles', 2, 4, 64], ['Feedback Response', 1, 14, 14]
];
const snap = (t: any, r0: number, c0: number, c1: number) => {
  const out: string[] = [];
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= t.rows.length; r++) {
    const v = displayValue(t.get(r, c), t.format(r, c));
    if (v !== '') out.push(c + ':' + r + '=' + v);
  }
  return out;
};
const before = checks.map(([n, r, a, b]) => snap(wb.rawTab(n), r, a, b));
console.log('now', new Date().toString());
for (const n of new Set(checks.map((c) => c[0]))) ensureFresh(wb, wb.rawTab(n)!);
let bad = 0;
checks.forEach(([n, r, a, b], i) => {
  const after = snap(wb.rawTab(n), r, a, b);
  const A = new Set(before[i]), B = new Set(after);
  const missing = before[i].filter((x) => !B.has(x)), extra = after.filter((x) => !A.has(x));
  const ok = !missing.length && !extra.length;
  if (!ok) bad++;
  console.log((ok ? 'OK   ' : 'DIFF ') + n + ' cols ' + a + '-' + b + ': sheet ' + before[i].length + ', computed ' + after.length +
    (ok ? '' : '\n   only in sheet: ' + missing.slice(0, 6).join(' | ') + '\n   only computed: ' + extra.slice(0, 6).join(' | ')));
});
await pool.end();
process.exit(bad ? 1 : 0);
