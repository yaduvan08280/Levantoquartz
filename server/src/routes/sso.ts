/**
 * One sign-in for the three screens.
 *
 * The forms app, the dashboard and the admin panel each keep their own
 * sign-in in the browser, as the two Apps Script apps always did. Someone who
 * has signed in to one of them is the same person in the others, so a page
 * that finds itself signed out asks here to be signed in from a sign-in the
 * browser already holds. Every rule still applies: the dashboard stays
 * admins-and-supervisors only, the admin panel admins only, and the forms app
 * shows each person their own forms.
 */
import type { FastifyInstance } from 'fastify';
import { rt, run, commit } from '../app.js';

/** Runs before the page's own scripts. `want` is the sign-in this page uses. */
export function ssoSnippet(want: 'forms' | 'dash' | 'admin'): string {
  return `<script>
(function () {
  var K = { forms: 'sw_tok', admin: 'levanto.admin.token', dash: 'slabworksKey' }, want = ${JSON.stringify(want)};
  function get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  /* Signing out of one screen signs out of all three, or the next page would
     quietly sign straight back in. */
  try {
    var remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (k) {
      remove.call(this, k);
      if (this === window.localStorage && (k === K.forms || k === K.admin || k === K.dash)) {
        remove.call(this, K.forms); remove.call(this, K.admin); remove.call(this, K.dash);
      }
    };
  } catch (e) {}
  try {
    if (get(K[want])) return;
    var forms = get(K.forms) || get(K.admin), dash = get(K.dash);
    if (!forms && !(dash && dash.key)) return;
    var x = new XMLHttpRequest();
    x.open('POST', '/api/sso', false);
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify({ want: want, token: forms || '', key: (dash && dash.key) || '' }));
    var r = JSON.parse(x.responseText || '{}');
    if (r && r.ok && r.value) localStorage.setItem(K[want], JSON.stringify(r.value));
  } catch (e) {}
})();
</script>`;
}

/**
 * Links between the screens, added to the forms app and the dashboard as
 * they are served (their files are untouched). Each person sees only the
 * screens their role may open, and a link opens in the same tab, so the
 * browser's Back button goes back to where they were.
 */
export function switcherSnippet(here: 'forms' | 'dash'): string {
  return `<script>
(function () {
  var here = ${JSON.stringify(here)}, last = null;
  var APPS = {
    forms: { url: '/', label: 'Forms app', hint: 'Enter production data', chip: 'FM', ic: '✎' },
    dash:  { url: '/dashboard', label: 'Dashboard', hint: 'Production overview and reports', chip: 'DB', ic: '▦' },
    admin: { url: '/admin/', label: 'Admin panel', hint: 'Users, raw data and backups', chip: 'AD', ic: '⚙' }
  };
  function get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function creds() {
    var d = get('slabworksKey');
    return { token: get('sw_tok') || get('levanto.admin.token') || '', key: (d && d.key) || '' };
  }
  function clear() {
    var old = document.querySelectorAll('[data-lev-switch]');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
  }
  function go(url) { return function (e) { e.preventDefault(); e.stopPropagation(); location.href = url; }; }
  function make(tag, cls, html, url) {
    var n = document.createElement(tag);
    n.className = cls; n.setAttribute('data-lev-switch', '1'); n.innerHTML = html;
    if (url) { n.type = 'button'; n.addEventListener('click', go(url), true); }
    return n;
  }
  function render(apps) {
    clear();
    var list = apps.filter(function (a) { return a !== here && APPS[a]; });
    if (!list.length) return;
    if (here === 'forms') {
      var foot = document.querySelector('.sidebar .foot'), before = document.getElementById('notifyBtnD');
      var sheet = document.querySelector('#menuSheet .sheet-body'), out = document.getElementById('mLogout');
      list.forEach(function (a) {
        var x = APPS[a];
        if (foot) foot.insertBefore(make('button', 'navitem', '<span class="chip">' + x.chip + '</span>' + x.label, x.url), before);
        if (sheet) sheet.insertBefore(make('button', 'menurow', '<b>' + x.label + '</b><i>' + x.hint + '</i>', x.url), out);
      });
    } else {
      /* Under the person's name at the foot of the menu, where the forms
         app and the admin panel have them. */
      var dfoot = document.querySelector('.side-foot'), user = document.getElementById('sideUser');
      if (!dfoot) return;
      var after = user && user.parentNode === dfoot ? user.nextSibling : dfoot.firstChild;
      list.forEach(function (a) {
        var x = APPS[a];
        dfoot.insertBefore(make('button', 'nav-item', '<span class="ic">' + x.ic + '</span> ' + x.label, x.url), after);
      });
    }
  }
  function check() {
    var c = creds(), sig = c.token + '|' + c.key;
    if (sig === last) return;
    last = sig;
    if (!c.token && !c.key) { clear(); return; }
    var x = new XMLHttpRequest();
    x.open('POST', '/api/apps', true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () {
      try { var r = JSON.parse(x.responseText || '{}'); render(r && r.ok ? r.apps : []); } catch (e) { clear(); }
    };
    x.send(JSON.stringify(c));
  }
  document.addEventListener('DOMContentLoaded', function () { check(); setInterval(check, 1500); });
})();
</script>`;
}

