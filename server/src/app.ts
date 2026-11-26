/**
 * Process-wide singletons: the workbook, the logic runtime, and the one path
 * through which the logic is called and its changes are committed.
 */
import { pool } from './db.js';
import { Workbook } from './store/workbook.js';
import { installComputed, refreshAll } from './store/computed.js';
import { Runtime } from './gas/runtime.js';

export const wb = new Workbook(pool);
export const rt = new Runtime(wb);

export async function boot(): Promise<void> {
  await wb.load();
  installComputed(wb);
  refreshAll(wb);
  rt.load();
}

/** Call the logic, then commit whatever it changed before returning. */
export async function run<T = any>(fn: string, args: unknown[] = []): Promise<T> {
  let out: T;
  try {
    out = rt.call(fn, args) as T;
  } finally {
    /* Committed even when the call threw: it may have written before failing,
       and the logic's own error paths expect those writes to stand. */
    await wb.flush();
  }
  return out;
}

/** Run server-side work against the store, then commit. */
export async function commit<T>(work: () => T): Promise<T> {
  let out: T;
  try { out = work(); } finally { await wb.flush(); }
  return out;
}
