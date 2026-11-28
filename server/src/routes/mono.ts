/**
 * Mono Sheets, served as it is, with the server side of its protocol.
 *
 * /sheets/ is the Mono Sheets app (server/monosheets, an untouched copy of
 * the monosheets project's public folder). The /api routes below are the ones
 * that app calls; they are answered from the data store by mono/bridge.ts.
 * Super admins only (see super.ts), on the same accounts as everything else.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from '../config.js';
import { pool } from '../db.js';
import { rt, run, commit, bridge } from '../app.js';
import { BridgeError, MAIN_BOOK, type Change } from '../mono/bridge.js';
import { isSuper } from '../super.js';

const COOKIE = 'levanto_sheets';

function cookieOf(req: FastifyRequest): string {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setCookie(reply: FastifyReply, token: string): void {
  const secure = config.publicUrl.startsWith('https://') ? '; Secure' : '';
  reply.header('Set-Cookie', COOKIE + '=' + (token ? encodeURIComponent(token) : '') +
    '; Path=/; HttpOnly; SameSite=Lax' + secure + (token ? '; Max-Age=43200' : '; Max-Age=0'));
}
const csrfFor = (token: string) => crypto.createHash('sha256').update('sheets-csrf|' + token).digest('hex').slice(0, 40);

interface Who { username: string; token: string }

async function whoIs(token: string): Promise<Who | null> {
  if (!token) return null;
  try {
    const s: any = await run('fRequireSession_', [token]);
    const u: any = rt.call('fFindUser_', [s.username]);
    return u && isSuper(u.username) ? { username: u.username, token } : null;
  } catch { return null; }
}

async function audit(actor: string, changes: Change[]): Promise<void> {
  if (!changes.length) return;
  if (changes.length > 500) {
    await pool.query(`INSERT INTO audit_log(actor, action, tab, detail) VALUES ($1,'data.bulk',$2,$3)`,
      [actor, changes[0].tab, JSON.stringify({ cells: changes.length, sample: changes.slice(0, 50) })]);
    return;
  }
  for (const c of changes) {
    if (c.row === 0) {
      await pool.query(`INSERT INTO audit_log(actor, action, tab, detail) VALUES ($1,'data.rows',$2,$3)`,
        [actor, c.tab, JSON.stringify({ note: c.neu })]);
    } else {
      await pool.query(`INSERT INTO audit_log(actor, action, tab, row_no, col_no, old_val, new_val) VALUES ($1,'data.edit',$2,$3,$4,$5,$6)`,
        [actor, c.tab, c.row, c.col, c.old, c.neu]);
    }
  }
}

/** After the sheet editor changed data: the forms' cached lists and the dashboard must follow. */
async function afterEdit(changes: Change[]): Promise<void> {
  if (!changes.length) return;
  rt.cache.clearData();
  try {
    const whole = changes.some((c) => c.row === 0) || changes.length > 80;
    if (whole && rt.has('noteFullChange_')) await run('noteFullChange_', []);
    else if (rt.has('noteChange_')) {
      const seen = new Set<string>();
      for (const c of changes) {
        const k = c.tab + '|' + c.row;
        if (seen.has(k)) continue;
        seen.add(k);
        rt.call('noteChange_', [c.tab, c.row, 1]);
      }
      await commit(() => undefined);
    }
  } catch { /* the dashboard catches up on its next rebuild */ }
}

/* Mono Sheets opens in dashboard mode with an empty workspace on a new
   browser. This runs first and points it at the sheet and the data. */
