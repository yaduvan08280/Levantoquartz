/**
 * The admin panel's API: users, the raw data behind every form, the audit
 * trail, import and backup. Admins only — the same accounts as the forms app,
 * with the role "admin".
 */
import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { rt, wb, run, commit, bridge } from '../app.js';
import { refreshAll } from '../store/computed.js';
import { editValue, formatDate, isEmpty, isTimeOnly } from '../store/values.js';
import { Tab } from '../store/workbook.js';
import { readXlsx } from '../importer/xlsx.js';
import { listTriggers } from '../gas/services.js';

interface Admin { username: string; display: string }

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function requireAdmin(req: FastifyRequest): Promise<Admin> {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Sign in first.');
  let s: any;
  try { s = await run('fRequireSession_', [token]); }
  catch (e: any) { throw new HttpError(401, String(e.message || e)); }
  /* The role is read from the user's row now, not from the session: taking
     admin away from someone takes effect on their very next click. */
  const u: any = rt.call('fFindUser_', [s.username]);
  if (!u || !u.active || u.role !== 'admin') throw new HttpError(403, 'This area is for administrators.');
  return { username: u.username, display: u.display };
}

/* ------------------------------------------------------------ users -- */

const USER_HEADERS = ['Username', 'Display Name', 'Assigned Forms', 'Set Password Here', 'Password Hash',
  'Active', 'Last Login', 'Role', 'Telegram Chat ID', 'Telegram Code'];

function usersTab(): Tab {
  const name = String(rt.global('FORMS_CFG').USERS_TAB);
  let t = wb.tab(name);
  if (!t) {
    t = wb.createTab(name);
    USER_HEADERS.forEach((h, i) => t!.set(1, i + 1, h));
    t.frozenRows = 1;
  }
  return t;
}

function userCols(t: Tab): Record<string, number> {
  const map: Record<string, number> = {};
  const n = Math.max(t.lastCol(), 1);
  for (let c = 1; c <= n; c++) {
    const h = String(t.get(1, c)).trim();
    if (h && map[h] === undefined) map[h] = c;
  }
  /* A tab that predates roles: add the columns rather than fail. */
  for (const h of ['Role', 'Telegram Chat ID', 'Telegram Code']) {
    if (map[h] === undefined) {
      const c = Math.max(t.lastCol(), 7) + 1;
      t.set(1, c, h);
      map[h] = c;
    }
  }
  return map;
}

function formCatalog() {
  const keys: string[] = rt.global('FORM_KEYS') || [];
  const defs: any = rt.global('FORM_DEFS') || {};
  return keys.filter((k) => defs[k]).map((k) => ({ key: k, no: defs[k].no, title: defs[k].title, abbr: defs[k].abbr }));
}

function listUsers() {
  const t = usersTab();
  const cols = userCols(t);
  const roles: string[] = rt.global('FORMS_ROLES');
  const out: any[] = [];
  for (let r = 2; r <= t.lastRow(); r++) {
    const username = String(t.get(r, 1)).trim();
    if (!username) continue;
    const assigned = String(t.get(r, 3) || '').trim();
    let role = String(t.get(r, cols['Role']) || '').trim().toLowerCase();
    if (roles.indexOf(role) === -1) role = 'operator';
    out.push({
      row: r,
      username,
      display: String(t.get(r, 2) || username).trim(),
      assigned,
      all: !assigned || assigned.toUpperCase() === 'ALL',
      forms: rt.call('fAssigned_', [assigned]) as string[],
      active: String(t.get(r, 6) || '').trim().toUpperCase() !== 'NO',
      hasPassword: !!String(t.get(r, 5) || '').trim() || !!String(t.get(r, 4) || '').trim(),
      lastLogin: t.get(r, 7) instanceof Date ? formatDate(t.get(r, 7) as Date, 'dd MMM yyyy, HH:mm') : t.display(r, 7),
      role,
      telegramLinked: !!String(t.get(r, cols['Telegram Chat ID']) || '').trim()
    });
  }
  return out;
}

function findUserRow(t: Tab, username: string): number {
  const u = String(username || '').trim().toLowerCase();
  for (let r = 2; r <= t.lastRow(); r++) {
    if (String(t.get(r, 1)).trim().toLowerCase() === u) return r;
  }
  return 0;
}

