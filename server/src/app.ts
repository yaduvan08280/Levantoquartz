/**
 * Process-wide singletons: the workbook, the logic runtime, and the one path
 * through which the logic is called and its changes are committed.
 */
import crypto from 'node:crypto';
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
  await firstRun();
}

/**
 * A database with nobody in it: create the users tab and one administrator,
 * so there is a way in to import the data. The password comes from
 * ADMIN_PASSWORD, or is generated and printed once.
 */
async function firstRun(): Promise<void> {
  const name = String(rt.global('FORMS_CFG').USERS_TAB);
  if (wb.rawTab(name)) return;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const t = wb.createTab(name);
  rt.global<string[]>('FORMS_USER_HEADERS').forEach((h, i) => t.set(1, i + 1, h));
  t.frozenRows = 1;
  const row = ['admin', 'Administrator', 'ALL', '', rt.call('fHash_', [password]), 'YES', '', 'admin'];
  row.forEach((v, i) => { if (v !== '') t.set(2, i + 1, v as string); });
  await wb.flush();
  console.log('\n  First run: created the administrator account.');
  console.log('    username: admin');
  console.log('    password: ' + (process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password));
  console.log('  Sign in at /admin/ and import the workbook, or change the password under Users.\n');
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
