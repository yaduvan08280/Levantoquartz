// ============================================================
//  Mono Scripts — controller (Phase 5)
//  Owns the runtime + host, the code editor, triggers, and custom
//  menus. Created by monoSheets.js; wired to the grid + engine.
// ============================================================
import { ScriptRuntime } from './runtime.js';
import { icon } from '../../ui/icons.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class MonoScripts {
  constructor({ engine, grid, save }) {
    this.engine = engine; this.grid = grid; this._save = save || (() => {});
    const wb = engine.wb; if (!wb.scripts) wb.scripts = { files: [], props: { script: {}, document: {} } }; if (!wb.scripts.props) wb.scripts.props = { script: {}, document: {} };
    this.host = {
      engine, activeSheetId: () => grid.sid(),
      activeRange: () => { const r = grid.rect(); return { sid: grid.sid(), r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2 }; },
      refresh: () => { this._save(); grid.render(); }, save: () => this._save(),
      ui: { toast: (m) => this.toast(m), alert: (m) => window.alert(m), prompt: (m) => window.prompt(m) },
      props: wb.scripts.props,
    };
    this.rt = new ScriptRuntime(this.host);
    this.rt.compile();
    engine.setCustomResolver((n, a) => this.rt.invokeCustom(n, a));
    engine.recalcAll();
  }
  menus() { return this.rt.menus; }
  async fireOpen() { let r = await this.rt.runIsolated('onOpen'); if (r.error && !r.timedOut) r = this.rt.runMain('onOpen'); this.rt.menus = r.menus || []; this.grid.render(); }
  async fireEdit(ev) { if (typeof this.rt.fns.onEdit !== 'function') return; let r = await this.rt.runIsolated('onEdit', [ev]); if (r.error && !r.timedOut) r = this.rt.runMain('onEdit', [ev]); this._save(); this.grid.render(); if (r.error) this.toast(r.error); }
  async runMenu(fn) { let r = await this.rt.runIsolated(fn); if (r.error && !r.timedOut) r = this.rt.runMain(fn); if (r.error) window.alert('Script error: ' + r.error); this._save(); await this.fireOpen(); this.grid.render(); const logs = r.logs || []; if (logs.length) this.toast(logs[logs.length - 1]); }
  recompile() { const err = this.rt.compile(); this.engine.recalcAll(); this.fireOpen(); this.grid.render(); return err; }
  toast(msg) { let t = document.getElementById('msScriptToast'); if (!t) { t = document.createElement('div'); t.id = 'msScriptToast'; t.className = 'ms-stoast'; document.body.appendChild(t); } t.textContent = String(msg); t.classList.add('show'); clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('show'), 2600); }
  openEditor() {
    const wb = this.engine.wb; const file = wb.scripts.files[0] || (wb.scripts.files[0] = { name: 'Code.gs', source: '' });
    const back = document.createElement('div'); back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal ms-ed"><div class="ms-ed-head"><b>Mono Scripts</b> <span class="muted">${escH(file.name)}</span><span style="flex:1"></span><select id="seFn" class="ms-ed-sel"></select><button class="btn btn-ghost" id="seRun">${icon('play', { size: 12 })} Run</button><button class="btn btn-primary" id="seSave">Save</button><button class="btn btn-ghost" id="seClose">${icon('x', { size: 13 })}</button></div><textarea id="seSrc" class="ms-ed-src" spellcheck="false"></textarea><div class="ms-ed-log"><div class="muted" style="margin-bottom:4px">Execution log</div><pre id="seLog"></pre></div></div>`;
    document.body.appendChild(back);
    const src = back.querySelector('#seSrc'); src.value = file.source || '';
    const log = back.querySelector('#seLog'); const sel = back.querySelector('#seFn');
    const refreshSel = () => { const l = this.rt.list(); sel.innerHTML = l.length ? l.map((n) => `<option>${escH(n)}</option>`).join('') : '<option value="">(no functions)</option>'; };
    const showLog = () => { log.textContent = (this.rt.error ? '⚠ ' + this.rt.error + '\n' : '') + this.rt.logs.join('\n'); };
    refreshSel(); showLog();
    back.querySelector('#seClose').onclick = () => back.remove();
    back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
    back.querySelector('#seSave').onclick = () => { file.source = src.value; const err = this.recompile(); refreshSel(); showLog(); this.toast(err ? 'Saved — compile error' : 'Saved'); };
    back.querySelector('#seRun').onclick = () => { file.source = src.value; this.rt.compile(); this.engine.recalcAll(); refreshSel(); const fn = sel.value; if (fn) { try { this.rt.run(fn); } catch (e) { this.rt.logs.push('✕ ' + (e && e.message || e)); } } this._save(); this.grid.render(); showLog(); };
  }
}
export default MonoScripts;