const BOOT = `<script>
(function () {
  try {
    localStorage.setItem('mono.mode', 'sheet');
    var s = {}; try { s = JSON.parse(localStorage.getItem('mono.settings') || '{}') || {}; } catch (e) {}
    var ws = s.workspace && Array.isArray(s.workspace.order) ? s.workspace : { order: [], activeWorkbookId: null };
    var known = { ${JSON.stringify(MAIN_BOOK)}: 1, applog: 1 };
    ws.order = ws.order.filter(function (id) { return known[id]; });
    if (ws.order.indexOf(${JSON.stringify(MAIN_BOOK)}) < 0) ws.order.unshift(${JSON.stringify(MAIN_BOOK)});
    if (!ws.activeWorkbookId || !known[ws.activeWorkbookId]) ws.activeWorkbookId = ${JSON.stringify(MAIN_BOOK)};
    s.workspace = ws; s.dataHome = 'server'; s.serverUrl = '';
    localStorage.setItem('mono.settings', JSON.stringify(s));
  } catch (e) {}
})();
</script>`;

export async function monoRoutes(app: FastifyInstance): Promise<void> {
  if (!fs.existsSync(path.join(config.monoDir, 'index.html'))) return;      // Mono Sheets not installed

  /* ------------------------------------------------------- the app -- */
  const page = async (_req: FastifyRequest, reply: FastifyReply) => {
    const html = fs.readFileSync(path.join(config.monoDir, 'index.html'), 'utf8')
      .replace(/<head([^>]*)>/i, (m) => m + BOOT);
    return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html);
  };
  app.get('/sheets', async (_req, reply) => reply.redirect('/sheets/'));
  app.get('/sheets/', page);
  app.get('/sheets/index.html', page);
  await app.register(fastifyStatic, { root: config.monoDir, prefix: '/sheets/', decorateReply: false, index: false, cacheControl: false,
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } });
  /* A few of its modules are imported by paths that assume the app sits at
     the site root. Sending those to the real location keeps each one the
     same module instead of a second copy. */
  app.get('/mono/*', async (req, reply) => reply.redirect('/sheets/mono/' + (req.params as any)['*']));
  /* The same for any other file of its own it asks for at the root. */
  app.setNotFoundHandler((req, reply) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (req.method === 'GET' && !p.includes('..') && /^\/[\w./-]+\.(js|css|json|png|svg|ico|woff2?)$/.test(p) &&
        fs.existsSync(path.join(config.monoDir, p))) {
      return reply.redirect('/sheets' + p);
    }
    reply.status(404).send({ ok: false, error: 'not_found' });
  });

  /* ---------------------------------------------------------- auth -- */
  app.get('/api/auth/status', async () => ({ ok: true, usersExist: true }));

  app.get('/api/me', async (req, reply) => {
    const who = await whoIs(cookieOf(req));
    if (!who) return reply.status(401).send({ ok: false, error: 'auth_required' });
    return { ok: true, user: { userId: who.username, username: who.username, admin: true }, csrf: csrfFor(who.token) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = (req.body || {}) as any;
    await new Promise((r) => setTimeout(r, 250));
    const res: any = await run('api_login', [String(b.username || ''), String(b.password || '')]);
    if (!res || !res.ok) return reply.status(401).send({ ok: false, error: (res && res.error) || 'Could not sign in.' });
    if (!isSuper(res.user.username)) {
      await run('api_logout', [res.token]);
      return reply.status(403).send({ ok: false, error: 'The data sheets are for super admins.' });
    }
    setCookie(reply, res.token);
    return { ok: true, user: { userId: res.user.username, username: res.user.username, admin: true }, csrf: csrfFor(res.token) };
  });

  app.post('/api/auth/logout', async (_req, reply) => { setCookie(reply, ''); return { ok: true }; });
  app.post('/api/auth/register', async (_req, reply) => reply.status(403).send({ ok: false, error: 'Accounts are created in the admin panel, under Users.' }));

  /* The admin panel is already signed in; this gives the sheet editor the same sign-in. */
  app.post('/api/admin/sheets-session', async (req, reply) => {
    const h = String(req.headers.authorization || '');
    const who = await whoIs(h.startsWith('Bearer ') ? h.slice(7).trim() : '');
    if (!who) return reply.status(401).send({ ok: false, error: 'Sign in first.' });
    setCookie(reply, who.token);
    return { ok: true };
  });

  /* Everything below needs the sign-in, and a write needs the anti-forgery header. */
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<Who | null> => {
    const who = await whoIs(cookieOf(req));
    if (!who) { reply.status(401).send({ ok: false, error: 'auth_required' }); return null; }
    if (req.method !== 'GET' && req.headers['x-mono-csrf'] !== csrfFor(who.token)) {
      reply.status(403).send({ ok: false, error: 'csrf' });
      return null;
    }
    return who;
  };

  app.get('/api/users/check', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return { ok: true, exists: false, username: null };
  });

  /* ----------------------------------------------------- workbooks -- */
  app.get('/api/workbooks', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return {
      ok: true,
      workbooks: bridge.books().map((id) => ({ id, name: bridge.bookName(id), role: 'owner', sharedCount: 0, ownerName: 'Levanto', version: bridge.version(id) }))
    };
  });

  app.get('/api/workbook/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const id = String((req.params as any).id);
    if (!bridge.hasBook(id)) return reply.status(404).send({ ok: false, error: 'not_found' });
    await commit(() => undefined);                 // new tabs get their ids before they are named in the answer
    return {
      ok: true, workbook: bridge.workbookJson(id), version: bridge.version(id), role: 'owner',
      meta: { name: bridge.bookName(id), ownerName: 'Levanto', sharedCount: 0 }
    };
  });

  /* Mono Sheets gzips a large save; the server's compression plugin inflates it. */
  const big = { bodyLimit: 400 * 1024 * 1024 };

  const write = (full: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const who = await guard(req, reply);
    if (!who) return;
    const id = String((req.params as any).id);
    if (!bridge.hasBook(id)) {
      return full ? reply.status(403).send({ ok: false, error: 'forbidden', detail: 'New workbooks are not kept here. The data lives in "New Base".' })
                  : reply.status(409).send({ ok: false, error: 'unpatchable', detail: 'nothing stored yet' });
    }
    const body = (req.body || {}) as any;
    const client = String(req.headers['x-mono-client'] || '');
    const base = body.baseVersion === undefined || body.baseVersion === null ? null : Number(body.baseVersion);
    let changes: Change[] = [];
    try {
      changes = await commit(() => full ? bridge.applyFull(id, body.workbook ?? body, base, client)
                                        : bridge.applyPatch(id, body.patch || {}, base, client));
    } catch (e) {
      if (e instanceof BridgeError) {
        if (e.code === 'conflict') return reply.status(409).send({ ok: false, error: 'conflict', version: bridge.version(id) });
        if (e.code === 'sheet_delete_forbidden') {
          return reply.status(403).send({ ok: false, error: 'sheet_delete_forbidden', detail: 'A data sheet cannot be deleted from here.' });
        }
        return reply.status(422).send({ ok: false, error: 'unpatchable', detail: e.message });
      }
      throw e;
    }
    const version = bridge.version(id);
    await audit(who.username, changes);
    await afterEdit(changes);
    return { ok: true, version };
  };
  app.patch('/api/workbook/:id', big, write(false));
  app.put('/api/workbook/:id', big, write(true));

  app.delete('/api/workbook/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return reply.status(403).send({ ok: false, error: 'forbidden', detail: 'The data workbooks cannot be deleted.' });
  });

  /* ------------------------------------------------- live updates -- */
  app.get('/api/live', async (req, reply) => {
    const who = await whoIs(cookieOf(req));
    if (!who) return reply.status(401).send({ ok: false, error: 'auth_required' });
    const ids = String((req.query as any).ids || '').split(',').filter((id) => bridge.hasBook(id)).slice(0, 10);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    for (const id of ids) {
      bridge.watch(id, res);
      res.write('data: ' + JSON.stringify({ id, v: bridge.version(id), hello: true }) + '\n\n');
    }
    const beat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 25000);
    req.raw.on('close', () => { clearInterval(beat); bridge.unwatch(res); });
  });
}
