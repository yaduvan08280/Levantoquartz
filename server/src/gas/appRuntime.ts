/**
 * Runs a further Apps Script project beside the production one.
 *
 * The forms logic and the dashboard share the process's global scope
 * (runtime.ts), as they were written to. Any other project — Domestic
 * Marketing is the first — has its own names for the same things (doGet,
 * setup, login, T…), its own spreadsheet and its own settings, so it gets a
 * scope of its own: its files are compiled into one function whose local
 * variables are the project's "globals", and which is handed its own set of
 * platform objects bound to its own workbook.
 *
 * Like Apps Script, every call starts from fresh globals: the function is
 * run anew for each call.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { Workbook } from '../store/workbook.js';
import { makeSpreadsheetApp } from './spreadsheet.js';
import {
  MemoryCache, makeProperties, LockService, Utilities, UrlFetchApp, makeScriptApp, Session, Logger,
  makeBlob, listTriggers, type Trigger
} from './services.js';

export interface AppOptions {
  /** Short id: URL prefix, workbook id, settings namespace. */
  id: string;
  title: string;
  dir: string;
  /** Files that only made sense inside Google (none by default). */
  skip?: string[];
}

interface Instance { fns: Record<string, Function>; ev: (src: string) => any }

const SERVICE_NAMES = ['SpreadsheetApp', 'CacheService', 'PropertiesService', 'LockService', 'Utilities', 'UrlFetchApp',
  'DriveApp', 'ScriptApp', 'Session', 'Logger', 'HtmlService', 'ContentService', 'MimeType'];

export class AppRuntime {
  cache = new MemoryCache();
  private factory: Function | null = null;
  private services: any[] = [];
  private current: Instance | null = null;
  private uploads = new Map<string, { file: string; size: number; got: number }>();
  names: string[] = [];

  constructor(public wb: Workbook, public opts: AppOptions) {}

  get id(): string { return this.opts.id; }
  get installed(): boolean { return !!this.factory; }
  private get propScope(): string { return 'prop:' + this.opts.id; }
  get triggerScope(): string { return 'trigger:' + this.opts.id; }
  private filesDir(): string { return path.join(config.dataDir, 'media', this.opts.id); }
  publicUrl(): string { return config.publicUrl + '/' + this.opts.id; }

  triggers(): Trigger[] { return listTriggers(this.wb, this.triggerScope); }

