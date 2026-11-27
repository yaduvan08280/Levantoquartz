// ============================================================
//  Mono — client auth (UI Plan v3 §2)
//  - pre-app login/register gate: the SPA does not boot until
//    /api/me succeeds (login page, invite registration, first-run
//    "create the admin account" bootstrap)
//  - one fetch interceptor for the whole app: injects the CSRF
//    header on every state-changing /api call, injects the user's
//    own AI key headers (BYOK) on AI routes, and turns a mid-work
//    401 into a session-expiry modal that PRESERVES unsaved state
//    (re-login in place, no redirect).
//  - account menu on the existing topbar avatar: username,
//    invites (admin), sign out.
// ============================================================
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const Auth = {
  user: null,
  csrf: '',
  get isAdmin() { return !!(this.user && this.user.admin); },
};
window.MonoAuth = Auth;   // non-module consumers (dashboard app.js) can read it

/* ---------- BYOK client config (browser-only storage, §7) ----------
   P22 #6: multi-key keyring. Keys live at 'mono.ai.keys' (array of
   { id, name, provider, model, base, key, createdAt }); the active
   key is a single scalar pointer at 'mono.ai.activeId' — at most one
   active, none active is valid (deterministic mode).
   loadAiConfig() keeps its old contract: it returns the ACTIVE key
   as { provider, model, base, key } or null, so the fetch
   interceptor, aiStatusLine and /api/copilot consumers need no
   changes. */
const AI_KEY = 'mono.ai';                 // legacy single slot (migrated away)
const AI_KEYRING = 'mono.ai.keys';
const AI_ACTIVE = 'mono.ai.activeId';

