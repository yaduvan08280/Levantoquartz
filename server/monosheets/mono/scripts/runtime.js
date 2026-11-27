// ============================================================
//  Mono Scripts — runtime (Phase 5 + 5B)
//  • compile() shadows dangerous globals (sandbox.compileFunctions)
//  • invokeCustom() enforces recursion + output-size quotas
//  • runIsolated() runs menu/trigger scripts in a Web Worker with a
//    hard timeout (killed on overrun); falls back to the hardened
//    main thread for full-API compatibility.
// ============================================================
import { buildApi } from './api.js';
import { compileFunctions, applyOps } from './sandbox.js';

export class ScriptRuntime {
  constructor(host) { this.host = host; this.logs = []; this.menus = []; this.fns = {}; this.error = null; this._depth = 0; this.timeoutMs = 5000; this.maxOutChars = 500000; }
  source() { return (this.host.engine.wb.scripts.files || []).map((f) => f.source || '').join('\n;\n'); }
  compile() {
    this.logs = []; this.menus = []; this.fns = {}; this.error = null;
    const src = this.source(); if (!src.trim()) return null;
    const api = buildApi(this.host, this);
    try { this.fns = compileFunctions(src, api); } catch (e) { this.error = String(e && e.message || e); this.fns = {}; }
    return this.error;
  }
  list() { return Object.keys(this.fns).filter((n) => typeof this.fns[n] === 'function'); }
  run(name, args) { this.logs = []; const fn = this.fns[name]; if (typeof fn !== 'function') throw new Error('No function "' + name + '"'); return fn.apply(null, args || []); }
  runMain(name, args) { this.logs = []; this.menus = []; try { const result = this.run(name, args); return { result, logs: this.logs.slice(), menus: this.menus.slice(), ops: [] }; } catch (e) { return { error: String(e && e.message || e), logs: this.logs.slice(), menus: [], ops: [] }; } }
  trigger(name, ev) { const fn = this.fns[name]; if (typeof fn !== 'function') return; try { fn(ev); } catch (e) { this.logs.push('Trigger ' + name + ' error: ' + (e && e.message || e)); } }
  invokeCustom(name, args) {
    const fn = this.fns[name]; if (typeof fn !== 'function') return undefined;
    if (this._depth >= 64) throw new Error('custom function recursion too deep');
    this._depth++;
    try {
      const out = fn.apply(null, args);
      if (typeof out === 'string' && out.length > this.maxOutChars) throw new Error('output too large');
      if (Array.isArray(out) && JSON.stringify(out).length > this.maxOutChars) throw new Error('output too large');
      return out;
    } finally { this._depth--; }
  }
  snapshot() {
    const eng = this.host.engine;
    return { activeId: this.host.activeSheetId(), name: eng.wb.name, sheets: eng.wb.sheets.map((sh) => { const cells = {}; const R = Math.min(sh.rows, 2000), C = Math.min(sh.cols, 200); for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const d = eng.getDisplay(sh.id, r, c); if (d !== '') cells[r + ',' + c] = d; } return { id: sh.id, name: sh.name, rows: sh.rows, cols: sh.cols, cells }; }) };
  }
  workerUrl() { try { return new URL('./worker.js', import.meta.url); } catch { return null; } }
  runIsolated(name, args) {
    if (typeof this.fns[name] !== 'function') return Promise.resolve({ result: undefined, logs: [], menus: [], ops: [] });
    const url = this.workerUrl();
    if (typeof Worker === 'undefined' || !url) return Promise.resolve(this.runMain(name, args));
    return new Promise((resolve) => {
      let w, done = false; const finish = (d) => { if (done) return; done = true; try { w && w.terminate(); } catch {} resolve(d); };
      try { w = new Worker(url, { type: 'module' }); } catch { return resolve(this.runMain(name, args)); }
      const to = setTimeout(() => finish({ error: 'Script timed out (killed after ' + (this.timeoutMs / 1000) + 's)', timedOut: true, logs: ['✕ terminated: timeout'], menus: [], ops: [] }), this.timeoutMs);
      w.onmessage = (e) => { clearTimeout(to); const d = e.data || {}; if (!d.error && d.ops && d.ops.length) applyOps(this.host.engine, d.ops); finish(d); };
      w.onerror = () => { clearTimeout(to); finish(this.runMain(name, args)); };
      try { w.postMessage({ source: this.source(), fnName: name, args: args || [], snapshot: this.snapshot() }); } catch { clearTimeout(to); finish(this.runMain(name, args)); }
    });
  }
}
export default ScriptRuntime;
