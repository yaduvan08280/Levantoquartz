// ============================================================
//  Mono Scripts — Web Worker sandbox (Phase 5B)
//  Runs a menu/trigger script against a read-only snapshot with
//  global shadowing; writes are op-logged and returned. The main
//  thread can terminate this worker on timeout.
// ============================================================
import { compileFunctions, snapshotApi } from './sandbox.js';

self.onmessage = (e) => {
  const { source, fnName, args, snapshot } = e.data || {};
  const sink = { ops: [], logs: [], menus: [] };
  let result, error = null;
  try {
    const api = snapshotApi(snapshot, sink);
    const fns = compileFunctions(source, api);
    const fn = fns[fnName];
    if (typeof fn !== 'function') error = 'No function "' + fnName + '"';
    else result = fn.apply(null, args || []);
  } catch (err) { error = String(err && err.message || err); }
  try { self.postMessage({ result: (result && typeof result === 'object') ? undefined : result, logs: sink.logs, menus: sink.menus, ops: sink.ops, error }); }
  catch { self.postMessage({ logs: sink.logs, menus: sink.menus, ops: sink.ops, error: error || 'postMessage failed' }); }
};
