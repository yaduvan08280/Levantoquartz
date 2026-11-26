/**
 * ============================================================================
 *  SLABWORKS — dashboard sign-in
 *  ---------------------------------------------------------------------------
 *  The dashboard signs people in with the SAME accounts as the forms app: the
 *  "App Users" tab of New Base. Only admin and supervisor may sign in; an
 *  operator (or a blank Role, which the forms app treats as operator) is
 *  refused. Which views each role does not see is CFG.ROLE_HIDE in Code.js.
 *
 *  This file only READS App Users. It never hashes a waiting password, never
 *  stamps Last Login, never touches a row: the forms app owns that tab, and
 *  two projects writing it is how a password gets lost.
 *
 *  The sign-in key is signed, not stored. It carries the username and an
 *  expiry, plus an HMAC made with a secret kept in this project's Script
 *  Properties. Nothing is saved per session, so nothing piles up. The role is
 *  NOT in the key: every request looks the user up again (cached for
 *  USER_CACHE_SECONDS), so setting Active = NO or changing Role takes effect
 *  within a couple of minutes without waiting for the key to run out.
 *
 *  To sign everybody out at once, delete the DASH_AUTH_SECRET script property.
 *
 *  Run dashAccessReport() from the editor to see who can sign in and why not.
 * ============================================================================
 */

var DASH_AUTH = {
  USERS_TAB: 'App Users',

  /* MUST be exactly FORMS_CFG.PASSWORD_PEPPER in forms/FormsConfig.js. The
     two projects hash the same passwords; change one without the other and
     nobody can sign in to the dashboard. */
  PASSWORD_PEPPER: 'CHANGE-ME-slabworks-2026',

  ROLES: ['admin', 'supervisor'],   // who may sign in at all
  SESSION_HOURS: 12,                // same as the forms app
  USER_CACHE_SECONDS: 120,          // how stale a Role / Active change can be
  MAX_FAILS: 5,                     // wrong passwords before a username is locked...
  LOCK_MINUTES: 15,                 // ...for this long
  SECRET_PROP: 'DASH_AUTH_SECRET'
};

/* Which data route belongs to which view. A role that cannot see the view is
   refused the route too, so hiding a tab also hides what feeds it. */
var DASH_ROUTE_VIEW = { prices: 'costing', savePrices: 'costing', feedback: 'feedback' };

/* ---- App Users ------------------------------------------------------------ */

/* Read the way the forms app reads it (FormsAuth.js): Username, Display Name,
   Password Hash and Active by position, Role by header name. Same columns,
   same answers, in both apps. */
function dashReadUsers_() {
  var sh = SpreadsheetApp.openById(CFG.SHEET_ID).getSheetByName(DASH_AUTH.USERS_TAB);
  if (!sh) throw new Error('Missing "' + DASH_AUTH.USERS_TAB + '" tab.');
  var data = sh.getDataRange().getValues();
  var roleCol = -1;
  for (var c = 0; c < (data[0] || []).length; c++) {
    if (String(data[0][c]).trim() === 'Role') { roleCol = c; break; }
  }
  var out = {};
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var username = String(row[0] || '').trim();
    if (!username) continue;
    var role = roleCol < 0 ? '' : String(row[roleCol] || '').trim().toLowerCase();
    if (['admin', 'supervisor', 'operator'].indexOf(role) === -1) role = 'operator';
    out[username.toLowerCase()] = {
      username: username,
      display: String(row[1] || row[0]).trim(),
      pending: String(row[3] || '').trim() !== '',   // "Set Password Here" not yet hashed
      hash: String(row[4] || '').trim(),
      active: String(row[5] || '').trim().toUpperCase() !== 'NO',
      role: role
    };
  }
  return out;
}

/* The per-request lookup. Hashes are left out of the cached copy. */
function dashUser_(username) {
  return dashUsers_()[String(username || '').trim().toLowerCase()] || null;
}

function dashUsers_() {
  var key = 'dash_users';
  var hit = cache_().get(key);
  var users = null;
  if (hit) { try { users = JSON.parse(hit); } catch (e) {} }
  if (!users) {
    var all = dashReadUsers_();
    users = {};
    Object.keys(all).forEach(function (k) {
      users[k] = { username: all[k].username, display: all[k].display,
                   active: all[k].active, role: all[k].role };
    });
    try { cache_().put(key, JSON.stringify(users), DASH_AUTH.USER_CACHE_SECONDS); } catch (e) {}
  }
  return users;
}

function dashHash_(plain) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    DASH_AUTH.PASSWORD_PEPPER + '::' + plain, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

/* ---- the signed key ------------------------------------------------------- */

function dashSecret_() {
  var props = props_();
  var s = props.getProperty(DASH_AUTH.SECRET_PROP);
  if (s) return s;
  /* Two first-ever sign-ins at the same moment must not each mint a secret. */
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    s = props.getProperty(DASH_AUTH.SECRET_PROP);
    if (!s) {
      s = Utilities.getUuid() + Utilities.getUuid();
      props.setProperty(DASH_AUTH.SECRET_PROP, s);
    }
    return s;
  } finally {
    lock.releaseLock();
  }
}

