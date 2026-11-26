/* One slab through every stage, by the same calls the page makes. Writes to
   the database it is pointed at — a development copy only. */
process.env.SCHEDULER = 'off';
import '../src/config.js';
import { pool } from '../src/db.js';
import { boot, rt, run, wb } from '../src/app.js';
await boot();
rt.call('setFormsPassword', ['admin', 'test1234']);
const tk = (await run('api_login', ['admin', 'test1234'])).token;
let fails = 0;
const lastRow = (tab: string) => { const t = wb.tab(tab)!; return t.rows[t.lastRow() - 1].map((v) => v instanceof Date ? 'D:' + t.display(t.lastRow(), 1 + t.rows[t.lastRow() - 1].indexOf(v)) : v); };
async function submit(key: string, values: any, expectOk = true) {
  const s = performance.now();
  let r: any;
  try { r = await run('api_submit', [tk, key, values, 'T' + Math.random()]); } catch (e: any) { r = { ok: false, error: 'THROW ' + e.message }; }
  const ms = (performance.now() - s).toFixed(1);
  const good = !!r.ok === expectOk;
  if (!good) fails++;
  console.log((good ? 'ok   ' : 'FAIL ') + key.padEnd(12) + ms.padStart(7) + ' ms  ' + JSON.stringify(r).slice(0, 230));
  return r;
}
const lists = async (key: string) => await run('api_refreshLists', [tk, key]);

const slab = (await lists('batching')).slabA[0];
console.log('slab', slab);
await submit('batching', { line: 'A', slabA: slab, design: 'LQ-214', size: 'LQS - 3600*2080*36', ga1s: 'QG4CV', ga1b: '2401', ga1q: '64.35', fa1s: 'QFDM - 325', fa1b: '0051', fa1q: '155.5', remark: 'migration test' });
console.log('     row', JSON.stringify(lastRow('Batching Form')).slice(0, 300));
await submit('batching', { line: 'A', slabA: slab, design: 'LQ-214', size: 'LQS - 3600*2080*36', ga1s: 'QG4CV', ga1b: '2401', ga1q: '64.35', fa1s: 'QFDM - 325', fa1b: '51', fa1q: '155.5' }, false);
console.log('     next free A:', (await lists('batching')).slabA[0], '| resin list has slab:', (await lists('resin')).slab.includes(slab));
await submit('resin', { slab, rsa: 'A-ONE', ibca: 'IBC-1', rqa: '70', wpa: '8.96', hsa: 'TX-21S', hqa: '0.683', sqa: '0.5' });
await submit('mixer', { slab, mixer: '1', start: '10:05', qty: '448', disch: '10:25' });
console.log('     row', JSON.stringify(lastRow('Mixer Form')));
await submit('pressing', { slab, wet: 'Perfect', series: 'Pure White', mould: 'MD01' });
await submit('ovenIn', { slab, shelf: '3', est: '1', top: '77', low: '82' });
console.log('     oven', JSON.stringify(await run('api_ovenStatus', [tk])).slice(0, 260));
await submit('ovenOut', { slab });
console.log('     row', JSON.stringify(lastRow('Oven Out Form')));
const bundle = (await lists('vacuum')).bundle[0];
console.log('     vacuum list has slab:', (await lists('vacuum')).slab.includes(slab), 'bundle', bundle);
await submit('vacuum', { bundle, slab: [slab] });
console.log('     filled bundles include it:', (await lists('trolley')).bundle.includes(bundle), '| slabs in bundle', JSON.stringify(await run('api_bundleSlabs', [tk, bundle])));
await submit('trolley', { bundle, slabs: [slab] });
console.log('     row', JSON.stringify(lastRow('Trolley Form').filter((v) => v !== '')));
console.log('     bundle free again:', (await lists('vacuum')).bundle.includes(bundle));
await submit('calibration', { slab, th1: '36.1', th2: '36.2', th3: '36.3', th4: '36.4', th5: '36.5', th6: '36.6', th7: '36.7', th8: '36.8', defects: ['Perfect'] });
console.log('     qc list has slab:', (await lists('qc')).slab.includes(slab));
await submit('qc', { slab, quality: 'Defect', defects: ['White spots'], grade: 'B', remark: 'test' });
console.log('     row', JSON.stringify(lastRow('Q.C. Final Form')));
console.log('     gone from every stage list:', !(await lists('resin')).slab.includes(slab) && !(await lists('qc')).slab.includes(slab));
console.log('     alertScan →', JSON.stringify(await run('alertScan', [])).slice(0, 200));
console.log('     alerts', JSON.stringify(await run('api_alerts', [tk])).slice(0, 300));
const ds = await run('api_dispatchSlabs', [tk]);
console.log('     dispatchable:', ds.slabs.includes(slab), 'of', ds.slabs.length);
console.log('     history', JSON.stringify((await run('api_history', [tk, 'mixer', 1])).entries[0]).slice(0, 300));
console.log('     log', JSON.stringify(lastRow('App Submission Log')).slice(0, 260));
console.log(fails ? 'FAILURES: ' + fails : 'ALL OK');
await pool.end();
