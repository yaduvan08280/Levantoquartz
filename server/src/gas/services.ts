/**
 * The rest of the platform the forms logic expects: a cache, a settings
 * store, locks, date formatting, hashing, outbound HTTP, file storage and
 * scheduled jobs. Each one is the smallest faithful stand-in for the Apps
 * Script service of the same name.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { config } from '../config.js';
import { formatDate } from '../store/values.js';
import { Workbook } from '../store/workbook.js';

/* ================================================================ cache == */

interface CacheEntry { v: string; exp: number }

export class MemoryCache {
  private map = new Map<string, CacheEntry>();

  get(key: string): string | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) { this.map.delete(key); return null; }
    return e.v;
  }
  put(key: string, value: string, seconds?: number): void {
    const ttl = Math.min(Math.max(seconds === undefined ? 600 : seconds, 1), 21600);
    this.map.set(key, { v: String(value), exp: Date.now() + ttl * 1000 });
  }
  remove(key: string): void { this.map.delete(key); }
  removeAll(keys: string[]): void { (keys || []).forEach((k) => this.map.delete(k)); }
  getAll(keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    (keys || []).forEach((k) => { const v = this.get(k); if (v !== null) out[k] = v; });
    return out;
  }
  putAll(values: Record<string, string>, seconds?: number): void {
    Object.keys(values || {}).forEach((k) => this.put(k, values[k], seconds));
  }

  /** Forget everything derived from sheet data (lists, headers), keep sign-ins. */
  clearData(): void {
    for (const k of Array.from(this.map.keys())) {
      if (k.startsWith('sess_') || k === 'prune_sessions') continue;
      this.map.delete(k);
    }
  }
  sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.exp < now) this.map.delete(k);
  }
}

/* =========================================================== properties == */

export function makeProperties(wb: Workbook, scope = 'prop') {
  const api = {
    getProperty: (k: string) => wb.kvGet(scope, k),
    setProperty(k: string, v: string) { wb.kvSet(scope, k, String(v)); return api; },
    deleteProperty(k: string) { wb.kvDelete(scope, k); return api; },
    getProperties: () => wb.kvAll(scope),
    getKeys: () => Object.keys(wb.kvAll(scope)),
    setProperties(values: Record<string, string>, deleteAllOthers?: boolean) {
      if (deleteAllOthers) {
        Object.keys(wb.kvAll(scope)).forEach((k) => { if (!(k in values)) wb.kvDelete(scope, k); });
      }
      Object.keys(values || {}).forEach((k) => {
        if (wb.kvGet(scope, k) !== String(values[k])) wb.kvSet(scope, k, String(values[k]));
      });
      return api;
    },
    deleteAllProperties() { Object.keys(wb.kvAll(scope)).forEach((k) => wb.kvDelete(scope, k)); return api; }
  };
  return api;
}

/* ================================================================ locks == */
/*
 * Apps Script ran many executions at once and needed locks between them.
 * Here every call into the forms logic runs start to finish on one thread
 * before the next begins, so a lock is always free.
 */
const freeLock = {
  waitLock() { /* always free */ },
  tryLock() { return true; },
  hasLock() { return true; },
  releaseLock() { /* nothing held */ }
};
export const LockService = {
  getScriptLock: () => freeLock,
  getUserLock: () => freeLock,
  getDocumentLock: () => freeLock
};

/* ============================================================ utilities == */

function zoneOffsetMinutes(d: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(d);
  const n: Record<string, number> = {};
  parts.forEach((p) => { if (p.type !== 'literal') n[p.type] = parseInt(p.value, 10); });
  const asUtc = Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second);
  return Math.round((asUtc - (d.getTime() - d.getMilliseconds())) / 60000);
}