function dashSign_(body) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, dashSecret_()));
}

function dashMakeKey_(username) {
  var body = Utilities.base64EncodeWebSafe(JSON.stringify({
    u: username, exp: Date.now() + DASH_AUTH.SESSION_HOURS * 3600 * 1000
  }));
  return body + '.' + dashSign_(body);
}

/* The reply every refusal uses. auth:true tells the page to show the sign-in
   screen instead of a "could not load" error. */
function dashDenied_(msg) { return { ok: false, auth: true, error: msg }; }

/** {ok:true, user} or a dashDenied_ reply. */
function dashCheck_(key) {
  key = String(key || '');
  var dot = key.indexOf('.');
  if (!key || dot < 1) return dashDenied_('Please sign in.');
  var body = key.slice(0, dot);
  if (dashSign_(body) !== key.slice(dot + 1)) return dashDenied_('Please sign in again.');
  var claim;
  try { claim = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString()); }
  catch (e) { return dashDenied_('Please sign in again.'); }
  if (!claim || !claim.exp || Date.now() > claim.exp) {
    return dashDenied_('Your session expired. Please sign in again.');
  }
  var u = dashUser_(claim.u);
  if (!u || !u.active) return dashDenied_('This account is no longer active.');
  if (DASH_AUTH.ROLES.indexOf(u.role) === -1) {
    return dashDenied_('Dashboard access is for admins and supervisors only.');
  }
  return { ok: true, user: u };
}

function dashHidden_(role) {
  if (role === 'admin') return [];                 // admin always sees everything
  return ((CFG.ROLE_HIDE || {})[role] || []).slice();
}

function dashCanSee_(user, view) {
  return dashHidden_(user.role).indexOf(view) === -1;
}

/** What the page needs to know about whoever is signed in. */
function dashWho_(user) {
  /* names: username -> Display Name for everyone in App Users, so the slab
     pop-up can say who filled each step (rows store the username). */
  var users = dashUsers_(), names = {};
  Object.keys(users).forEach(function (k) { names[k] = users[k].display; });
  return { ok: true, user: { name: user.display, username: user.username, role: user.role },
           hide: dashHidden_(user.role), names: names };
}

/* ---- sign-in -------------------------------------------------------------- */

function dashLogin_(username, password) {
  username = String(username || '').trim();
  if (!username || !password) return { ok: false, error: 'Enter your username and password.' };

  var failKey = 'dash_fail_' + username.toLowerCase();
  var fails = Number(cache_().get(failKey) || 0);
  if (fails >= DASH_AUTH.MAX_FAILS) {
    return { ok: false, error: 'Too many wrong attempts. Try again in ' +
             DASH_AUTH.LOCK_MINUTES + ' minutes.' };
  }

  Utilities.sleep(250);                            // slows brute forcing, as the forms app does
  var u = dashReadUsers_()[username.toLowerCase()];
  var wrong = function (msg) {
    cache_().put(failKey, String(fails + 1), DASH_AUTH.LOCK_MINUTES * 60);
    return { ok: false, error: msg };
  };
  if (!u || !u.active) return wrong('Unknown or inactive user.');
  if (!u.hash) {
    return { ok: false, error: u.pending
      ? 'Your password has not been activated yet. Sign in to the forms app once, then try again.'
      : 'No password set for this user yet. Ask your administrator.' };
  }
  if (dashHash_(String(password)) !== u.hash) {
    return wrong(u.pending
      ? 'Wrong password. If your password was just changed, sign in to the forms app once first.'
      : 'Wrong password.');
  }
  if (DASH_AUTH.ROLES.indexOf(u.role) === -1) {
    return { ok: false, error: 'Dashboard access is for admins and supervisors only.' };
  }

  cache_().remove(failKey);
  var who = dashWho_(u);
  who.key = dashMakeKey_(u.username);
  return who;
}

/* ---- editor tools --------------------------------------------------------- */

/** Who can sign in to the dashboard, and why not. Run from the editor. */
function dashAccessReport() {
  var users = dashReadUsers_();
  var lines = Object.keys(users).sort().map(function (k) {
    var u = users[k];
    var why = !u.active ? 'NO  - Active is NO'
            : DASH_AUTH.ROLES.indexOf(u.role) === -1 ? 'NO  - role is ' + u.role
            : !u.hash ? 'NO  - no password hash yet' + (u.pending ? ' (sign in to the forms app once)' : '')
            : 'YES - ' + u.role + (dashHidden_(u.role).length ? ', hidden: ' + dashHidden_(u.role).join(', ') : ', sees everything');
    return u.username + ' : ' + why;
  });
  var out = lines.join('\n');
  Logger.log(out);
  return out;
}

/** Signs everybody out of the dashboard (not the forms app). */
function dashSignOutEveryone() {
  props_().deleteProperty(DASH_AUTH.SECRET_PROP);
  Logger.log('Dashboard secret reset - every dashboard sign-in is now invalid.');
}
