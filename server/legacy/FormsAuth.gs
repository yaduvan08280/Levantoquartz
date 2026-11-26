/**
 * Slabworks Production Forms — users, passwords, sessions
 */

var FORMS_USER_HEADERS = ['Username', 'Display Name', 'Assigned Forms',
                    'Set Password Here', 'Password Hash', 'Active', 'Last Login',
                    'Role', 'Telegram Chat ID', 'Telegram Code'];

/* Columns 8-10 were added after the tab was already in use, so they are read
   by NAME rather than by position — an older tab that has not been migrated
   yet simply reports every user as an operator instead of throwing. */
var FORMS_USER_EXTRA = {
  role:     'Role',
  chatId:   'Telegram Chat ID',
  tgCode:   'Telegram Code'
};

/*
 * Roles
 *   admin       sees the Feedback page, the unattended list, and every form
 *   supervisor  gets grade alerts on Telegram and in the app, fills Grade Reporting
 *   operator    everything as before: their own forms, no alerts   (the default)
 *
 * A blank Role is an operator. That is deliberate: the migration below adds the
 * column to 35 existing rows, and nobody should start receiving alerts because
 * a column appeared.
 */
var FORMS_ROLES = ['admin', 'supervisor', 'operator'];

/* Opened once per execution and reused. A save used to open New Base three
   times — duplicate check, write, log — and opening a 31-tab workbook is the
   heaviest single call there is. */
var F_SS = null;
function fss_() {
  if (!F_SS) F_SS = SpreadsheetApp.openById(FORMS_CFG.SHEET_ID);
  return F_SS;
}

function fUsersSheet_() {
  var sh = fss_().getSheetByName(FORMS_CFG.USERS_TAB);
  if (!sh) throw new Error('Missing "' + FORMS_CFG.USERS_TAB +
    '" tab. Run setupUsersSheet() once from the Apps Script editor.');
  return sh;
}

function fHash_(plain) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    FORMS_CFG.PASSWORD_PEPPER + '::' + plain,
    Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

/**
 * RUN THIS ONCE from the Apps Script editor.
 * Creates the "App Users" tab, pre-filled from "Responsible Persons"
 * so every operator already has a row and the right form assignment.
 */
function setupUsersSheet() {
  var ss = fss_();
  var sh = ss.getSheetByName(FORMS_CFG.USERS_TAB);
  if (sh) {
    Logger.log('"' + FORMS_CFG.USERS_TAB + '" already exists - leaving it alone.');
    return;
  }
  sh = ss.insertSheet(FORMS_CFG.USERS_TAB);
  sh.getRange(1, 1, 1, FORMS_USER_HEADERS.length).setValues([FORMS_USER_HEADERS])
    .setFontWeight('bold').setBackground('#131211').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);

  var rows = [['admin', 'Administrator', 'ALL', 'change-me-now', '', 'YES', '']];

  // Seed from Responsible Persons: name columns B, D, F, H, J, L
  var rp = ss.getSheetByName('Responsible Persons');
  if (rp) {
    var data = rp.getDataRange().getValues();
    var seen = {};
    for (var r = 1; r < data.length; r++) {
      var formName = String(data[r][0] || '').trim();
      if (!formName) continue;
      var key = fFormKey_(formName);
      if (!key) continue;
      [1, 3, 5, 7, 9, 11].forEach(function (c) {
        var name = String(data[r][c] || '').trim();
        if (!name) return;
        var username = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (!username) return;
        if (seen[username]) {
          if (seen[username].indexOf(key) === -1) seen[username].push(key);
        } else {
          seen[username] = [key];
        }
      });
    }
    Object.keys(seen).sort().forEach(function (u) {
      rows.push([u, u.toUpperCase(), seen[u].join(','), '', '', 'YES', '']);
    });
  }

  sh.getRange(2, 1, rows.length, FORMS_USER_HEADERS.length).setValues(rows);
  sh.setColumnWidth(1, 140).setColumnWidth(2, 160).setColumnWidth(3, 260)
    .setColumnWidth(4, 160).setColumnWidth(5, 300);
  sh.getRange(2, 5, rows.length, 1).setFontSize(8).setFontColor('#999999');
  sh.getRange(1, 4).setNote(
    'Type a password here and it is hashed into "Password Hash" and cleared ' +
    'the next time that user signs in or you run hashPendingFormsPasswords().');
  hashPendingFormsPasswords();
}