export const Utilities = {
  DigestAlgorithm: { SHA_256: 'sha256', SHA_1: 'sha1', MD5: 'md5', SHA_512: 'sha512' },
  Charset: { UTF_8: 'utf8', US_ASCII: 'ascii' },
  /** Bytes come back signed (-128..127), as Apps Script returns them. */
  computeDigest(alg: string, value: string | number[], charset?: string): number[] {
    const h = crypto.createHash(alg || 'sha256');
    if (typeof value === 'string') h.update(value, (charset as BufferEncoding) || 'utf8');
    else h.update(Buffer.from(Uint8Array.from(value.map((b) => b & 0xff))));
    return Array.from(h.digest()).map((b) => (b > 127 ? b - 256 : b));
  },
  formatDate(date: Date, zone: string, pattern: string): string {
    const d = new Date(date as any);
    if (zone && zone !== config.timezone) {
      try {
        const shift = zoneOffsetMinutes(d, zone) + d.getTimezoneOffset();
        return formatDate(new Date(d.getTime() + shift * 60000), pattern);
      } catch { /* unknown zone: fall through to the app's own */ }
    }
    return formatDate(d, pattern);
  },
  getUuid: () => crypto.randomUUID(),
  computeHmacSha256Signature(value: string | number[], key: string | number[]): number[] {
    const buf = (v: string | number[]) => typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(Uint8Array.from(v.map((b) => b & 0xff)));
    return Array.from(crypto.createHmac('sha256', buf(key)).update(buf(value)).digest()).map((b) => (b > 127 ? b - 256 : b));
  },
  base64EncodeWebSafe(v: string | number[]) {
    return (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(Uint8Array.from(v.map((b) => b & 0xff))))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  },
  base64DecodeWebSafe: (s: string) => Array.from(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')).map((b) => (b > 127 ? b - 256 : b)),
  /* The one sleep in the logic slows password guessing. A sleep here would
     stall every other user for the same time, so the pause is applied to the
     sign-in response instead (routes/forms.ts). */
  sleep(_ms: number) { /* see above */ },
  base64Decode: (s: string) => Array.from(Buffer.from(String(s), 'base64')).map((b) => (b > 127 ? b - 256 : b)),
  base64Encode(v: string | number[]) {
    return (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(Uint8Array.from(v.map((b) => b & 0xff)))).toString('base64');
  },
  newBlob(data: number[] | string, contentType?: string, name?: string) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(Uint8Array.from(data.map((b) => b & 0xff)));
    return makeBlob(buf, contentType || 'application/octet-stream', name || 'file');
  },
  parseDate(s: string) { return new Date(s); }
};

export interface Blob {
  _buf: Buffer;
  getBytes(): number[];
  getContentType(): string;
  getName(): string;
  setName(n: string): Blob;
  getDataAsString(): string;
}

export function makeBlob(buf: Buffer, contentType: string, name: string): Blob {
  const b: Blob = {
    _buf: buf,
    getBytes: () => Array.from(buf).map((x) => (x > 127 ? x - 256 : x)),
    getContentType: () => contentType,
    getName: () => name,
    setName(n: string) { name = n; return b; },
    getDataAsString: () => buf.toString('utf8'),
    /* No converter here: an HTML document asked for as a PDF stays HTML and
       is marked to open the browser's print dialog, which saves it as one. */
    getAs(type: string) { const o: any = makeBlob(buf, contentType, name); o._printAs = type; return o; }
  } as any;
  return b;
}

