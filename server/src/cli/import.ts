/**
 * npm run import -- "/path/to/New Base.xlsx"
 *
 * Replaces every data tab with the contents of the workbook export. Settings
 * (the Telegram token, sign-in sessions, scheduled jobs) are kept. Stop the
 * app first, or restart it afterwards: a running server holds its own copy.
 */
import '../config.js';
import { pool, migrate } from '../db.js';
import { Workbook } from '../store/workbook.js';
import { readXlsx } from '../importer/xlsx.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- <workbook.xlsx>');
  process.exit(2);
}
const t0 = Date.now();
await migrate();
const { tabs, summary } = await readXlsx(file);
console.log('Read ' + tabs.length + ' tabs in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
const wb = new Workbook(pool);
await wb.load();
wb.replaceAll(tabs);
await wb.flush();
for (const s of summary) console.log('  ' + s.name.padEnd(26) + String(s.rows).padStart(7) + ' rows ' + String(s.cols).padStart(4) + ' cols');
console.log('Imported in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
await pool.end();