function fFormKey_(title) {
  var t = String(title).toLowerCase();
  var map = {
    batching: 'batching', resin: 'resin', mixer: 'mixer', pressing: 'pressing',
    'oven in': 'ovenIn', 'oven out': 'ovenOut', vacuum: 'vacuum',
    trolley: 'trolley', trolly: 'trolley', calibration: 'calibration',
    'q.c': 'qc', 'qc': 'qc',
    dispatch: 'dispatch', despatch: 'dispatch',
    /* longest first: "summary (a" must win before a bare "summary" could */
    'summary (a': 'prodSummaryA', 'summary(a': 'prodSummaryA', 'summary a': 'prodSummaryA',
    'summary (b': 'prodSummaryB', 'summary(b': 'prodSummaryB', 'summary b': 'prodSummaryB'
  };
  for (var k in map) if (t.indexOf(k) !== -1) return map[k];
  return null;
}

/**
 * Turns anything typed in "Set Password Here" into a hash and clears the cell.
 * Runs automatically on every login attempt; you can also run it manually.
 */
function hashPendingFormsPasswords() {
  var sh = fUsersSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var rng = sh.getRange(2, 4, last - 1, 2);      // D:E
  var vals = rng.getValues();
  var changed = 0;
  for (var i = 0; i < vals.length; i++) {
    var plain = String(vals[i][0] || '').trim();
    if (plain) { vals[i][1] = fHash_(plain); vals[i][0] = ''; changed++; }
  }
  if (changed) rng.setValues(vals);
  return changed;
}

/** Set one password from the editor: setFormsPassword('shrikant', 'Slab@2026') */
function setFormsPassword(username, plain) {
  var sh = fUsersSheet_();
  var data = sh.getDataRange().getValues();
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      sh.getRange(r + 1, 5).setValue(fHash_(plain));
      sh.getRange(r + 1, 4).setValue('');
      return 'Password set for ' + data[r][0];
    }
  }
  throw new Error('No user named "' + username + '"');
}

// ---- login / sessions ------------------------------------------------------

/** Column index (0-based) of each header the user tab has, by name. */
function fUserCols_(headerRow) {
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    var n = String(headerRow[i]).trim();
    if (n && map[n] === undefined) map[n] = i;
  }
  return map;
}

function fUserFromRow_(row, rowNo, cols) {
  function ex(name) {
    var i = cols[name];
    return i === undefined ? '' : String(row[i] === undefined ? '' : row[i]).trim();
  }
  var role = ex(FORMS_USER_EXTRA.role).toLowerCase();
  if (FORMS_ROLES.indexOf(role) === -1) role = 'operator';
  return {
    row: rowNo,
    username: String(row[0]).trim(),
    display: String(row[1] || row[0]).trim(),
    assigned: String(row[2] || '').trim(),
    hash: String(row[4] || '').trim(),
    active: String(row[5] || '').trim().toUpperCase() !== 'NO',
    role: role,
    chatId: ex(FORMS_USER_EXTRA.chatId),
    tgCode: ex(FORMS_USER_EXTRA.tgCode)
  };
}

function fFindUser_(username) {
  var sh = fUsersSheet_();
  var data = sh.getDataRange().getValues();
  if (!data.length) return null;
  var cols = fUserCols_(data[0]);
  var u = String(username || '').trim().toLowerCase();
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim().toLowerCase() === u) {
      return fUserFromRow_(data[r], r + 1, cols);
    }
  }
  return null;
}

/** Everyone with a given role. Used to decide who an alert goes to. */
function fUsersByRole_(role) {
  var sh = fUsersSheet_();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var cols = fUserCols_(data[0]);
  var out = [];
  for (var r = 1; r < data.length; r++) {
    if (!String(data[r][0]).trim()) continue;
    var u = fUserFromRow_(data[r], r + 1, cols);
    if (u.active && u.role === role) out.push(u);
  }
  return out;
}

function fAssigned_(assigned) {
  if (!assigned || assigned.toUpperCase() === 'ALL') return FORM_KEYS.slice();
  var wanted = assigned.split(/[,;|]/).map(function (s) {
    return s.trim();
  }).filter(String);
  var keys = [];
  wanted.forEach(function (w) {
    if (FORM_DEFS[w]) { keys.push(w); return; }
    var k = fFormKey_(w);
    if (k && keys.indexOf(k) === -1) keys.push(k);
  });
  return keys.filter(function (k, i) { return keys.indexOf(k) === i; });
}