  load(): void {
    const dir = this.opts.dir;
    if (!fs.existsSync(dir)) return;
    const skip = new Set(this.opts.skip || []);
    const files = fs.readdirSync(dir).filter((f) => /\.(js|gs)$/.test(f) && !skip.has(f)).sort();
    if (!files.length) return;
    let src = '';
    const names = new Set<string>();
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1]);
      src += '\n// ---- ' + f + '\n' + text + '\n';
    }
    this.names = Array.from(names);
    /* The trailing object is the only way out of the scope: every top-level
       function by name, and an eval that sees the project's variables (the
       page template's <?!= ... ?> expressions need it). */
    const tail = '\nreturn { fns: {' + this.names.map((n) => JSON.stringify(n) + ': ' + n).join(', ') +
      '}, ev: function (__src) { return eval(__src); } };';
    this.factory = new Function(...SERVICE_NAMES, src + tail + '\n//# sourceURL=legacy-' + this.opts.id + '.js');
    this.services = this.makeServices();
  }

  has(fn: string): boolean { return this.names.indexOf(fn) !== -1; }

  /** Call one of the project's functions. Synchronous; the caller commits the store. */
  call(fn: string, args: unknown[] = []): any {
    if (!this.factory) throw new Error(this.opts.title + ' is not installed.');
    const inst = this.factory(...this.services) as Instance;
    this.current = inst;
    const f = inst.fns[fn];
    if (typeof f !== 'function') throw new Error('No such function: ' + fn);
    return f.apply(null, args);
  }

  /** Evaluate an expression inside the project's scope (maintenance and tests). */
  evalIn(src: string): any {
    if (!this.factory) throw new Error(this.opts.title + ' is not installed.');
    const inst = this.factory(...this.services) as Instance;
    this.current = inst;
    return inst.ev(src);
  }

  /* ------------------------------------------------------- platform -- */

  private makeServices(): any[] {
    const self = this;
    const cache = this.cache;
    const props = makeProperties(this.wb, this.propScope);

    const output = (kind: string, content: string) => {
      const o: any = {
        _kind: kind, _content: String(content),
        getContent: () => o._content,
        setMimeType(m: string) { o._kind = m === 'JSON' ? 'json' : 'text'; return o; },
        setTitle(t: string) { o._title = t; return o; },
        addMetaTag(name: string, value: string) { (o._meta = o._meta || []).push([name, value]); return o; },
        setXFrameOptionsMode: () => o, setFaviconUrl: () => o, setSandboxMode: () => o
      };
      return o;
    };
    const readHtml = (name: string) => {
      const f = path.join(this.opts.dir, path.basename(String(name)) + '.html');
      if (!fs.existsSync(f)) throw new Error('No HTML file named ' + name);
      return fs.readFileSync(f, 'utf8');
    };
    const HtmlService = {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
      SandboxMode: { IFRAME: 'IFRAME' },
      createHtmlOutput: (html: string) => output('html', html || ''),
      createHtmlOutputFromFile: (name: string) => output('html', readHtml(name)),
      /* Apps Script templates: <?!= expr ?> prints the value as it is,
         <?= expr ?> prints it escaped. Only those two forms are used. */
      createTemplateFromFile: (name: string) => ({
        evaluate() {
          const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          const html = readHtml(name).replace(/<\?(!?)=([\s\S]*?)\?>/g, (_m, raw: string, expr: string) => {
            const v = String(self.current!.ev('(' + expr.trim().replace(/;$/, '') + ')'));
            return raw ? v : esc(v);
          });
          return output('html', html);
        }
      })
    };

    /* Files. Each gets an id and lives at /files/d/<id>/<name> — the same
       "/d/<id>" shape as a Drive link, which is how the page finds the id. */
    const fileOf = (id: string) => {
      const dir = path.join(self.filesDir(), id);
      const name = fs.existsSync(dir) ? fs.readdirSync(dir)[0] : '';
      if (!name) throw new Error('File not found.');
      const file: any = {
        getId: () => id,
        getName: () => name,
        getUrl: () => config.publicUrl + '/files/d/' + id + '/' + encodeURIComponent(name),
        setSharing: () => file, setName: () => file, setTrashed: () => file
      };
      return file;
    };
    const newFile = (name: string, buf: Buffer) => {
      const id = crypto.randomBytes(18).toString('base64url');
      const dir = path.join(self.filesDir(), id);
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(name || 'file').replace(/[\\/\u0000-\u001f<>:"|?*]+/g, '_').slice(0, 140) || 'file';
      fs.writeFileSync(path.join(dir, safe), buf);
      return id;
    };
    const folder: any = {
      getId: () => 'uploads', getName: () => this.opts.title + ' — Uploads', getUrl: () => '',
      createFile(blob: any) {
        let name = blob.getName(), buf: Buffer = blob._buf;
        if (blob._printAs === 'application/pdf' && /html/.test(blob.getContentType())) {
          name = name.replace(/\.pdf$/i, '') + '.html';
          buf = Buffer.concat([buf, Buffer.from('<script>addEventListener("load",function(){setTimeout(function(){print()},300)})</script>')]);
        }
        return fileOf(newFile(name, buf));
      },
      setSharing: () => folder
    };
    const DriveApp = {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', ANYONE: 'ANYONE', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK', PRIVATE: 'PRIVATE' },
      Permission: { VIEW: 'VIEW', EDIT: 'EDIT' },
      getFolderById: () => folder,
      createFolder: () => folder,
      getRootFolder: () => folder,
      getFileById: (id: string) => fileOf(String(id))
    };

    /* Large files went to Drive through its resumable-upload address, a piece
       at a time. The same two requests are answered here, into the file store. */
    const fetch = (url: string, o: any = {}) => {
      const reply = (code: number, text: string, headers: Record<string, string> = {}) => ({
        getResponseCode: () => code, getContentText: () => text, getHeaders: () => headers, getAllHeaders: () => headers
      });
      if (/googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable/.test(url)) {
        let meta: any = {};
        try { meta = JSON.parse(o.payload || '{}'); } catch { /* unnamed */ }
        const id = newFile(meta.name || 'file', Buffer.alloc(0));
        const dir = path.join(self.filesDir(), id);
        self.uploads.set(id, { file: path.join(dir, fs.readdirSync(dir)[0]), size: Number((o.headers || {})['X-Upload-Content-Length']) || 0, got: 0 });
        return reply(200, '', { Location: 'local-upload://' + id });
      }
      if (url.startsWith('local-upload://')) {
        const id = url.slice('local-upload://'.length);
        const up = self.uploads.get(id);
        if (!up) return reply(404, '{}');
        const bytes: number[] = Array.isArray(o.payload) ? o.payload : [];
        fs.appendFileSync(up.file, Buffer.from(Uint8Array.from(bytes.map((b) => b & 0xff))));
        up.got += bytes.length;
        if (up.got < up.size) return reply(308, '');
        self.uploads.delete(id);
        return reply(200, JSON.stringify({ id }));
      }
      return UrlFetchApp.fetch(url, o);
    };

    const byName: Record<string, any> = {
      SpreadsheetApp: makeSpreadsheetApp(this.wb, this.opts.id, this.opts.title),
      CacheService: { getScriptCache: () => cache, getUserCache: () => cache, getDocumentCache: () => cache },
      PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props, getDocumentProperties: () => props },
      LockService,
      Utilities: Object.assign({}, Utilities, {
        newBlob(data: number[] | string, contentType?: string, name?: string) {
          const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(Uint8Array.from(data.map((b) => b & 0xff)));
          return makeBlob(buf, contentType || 'application/octet-stream', name || 'file');
        }
      }),
      UrlFetchApp: { fetch },
      DriveApp,
      ScriptApp: makeScriptApp(this.wb, this.triggerScope, () => this.publicUrl()),
      Session, Logger, HtmlService,
      ContentService: { MimeType: { JSON: 'JSON', TEXT: 'TEXT' }, createTextOutput: (s: string) => output('text', s === undefined ? '' : s) },
      MimeType: { JPEG: 'image/jpeg', PNG: 'image/png', PDF: 'application/pdf', PLAIN_TEXT: 'text/plain', HTML: 'text/html' }
    };
    return SERVICE_NAMES.map((n) => byName[n]);
  }
}
