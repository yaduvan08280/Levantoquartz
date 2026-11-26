/**
 * The forms app: its page, and the calls the page makes.
 *
 * The page is the original one (legacy/FormsPage.html with its stylesheet and
 * script), byte for byte. It reached the server through Apps Script's
 * google.script.run bridge; a few lines put in front of it provide that same
 * object over plain HTTP, so nothing in the page had to change.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { rt, run } from '../app.js';

const BRIDGE = `<script>
/* google.script.run, over HTTP. Same calling convention, same callbacks. */
(function () {
  function runner(ok, fail) {
    return new Proxy({}, {
      get: function (_t, name) {
        if (name === 'withSuccessHandler') return function (f) { return runner(f, fail); };
        if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
        if (name === 'withUserObject') return function () { return runner(ok, fail); };
        return function () {
          var args = [].slice.call(arguments);
          fetch('/api/run/' + encodeURIComponent(String(name)), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
            credentials: 'same-origin'
          }).then(function (r) {
            return r.json().catch(function () { throw new Error('The server gave an unreadable answer (HTTP ' + r.status + ').'); });
          }).then(function (j) {
            if (j && j.ok) { if (ok) ok(j.result === undefined ? null : j.result); }
            else if (fail) fail(new Error((j && j.error) || 'The server could not be reached.'));
          }).catch(function (e) { if (fail) fail(e instanceof Error ? e : new Error(String(e))); });
        };
      }
    });
  }
  window.google = { script: { run: runner(null, null) } };
})();
</script>`;

let template: { head: string; tail: string } | null = null;

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
}

function buildTemplate(): { head: string; tail: string } {
  const read = (f: string) => fs.readFileSync(path.join(config.legacyDir, f), 'utf8');
  let page = read('FormsPage.html');
  const title = String((rt.global('FORMS_CFG') || {}).APP_TITLE || 'Slabworks Production Forms');
  page = page.replace(/<\?!=\s*formsInclude\('FormsCss'\);?\s*\?>/, () => '<title>' + escHtml(title) + '</title>\n' + read('FormsCss.html'));
  page = page.replace(/<\?!=\s*formsInclude\('FormsJs'\);?\s*\?>/, () => BRIDGE + '\n' + read('FormsJs.html'));
  const marker = /<\?!=\s*deepLink\s*\?>/;
  const m = marker.exec(page);
  if (!m) throw new Error('FormsPage.html: deep-link marker not found');
  return { head: page.slice(0, m.index), tail: page.slice(m.index + m[0].length) };
}

/* Wrong-password attempts per address + username, to make guessing slow. */
const failures = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 10 * 60 * 1000, MAX_FAILS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function formsRoutes(app: FastifyInstance): Promise<void> {
  const page = async (req: any, reply: any) => {
    if (!template || process.env.NODE_ENV !== 'production') template = buildTemplate();
    const q = (req.query || {}) as Record<string, string>;
    const deep = JSON.stringify({
      form: String(q.form || ''), slab: String(q.slab || ''), alert: String(q.alert || '')
    }).replace(/</g, '\\u003c');
    reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8');
    return template.head + deep + template.tail;
  };
  app.get('/', page);
  app.get('/forms', page);

  app.post('/api/run/:fn', async (req, reply) => {
    const fn = String((req.params as any).fn || '');
    reply.header('Cache-Control', 'no-store');
    /* Only the page's own API. Apps Script exposed every function in the
       project to the browser, the setup and password ones included. */
    if (!/^api_[A-Za-z0-9]+$/.test(fn) || !rt.has(fn)) {
      return { ok: false, error: 'Unknown call.' };
    }
    const args = Array.isArray(req.body) ? (req.body as unknown[]) : [];

    let key = '';
    if (fn === 'api_login') {
      key = req.ip + '|' + String(args[0] || '').trim().toLowerCase();
      const f = failures.get(key);
      if (f && f.n >= MAX_FAILS && f.until > Date.now()) {
        return { ok: true, result: { ok: false, error: 'Too many wrong attempts. Wait ten minutes and try again.' } };
      }
      await sleep(250);                              // the pause the logic asks for on every sign-in
    }
    try {
      const result = await run(fn, args);
      if (fn === 'api_login') {
        if (result && (result as any).ok) failures.delete(key);
        else {
          const f = failures.get(key);
          const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + WINDOW_MS };
          cur.n++;
          failures.set(key, cur);
        }
      }
      return { ok: true, result: result === undefined ? null : result };
    } catch (e: any) {
      const msg = String((e && e.message) || e);
      if (!/sign in|session|assigned|not signed/i.test(msg)) req.log.warn({ fn, err: msg }, 'call failed');
      return { ok: false, error: msg };
    }
  });
}