function fToken_() {
  return Utilities.getUuid().replace(/-/g, '') +
         Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function fSessions_() { return CacheService.getScriptCache(); }

function fSaveSession_(token, payload) {
  fSessions_().put('sess_' + token, JSON.stringify(payload),
                      Math.min(21600, FORMS_CFG.SESSION_HOURS * 3600));
  // Cache tops out at 6h; back it with Properties for longer sessions.
  PropertiesService.getScriptProperties()
    .setProperty('sess_' + token, JSON.stringify(payload));
}

function fRequireSession_(token) {
  if (!token) throw new Error('Not signed in.');
  var raw = fSessions_().get('sess_' + token);
  if (!raw) raw = PropertiesService.getScriptProperties().getProperty('sess_' + token);
  if (!raw) throw new Error('Your session expired. Please sign in again.');
  var s = JSON.parse(raw);
  if (s.exp && new Date().getTime() > s.exp) {
    api_logout(token);
    throw new Error('Your session expired. Please sign in again.');
  }
  return s;
}

function api_login(username, password) {
  hashPendingFormsPasswords();
  var u = fFindUser_(username);
  Utilities.sleep(250);                       // slows brute forcing
  if (!u || !u.active) return { ok: false, error: 'Unknown or inactive user.' };
  if (!u.hash) return { ok: false, error: 'No password set for this user yet. Ask your administrator.' };
  if (fHash_(String(password || '')) !== u.hash) return { ok: false, error: 'Wrong password.' };

  var keys = fAssigned_(u.assigned);
  if (!keys.length) return { ok: false, error: 'No forms are assigned to you yet.' };

  try { fPruneSessions_(); } catch (e) { /* housekeeping must never block a sign-in */ }
  var token = fToken_();
  fSaveSession_(token, {
    username: u.username,
    display: u.display,
    role: u.role,
    forms: keys,
    exp: new Date().getTime() + FORMS_CFG.SESSION_HOURS * 3600 * 1000
  });
  try { fUsersSheet_().getRange(u.row, 7).setValue(new Date()); } catch (e) {}

  return { ok: true, token: token,
           user: { name: u.display, username: u.username, role: u.role },
           forms: keys.map(function (k) {
             return { key: k, no: FORM_DEFS[k].no, title: FORM_DEFS[k].title, abbr: FORM_DEFS[k].abbr };
           }) };
}

/*
 * Expired sessions, swept.
 *
 * Every sign-in writes its session to Script Properties as a backstop for the
 * six-hour cache, and only Log out ever removed one, so every sign-in since
 * the app went live was still in there. That store is capped at 500 KB — past
 * it, setProperty throws and nobody can sign in — and every read of it loads
 * all of it, the Telegram poll's once a minute included.
 *
 * At most once an hour, on a sign-in. The survivors go back in ONE call
 * (setProperties with deleteAllOthers) rather than one delete per session,
 * which for a few thousand of them would be a minute-long sign-in. Under the
 * script lock, so the Telegram poll cannot write its offset in between and
 * lose it. A session with no expiry is kept; only a known-expired one goes.
 */
function fPruneSessions_() {
  var c = fSessions_();
  if (c.get('prune_sessions')) return 0;
  c.put('prune_sessions', '1', 3600);
  /* The jobs' lock: what this must not interleave with is the Telegram poll
     writing its offset, and that poll now takes the jobs' lock. */
  return fWithJobLock_(10000, function () {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties(), keep = {}, now = new Date().getTime(), gone = 0;
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('sess_') === 0) {
        var exp = 0;
        try { exp = JSON.parse(all[k]).exp || 0; } catch (e) {}
        if (exp && exp < now) { gone++; return; }
      }
      keep[k] = all[k];
    });
    if (gone) props.setProperties(keep, true);
    return gone;
  });
}

function api_logout(token) {
  fSessions_().remove('sess_' + token);
  PropertiesService.getScriptProperties().deleteProperty('sess_' + token);
  return { ok: true };
}