export function loadKeyring() { try { const a = JSON.parse(localStorage.getItem(AI_KEYRING) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
export function saveKeyring(arr) { try { localStorage.setItem(AI_KEYRING, JSON.stringify(arr || [])); } catch {} }
function activeId() { try { return localStorage.getItem(AI_ACTIVE) || ''; } catch { return ''; } }

export function addKey({ name, provider, model, base, key }) {
  const id = (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(36).slice(2));
  const ring = loadKeyring();
  ring.push({ id, name: String(name || 'Unnamed key'), provider: provider || 'openai', model: model || '', base: base || '', key: String(key || ''), createdAt: Date.now() });
  saveKeyring(ring);
  return id;
}
export function removeKey(id) {
  saveKeyring(loadKeyring().filter((k) => k.id !== id));
  if (activeId() === id) setActiveKey(null);
}
export function setActiveKey(id) {
  try { id ? localStorage.setItem(AI_ACTIVE, id) : localStorage.removeItem(AI_ACTIVE); } catch {}
}

// One-time migration: old single 'mono.ai' object → keyring entry, active.
(function migrateAiSlot() {
  try {
    const old = JSON.parse(localStorage.getItem(AI_KEY) || 'null');
    if (old && old.key && !localStorage.getItem(AI_KEYRING)) {
      const id = addKey({ name: 'Imported key', provider: old.provider, model: old.model, base: old.base, key: old.key });
      setActiveKey(id);
    }
    localStorage.removeItem(AI_KEY);
  } catch {}
})();

/** Returns the ACTIVE key as { provider, model, base, key }, or null (deterministic mode). */
export function loadAiConfig() {
  const id = activeId(); if (!id) return null;
  const e = loadKeyring().find((k) => k.id === id);
  return e ? { provider: e.provider, model: e.model, base: e.base, key: e.key } : null;
}
/** Back-compat shim: cfg → save as a new active key; null → deactivate. */
export function saveAiConfig(cfg) {
  if (cfg && cfg.key) setActiveKey(addKey({ name: 'Unnamed key', ...cfg }));
  else setActiveKey(null);
}
export function aiStatusLine() {
  const cfg = loadAiConfig();
  return cfg && cfg.key ? `AI: using your ${cfg.provider} key` : 'AI: deterministic mode — add a key from your profile menu to enable cloud AI';
}

/* ---------- fetch interceptor ---------- */
const AI_ROUTES = ['/api/copilot', '/api/chat', '/api/generate', '/api/report-narrative'];
let _patched = false;
function patchFetch() {
  if (_patched) return; _patched = true;
  const raw = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const sameOrigin = url.startsWith('/') || url.startsWith(location.origin);
    const method = (init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    if (sameOrigin && url.includes('/api/')) {
      const headers = new Headers(init.headers || (typeof input !== 'string' ? input?.headers : undefined) || {});
      if (method !== 'GET' && method !== 'HEAD' && Auth.csrf && !headers.has('x-mono-csrf')) headers.set('x-mono-csrf', Auth.csrf);
      const path = url.replace(location.origin, '').split('?')[0];
      if (AI_ROUTES.some((p) => path === p)) {
        const cfg = loadAiConfig();
        if (cfg && cfg.key) {
          headers.set('x-ai-provider', cfg.provider || 'openai');
          if (cfg.model) headers.set('x-ai-model', cfg.model);
          headers.set('x-ai-key', cfg.key);
          if (cfg.base) headers.set('x-ai-base', cfg.base);
        }
      }
      init = { ...init, headers };
      const res = await raw(input, init);
      // Session expired mid-work → modal re-login, state preserved (UI plan §2.3)
      if (res.status === 401 && Auth.user && !path.startsWith('/api/auth/')) showExpiryModal();
      return res;
    }
    return raw(input, init);
  };
}

/* ---------- boot gate ---------- */
export async function initAuth() {
  patchFetch();
  try {
    const r = await fetch('/api/me');
    if (r.ok) {
      const j = await r.json();
      Auth.user = j.user; Auth.csrf = j.csrf;
      return Auth.user;
    }
  } catch {}
  return new Promise((resolve) => renderGate(resolve));
}

function gateHTML(mode, usersExist) {
  const first = !usersExist;
  const login = `
    <form id="agForm" autocomplete="on">
      <div class="ag-row"><label>Username</label><input id="agUser" autocomplete="username" required></div>
      <div class="ag-row"><label>Password</label><input id="agPass" type="password" autocomplete="current-password" required></div>
      <div class="ag-err" id="agErr"></div>
      <button class="btn btn-primary ag-submit" type="submit">Sign in</button>
      <div class="ag-alt">Have an invite? <a href="#" id="agSwap">Create account</a></div>
    </form>`;
  const register = `
    <form id="agForm" autocomplete="on">
      ${first ? `<div class="ag-note">No accounts exist yet — this first account becomes the <b>admin</b> (that's you, Nikhil).</div>`
              : `<div class="ag-row"><label>Invite username / email</label><input id="agInvite" placeholder="the name your invite was created for"></div>`}
      <div class="ag-row"><label>Choose a username</label><input id="agUser" autocomplete="username" required><div class="ag-hint" id="agAvail"></div></div>
      <div class="ag-row"><label>Password (min 8 chars)</label><input id="agPass" type="password" autocomplete="new-password" required></div>
      <div class="ag-row"><label>Confirm password</label><input id="agPass2" type="password" autocomplete="new-password" required></div>
      <div class="ag-err" id="agErr"></div>
      <button class="btn btn-primary ag-submit" type="submit">${first ? 'Create admin account' : 'Create account'}</button>
      ${first ? '' : `<div class="ag-alt">Already have an account? <a href="#" id="agSwap">Sign in</a></div>`}
    </form>`;
  return `
    <div class="auth-gate" id="authGate">
      <div class="ag-card">
        <div class="ag-brand"><div class="logo">M</div><div><div class="ag-title">Mono</div><div class="ag-sub">invited testers only</div></div></div>
        ${mode === 'register' ? register : login}
      </div>
    </div>`;
}

function renderGate(resolve) {
  document.getElementById('authGate')?.remove();
  fetch('/api/auth/status').then((r) => r.json()).catch(() => ({ usersExist: true })).then(({ usersExist }) => {
    let mode = usersExist ? 'login' : 'register';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const draw = () => {
      host.innerHTML = gateHTML(mode, usersExist);
      const $ = (s) => host.querySelector(s);
      $('#agSwap')?.addEventListener('click', (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; draw(); });
      $('#agUser').focus();
      // inline availability check on register (UI plan §2.2)
      if (mode === 'register') {
        $('#agUser').addEventListener('blur', async () => {
          const u = $('#agUser').value.trim(); if (!u) return;
          try {
            const j = await (await fetch('/api/users/check?u=' + encodeURIComponent(u))).json();
            $('#agAvail').textContent = j.exists ? 'Taken' : 'Available';
            $('#agAvail').className = 'ag-hint ' + (j.exists ? 'bad' : 'good');
          } catch {}
        });
      }
      $('#agForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('#agErr'); err.textContent = '';
        const username = $('#agUser').value.trim(), password = $('#agPass').value;
        try {
          let r;
          if (mode === 'register') {
            if ($('#agPass2') && $('#agPass2').value !== password) { err.textContent = 'Passwords don’t match.'; return; }
            r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, invite: $('#agInvite')?.value.trim() || undefined }) });
          } else {
            r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
          }
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { err.textContent = j.error || 'Something went wrong. Try again.'; return; }
          Auth.user = j.user; Auth.csrf = j.csrf;
          host.remove();
          resolve(Auth.user);
        } catch {
          err.textContent = 'Server unreachable. Check your connection and try again.';
        }
      });
    };
    draw();
  });
}

/* ---------- session-expiry modal (state preserved) ---------- */
let _expiryOpen = false;
export function showExpiryModal() {
  if (_expiryOpen) return; _expiryOpen = true;
  const back = document.createElement('div'); back.className = 'modal-backdrop'; back.id = 'sessExpired';
  back.innerHTML = `<div class="modal" style="max-width:380px">
    <h3>Signed out</h3>
    <p class="muted" style="margin-bottom:12px">Your session expired. Sign in to continue — your unsaved work is kept in this tab.</p>
    <div class="ag-row"><label>Username</label><input id="seUser" value="${escH(Auth.user?.username || '')}"></div>
    <div class="ag-row"><label>Password</label><input id="sePass" type="password" autocomplete="current-password"></div>
    <div class="ag-err" id="seErr"></div>
    <div class="modal-actions"><button class="btn btn-primary" id="seGo">Sign in</button></div>
  </div>`;
  document.body.appendChild(back);
  back.querySelector('#sePass').focus();
  const go = async () => {
    const err = back.querySelector('#seErr'); err.textContent = '';
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: back.querySelector('#seUser').value.trim(), password: back.querySelector('#sePass').value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = j.error || 'Sign-in failed.'; return; }
      Auth.user = j.user; Auth.csrf = j.csrf;
      _expiryOpen = false; back.remove();
      toast('Signed back in — retrying your last save…');
      window.dispatchEvent(new CustomEvent('mono:reauthed'));
    } catch { err.textContent = 'Server unreachable.'; }
  };
  back.querySelector('#seGo').addEventListener('click', go);
  back.querySelector('#sePass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

/* ---------- account menu (topbar avatar) ---------- */
export function openAccountMenu(anchor) {
  document.getElementById('acctPop')?.remove();
  const el = document.createElement('div'); el.className = 'cmdbar-popover cmdbar-popover-right open'; el.id = 'acctPop';
  el.style.position = 'fixed';
  const r = anchor.getBoundingClientRect(); el.style.top = (r.bottom + 6) + 'px'; el.style.right = (innerWidth - r.right) + 'px'; el.style.left = 'auto';
  el.innerHTML = `
    <div class="cmdbar-pop-heading">Signed in as <b>${escH(Auth.user?.username || '')}</b>${Auth.isAdmin ? ' · admin' : ''}</div>
    ${Auth.isAdmin ? `<button class="cmdbar-pop-item" data-act="invites">${icon('users', { size: 14 })}<span>Invite testers…</span></button>` : ''}
    <button class="cmdbar-pop-item" data-act="apikey">${icon('key', { size: 14 })}<span>API key…</span></button>
    <button class="cmdbar-pop-item" data-act="signout">${icon('log-out', { size: 14 })}<span>Sign out</span></button>`;
  document.body.appendChild(el);
  el.querySelector('[data-act="signout"]').addEventListener('click', async () => {
    el.remove();
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    location.reload();
  });
  el.querySelector('[data-act="invites"]')?.addEventListener('click', () => { el.remove(); openInvitesDialog(); });
  el.querySelector('[data-act="apikey"]')?.addEventListener('click', () => { el.remove(); openApiKeyDialog(); });
  setTimeout(() => document.addEventListener('mousedown', function h(ev) { if (!el.contains(ev.target) && ev.target !== anchor) { el.remove(); document.removeEventListener('mousedown', h); } }), 0);
}

/* ---------- API key dialog (profile menu) — P22 #4 + #6 ----------
   Save form on top (name + provider/model/base/key → "Save key"),
   "My keys" list below; green dot marks the single active key;
   "Use" toggles activation (active → click again to deactivate). */
const PROVIDERS = [
  ['openai', 'OpenAI', 'gpt-4o-mini'],
  ['anthropic', 'Anthropic', 'claude-haiku-4-5-20251001'],
  ['gemini', 'Google Gemini', 'gemini-2.0-flash'],
  ['compatible', 'OpenAI-compatible (base URL)', ''],
];

async function testKeyReq({ provider, model, key, base }) {
  const r = await fetch('/api/ai/test-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, key, base: base || '' }),
  });
  return r.json();
}

export function openApiKeyDialog() {
  const back = document.createElement('div'); back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal" style="max-width:480px">
    <h3>AI — your API keys</h3>
    <div class="form-row"><label>Name</label><input id="aiName" placeholder="e.g. Work OpenAI" autocomplete="off"></div>
    <div class="form-grid">
      <div class="form-row"><label>Provider</label><select id="aiProv">${PROVIDERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <div class="form-row"><label>Model</label><input id="aiModel" placeholder="${escH(PROVIDERS[0][2])}"></div>
    </div>
    <div class="form-row" id="aiBaseRow" style="display:none"><label>Base URL</label><input id="aiBase" placeholder="https://your-router.example/v1"></div>
    <div class="form-row"><label>API key</label><input id="aiKey" type="password" placeholder="paste your key" autocomplete="off"></div>
    <div class="form-row"><label style="font-weight:400"><input type="checkbox" id="aiActivate" checked> Activate after saving</label></div>
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:2px">
      <button class="btn btn-primary" id="aiSave">Save key</button>
      <button class="btn btn-ghost" id="aiTest">Test key</button>
      <span class="ai-test-out" id="aiTestOut"></span>
    </div>
    <div class="set-sec">My keys</div>
    <div id="aiKeyList"></div>
    <div class="ai-status" id="aiStatus"></div>
    <div class="note">Your keys are stored in this browser only — they never leave it except with your own AI requests. You'll need to re-enter them on another device. No active key = the free deterministic engine still answers what it can.</div>
    <div class="modal-actions"><button class="btn btn-primary" id="aiClose">Done</button></div>
  </div>`;
  document.body.appendChild(back);
  const $ = (s) => back.querySelector(s);
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
  $('#aiClose').onclick = () => back.remove();

  const formCfg = () => {
    const provSel = $('#aiProv').value;
    return {
      provider: provSel === 'compatible' ? 'openai' : provSel,
      model: $('#aiModel').value.trim(),
      base: provSel === 'compatible' ? $('#aiBase').value.trim() : '',
      key: $('#aiKey').value.trim(),
    };
  };
  $('#aiProv').onchange = () => {
    $('#aiBaseRow').style.display = $('#aiProv').value === 'compatible' ? '' : 'none';
    $('#aiModel').placeholder = PROVIDERS.find(([v]) => v === $('#aiProv').value)?.[2] || 'model id';
  };

  const say = (msg, ok) => { const o = $('#aiTestOut'); o.textContent = msg; o.style.color = ok ? 'var(--ui-green,#4F9D69)' : (ok === false ? 'var(--ui-red)' : 'var(--tx-3)'); };
  const changed = () => window.dispatchEvent(new CustomEvent('mono:aiConfigChanged'));

  const renderList = () => {
    const ring = loadKeyring();
    const act = loadAiConfig();
    const actId = (() => { try { return localStorage.getItem('mono.ai.activeId') || ''; } catch { return ''; } })();
    $('#aiKeyList').innerHTML = ring.length ? ring.map((k) => `
      <div class="inv-item" data-kid="${escH(k.id)}">
        <span style="width:10px;flex:0 0 auto;color:var(--ui-green,#4F9D69)">${k.id === actId ? '●' : ''}</span>
        <span style="flex:1;min-width:0"><b>${escH(k.name)}</b> <span class="muted" style="font-size:11px">${escH(k.provider)}${k.key ? ' · …' + escH(String(k.key).slice(-4)) : ''}</span></span>
        <button class="btn btn-ghost" data-use="${escH(k.id)}" style="padding:2px 8px">${k.id === actId ? 'Deactivate' : 'Use'}</button>
        <button class="btn btn-ghost" data-test="${escH(k.id)}" style="padding:2px 8px">Test</button>
        <button class="xmini" data-del="${escH(k.id)}" title="Delete key">${icon('x', { size: 11 })}</button>
      </div>`).join('') : '<div class="muted" style="padding:6px 0">No saved keys yet — save one above.</div>';
    $('#aiStatus').textContent = aiStatusLine();
    $('#aiStatus').className = 'ai-status' + (act && act.key ? ' good' : '');
    $('#aiKeyList').querySelectorAll('[data-use]').forEach((b) => b.onclick = () => {
      setActiveKey(b.dataset.use === actId ? null : b.dataset.use);
      changed(); renderList();
    });
    $('#aiKeyList').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
      const k = ring.find((x) => x.id === b.dataset.del);
      if (!confirm(`Delete key "${k ? k.name : ''}"?`)) return;
      removeKey(b.dataset.del); changed(); renderList();
    });
    $('#aiKeyList').querySelectorAll('[data-test]').forEach((b) => b.onclick = async () => {
      const k = loadKeyring().find((x) => x.id === b.dataset.test); if (!k) return;
      say('Testing…');
      try { const j = await testKeyReq(k); j.ok ? say(`"${k.name}" works ✓ (model: ${j.model})`, true) : say(j.error || 'Key failed', false); }
      catch { say('Could not reach the server', false); }
    });
  };

  $('#aiSave').onclick = () => {
    const name = $('#aiName').value.trim();
    const cfg = formCfg();
    if (!name) { say('Give the key a name first', false); return; }
    if (!cfg.key) { say('Paste a key first', false); return; }
    const id = addKey({ name, ...cfg });
    if ($('#aiActivate').checked) setActiveKey(id);
    ['#aiName', '#aiModel', '#aiBase', '#aiKey'].forEach((s) => { $(s).value = ''; });
    say(`Saved "${name}" ✓`, true);
    changed(); renderList();
  };
  $('#aiTest').onclick = async () => {
    const cfg = formCfg();
    if (!cfg.key) { say('Paste a key first', false); return; }
    say('Testing…');
    try { const j = await testKeyReq(cfg); j.ok ? say(`Key works ✓ (model: ${j.model})`, true) : say(j.error || 'Key failed', false); }
    catch { say('Could not reach the server', false); }
  };
  renderList();
  $('#aiName').focus();
}

/* ---------- invites dialog (admin) ---------- */
export async function openInvitesDialog() {
  const back = document.createElement('div'); back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal" style="max-width:440px">
    <h3>Invite testers</h3>
    <p class="muted" style="margin-bottom:10px">Registration is invite-only. Add the username or email a tester will register with.</p>
    <div class="form-row" style="display:flex;gap:8px"><input id="invHandle" placeholder="username or email" style="flex:1"><button class="btn btn-primary" id="invAdd">Add</button></div>
    <div id="invList" class="inv-list"><span class="muted">Loading…</span></div>
    <div class="modal-actions"><button class="btn btn-primary" id="invClose">Done</button></div>
  </div>`;
  document.body.appendChild(back);
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
  back.querySelector('#invClose').onclick = () => back.remove();
  const list = back.querySelector('#invList');
  const refresh = async () => {
    try {
      const j = await (await fetch('/api/invites')).json();
      const items = (j.invites || []);
      list.innerHTML = items.length ? items.map((i) => `
        <div class="inv-item">
          <span class="mono">${escH(i.handle)}</span>
          ${i.usedBy ? `<span class="inv-used">joined as ${escH(i.usedBy)}</span>` : `<span class="inv-open">open</span><button class="xmini" data-del="${escH(i.handle)}" title="Remove invite">${icon('x', { size: 11 })}</button>`}
        </div>`).join('') : '<span class="muted">No invites yet.</span>';
      list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        await fetch('/api/invites/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); refresh();
      }));
    } catch { list.innerHTML = '<span class="muted">Could not load invites.</span>'; }
  };
  back.querySelector('#invAdd').addEventListener('click', async () => {
    const h = back.querySelector('#invHandle').value.trim(); if (!h) return;
    const r = await fetch('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: h }) });
    if (r.ok) { back.querySelector('#invHandle').value = ''; toast('Invite added for ' + h); refresh(); }
    else toast('Could not add invite');
  });
  refresh();
}

export default { initAuth, Auth, openAccountMenu, openInvitesDialog, openApiKeyDialog, loadAiConfig, saveAiConfig, aiStatusLine, showExpiryModal };