export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  /** Which screens this person's role may open. */
  app.post('/api/apps', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = (req.body || {}) as { token?: string; key?: string };
    let username = '';
    if (b.token) {
      try { username = String(((await run('fRequireSession_', [String(b.token)])) as any).username || ''); } catch { /* expired */ }
    }
    if (!username && b.key && rt.has('dashCheck_')) {
      const who: any = rt.call('dashCheck_', [String(b.key)]);
      if (who && who.ok) username = who.user.username;
    }
    const u: any = username ? rt.call('fFindUser_', [username]) : null;
    if (!u || !u.active) return { ok: false, apps: [] };
    const apps: string[] = [];
    if ((rt.call('fAssigned_', [u.assigned]) as string[]).length) apps.push('forms');
    const dashRoles: string[] = (rt.global('DASH_AUTH') || {}).ROLES || [];
    if (rt.has('doGet') && dashRoles.indexOf(u.role) !== -1) apps.push('dash');
    if (u.role === 'admin') apps.push('admin');
    return { ok: true, role: u.role, apps };
  });

  app.post('/api/sso', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = (req.body || {}) as { want?: string; token?: string; key?: string };
    let username = '';
    let token = '';

    /* Who is this? A forms/admin session first, else a dashboard key. */
    if (b.token) {
      try { username = String(((await run('fRequireSession_', [String(b.token)])) as any).username || ''); token = String(b.token); }
      catch { /* expired: try the other one */ }
    }
    if (!username && b.key && rt.has('dashCheck_')) {
      const who: any = rt.call('dashCheck_', [String(b.key)]);
      if (who && who.ok) username = who.user.username;
    }
    if (!username) return { ok: false };
    const u: any = rt.call('fFindUser_', [username]);
    if (!u || !u.active) return { ok: false };

    if (b.want === 'dash') {
      if (!rt.has('dashUser_')) return { ok: false };
      const du: any = rt.call('dashUser_', [u.username]);
      const roles: string[] = (rt.global('DASH_AUTH') || {}).ROLES || [];
      if (!du || !du.active || roles.indexOf(du.role) === -1) return { ok: false };
      const who: any = rt.call('dashWho_', [du]);
      return { ok: true, value: { key: rt.call('dashMakeKey_', [du.username]), user: who.user, hide: who.hide, names: who.names } };
    }

    if (b.want === 'admin' && u.role !== 'admin') return { ok: false };
    if (token) return { ok: true, value: token };

    /* Came in on a dashboard key: open a forms session for the same person. */
    const forms: string[] = rt.call('fAssigned_', [u.assigned]) as string[];
    if (!forms.length) return { ok: false };
    const fresh = await commit(() => {
      const t = rt.call('fToken_', []) as string;
      const hours = Number(rt.global('FORMS_CFG').SESSION_HOURS) || 12;
      rt.call('fSaveSession_', [t, {
        username: u.username, display: u.display, role: u.role, forms, exp: Date.now() + hours * 3600 * 1000
      }]);
      return t;
    });
    return { ok: true, value: fresh };
  });
}