/* ========================================================= outbound HTTP == */
/*
 * The logic calls UrlFetchApp.fetch() and uses the answer on the next line,
 * so the call has to block. A worker thread makes the request while this
 * thread waits on it, with a hard deadline so a stalled remote (Telegram)
 * can never hold the app for long.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', async (job) => {
  const flag = new Int32Array(job.sab);
  let out;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), job.timeoutMs);
    const res = await fetch(job.url, {
      method: job.method, headers: job.headers, body: job.body,
      redirect: job.followRedirects ? 'follow' : 'manual', signal: ctl.signal
    });
    const text = await res.text();
    clearTimeout(timer);
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    out = { ok: true, status: res.status, text, headers };
  } catch (e) {
    out = { ok: false, error: String((e && e.cause && e.cause.message) || (e && e.message) || e) };
  }
  job.port.postMessage(out);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
`;

let fetchWorker: Worker | null = null;

export function fetchSync(url: string, opts: any) {
  if (!fetchWorker) {
    fetchWorker = new Worker(WORKER_SOURCE, { eval: true });
    fetchWorker.unref();
    fetchWorker.on('error', () => { fetchWorker = null; });
    fetchWorker.on('exit', () => { fetchWorker = null; });
  }
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const headers: Record<string, string> = Object.assign({}, opts.headers || {});
  if (opts.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = opts.contentType;
  }
  let body = opts.payload;
  if (body && typeof body === 'object') {
    body = Object.keys(body).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(body[k])).join('&');
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const method = String(opts.method || (body ? 'post' : 'get')).toUpperCase();
  fetchWorker.postMessage({
    url, method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body,
    followRedirects: opts.followRedirects !== false, timeoutMs: config.fetchTimeoutMs, sab, port: port2
  }, [port2]);
  Atomics.wait(flag, 0, 0, config.fetchTimeoutMs + 3000);
  const msg = receiveMessageOnPort(port1);
  port1.close();
  if (!msg) {
    /* The worker is stuck on this request; start a clean one for the next. */
    try { fetchWorker.terminate(); } catch { /* already gone */ }
    fetchWorker = null;
    throw new Error('No answer from ' + safeHost(url) + ' in ' + Math.round(config.fetchTimeoutMs / 1000) + 's');
  }
  return msg.message as { ok: boolean; status?: number; text?: string; headers?: Record<string, string>; error?: string };
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return 'the server'; }
}

export const UrlFetchApp = {
  fetch(url: string, opts?: any) {
    const o = opts || {};
    const r = fetchSync(url, o);
    if (!r.ok) throw new Error('Request to ' + safeHost(url) + ' failed: ' + r.error);
    if (!o.muteHttpExceptions && (r.status as number) >= 400) {
      throw new Error('Request failed for ' + safeHost(url) + ' returned code ' + r.status);
    }
    return {
      getResponseCode: () => r.status,
      getContentText: () => r.text || '',
      getAllHeaders: () => r.headers || {},
      getHeaders: () => r.headers || {}
    };
  }
};

/* ============================================================ file store == */
/*
 * Photos and videos from Grade Reporting and the Container form. They were
 * saved to a Google Drive folder; they are saved under DATA_DIR/media now and
 * served from /media/. A folder's id is its path; a file is addressed by a
 * link with a random component, like a Drive "anyone with the link" file.
 */
const mediaRoot = () => path.join(config.dataDir, 'media');

