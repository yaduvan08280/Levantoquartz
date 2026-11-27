// ============================================================
//  Mono — sync base store
//  ------------------------------------------------------------
//  The "base" is the fingerprint of the last-synced remote snapshot,
//  { [sheetName]: { "r,c": fingerprint } }. It is what lets a pull
//  tell "remote changed this cell" apart from "you changed it
//  locally and remote never touched it".
//
//  It used to live inside app settings in localStorage. That quietly
//  broke at scale: settings are written with
//      try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {}
//  so once the base outgrew the localStorage quota (~5 MB in most
//  browsers) EVERY settings write started failing silently — taking
//  the sync config, workspace layout and sheet colours down with it,
//  with no error anywhere.
//
//  So the base lives here instead:
//   - IndexedDB, which is measured in gigabytes rather than megabytes;
//   - written by structured clone, so there is no JSON.stringify and
//     therefore no max-string-length ceiling;
//   - per workbook, so one big workbook cannot affect another;
//   - failure is REPORTED, never swallowed.
//
//  If IndexedDB is unavailable (private mode, storage disabled), the
//  functions degrade to "no base": the sync still runs, it simply
//  cannot protect local edits in cells that are empty upstream. The
//  caller is told via the returned `available` flag rather than being
//  left to guess.
// ============================================================

const DB_NAME = 'mono.sync';
const DB_VERSION = 1;
const STORE = 'base';

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser context')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error || new Error('Could not open the sync database'));
    req.onblocked = () => reject(new Error('The sync database is blocked by another open tab'));
  }).catch((err) => { _dbPromise = null; throw err; });
  return _dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/**
 * Read the stored base for a workbook.
 * @returns {Promise<{available: boolean, base: object|null, error?: string}>}
 */
export async function loadBase(workbookId) {
  let db;
  try { db = await openDb(); } catch (err) { return { available: false, base: null, error: String(err.message || err) }; }
  return new Promise((resolve) => {
    try {
      const req = tx(db, 'readonly').get(String(workbookId));
      req.onsuccess = () => resolve({ available: true, base: (req.result && req.result.base) || null });
      req.onerror = () => resolve({ available: false, base: null, error: String(req.error && req.error.message || 'read failed') });
    } catch (err) {
      resolve({ available: false, base: null, error: String(err.message || err) });
    }
  });
}

/**
 * Store the base for a workbook. Never throws — returns why it failed
 * instead, so a caller can surface it rather than silently losing
 * anti-clobber protection on the next sync.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function saveBase(workbookId, base) {
  let db;
  try { db = await openDb(); } catch (err) { return { ok: false, error: String(err.message || err) }; }
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put({ id: String(workbookId), base, savedAt: Date.now() });
      t.oncomplete = () => resolve({ ok: true });
      t.onerror = () => resolve({ ok: false, error: String(t.error && t.error.message || 'write failed') });
      t.onabort = () => resolve({ ok: false, error: String(t.error && t.error.message || 'write aborted — storage may be full') });
    } catch (err) {
      resolve({ ok: false, error: String(err.message || err) });
    }
  });
}

/** Forget a workbook's base (on delete / disconnect). */
export async function removeBase(workbookId) {
  let db;
  try { db = await openDb(); } catch { return { ok: false }; }
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).delete(String(workbookId));
      t.oncomplete = () => resolve({ ok: true });
      t.onerror = () => resolve({ ok: false });
    } catch { resolve({ ok: false }); }
  });
}

