// ============================================================
//  Mono — Attachment blob store  (P10)
//
//  Stores file blobs in IndexedDB under the object store
//  'attachments' — added to the existing database in the same
//  onupgradeneeded version bump as the main store.
//
//  Because the main LocalStore uses localStorage (not IDB), this
//  file opens the IDB independently for attachments only.
//
//  Cell raw values hold attachment IDs, never blobs.
//  IDs are stable UUIDs generated here on upload.
//
//  API (all async):
//    put(file: File) → attachmentId: string
//    get(id: string) → { blob: Blob, name: string, type: string } | null
//    remove(id: string) → void
//    list() → [{id, name, type, size}]
// ============================================================

const DB_NAME    = 'mono.attachments';
const DB_VERSION = 1;
const STORE      = 'attachments';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function _uuid() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Store a File and return its stable ID.
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function put(file) {
  const id = _uuid();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ id, name: file.name, type: file.type, size: file.size, blob: file });
    tx.oncomplete = () => resolve(id);
    tx.onerror    = (e) => reject(e.target.error);
  });
}

/**
 * Retrieve a stored attachment by ID.
 * @param {string} id
 * @returns {Promise<{id,name,type,size,blob}|null>}
 */
export async function get(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Delete an attachment by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function remove(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
}

/**
 * List all stored attachments (metadata only, no blobs).
 * @returns {Promise<{id,name,type,size}[]>}
 */
export async function list() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = (e) => resolve((e.target.result || []).map(({ id, name, type, size }) => ({ id, name, type, size })));
    req.onerror   = (e) => reject(e.target.error);
  });
}