function assignedText(forms: unknown, all: unknown): string {
  if (all === true || forms === 'ALL') return 'ALL';
  const keys: string[] = rt.global('FORM_KEYS');
  const list = (Array.isArray(forms) ? forms : []).map(String).filter((k) => keys.indexOf(k) !== -1);
  if (!list.length) throw new HttpError(400, 'Choose at least one form, or "All forms".');
  return list.filter((k, i) => list.indexOf(k) === i).join(',');
}

function checkPassword(p: unknown): string {
  const s = String(p === undefined || p === null ? '' : p);
  if (s.length < 4) throw new HttpError(400, 'A password needs at least 4 characters.');
  if (s.length > 200) throw new HttpError(400, 'That password is too long.');
  return s;
}

/** Sign a user out everywhere: their open sessions carry the old forms and role. */
function dropSessions(username: string): number {
  const props: any = (globalThis as any).PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const u = username.toLowerCase();
  let n = 0;
  Object.keys(all).forEach((k) => {
    if (k.indexOf('sess_') !== 0) return;
    try {
      if (String(JSON.parse(all[k]).username || '').toLowerCase() !== u) return;
    } catch { return; }
    props.deleteProperty(k);
    rt.cache.remove(k);
    n++;
  });
  return n;
}

function activeAdmins(except?: string): number {
  return listUsers().filter((u) => u.active && u.role === 'admin' && u.username.toLowerCase() !== (except || '').toLowerCase()).length;
}

