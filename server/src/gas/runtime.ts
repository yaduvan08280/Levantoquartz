/**
 * Runs the production logic in legacy/.
 *
 * Those files are the Apps Script project that ran the plant, kept as they
 * were written: one shared global scope, every function synchronous. They are
 * loaded into this process's global scope with the platform objects they
 * expect (SpreadsheetApp and friends, from spreadsheet.ts and services.ts).
 *
 * Apps Script started every call with fresh globals, and the logic relies on
 * it — its per-call memos (header maps, column reads) are plain variables it
 * never clears. So the scripts' top level is re-run before each call, which
 * resets every one of them without this file having to know their names.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { config } from '../config.js';
import { Workbook } from '../store/workbook.js';
import { makeSpreadsheetApp } from './spreadsheet.js';
import {
  MemoryCache, makeProperties, LockService, Utilities, UrlFetchApp, DriveApp,
  makeScriptApp, Session, Logger
} from './services.js';

const SKIP = new Set(['FormsEntry.gs']);          // doGet/doPost: the dashboard's router has that job
/* The dashboard's Apps Script project, loaded into the same scope as the
   forms logic — the arrangement both were written to support. One file is
   left out: it reacted to Google Forms submissions, which no longer exist. */
const DASH_SKIP = new Set(['defectssplitter.js']);

export class Runtime {
  cache = new MemoryCache();
  private scripts: vm.Script[] = [];
  private g = globalThis as any;

  constructor(public wb: Workbook) {}

  load(): void {
    const g = this.g;
    const cache = this.cache;
    const props = makeProperties(this.wb);
    g.SpreadsheetApp = makeSpreadsheetApp(this.wb);
    g.CacheService = { getScriptCache: () => cache, getUserCache: () => cache, getDocumentCache: () => cache };
    g.PropertiesService = {
      getScriptProperties: () => props, getUserProperties: () => props, getDocumentProperties: () => props
    };
    g.LockService = LockService;
    g.Utilities = Utilities;
    g.UrlFetchApp = UrlFetchApp;
    g.DriveApp = DriveApp;
    g.ScriptApp = makeScriptApp(this.wb);
    g.Session = Session;
    g.Logger = Logger;
    g.MimeType = { JPEG: 'image/jpeg', PNG: 'image/png', PLAIN_TEXT: 'text/plain' };
    const output = (kind: string, content: string) => {
      const o: any = {
        _kind: kind, _content: String(content), _title: '',
        getContent: () => o._content,
        setMimeType(m: string) { o._kind = m === 'JSON' ? 'json' : 'text'; return o; },
        setTitle(t: string) { o._title = t; return o; },
        addMetaTag: () => o, setXFrameOptionsMode: () => o, setFaviconUrl: () => o, setSandboxMode: () => o
      };
      return o;
    };
    g.ContentService = {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT', JAVASCRIPT: 'TEXT' },
      createTextOutput: (s: string) => output('text', s === undefined ? '' : s)
    };
    g.HtmlService = {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
      SandboxMode: { IFRAME: 'IFRAME' },
      createHtmlOutput: (html: string) => output('html', html || ''),
      createHtmlOutputFromFile: (name: string) => {
        for (const dir of [config.dashboardDir, config.legacyDir]) {
          const f = path.join(dir, path.basename(String(name)) + '.html');
          if (fs.existsSync(f)) return output('html', fs.readFileSync(f, 'utf8'));
        }
        throw new Error('No HTML file named ' + name);
      }
    };

    const files = fs.readdirSync(config.legacyDir).filter((f) => f.endsWith('.gs') && !SKIP.has(f)).sort();
    /* Configuration first: other files read it while they load. */
    files.sort((a, b) => (a === 'FormsConfig.gs' ? -1 : b === 'FormsConfig.gs' ? 1 : a.localeCompare(b)));
    this.scripts = files.map((f) => new vm.Script(
      fs.readFileSync(path.join(config.legacyDir, f), 'utf8'), { filename: path.join('legacy', f) }));
    if (fs.existsSync(config.dashboardDir)) {
      for (const f of fs.readdirSync(config.dashboardDir).filter((x) => /\.(js|gs)$/.test(x) && !DASH_SKIP.has(x)).sort()) {
        this.scripts.push(new vm.Script(
          fs.readFileSync(path.join(config.dashboardDir, f), 'utf8'), { filename: path.join('legacy-dashboard', f) }));
      }
    }
    this.fresh();
  }

  /** Reset the logic's globals to what a new Apps Script execution would see. */
  private fresh(): void {
    for (const s of this.scripts) s.runInThisContext();
  }

  has(fn: string): boolean { return typeof this.g[fn] === 'function'; }

  /** Call one of the logic's functions. Synchronous; the caller flushes the store. */
  call(fn: string, args: unknown[] = []): unknown {
    this.fresh();
    const f = this.g[fn];
    if (typeof f !== 'function') throw new Error('No such function: ' + fn);
    return f.apply(null, args);
  }

  /** A value from the logic's global scope (form definitions, config). */
  global<T = any>(name: string): T { return this.g[name] as T; }
}
