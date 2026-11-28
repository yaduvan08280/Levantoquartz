/**
 * Domestic Marketing — the field-sales app (visits, customers, orders),
 * served at /marketing. Its page and logic are the Apps Script project in
 * legacy-marketing, unchanged, run by gas/appRuntime.ts against its own
 * workbook in the database. It keeps its own user accounts.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { marketing, runApp, wb } from '../app.js';
import { switcherSnippet } from './sso.js';

const BASE = '/marketing';

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
          fetch('${BASE}/api/run/' + encodeURIComponent(String(name)), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args)
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

/* The page builds Google Drive thumbnail and preview links from a file's id.
   Files uploaded here are not on Drive, so for those (and only those) the
   same three helpers answer with this server's addresses. Older records that
   point at Drive keep working exactly as before. */
const MEDIA = `<script>
(function () {
  var mine = function (url) { return /\\/files\\/d\\/[\\w-]{20,}\\//.test(String(url || '')) && String(url).indexOf('drive.google') < 0; };
  var isImg = function (url) { return /\\.(jpe?g|png|gif|webp|heic)(\\?|$)/i.test(String(url)); };
  var isVid = function (url) { return /\\.(mp4|mov|webm|m4v|3gp)(\\?|$)/i.test(String(url)); };
  var thumb0 = window.thumbUrl, light0 = window.lightbox;
  if (typeof thumb0 === 'function') window.thumbUrl = function (url, w) {
    if (!mine(url)) return thumb0(url, w);
    return isImg(url) ? url : '';
  };
  if (typeof light0 === 'function') window.lightbox = function (url, kind, cap) {
    if (!mine(url)) return light0(url, kind, cap);
    var lb = document.getElementById('lightbox'), safe = String(url).replace(/"/g, '&quot;');
    var body = kind === 'photo' || isImg(url) ? '<img src="' + safe + '" alt="">'
      : isVid(url) ? '<video src="' + safe + '" controls autoplay playsinline style="max-width:100%;max-height:80vh"></video>'
      : '<iframe src="' + safe + '"></iframe>';
    var c = document.createElement('div'); c.textContent = cap || '';
    lb.innerHTML = body + '<div class="lbc">' + c.innerHTML + ' · <a href="' + safe + '" target="_blank" rel="noopener">Open file ↗</a> · tap outside to close</div>';
    lb.classList.add('on');
  };
})();
</script>`;

export async function marketingRoutes(app: FastifyInstance): Promise<void> {
  /* Uploaded files of every app that keeps its own (photos, videos, slips). */
  app.get('/files/d/:id/:name', async (req, reply) => {
    const { id } = req.params as { id: string; name: string };
    if (!/^[\w-]{20,40}$/.test(id)) return reply.status(404).send({ ok: false });
    for (const sub of ['marketing']) {
      const dir = path.join(config.dataDir, 'media', sub, id);
      if (!fs.existsSync(dir)) continue;
      const name = fs.readdirSync(dir)[0];
      if (!name) break;
      const ext = path.extname(name).toLowerCase();
      const types: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
        '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.pdf': 'application/pdf',
        '.html': 'text/html; charset=utf-8'
      };
      reply.header('Cache-Control', 'private, max-age=86400').type(types[ext] || 'application/octet-stream');
      /* Only the app's own generated documents may run as pages; anything a
         user uploaded is sent as a download unless it is a plain image or video. */
      if (!types[ext]) reply.header('Content-Disposition', 'attachment');
      if (ext === '.html') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
      return reply.send(fs.createReadStream(path.join(dir, name)));
    }
    return reply.status(404).send({ ok: false });
  });

  if (!marketing.installed) return;

  /* What the page calls, read from the page itself, so nothing else is reachable. */
  const pageSrc = fs.readFileSync(path.join(config.marketingDir, 'App.html'), 'utf8');
  const allowed = new Set<string>();
  for (const m of pageSrc.matchAll(/\bapi\(\s*'([A-Za-z_]\w*)'/g)) if (marketing.has(m[1]) && !m[1].endsWith('_')) allowed.add(m[1]);

  /* Until its workbook has been imported there is nothing to show — and the
     app's own first run would create an administrator with a published
     default password, which must not happen on a public address. */
  const ready = () => wb.tabsOf(marketing.id).length > 0;
  const NOT_READY = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Domestic Marketing</title><body style="font:16px/1.5 system-ui,sans-serif;background:#f4f1e9;color:#1b1a17;display:grid;place-items:center;min-height:100vh;margin:0">' +
    '<div style="max-width:440px;padding:28px"><h1 style="font-size:22px;margin:0 0 8px">Domestic Marketing is not set up yet</h1>' +
    '<p>Its data has not been imported. A super admin can do that in the admin panel: <b>Import &amp; backup</b> → choose <b>Domestic Marketing</b> → pick the Google Sheets export.</p>' +
    '<p><a href="/admin/" style="color:#b9860b;font-weight:600">Open the admin panel</a></p></div></body>';

  const page = async (_req: any, reply: any) => {
    if (!ready()) return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(NOT_READY);
    const out: any = await runApp(marketing, 'doGet', [{ parameter: {} }]);
    let html = String(out._content);
    const meta = (out._meta || []).map((m: string[]) => '<meta name="' + m[0] + '" content="' + m[1] + '">').join('');
    const title = out._title ? '<title>' + String(out._title).replace(/</g, '&lt;') + '</title>' : '';
    html = html.replace(/<head([^>]*)>/i, (m) => m + title + meta + BRIDGE);
    html = html.replace(/<\/body>/i, () => MEDIA + switcherSnippet('mkt') + '</body>');
    return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html);
  };
  app.get(BASE, page);
  app.get(BASE + '/', page);

  app.post(BASE + '/api/run/:fn', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const fn = String((req.params as any).fn || '');
    if (!allowed.has(fn) || !ready()) return { ok: false, error: 'Unknown call.' };
    const args = Array.isArray(req.body) ? (req.body as unknown[]) : [];
    if (fn === 'login') await new Promise((r) => setTimeout(r, 250));
    try {
      const result = await runApp(marketing, fn, args);
      return { ok: true, result: result === undefined ? null : result };
    } catch (e: any) {
      const msg = String((e && e.message) || e);
      if (msg !== 'AUTH' && !/Invalid username|not allowed/i.test(msg)) req.log.warn({ fn, err: msg }, 'marketing call failed');
      return { ok: false, error: msg };
    }
  });
}
