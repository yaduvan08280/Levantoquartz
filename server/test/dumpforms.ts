process.env.SCHEDULER = 'off';
import '../src/config.js';
import { pool } from '../src/db.js';
import { boot, rt } from '../src/app.js';
await boot();
const defs: any = rt.global('FORM_DEFS');
for (const k of rt.global<string[]>('FORM_KEYS')) {
  const f = defs[k];
  console.log('\n## ' + k + ' tab=' + f.tab + ' keyField=' + (f.keyField || '') + ' flags=' + ['multiRow', 'multiSection', 'repeatSection', 'dynamicBundle', 'strictOptions', 'repeatOf'].filter((x) => f[x]).map((x) => x + '=' + f[x]).join(','));
  for (const s of f.sections) {
    console.log('  [' + s.title + ']' + (s.showWhen ? ' showWhen=' + JSON.stringify(s.showWhen) : '') + (s.repeat ? ' repeat=' + JSON.stringify(s.repeat) : ''));
    for (const x of s.fields) console.log('    ' + x.id + ' :' + x.type + (x.required ? ' *' : '') + (x.source ? ' src=' + x.source : '') + (x.options ? ' opts=' + x.options.length + '(' + x.options.slice(0, 2).join('|') + ')' : '') + (x.showWhen ? ' when=' + JSON.stringify(x.showWhen) : '') + ' "' + x.label + '"');
  }
}
await pool.end();