async function audit(actor: string, action: string, f: {
  tab?: string; row?: number; col?: number; old?: string; neu?: string; detail?: unknown
} = {}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log(actor, action, tab, row_no, col_no, old_val, new_val, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor, action, f.tab ?? null, f.row ?? null, f.col ?? null, f.old ?? null, f.neu ?? null,
     f.detail === undefined ? null : JSON.stringify(f.detail)]);
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof HttpError ? err.status : (err.statusCode || 500);
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ ok: false, error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on the server.' : err.message });
  });

  app.post('/api/admin/login', async (req) => {
    const b = (req.body || {}) as any;
    await new Promise((r) => setTimeout(r, 250));
    const res: any = await run('api_login', [String(b.username || ''), String(b.password || '')]);
    if (!res || !res.ok) throw new HttpError(401, (res && res.error) || 'Could not sign in.');
    if (res.user.role !== 'admin') {
      await run('api_logout', [res.token]);
      throw new HttpError(403, 'This area is for administrators.');
    }
    return { ok: true, token: res.token, user: res.user };
  });

  app.get('/api/admin/me', async (req) => ({ ok: true, user: await requireAdmin(req) }));

  app.post('/api/admin/logout', async (req) => {
    const h = String(req.headers.authorization || '');
    if (h.startsWith('Bearer ')) await run('api_logout', [h.slice(7).trim()]);
    return { ok: true };
  });

  /* ---------------------------------------------------------- overview */
  app.get('/api/admin/overview', async (req) => {
    await requireAdmin(req);
    const users = listUsers();
    const log = wb.tab(String(rt.global('FORMS_CFG').LOG_TAB || ''));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let entriesToday = 0, lastEntry = '';
    if (log) {
      for (let r = log.lastRow(); r >= 2; r--) {
        const ts = log.get(r, 1);
        if (!(ts instanceof Date)) continue;
        if (!lastEntry) lastEntry = log.display(r, 1) + ' — ' + log.display(r, 3) + ' by ' + log.display(r, 2);
        if (ts.getTime() < today.getTime()) break;
        entriesToday++;
      }
    }
    const tg: any = rt.call('fTelegramToken_', []) ? 'connected' : 'not set up';
    return {
      ok: true,
      users: { total: users.length, active: users.filter((u) => u.active).length, admins: users.filter((u) => u.active && u.role === 'admin').length },
      tabs: wb.tabs.length,
      rows: wb.tabs.reduce((n, t) => n + t.lastRow(), 0),
      entriesToday, lastEntry,
      telegram: tg,
      jobs: listTriggers(wb).map((t) => ({ handler: t.handler, everyMinutes: t.everyMinutes })),
      loadedAt: wb.loadedAt
    };
  });

  /* ------------------------------------------------------------- users */
  app.get('/api/admin/users', async (req) => {
    await requireAdmin(req);
    return { ok: true, users: listUsers(), forms: formCatalog(), roles: rt.global('FORMS_ROLES') };
  });

  app.post('/api/admin/users', async (req) => {
    const me = await requireAdmin(req);
    const b = (req.body || {}) as any;
    const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(username)) {
      throw new HttpError(400, 'A username is 2–40 letters or digits (dots, dashes and underscores allowed), no spaces.');
    }
    const password = checkPassword(b.password);
    const roles: string[] = rt.global('FORMS_ROLES');
    const role = roles.indexOf(String(b.role)) === -1 ? 'operator' : String(b.role);
    const assigned = assignedText(b.forms, b.all);
    await commit(() => {
      const t = usersTab();
      const cols = userCols(t);
      if (findUserRow(t, username)) throw new HttpError(409, 'There is already a user called "' + username + '".');
      const r = t.lastRow() + 1;
      t.set(r, 1, username);
      t.set(r, 2, String(b.display || '').trim() || username.toUpperCase());
      t.set(r, 3, assigned);
      t.set(r, 5, rt.call('fHash_', [password]) as string);
      t.set(r, 6, b.active === false ? 'NO' : 'YES');
      t.set(r, cols['Role'], role);
    });
    await audit(me.username, 'user.create', { detail: { username, role, forms: assigned } });
    return { ok: true, users: listUsers() };
  });

  app.patch('/api/admin/users/:username', async (req) => {
    const me = await requireAdmin(req);
    const target = String((req.params as any).username || '');
    const b = (req.body || {}) as any;
    const changed: Record<string, unknown> = {};
    await commit(() => {
      const t = usersTab();
      const cols = userCols(t);
      const r = findUserRow(t, target);
      if (!r) throw new HttpError(404, 'No user called "' + target + '".');
      const current = listUsers().find((u) => u.row === r)!;
      const isSelf = current.username.toLowerCase() === me.username.toLowerCase();
      const roles: string[] = rt.global('FORMS_ROLES');

      const newRole = b.role === undefined ? current.role : (roles.indexOf(String(b.role)) === -1 ? 'operator' : String(b.role));
      const newActive = b.active === undefined ? current.active : !!b.active;
      if (current.role === 'admin' && current.active && (newRole !== 'admin' || !newActive)) {
        if (isSelf) throw new HttpError(400, 'You cannot take admin access away from yourself.');
        if (activeAdmins(current.username) === 0) throw new HttpError(400, 'This is the last administrator. Make someone else an admin first.');
      }
      if (b.display !== undefined) {
        const d = String(b.display).trim();
        if (!d) throw new HttpError(400, 'The display name cannot be empty.');
        if (d !== current.display) { t.set(r, 2, d); changed.display = d; }
      }
      if (b.forms !== undefined || b.all !== undefined) {
        const a = assignedText(b.forms, b.all);
        if (a !== current.assigned) { t.set(r, 3, a); changed.forms = a; }
      }
      if (newRole !== current.role) { t.set(r, cols['Role'], newRole); changed.role = newRole; }
      if (newActive !== current.active) { t.set(r, 6, newActive ? 'YES' : 'NO'); changed.active = newActive; }
      if (b.password !== undefined && b.password !== '') {
        t.set(r, 5, rt.call('fHash_', [checkPassword(b.password)]) as string);
        t.set(r, 4, '');
        changed.password = 'changed';
      }
      if (b.unlinkTelegram) {
        t.set(r, cols['Telegram Chat ID'], '');
        t.set(r, cols['Telegram Code'], '');
        changed.telegram = 'unlinked';
      }
      /* Open sessions hold the old forms and role, so they end here. The
         admin's own session survives a change to their own name or forms. */
      if (!isSelf && (changed.forms || changed.role || changed.active !== undefined || changed.password)) {
        dropSessions(current.username);
      }
    });
    if (Object.keys(changed).length) await audit(me.username, 'user.update', { detail: { username: target, ...changed } });
    return { ok: true, users: listUsers() };
  });

  app.delete('/api/admin/users/:username', async (req) => {
    const me = await requireAdmin(req);
    const target = String((req.params as any).username || '');
    await commit(() => {
      const t = usersTab();
      const r = findUserRow(t, target);
      if (!r) throw new HttpError(404, 'No user called "' + target + '".');
      if (target.toLowerCase() === me.username.toLowerCase()) throw new HttpError(400, 'You cannot delete your own account.');
      const u = listUsers().find((x) => x.row === r)!;
      if (u.role === 'admin' && u.active && activeAdmins(u.username) === 0) {
        throw new HttpError(400, 'This is the last administrator.');
      }
      dropSessions(u.username);
      t.deleteRows(r, 1);
    });
    await audit(me.username, 'user.delete', { detail: { username: target } });
    return { ok: true, users: listUsers() };
  });

  app.get('/api/admin/audit', async (req) => {
    await requireAdmin(req);
    const q = (req.query || {}) as any;
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 200, 1), 1000);
    const before = parseInt(q.before, 10);
    const r = await pool.query(
      `SELECT id, at, actor, action, tab, row_no, col_no, old_val, new_val, detail
         FROM audit_log WHERE ($1::bigint IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
      [isFinite(before) ? before : null, limit]);
    return { ok: true, entries: r.rows };
  });

  /* ---------------------------------------------------- import / backup */
  app.post('/api/admin/import', async (req) => {
    const me = await requireAdmin(req);
    const file = await (req as any).file();
    if (!file) throw new HttpError(400, 'Choose the .xlsx file to import.');
    const buf: Buffer = await file.toBuffer();
    let parsed;
    try { parsed = await readXlsx(buf); }
    catch (e: any) { throw new HttpError(400, 'That file could not be read as an Excel workbook: ' + (e.message || e)); }
    const usersName = String(rt.global('FORMS_CFG').USERS_TAB);
    const incoming = parsed.tabs.find((t) => t.name === usersName);
    if (!incoming) throw new HttpError(400, 'The workbook has no "' + usersName + '" tab, so nobody could sign in afterwards. Nothing was imported.');
    await commit(() => {
      wb.replaceAll(parsed.tabs);
      refreshAll(wb);
    });
    rt.cache.clearData();
    bridge.reloadAll();
    /* Open dashboards must drop what they hold and load the new data. */
    try { if (rt.has('noteFullChange_')) await run('noteFullChange_', []); } catch { /* next rebuild catches up */ }
    await audit(me.username, 'import', { detail: { file: file.filename, tabs: parsed.summary } });
    return { ok: true, tabs: parsed.summary };
  });

  app.get('/api/admin/export', async (req, reply) => {
    await requireAdmin(req);
    const book = new ExcelJS.Workbook();
    const used = new Set<string>();
    for (const tab of wb.tabs) {
      const t = wb.tab(tab.name)!;
      let name = t.name.replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Sheet';
      while (used.has(name.toLowerCase())) name = name.slice(0, 28) + ' ' + (used.size + 1);
      used.add(name.toLowerCase());
      const ws = book.addWorksheet(name, {
        state: t.hidden ? 'hidden' : 'visible',
        views: t.frozenRows || t.frozenCols ? [{ state: 'frozen', ySplit: t.frozenRows, xSplit: t.frozenCols }] : []
      });
      for (let r = 1; r <= t.lastRow(); r++) {
        const src = t.rows[r - 1];
        if (!src) continue;
        for (let c = 1; c <= src.length; c++) {
          const v = src[c - 1];
          if (isEmpty(v)) continue;
          const cell = ws.getCell(r, c);
          if (v instanceof Date) {
            /* Written as the same wall-clock reading, which is what a sheet stores. */
            cell.value = isTimeOnly(v)
              ? new Date(Date.UTC(1899, 11, 30, v.getHours(), v.getMinutes(), v.getSeconds()))
              : new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds()));
            cell.numFmt = (t.format(r, c) || (isTimeOnly(v) ? 'HH:mm' : 'dd/MM/yyyy HH:mm:ss')).replace(/M/g, 'm').replace(/H/g, 'h').replace(/hh:mm/g, 'hh:mm');
          } else {
            cell.value = v as any;
            const f = t.format(r, c);
            if (f && f !== 'General' && typeof v === 'number') cell.numFmt = f;
          }
        }
      }
    }
    const buf = await book.xlsx.writeBuffer();
    const d = new Date();
    const stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="levanto-data-' + stamp + '.xlsx"');
    return Buffer.from(buf as ArrayBuffer);
  });

  app.post('/api/admin/reload', async (req) => {
    const me = await requireAdmin(req);
    await wb.flush();
    await wb.load();
    refreshAll(wb);
    rt.cache.clearData();
    bridge.reloadAll();
    await audit(me.username, 'reload');
    return { ok: true, tabs: wb.tabs.length };
  });
}
