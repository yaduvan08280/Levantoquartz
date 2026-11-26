/* Exercise every read call the page makes, for every form, on whatever data
   is in the database. Dev tool: sets a known password on the local admin. */
process.env.SCHEDULER = 'off';
import '../src/config.js';
import { pool, migrate } from '../src/db.js';
import { boot, rt, run, wb } from '../src/app.js';

await migrate();
let t0 = Date.now();
await boot();
console.log('boot', Date.now() - t0, 'ms');
rt.call('setFormsPassword', ['admin', 'test1234']);
const time = async (label: string, f: () => Promise<any>) => {
  const s = performance.now();
  let out: any, err = '';
  try { out = await f(); } catch (e: any) { err = e.message; }
  const ms = (performance.now() - s).toFixed(1);
  console.log((err ? 'FAIL ' : 'ok   ') + label.padEnd(34) + ms.padStart(8) + ' ms  ' + (err || summarise(out)));
  return out;
};
const summarise = (o: any) => {
  if (o == null) return 'null';
  const s = JSON.stringify(o);
  return s.length + ' bytes ' + s.slice(0, 110);
};
const login = await time('api_login', () => run('api_login', ['admin', 'test1234']));
const tk = login.token;
await time('api_resume', () => run('api_resume', [tk]));
for (const f of login.forms) {
  const form = await time('api_getForm ' + f.key, () => run('api_getForm', [tk, f.key]));
  if (form && form.options) {
    const sizes = Object.keys(form.options).filter((k) => form.options[k].length > 30).map((k) => k + ':' + form.options[k].length);
    if (sizes.length) console.log('       lists', sizes.join(' '));
  }
  await time('api_history ' + f.key, () => run('api_history', [tk, f.key, 20]));
  await time('api_previousValues ' + f.key, () => run('api_previousValues', [tk, f.key, 'A']));
  await time('api_refreshLists ' + f.key, () => run('api_refreshLists', [tk, f.key]));
}
await time('api_ovenStatus', () => run('api_ovenStatus', [tk]));
await time('api_dispatchSlabs', () => run('api_dispatchSlabs', [tk]));
await time('api_alerts', () => run('api_alerts', [tk]));
await time('api_feedback', () => run('api_feedback', [tk, 50]));
await time('api_usedBags', () => run('api_usedBags', [tk]));
await time('api_invoiceBags', () => run('api_invoiceBags', [tk, 'Grit', 'QG1AM']));
await time('api_bundleSlabs BN46', () => run('api_bundleSlabs', [tk, 'BN46']));
await time('api_telegramStatus', () => run('api_telegramStatus', [tk]));
console.log('pending writes', wb.hasPending());
await pool.end();