/** Restore a session after a page reload (tablets get logged out otherwise). */
function api_resume(token) {
  try {
    var s = fRequireSession_(token);
    return { ok: true, token: token,
             user: { name: s.display, username: s.username, role: s.role || 'operator' },
             forms: s.forms.map(function (k) {
               return { key: k, no: FORM_DEFS[k].no, title: FORM_DEFS[k].title, abbr: FORM_DEFS[k].abbr };
             }) };
  } catch (e) {
    return { ok: false };
  }
}

/* ===================================================== adding a user ===== */
/**
 * Add a user, or re-point one that already exists, without hand-editing the
 * App Users tab. The password is hashed here and never written in the clear —
 * the "Set Password Here" column stays empty.
 *
 *   addFormsUser('venkatesh', 'Venkatesh', 'dispatch', '1234')
 *
 * `forms` is a comma-separated list of form keys, or 'ALL'. The keys are the
 * ones in FORM_KEYS: batching, resin, mixer, pressing, ovenIn, ovenOut,
 * vacuum, trolley, calibration, qc, prodSummaryA, prodSummaryB, dispatch,
 * gradeReport, bag, formula, bagInvoice.
 */
function addFormsUser(username, displayName, forms, password) {
  username = String(username || '').trim().toLowerCase();
  if (!username) throw new Error('A username is required.');
  if (!password) throw new Error('A password is required.');

  var keys = String(forms || '').trim();
  if (keys.toUpperCase() !== 'ALL') {
    var bad = keys.split(/\s*,\s*/).filter(function (k) {
      return k && FORM_KEYS.indexOf(k) === -1;
    });
    if (bad.length) {
      throw new Error('Not a form key: ' + bad.join(', ') +
                      '. Valid keys: ' + FORM_KEYS.join(', '));
    }
  }

  var sh = fUsersSheet_();
  var data = sh.getDataRange().getValues();
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim().toLowerCase() === username) {
      sh.getRange(r + 1, 2).setValue(displayName || data[r][1]);
      sh.getRange(r + 1, 3).setValue(keys);
      sh.getRange(r + 1, 4).setValue('');
      sh.getRange(r + 1, 5).setValue(fHash_(password));
      sh.getRange(r + 1, 6).setValue('YES');
      console.log('Updated existing user "' + username + '" — forms: ' + keys);
      return { username: username, created: false, forms: keys };
    }
  }

  sh.appendRow([username, displayName || username.toUpperCase(), keys,
                '', fHash_(password), 'YES', '']);
  var row = sh.getLastRow();
  sh.getRange(row, 5).setFontSize(8).setFontColor('#999999');
  console.log('Created user "' + username + '" — forms: ' + keys);
  return { username: username, created: true, forms: keys };
}

/**
 * THE ONE TO RUN for the dispatch operator.
 * Creates venkatesh / 1234 with the Dispatch Form and nothing else.
 *
 * Change the password afterwards with:
 *   setFormsPassword('venkatesh', 'something-better')
 */
function createDispatchUser() {
  var r = addFormsUser('venkatesh', 'VENKATESH', 'dispatch', '1234');
  console.log('');
  console.log('Sign in as  venkatesh  /  1234');
  console.log('He sees the Dispatch Form only. To give him more, put more keys');
  console.log('in his Assigned Forms cell, comma separated, or ALL.');
  console.log('');
  console.log('1234 is four digits — change it once he has signed in:');
  console.log("  setFormsPassword('venkatesh', 'a-better-password')");
  return r;
}

/* ================================================ roles & Telegram ======= */
/**
 * RUN THIS ONCE after pushing. Adds Role, Telegram Chat ID and Telegram Code
 * to the App Users tab if they are not there.
 *
 * Appending on the right is the only write it makes: nothing is renamed,
 * reordered or overwritten, and no existing cell is touched. Every existing
 * user is left with a blank Role, which reads as "operator" — nobody starts
 * receiving alerts just because a column appeared.
 */