function safeName(s: string): string {
  return String(s || '').replace(/[\\/\u0000-\u001f<>:"|?*]+/g, '_').replace(/^\.+/, '_').trim().slice(0, 120) || 'file';
}

function idFor(rel: string): string { return Buffer.from(rel, 'utf8').toString('base64url'); }
function relFor(id: string): string { return Buffer.from(String(id), 'base64url').toString('utf8'); }

export function mediaUrl(rel: string): string {
  return config.publicUrl + '/media/' + rel.split(path.sep).map(encodeURIComponent).join('/');
}

function makeFolder(rel: string) {
  const abs = path.join(mediaRoot(), rel);
  const folder = {
    getId: () => idFor(rel),
    getName: () => path.basename(rel),
    getUrl: () => mediaUrl(rel),
    getFoldersByName(name: string) {
      const child = path.join(rel, safeName(name));
      const exists = fs.existsSync(path.join(mediaRoot(), child));
      let used = false;
      return {
        hasNext: () => exists && !used,
        next() { used = true; return makeFolder(child); }
      };
    },
    createFolder(name: string) {
      const child = path.join(rel, safeName(name));
      fs.mkdirSync(path.join(mediaRoot(), child), { recursive: true });
      return makeFolder(child);
    },
    createFile(blob: Blob) {
      fs.mkdirSync(abs, { recursive: true });
      const name = safeName(blob.getName());
      const stored = crypto.randomBytes(9).toString('base64url') + '-' + name;
      fs.writeFileSync(path.join(abs, stored), blob._buf);
      const fileRel = path.join(rel, stored);
      const file = {
        /* No Drive id: the page links to the URL when there is none. */
        getId: () => '',
        getUrl: () => mediaUrl(fileRel),
        getName: () => name,
        setSharing() { return file; },
        setName() { return file; }
      };
      return file;
    },
    setSharing() { return folder; }
  };
  return folder;
}

export const DriveApp = {
  Access: { DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE', DOMAIN: 'DOMAIN' },
  Permission: { VIEW: 'VIEW', EDIT: 'EDIT' },
  getFolderById(id: string) {
    const rel = relFor(id);
    const abs = path.resolve(mediaRoot(), rel);
    if (!abs.startsWith(path.resolve(mediaRoot())) || !fs.existsSync(abs)) throw new Error('Folder not found.');
    return makeFolder(rel);
  },
  getFoldersByName: (name: string) => makeFolder('').getFoldersByName(name),
  createFolder: (name: string) => makeFolder('').createFolder(name),
  getRootFolder: () => makeFolder('')
};

/* ======================================================= scheduled jobs == */

export interface Trigger { handler: string; everyMinutes: number; id: string }

export function listTriggers(wb: Workbook, scope = 'trigger'): Trigger[] {
  const all = wb.kvAll(scope);
  return Object.keys(all).map((k) => {
    try { return JSON.parse(all[k]) as Trigger; } catch { return null; }
  }).filter((t): t is Trigger => !!t);
}

export function makeScriptApp(wb: Workbook, scope = 'trigger', url: () => string = () => config.publicUrl + '/exec') {
  const wrap = (t: Trigger) => ({
    getHandlerFunction: () => t.handler,
    getUniqueId: () => t.id,
    getEventType: () => 'CLOCK',
    _t: t
  });
  return {
    getService: () => ({ getUrl: url }),
    getOAuthToken: () => 'local',
    getScriptId: () => 'levanto',
    getProjectTriggers: () => listTriggers(wb, scope).map(wrap),
    deleteTrigger(t: any) { if (t && t._t) wb.kvDelete(scope, t._t.id); },
    newTrigger(handler: string) {
      let minutes = 60;
      const b: any = {
        timeBased: () => b,
        /* Sheet-event triggers have nothing to fire them here; they are
           recorded so the logic's own "is it installed" checks pass. */
        forSpreadsheet() { minutes = 0; return b; }, forDocument() { minutes = 0; return b; },
        onFormSubmit: () => b, onEdit: () => b, onOpen: () => b, onChange: () => b,
        everyMinutes(n: number) { minutes = n; return b; },
        everyHours(n: number) { minutes = n * 60; return b; },
        everyDays(n: number) { minutes = n * 1440; return b; },
        atHour: () => b, nearMinute: () => b, inTimezone: () => b,
        create() {
          const t: Trigger = { handler, everyMinutes: minutes, id: handler + ':' + crypto.randomBytes(4).toString('hex') };
          wb.kvSet(scope, t.id, JSON.stringify(t));
          return wrap(t);
        }
      };
      return b;
    }
  };
}

export const Session = {
  getScriptTimeZone: () => config.timezone,
  getActiveUser: () => ({ getEmail: () => '' }),
  getEffectiveUser: () => ({ getEmail: () => '' }),
  getTemporaryActiveUserKey: () => ''
};

export const Logger = {
  log(...args: unknown[]) { console.log(...args); }
};