function setupRolesAndTelegram() {
  var sh = fUsersSheet_();
  var hdr = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  var have = {};
  hdr.forEach(function (h) { var n = String(h).trim(); if (n) have[n] = true; });

  var added = [];
  ['Role', 'Telegram Chat ID', 'Telegram Code'].forEach(function (name) {
    if (have[name]) return;
    var at = sh.getLastColumn() + 1;
    if (at > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    sh.getRange(1, at).setValue(name)
      .setFontWeight('bold').setBackground('#131211').setFontColor('#FFFFFF');
    sh.setColumnWidth(at, name === 'Role' ? 110 : 150);
    added.push(name);
  });

  var cols = fUserCols_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
  var roleCol = cols['Role'] + 1;
  sh.getRange(1, roleCol).setNote(
    'admin      — sees the Feedback page and the unattended list\n' +
    'supervisor — gets grade alerts on Telegram and in the app\n' +
    'operator   — their own forms only (this is what a blank means)');

  /* A data validation dropdown, so nobody types "Supervisor " with a space and
     quietly stops getting alerts. */
  var last = Math.max(sh.getLastRow(), 2);
  sh.getRange(2, roleCol, last - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(FORMS_ROLES, true)
      .setAllowInvalid(true).build());

  console.log(added.length ? 'Added: ' + added.join(', ')
                           : 'All three columns were already there.');
  console.log('');
  console.log('Now set Role on the people who need it:');
  console.log('  admin       you, and anyone who reviews Feedback');
  console.log('  supervisor  everyone who should be alerted on a B or C grade');
  console.log('Everyone else can stay blank — that is an operator, exactly as today.');
  console.log('');
  console.log('Then run  telegramSetup()  to connect the bot.');
  return added;
}

/**
 * The one-time code a supervisor sends to the bot so it knows who they are.
 * Short, unambiguous on a phone keypad, and stored on their row.
 */
function fTelegramCode_() {
  var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
  var out = '';
  for (var i = 0; i < 6; i++) out += abc.charAt(Math.floor(Math.random() * abc.length));
  return out;
}

/** Find the user holding this link code, or null. */
function fUserByTelegramCode_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  var sh = fUsersSheet_();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var cols = fUserCols_(data[0]);
  if (cols[FORMS_USER_EXTRA.tgCode] === undefined) return null;
  for (var r = 1; r < data.length; r++) {
    var c = String(data[r][cols[FORMS_USER_EXTRA.tgCode]] || '').trim().toUpperCase();
    if (c && c === code) return fUserFromRow_(data[r], r + 1, cols);
  }
  return null;
}

/** Write a chat id onto a user's row once they have linked. */
function fSetChatId_(rowNo, chatId) {
  var sh = fUsersSheet_();
  var cols = fUserCols_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
  if (cols[FORMS_USER_EXTRA.chatId] === undefined) return;
  sh.getRange(rowNo, cols[FORMS_USER_EXTRA.chatId] + 1).setValue(String(chatId));
}

/* ------------------------------------------- lazy column migration ------- */

/**
 * Add Role / Telegram Chat ID / Telegram Code if this tab predates them.
 *
 * setupRolesAndTelegram() does the same thing plus notes and a dropdown, but
 * it has to be run by hand from the editor. This is the version the app calls
 * for itself the first time a supervisor opens Notifications, so the feature
 * works on a tab nobody has migrated. Idempotent, and it never touches a
 * column that already exists.
 */
function fEnsureUserCols_() {
  var sh = fUsersSheet_();
  var hdr = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  var have = {};
  hdr.forEach(function (h) { var n = String(h).trim(); if (n) have[n] = true; });

  var missing = ['Role', 'Telegram Chat ID', 'Telegram Code'].filter(function (n) {
    return !have[n];
  });
  if (!missing.length) return false;

  missing.forEach(function (name) {
    var at = sh.getLastColumn() + 1;
    if (at > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    sh.getRange(1, at).setValue(name)
      .setFontWeight('bold').setBackground('#131211').setFontColor('#FFFFFF');
    sh.setColumnWidth(at, name === 'Role' ? 110 : 150);
  });
  return true;
}

/** Write (or clear) a user's one-time link code. */
function fSetTelegramCode_(rowNo, code) {
  var sh = fUsersSheet_();
  var cols = fUserCols_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
  if (cols[FORMS_USER_EXTRA.tgCode] === undefined) return;
  sh.getRange(rowNo, cols[FORMS_USER_EXTRA.tgCode] + 1).setValue(String(code || ''));
}

/** Everyone who is meant to receive alerts: supervisors and admins. */
function fAlertAudience_() {
  var sh = fUsersSheet_();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var cols = fUserCols_(data[0]);
  var out = [];
  for (var r = 1; r < data.length; r++) {
    if (!String(data[r][0]).trim()) continue;
    var u = fUserFromRow_(data[r], r + 1, cols);
    if (u.active && (u.role === 'supervisor' || u.role === 'admin')) out.push(u);
  }
  return out;
}
