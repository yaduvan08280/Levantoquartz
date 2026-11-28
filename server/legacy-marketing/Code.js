/**
 * Domestic Marketing — web app entry, auth and API.
 * Every public function takes the session token first; the browser calls them via google.script.run.
 */

var APP_REV = 2; // bump when setup() must re-run on existing installs

/* ================================================================ web */

function doGet(e) {
  var P = PropertiesService.getScriptProperties(), schema = schema_();
  if (!P.getProperty('SECRET') || P.getProperty('SCHEMA') !== schema) { // first run, or new columns after an update
    var l = LockService.getScriptLock(); l.waitLock(30000);
    try { if (!P.getProperty('SECRET') || P.getProperty('SCHEMA') !== schema) setup(); } finally { l.releaseLock(); }
  }
  try {
    var url = ScriptApp.getService().getUrl();
    if (url && /\/exec$/.test(url) && P.getProperty('APP_URL') !== url) P.setProperty('APP_URL', url);
  } catch (err) {}
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Domestic Marketing')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }
function schema_() { return Object.keys(T).map(function (t) { return T[t].cols.length; }).join('.') + '.' + APP_REV; }

var _build = null;
function buildId_() {
  return _build || (_build = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, sharedJs_() + include('App') + include('Styles'))).slice(0, 12));
}
/** Shared definitions + maths, injected into the page so client and server agree. */
function sharedJs_() {
  return 'var DEF=' + JSON.stringify(DEF) + ';\n' + geoDist.toString() + '\n' + rateSegment.toString() + '\n' + custPriority.toString() + '\n' + leadOf.toString() + '\n' + [stepLabel, whoOf, reqOf, answersOf, tileOf, canDoStep, creditMax, termsFor, toSqft, orderMoney, lineAmt, slipRows].map(String).join('\n') + '\n' + orderPath.toString() + '\n' + orderStage.toString() + '\n' + creditDays.toString() + '\n';
}
function appUrl_() {
  return PropertiesService.getScriptProperties().getProperty('APP_URL') || (function () { try { return ScriptApp.getService().getUrl(); } catch (e) { return ''; } })();
}

/* ================================================================ setup */

/** Run once from the editor (Run ▸ setup). Safe to re-run: it only adds what is missing. */
function setup() {
  var P = PropertiesService.getScriptProperties();
  var id = P.getProperty('SHEET_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) ss = SpreadsheetApp.getActive();
  if (!ss) ss = SpreadsheetApp.create('Domestic Marketing — Database');
  P.setProperty('SHEET_ID', ss.getId());
  _ss = ss;
  try { ss.setSpreadsheetTimeZone(TZ); } catch (e) {}

  Object.keys(T).forEach(function (t) {
    renameHeaders_(T[t].sheet);
    var sh = ensureSheet_(T[t].sheet, T[t].cols.map(function (c) { return c[1]; }), true);
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], txt = [], dts = [];
    T[t].cols.forEach(function (c) {
      var i = hdr.indexOf(c[1]); if (i < 0) return;
      var a = colA1_(i + 1) + '2:' + colA1_(i + 1);
      if (c[2] === 's' || c[2] === 'j') txt.push(a); else if (c[2] === 'd') dts.push(a);
    });
    if (txt.length) sh.getRangeList(txt).setNumberFormat('@'); // mobiles keep leading zeros
    if (dts.length) sh.getRangeList(dts).setNumberFormat('dd-mmm-yyyy hh:mm');
  });
  try { // the app keeps the Orders sheet right; a hand edit there can skip a step → warn whoever tries
    var osh = sheet_(T.orders.sheet);
    if (osh && !osh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) osh.protect().setDescription('Orders are changed in the Domestic Marketing app — editing here can break the order steps.').setWarningOnly(true);
  } catch (e) {}
  renameHeaders_(SH_RATES);
  ensureSheet_(SH_RATES, RATE_COLS, true).getRange('A:A').setNumberFormat('dd-mmm-yyyy hh:mm');
  ensureSheet_(SH_LOG, LOG_COLS).getRange('A:A').setNumberFormat('dd-mmm-yyyy hh:mm:ss');
  ensureSheet_(SH_CFG, ['Key', 'Value (JSON)']);
  ensureSheet_(SH_PAY, PAY_COLS).getRange('A:A').setNumberFormat('dd-mmm-yyyy hh:mm');
  ensureSheet_(SH_NLOG, NLOG_COLS).getRange('A:A').setNumberFormat('dd-mmm-yyyy hh:mm');
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (!P.getProperty('SECRET')) P.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  reloadAll_();

  if (!load_('users').length) {
    save_('users', [newUserObj_('admin', 'Admin', 'admin', 'Admin@123', '')]);
  }
  var cfg = loadCfg_();
  if (!cfg.lists) setCfg_('lists', DEF.defaults.lists);
  if (!cfg.settings) setCfg_('settings', DEF.defaults.settings);
  uploadFolder_();
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'onSheetChange') ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  } catch (e) {}
  installNotifyTrigger_();
  bumpVersion_();
  P.setProperties({ FULL: String(Date.now()), SCHEMA: schema_() });
  return 'Domestic Marketing is ready. Deploy ▸ New deployment ▸ Web app.';
}

function ensureSheet_(name, headers, appendMissing) {
  var ss = ss_(), sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (appendMissing) {
    var have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var miss = headers.filter(function (h) { return have.indexOf(h) < 0; });
    if (miss.length) {
      if (sh.getMaxColumns() < have.length + miss.length) sh.insertColumnsAfter(sh.getMaxColumns(), have.length + miss.length - sh.getMaxColumns());
      sh.getRange(1, have.length + 1, 1, miss.length).setValues([miss]);
    }
  }
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#232220').setFontColor('#F2C14E').setWrap(true);
  sh.setFrozenRows(1);
  return sh;
}
function renameHeaders_(name) {
  var map = RENAMED[name], sh = ss_().getSheetByName(name);
  if (!map || !sh || sh.getLastRow() === 0) return;
  var r = sh.getRange(1, 1, 1, sh.getLastColumn()), hdr = r.getValues()[0], changed = false;
  hdr = hdr.map(function (h) { if (map[h] && hdr.indexOf(map[h]) < 0) { changed = true; return map[h]; } return h; });
  if (changed) r.setValues([hdr]);
}
function colA1_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function uploadFolder_() {
  var P = PropertiesService.getScriptProperties(), id = P.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var f = DriveApp.createFolder('Domestic Marketing — Uploads');
  P.setProperty('FOLDER_ID', f.getId());
  return f;
}

/** Someone edited the sheet by hand → drop caches so every app reloads it. */
function onEdit(e) {
  try {
    var n = e && e.range && e.range.getSheet().getName();
    var mine = Object.keys(T).map(function (t) { return T[t].sheet; }).concat([SH_CFG]);
    if (mine.indexOf(n) >= 0) reloadAll_();
  } catch (err) {}
}
function onSheetChange(e) { try { if (!e || e.changeType !== 'EDIT') reloadAll_(); } catch (err) {} }

/* ================================================================ auth */

function hash_(pw, salt) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8));
}
function newUserObj_(username, name, role, pw, mobile) {
  var salt = Utilities.getUuid().slice(0, 12);
  return { id: 'U' + Utilities.getUuid().slice(0, 8).toUpperCase(), username: username.toLowerCase(), name: name, role: role,
    mobile: mobile || '', areas: '', active: true, mustChange: true, passHash: hash_(pw, salt), salt: salt, createdAt: Date.now() };
}
function sign_(s) {
  var sec = PropertiesService.getScriptProperties().getProperty('SECRET');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, sec)).replace(/=+$/, '');
}
function makeToken_(u) {
  var exp = Date.now() + 30 * 864e5, body = u.id + '.' + exp;
  return body + '.' + sign_(body + '.' + String(u.passHash).slice(0, 10));
}
function auth_(token) {
  var p = String(token || '').split('.');
  if (p.length !== 3 || Number(p[1]) < Date.now()) throw new Error('AUTH');
  var u = find_('users', p[0]);
  if (!u || !u.active) throw new Error('AUTH');
  if (sign_(p[0] + '.' + p[1] + '.' + String(u.passHash).slice(0, 10)) !== p[2]) throw new Error('AUTH');
  return u;
}
function isAdmin_(u) { return u.role === 'admin'; }
function isBoss_(u) { return u.role === 'admin' || u.role === 'manager'; }
function need_(ok, msg) { if (!ok) throw new Error(msg || 'You are not allowed to do this.'); }

function withLock_(fn) {
  var l = LockService.getScriptLock();
  if (!l.tryLock(25000)) throw new Error('Server is busy — please try again.');
  try {
    _mem = {};
    var r = fn();
    flushLog_();
    SpreadsheetApp.flush();
    return r;
  } catch (e) { _logBuf = []; throw e; }
  finally { l.releaseLock(); }
}

/* ================================================================ session API */

function login(username, password) {
  var u = userByName_(username);
  if (!u || !u.active || hash_(String(password || ''), u.salt) !== u.passHash) throw new Error('Invalid username or password.');
  var token = makeToken_(u);
  return { token: token, boot: boot(token) };
}

/** App open. With `since` (browser already has a cached snapshot) only the delta is returned. */
function boot(token, since) {
  var u = auth_(token);
  return since ? sync(token, since) : payload_(u, true);
}

/** Cheap poll: returns nothing heavy if nothing changed since `since`. */
function sync(token, since) {
  var u = auth_(token), P = PropertiesService.getScriptProperties(), now = Date.now(); // stamp BEFORE reading VER
  var ver = Number(P.getProperty('VER') || 0), full = Number(P.getProperty('FULL') || 0);
  since = Number(since) || 0;
  if (ver && ver < since) return { same: true, now: now };
  if (full >= since) return payload_(u, true);
  return payload_(u, false, since);
}

function payload_(u, full, since) {
  var now = Date.now(), cut = now - DEF.visitDays * 864e5, boss = isBoss_(u);
  var fresh = function (o) { return full || (o.updatedAt || 0) >= since - 60000; }; // 60s overlap: updatedAt stamped before a slow write finishes
  var mine = function (v) { return boss || v.userId === u.id; };
  return {
    full: !!full, now: now,
    me: { id: u.id, username: u.username, name: u.name, role: u.role, mobile: u.mobile || '', mustChange: !!u.mustChange },
    users: load_('users').map(publicUser_),
    lists: getLists_(), settings: getSettings_(), forms: getForms_(), callForms: getCallForms_(),
    cust: load_('cust').filter(fresh),
    visits: load_('visits').filter(function (v) { return mine(v) && fresh(v) && (!full || (v.at || 0) >= cut); }),
    calls: load_('calls').filter(function (l) { return mine(l) && fresh(l) && (!full || (l.at || 0) >= cut); }),
    orders: load_('orders').filter(function (o) { return (boss || o.byId === u.id || stepPerson_(u)) && fresh(o); }),
    prod: load_('prod').filter(function (p) { return (boss || p.active) && fresh(p); }),
    url: appUrl_(), build: buildId_()
  };
}

/** Older visits for a date range (Analytics / Audit). Executives only get their own. */
function getVisitsRange(token, from, to) {
  var u = auth_(token);
  from = Number(from) || 0; to = Number(to) || Date.now();
  return load_('visits').filter(function (v) { return (isBoss_(u) || v.userId === u.id) && v.at >= from && v.at < to; });
}

/* ================================================================ helpers */

function str_(v, max) { v = String(v == null ? '' : v).trim(); return max ? v.slice(0, max) : v; }
function num_(v) { if (v === '' || v == null) return ''; var n = Number(String(v).replace(/[,₹\s]/g, '')); return isNaN(n) ? '' : n; }
function https_(v) { v = str_(v); if (!v) return ''; need_(/^https:\/\/\S+$/.test(v), 'Links must start with https://'); return v; } // blocks javascript: links (stored XSS)
function oneOf_(v, list, what) { v = str_(v); if (!v) return ''; need_(list.indexOf(v) >= 0, 'Pick a valid ' + what + '.'); return v; }
function uid_(prefix) { return prefix + Date.now().toString(36).toUpperCase() + Utilities.getUuid().slice(0, 4).toUpperCase(); }

/** Clean the {brand, product, rate} rows the executive typed. */
function cleanRates_(list) {
  return (Array.isArray(list) ? list : []).map(function (r) {
    return { brand: str_(r.brand, 60), product: str_(r.product, 80), thk: str_(r.thk, 20), rate: num_(r.rate) };
  }).filter(function (r) { return r.brand && r.rate !== '' && r.rate > 0; }).slice(0, 30);
}
function cleanMedia_(list) {
  return (Array.isArray(list) ? list : []).map(function (m) {
    return { url: https_(m.url), type: m.type === 'video' ? 'video' : 'photo', tag: str_(m.tag, 30), takenAt: Number(m.takenAt) || '',
      lat: num_(m.lat), lng: num_(m.lng), name: str_(m.name, 120) };
  }).filter(function (m) { return m.url; }).slice(0, 20);
}

var DAY_MS = 864e5;
function dayKey_(ms) { return Utilities.formatDate(new Date(Number(ms)), TZ, 'yyyyMMdd'); }
function fmtDay_(ms) { return Utilities.formatDate(new Date(Number(ms)), TZ, 'dd MMM yyyy'); }
/** A planned date from the browser (local midnight). Must not be before today (1.5-day slack for time zones). */
function planDate_(v, what) {
  var t = Number(v);
  need_(t > 0, 'Pick the ' + what + '.');
  need_(t >= Date.now() - 1.5 * DAY_MS, 'The ' + what + ' cannot be in the past.');
  need_(t <= Date.now() + 400 * DAY_MS, 'The ' + what + ' is too far ahead.');
  return t;
}
function mobile10_(m) { var d = String(m || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }

/** Customer fields an executive may fill / change. */
function applyCustBasics_(c, d, isNew) {
  ['shop', 'contact', 'city', 'area', 'address', 'notes'].forEach(function (k) { if (d[k] !== undefined) c[k] = str_(d[k], k === 'notes' || k === 'address' ? 1000 : 120); });
  if (d.mobile !== undefined && str_(d.mobile) !== (c.mobile || '')) {
    c.mobile = str_(d.mobile, 20);
    need_(!c.mobile || mobile10_(c.mobile), 'Mobile number needs at least 10 digits.');
  }
  if (d.type !== undefined && str_(d.type) !== (c.type || '')) c.type = oneOf_(d.type, getLists_().categories, 'category');
  if (d.potential !== undefined && d.potential !== '') c.potential = oneOf_(d.potential, DEF.potential, 'potential');
  need_(c.shop, 'Customer / firm name is required.');
  need_(c.type, 'Pick the customer category.');
  need_(c.city || c.area, 'City or area is required.');
  if (isNew) need_(mobile10_(c.mobile), 'Mobile number is required (10 digits).');
}

/**
 * The category's extra questions → {key: value}. A dropdown value no longer in the list is kept only if it was already saved.
 * strict: required questions must be answered.
 */
function cleanFields_(cat, input, prev, strict, forms) {
  var defs = (forms || getForms_())[cat] || [], out = {};
  input = input || {}; prev = prev || {};
  defs.forEach(function (f) {
    var v = input[f.k];
    if (v === undefined) v = prev[f.k];
    if (f.t === 'multi') {
      v = (Array.isArray(v) ? v : String(v == null ? '' : v).split(',')).map(function (x) { return str_(x, 80); })
        .filter(function (x) { return x && ((f.o || []).indexOf(x) >= 0 || (Array.isArray(prev[f.k]) && prev[f.k].indexOf(x) >= 0)); });
      if (!v.length) v = '';
    } else if (f.t === 'number') v = num_(v);
    else if (f.t === 'date') v = Number(v) || '';
    else if (f.t === 'select' || f.t === 'yesno') {
      v = str_(v, 120);
      var allowed = f.t === 'yesno' ? ['Yes', 'No'] : (f.o || []);
      if (v && allowed.indexOf(v) < 0) need_(v === prev[f.k], 'Pick a valid answer for “' + f.l + '”.');
    } else v = str_(v, 300);
    if (strict && f.r) need_(v !== '', '“' + f.l + '” is required for ' + cat + '.');
    if (v !== '') out[f.k] = v;
  });
  return out;
}
/** Readable copy of the answers for the sheet: "Label: value; Label: value". */
function fieldsText_(cat, fields, forms) {
  return ((forms || getForms_())[cat] || []).filter(function (f) { return fields[f.k] !== undefined; }).map(function (f) {
    var v = fields[f.k];
    return f.l + ': ' + (Array.isArray(v) ? v.join(', ') : f.t === 'date' ? fmtDay_(v) : v);
  }).join('; ');
}

/** An existing customer with the same mobile, or the same name in the same area. */
function dupOf_(c) {
  var mob = mobile10_(c.mobile), nm = str_(c.shop).toUpperCase(), ar = str_(c.area || c.city).toUpperCase(), byName = null;
  var list = load_('cust');
  for (var i = 0; i < list.length; i++) {
    var x = list[i];
    if (x.id === c.id || x.deleted) continue;
    if (mob && mobile10_(x.mobile) === mob) return { c: x, by: 'mobile' };
    if (!byName && String(x.shop).toUpperCase() === nm && String(x.area || x.city || '').toUpperCase() === ar) byName = x;
  }
  return byName ? { c: byName, by: 'name' } : null;
}
function redFlagText_(x) {
  return '🚩 “' + x.shop + '” (' + (x.area || x.city || '') + ') was marked NOT WORTH IT by ' + (x.closedBy || '?') + (x.closedAt ? ' on ' + fmtDay_(x.closedAt) : '') +
    (x.closeReason ? ': ' + x.closeReason : '') + '.';
}

/** Rates → customer summary (avg / min / max of the latest rates seen at the shop). */
function applyRates_(c, rates) {
  c.rates = rates;
  var nums = rates.map(function (r) { return r.rate; });
  c.avgRate = Math.round(nums.reduce(function (a, b) { return a + b; }, 0) / nums.length);
  c.minRate = Math.min.apply(null, nums); c.maxRate = Math.max.apply(null, nums);
}

/* ================================================================ visits */

/**
 * One customer visit. GPS is required; photos/videos are already uploaded (their links come in d.media).
 * The visit is checked against the customer's map pin. Anything that looks wrong is flagged for the boss (the visit is still saved).
 * d.leadResult closes the loop on the lead: WORKING (needs the next visit date), WON, or DEAD (red flag, with a reason).
 */
function saveVisit(token, d) {
  var u = auth_(token), S = getSettings_(), L = getLists_(), now = Date.now();
  var lat = num_(d.lat), lng = num_(d.lng), acc = num_(d.acc);
  var office = isBoss_(u) && (lat === '' || lng === ''); // admin / manager logging details from anywhere
  if (office) { lat = ''; lng = ''; acc = ''; }
  else need_(lat !== '' && lng !== '' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180, 'Location is required — allow GPS on your phone and try again.');
  need_(d.custId, 'Pick the customer. New customer? Add it first with “+ Add customer”.');
  var rates = cleanRates_(d.rates), media = cleanMedia_(d.media);
  var outcome = oneOf_(d.outcome, DEF.outcomes, 'outcome');
  need_(outcome, 'Pick what happened at the visit.');
  var result = str_(d.leadResult);
  need_(DEF.leadResult[result], 'Pick the lead result: keep working, successful, or not worth it.');
  var reason = str_(d.resultReason, 200), next = '';
  if (result === 'DEAD') need_(reason, 'Say why this customer is not worth it — other executives will see it.');
  if (result === 'WORKING') next = planDate_(d.nextFollow, 'next visit date');
  else if (result === 'WON' && d.nextFollow) next = planDate_(d.nextFollow, 'next visit date');
  var at = office ? now : Number(d.at) || now;
  need_(at <= now + 10 * 60000 && at > now - 24 * 3600e3, 'The GPS fix is too old — capture the location again.');
  return withLock_(function () {
    var c = liveCust_(String(d.custId));
    need_(leadOf(c) !== 'DEAD' || isBoss_(u), redFlagText_(c) + ' A manager must reopen it before anyone visits again.');
    var isFirst = !Number(c.visits);

    // ---- anti-cheat checks (against the customer's pin) — not for office entries by admin / manager
    var flags = [], dist = '';
    if (!office) {
    if (c.lat !== undefined && c.lat !== '') {
      dist = geoDist(lat, lng, c.lat, c.lng);
      if (dist !== null && dist > Number(S.gpsRadius)) flags.push('FAR');
    }
    if (acc !== '' && acc > Number(S.gpsMaxAcc)) flags.push('LOW_ACC');
    if (!media.some(function (m) { return m.type === 'photo'; })) flags.push('NO_PHOTO');
    if (media.some(function (m) { return m.takenAt && m.takenAt < at - Number(S.mediaMaxAge) * 60000; })) flags.push('OLD_MEDIA');
    if (d.deviceNow && Math.abs(Number(d.deviceNow) - now) > 10 * 60000) flags.push('CLOCK');
    var prev = load_('visits').filter(function (v) { return v.userId === u.id && v.at < at && v.at > at - 12 * 3600e3; })
      .sort(function (a, b) { return b.at - a.at; })[0];
    if (prev) {
      var km = (geoDist(lat, lng, prev.lat, prev.lng) || 0) / 1000, hrs = Math.max((at - prev.at) / 3600e3, 1 / 60);
      if (km > 1 && km / hrs > Number(S.maxSpeed)) flags.push('FAST');
    }
    }

    // ---- was this visit on the plan?
    var plan = 'Not planned';
    if (c.nextFollow) {
      var pk = dayKey_(c.nextFollow), vk = dayKey_(at);
      plan = pk === vk ? 'On plan' : pk < vk ? 'Late (planned ' + fmtDay_(c.nextFollow) + ')' : 'Early (planned ' + fmtDay_(c.nextFollow) + ')';
    }

    var v = {
      id: nextId_('V', 'V', 6), at: at, serverAt: now, userId: u.id, userName: u.name, custId: c.id, shop: c.shop, category: c.type || '', city: c.city || '', area: c.area || '', newShop: isFirst,
      plan: plan, source: office ? 'OFFICE' : 'GPS', lat: lat, lng: lng, acc: acc, dist: dist === null ? '' : dist,
      outcome: outcome, leadResult: result, resultReason: reason, interest: oneOf_(d.interest, DEF.interest, 'interest level'),
      brands: (Array.isArray(d.brands) ? d.brands : []).map(function (b) { return str_(b, 60); }).filter(String).join(', '),
      rates: rates, notes: str_(d.notes, 2000), nextFollow: next,
      standRec: oneOf_(d.standRec, ['Yes', 'No'], 'stand recommendation'), standRecReason: str_(d.standRecReason, 200),
      media: media, photo: (media.filter(function (m) { return m.type === 'photo'; })[0] || {}).url || '',
      mediaLinks: media.map(function (m) { return m.url; }).join('\n'), flags: flags.join(','), verify: 'PENDING'
    };
    if (office) { v.verify = 'OK'; v.verifyBy = u.name; v.verifyAt = now; v.verifyNote = 'Office entry by ' + DEF.roles[u.role] + ' — no location'; }

    // ---- customer summary
    if (!office && (c.lat === undefined || c.lat === '')) { if (acc === '' || acc <= Number(S.gpsMaxAcc) * 1.5) { c.lat = lat; c.lng = lng; c.locAt = now; c.locSrc = 'GPS on first visit'; } }
    if (d.fields) { c.fields = cleanFields_(c.type, d.fields, c.fields, result !== 'DEAD'); c.details = fieldsText_(c.type, c.fields); }
    if (v.brands) c.brands = v.brands;
    if (rates.length) applyRates_(c, rates);
    if (v.interest) c.interest = v.interest;
    if (d.potential) c.potential = oneOf_(d.potential, DEF.potential, 'potential');
    if (!c.photo && v.photo) c.photo = v.photo;
    c.visits = (Number(c.visits) || 0) + 1; c.lastVisit = at; c.lastVisitBy = u.name;
    c.nextFollow = next;
    c.status = result;
    if (result === 'WORKING') { c.closeReason = ''; c.closedBy = ''; c.closedAt = ''; }
    else { c.closeReason = reason; c.closedBy = u.name; c.closedAt = now; }
    if (!c.ownerId) { c.ownerId = u.id; c.ownerName = u.name; }
    if (v.standRec && (!c.standStatus || c.standStatus === 'UNDECIDED')) { c.standRec = v.standRec; c.standRecReason = v.standRecReason; c.standRecBy = u.name; }

    save_('cust', [c]);
    save_('visits', [v]);
    appendRates_(rates.map(function (r) { return [new Date(at), v.id, c.id, c.shop, c.city || '', c.area || '', r.brand, r.product, r.rate, S.rateUnit, u.name, r.thk || '']; }));
    log_('VISIT', v.id, u, (office ? '[office entry] ' : '') + c.shop + ' · ' + outcome + ' · ' + DEF.leadResult[result] + (reason ? ' (' + reason + ')' : '') + (flags.length ? ' · flags: ' + flags.join(',') : ''));
    return { visit: v, cust: c };
  });
}

/** Boss marks a visit Verified / Rejected after looking at the photos and the map. */
function verifyVisit(token, id, verdict, note) {
  var u = auth_(token);
  need_(isBoss_(u), 'Only admin or manager can review visits.');
  need_(['OK', 'BAD', 'PENDING'].indexOf(verdict) >= 0, 'Bad review value.');
  if (verdict === 'BAD') need_(str_(note), 'Say why the visit is rejected.');
  return withLock_(function () {
    var v = get_('visits', id, 'Visit');
    v.verify = verdict; v.verifyBy = u.name; v.verifyAt = Date.now(); v.verifyNote = str_(note, 500);
    save_('visits', [v]);
    log_('REVIEW', v.id, u, DEF.verify[verdict] + (note ? ' — ' + note : ''));
    return { visit: v };
  });
}

/** Many visits at once ("verify all clean visits of this day"). */
function verifyMany(token, ids) {
  var u = auth_(token);
  need_(isBoss_(u), 'Only admin or manager can review visits.');
  return withLock_(function () {
    var list = load_('visits').filter(function (v) { return ids.indexOf(v.id) >= 0 && v.verify === 'PENDING'; }), now = Date.now();
    list.forEach(function (v) { v.verify = 'OK'; v.verifyBy = u.name; v.verifyAt = now; });
    save_('visits', list);
    log_('REVIEW', '', u, list.length + ' visits verified');
    return { visits: list };
  });
}

/** Use this visit's GPS point as the shop's true location (e.g. the first one was taken across the road). */
function setShopLocation(token, visitId) {
  var u = auth_(token);
  need_(isBoss_(u), 'Only admin or manager can move a customer pin.');
  return withLock_(function () {
    var v = get_('visits', visitId, 'Visit'), c = liveCust_(v.custId);
    c.lat = v.lat; c.lng = v.lng; c.locAt = Date.now(); c.locSrc = 'Moved by ' + u.name + ' to visit ' + v.id;
    save_('cust', [c]);
    log_('LOCATION', c.id, u, 'Pin moved to visit ' + v.id);
    return { cust: c };
  });
}

function deleteVisit(token, id, reason) {
  var u = auth_(token);
  need_(isAdmin_(u), 'Only admin can delete a visit.');
  return softDelete_('visits', id, u, reason, 'Visit');
}

/* ================================================================ customers & stands */

/**
 * Add / edit a customer (= a lead).
 * New: category, name, mobile, city, map pin and the first visit date are required. The visit date is locked once saved
 * (change it only with rescheduleVisit + a reason). The pin can be moved by the executive only until the first visit.
 * Same mobile / same name in the same area is caught; a red-flagged one blocks executives from adding it again.
 */
function saveCustomer(token, d) {
  var u = auth_(token), boss = isBoss_(u), now = Date.now();
  return withLock_(function () {
    var isNew = !d.id, c;
    if (isNew) c = { id: '', createdAt: now, createdBy: u.name, ownerId: u.id, ownerName: u.name, standStatus: 'UNDECIDED', visits: 0, status: 'NEW' };
    else {
      c = liveCust_(String(d.id));
      need_(boss || leadOf(c) !== 'DEAD', redFlagText_(c) + ' Only a manager can change it.');
    }
    var mobBefore = c.mobile || '';
    applyCustBasics_(c, d, isNew);
    c.fields = cleanFields_(c.type, d.fields, d.fields ? (c.fields || {}) : c.fields, d.fields !== undefined);
    c.details = fieldsText_(c.type, c.fields);

    // map pin
    var lat = num_(d.lat), lng = num_(d.lng);
    if (lat !== '' && lng !== '') {
      need_(Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng), 'That map location is not valid.');
      var hadPin = c.lat !== undefined && c.lat !== '';
      if (!hadPin || geoDist(lat, lng, c.lat, c.lng) > 0) {
        need_(!hadPin || boss || !Number(c.visits), 'The pin is locked after the first visit. Ask a manager to move it.');
        c.lat = lat; c.lng = lng; c.locAt = now; c.locSrc = d.locSrc === 'gps' ? 'GPS at the customer' : 'Placed on map';
      }
    }
    if (isNew) {
      need_(boss || (c.lat !== undefined && c.lat !== ''), 'Mark the customer on the map.');
      c.nextFollow = planDate_(d.nextFollow, 'first visit date');
    }

    if (boss) {
      if (d.priorityManual !== undefined) c.priorityManual = oneOf_(d.priorityManual, ['A', 'B', 'C'], 'priority');
      if (d.ownerId !== undefined) {
        var o = d.ownerId ? find_('users', d.ownerId) : null;
        c.ownerId = o ? o.id : ''; c.ownerName = o ? o.name : '';
      }
    }
    if (d.interest !== undefined) c.interest = oneOf_(d.interest, DEF.interest, 'interest level');
    if (d.photo !== undefined && d.photo) c.photo = https_(d.photo);

    // duplicates
    var dup = dupOf_(c);
    if (dup && (isNew || (dup.by === 'mobile' && (c.mobile || '') !== mobBefore))) {
      var x = dup.c, where = '“' + x.shop + '” (' + (x.area || x.city || '') + ', ' + x.id + (x.ownerName ? ', ' + x.ownerName : '') + ')';
      if (leadOf(x) === 'DEAD') {
        need_(boss, redFlagText_(x) + ' Do not add it again. If things have changed, ask a manager to reopen it.');
        if (!d.force) return { confirm: redFlagText_(x) + ' Add a new customer anyway?' };
      } else if (dup.by === 'mobile') {
        need_(boss, 'This mobile number already belongs to ' + where + '. Open that customer instead.');
        if (!d.force) return { confirm: 'This mobile number already belongs to ' + where + '. Save anyway?' };
      } else if (!d.force) return { confirm: where + ' already exists in the same area. Is this a different customer?' };
    }

    if (isNew) c.id = nextId_('C', 'C', 5);
    save_('cust', [c]);
    log_(isNew ? 'NEW CUSTOMER' : 'CUSTOMER', c.id, u, c.shop + ' · ' + c.type + (isNew ? ' · first visit ' + fmtDay_(c.nextFollow) : ''));
    return { cust: c };
  });
}

/** Move the planned visit date. Once a date is set it can only change through here, with a reason that is kept forever. */
function rescheduleVisit(token, id, date, reason, note) {
  var u = auth_(token);
  date = planDate_(date, 'new visit date');
  reason = str_(reason, 120); note = str_(note, 300);
  return withLock_(function () {
    var c = liveCust_(String(id));
    need_(isBoss_(u) || !c.ownerId || c.ownerId === u.id, 'Only ' + (c.ownerName || 'the assigned executive') + ' or a manager can reschedule this visit.');
    need_(leadOf(c) !== 'DEAD', redFlagText_(c) + ' A manager must reopen it first.');
    var h = Array.isArray(c.resched) ? c.resched : [];
    if (c.nextFollow) {
      need_(dayKey_(date) !== dayKey_(c.nextFollow), 'That is the same date. Pick a different day.');
      need_(reason, 'Say why the visit is being moved.');
      need_(reason !== 'Other' || note, 'Write the reason in the note.');
      h.push({ from: c.nextFollow, to: date, reason: reason, note: note, by: u.name, byId: u.id, at: Date.now() });
      c.resched = h.slice(-60); c.reschedCount = (Number(c.reschedCount) || 0) + 1;
    }
    var from = c.nextFollow;
    c.nextFollow = date;
    if (!c.ownerId) { c.ownerId = u.id; c.ownerName = u.name; }
    save_('cust', [c]);
    log_('RESCHEDULE', c.id, u, c.shop + ': ' + (from ? fmtDay_(from) + ' → ' : 'planned ') + fmtDay_(date) + (reason ? ' — ' + reason : '') + (note ? ' (' + note + ')' : ''));
    return { cust: c };
  });
}

/** Manager: reopen a red-flagged / successful lead, or set the result by hand. */
function setLeadStatus(token, id, status, reason) {
  var u = auth_(token);
  need_(isBoss_(u), 'Only admin or manager can change a lead result directly.');
  need_(DEF.leadStatus[status], 'Bad lead status.');
  reason = str_(reason, 200);
  if (status === 'DEAD') need_(reason, 'Say why this customer is not worth it.');
  return withLock_(function () {
    var c = liveCust_(String(id)), old = leadOf(c);
    c.status = status;
    if (status === 'WON' || status === 'DEAD') { c.closeReason = reason; c.closedBy = u.name; c.closedAt = Date.now(); if (status === 'DEAD') c.nextFollow = ''; }
    else { c.closeReason = ''; c.closedBy = ''; c.closedAt = ''; }
    save_('cust', [c]);
    log_('LEAD', c.id, u, c.shop + ': ' + DEF.leadStatus[old] + ' → ' + DEF.leadStatus[status] + (reason ? ' — ' + reason : ''));
    return { cust: c };
  });
}

/** Sample-stand decision (admin / manager). */
function setStand(token, id, status, reason, note, qty, givenAt, execId) {
  var u = auth_(token);
  need_(isBoss_(u), 'Only admin or manager decides sample stands.');
  need_(DEF.stand[status], 'Bad stand status.');
  var L = getLists_();
  reason = str_(reason, 200);
  if (status === 'TO_GIVE' || status === 'EXCLUDED') need_(reason, 'Pick the main reason.');
  var ex = null;
  if (status === 'HANDED') { ex = find_('users', String(execId || '')); need_(ex && ex.active, 'Pick the field executive the stand was handed to.'); }
  var res = withLock_(function () {
    var c = liveCust_(id), old = c.standStatus || 'UNDECIDED';
    c.standStatus = status; c.standReason = reason; c.standNote = str_(note, 500); c.standBy = u.name; c.standAt = Date.now();
    if (status === 'HANDED') {
      c.standExecId = ex.id; c.standExec = ex.name; c.standHandedAt = Number(givenAt) || Date.now(); c.standQty = Math.max(1, Number(qty) || 1);
      c.standGivenAt = ''; c.standPlacedBy = '';
    } else if (status === 'GIVEN') {
      c.standGivenAt = Number(givenAt) || Date.now(); c.standQty = Math.max(1, Number(qty) || 1);
      if (old !== 'GIVEN') c.standPlacedBy = c.standExec || u.name;
    } else { c.standGivenAt = ''; c.standQty = ''; c.standExecId = ''; c.standExec = ''; c.standHandedAt = ''; c.standPlacedBy = ''; }
    save_('cust', [c]);
    log_('STAND', c.id, u, c.shop + ': ' + DEF.stand[old] + ' → ' + DEF.stand[status] + (ex ? ' (' + c.standQty + ' with ' + ex.name + ')' : '') + (reason ? ' — ' + reason : ''));
    return { cust: c, known: L.includeReasons.concat(L.excludeReasons).indexOf(reason) >= 0 };
  });
  if (ex && ex.id !== u.id) {
    try { tgTo_(ex, '🗄 <b>Sample stand handed to you</b>\n' + res.cust.standQty + ' stand(s) for ' + h_(res.cust.shop) + (res.cust.area || res.cust.city ? ' · ' + h_([res.cust.area, res.cust.city].filter(Boolean).join(', ')) : '') +
      '\nPlace it at the customer and tap “Mark placed” in the app.' + appLink_(), 'stand'); flushNlog_(); } catch (e) {}
  }
  return res;
}

/** The executive (or admin / manager) confirms the stand he was handed is now placed at the customer. */
function placeStand(token, id, placedAt, note) {
  var u = auth_(token);
  return withLock_(function () {
    var c = liveCust_(id);
    need_(c.standStatus === 'HANDED', 'This stand is not waiting to be placed.');
    need_(isBoss_(u) || c.standExecId === u.id, 'Only ' + (c.standExec || 'the executive') + ' (or admin / manager) can mark this stand placed.');
    var at = Number(placedAt) || Date.now();
    need_(at <= Date.now() + 864e5, 'The placed date cannot be in the future.');
    c.standStatus = 'GIVEN'; c.standGivenAt = at; c.standPlacedBy = u.name; c.standAt = Date.now();
    if (str_(note, 500)) c.standNote = [c.standNote, str_(note, 500)].filter(String).join(' · ').slice(0, 500);
    save_('cust', [c]);
    log_('STAND', c.id, u, c.shop + ': ' + c.standQty + ' stand(s) placed');
    return { cust: c };
  });
}

function deleteCustomer(token, id, reason) {
  var u = auth_(token);
  need_(isAdmin_(u), 'Only admin can delete a customer.');
  var open = load_('orders').filter(function (o) { return o.custId === String(id) && DEF.orderSteps[orderStage(o)]; });
  need_(!open.length, 'This customer has open orders (' + open.map(function (o) { return o.id; }).slice(0, 5).join(', ') + '). Finish or cancel them first.');
  return softDelete_('cust', id, u, reason, 'Customer');
}

/**
 * Nothing is ever removed: "delete" marks the record Deleted with who / when / why.
 * It drops out of lists and reports, can still be opened, and admin can restore it.
 */
var DEL_KEY = { cust: 'cust', visits: 'visit', calls: 'call', prod: 'prod' };
function softDelete_(t, id, u, reason, what) {
  reason = str_(reason, 300);
  need_(reason, 'Give a reason for deleting.');
  return withLock_(function () {
    var o = get_(t, String(id), what);
    need_(!o.deleted, 'This ' + what.toLowerCase() + ' is already deleted.');
    o.deleted = true; o.delReason = reason; o.delBy = u.name; o.delAt = Date.now();
    save_(t, [o]);
    log_('DELETED', o.id, u, what + ' deleted: ' + (o.shop || o.name || '') + ' — ' + reason);
    var r = {}; r[DEL_KEY[t]] = o; return r;
  });
}
function restoreRecord(token, t, id) {
  var u = auth_(token);
  need_(isAdmin_(u), 'Only admin can restore.');
  need_(DEL_KEY[t], 'Bad record type.');
  return withLock_(function () {
    var o = get_(t, String(id), 'Record');
    need_(o.deleted, 'This record is not deleted.');
    log_('RESTORED', o.id, u, (o.shop || o.name || '') + ' restored (was deleted by ' + (o.delBy || '?') + ': ' + (o.delReason || '') + ')');
    o.deleted = false; o.delReason = ''; o.delBy = ''; o.delAt = '';
    save_(t, [o]);
    var r = {}; r[DEL_KEY[t]] = o; return r;
  });
}
/** A customer that can be worked on (not deleted). */
function liveCust_(id) {
  var c = get_('cust', String(id), 'Customer');
  need_(!c.deleted, '“' + c.shop + '” was deleted' + (c.delReason ? ' (' + c.delReason + ')' : '') + '. Ask admin to restore it first.');
  return c;
}

/* ================================================================ calls & follow-ups */

/** Recordings attached to a call (audio or video, already uploaded to Drive). */
function cleanRec_(list) {
  return (Array.isArray(list) ? list : []).map(function (m) {
    return { url: https_(m.url), type: m.type === 'video' ? 'video' : 'audio', name: str_(m.name, 120), size: Number(m.size) || '' };
  }).filter(function (m) { return m.url; }).slice(0, 10);
}

/**
 * One phone call with a customer.
 * Not received → only the next call date. Received → one or more purposes, each with its own questions (Admin ▸ Forms ▸ Call purposes).
 * The next call date becomes a reminder in that person's Today / Upcoming work.
 */
function saveCall(token, d) {
  var u = auth_(token), now = Date.now(), L = getLists_(), CF = getCallForms_();
  need_(d.custId, 'Pick the customer.');
  var status = oneOf_(d.status, DEF.callStatus, 'call status');
  need_(status, 'Pick whether the call was received.');
  var dir = oneOf_(d.dir || 'Outgoing', DEF.callDir, 'call direction');
  var purposes = [], answers = {}, text = [];
  if (status === 'Received') {
    (Array.isArray(d.purposes) ? d.purposes : []).forEach(function (p) { p = str_(p, 80); if (p && purposes.indexOf(p) < 0) purposes.push(p); });
    need_(purposes.length, 'Pick what the call was about.');
    purposes.forEach(function (p) {
      need_(L.callPurposes.indexOf(p) >= 0, 'Pick a valid call purpose.');
      var a = cleanFields_(p, (d.answers || {})[p], {}, true, CF), t = fieldsText_(p, a, CF);
      if (Object.keys(a).length) answers[p] = a;
      text.push(p + (t ? ': ' + t : ''));
    });
  }
  var next = d.nextCall ? planDate_(d.nextCall, 'next call date') : '';
  var media = status === 'Received' ? cleanRec_(d.media) : [];
  return withLock_(function () {
    var c = liveCust_(String(d.custId));
    var l = {
      id: nextId_('L', 'CL', 6), at: now, userId: u.id, userName: u.name, custId: c.id, shop: c.shop, category: c.type || '', city: c.city || '', area: c.area || '',
      dir: dir, status: status, purposes: purposes.join(', '), answersText: text.join(' | '), answers: answers, notes: str_(d.notes, 2000), nextCall: next,
      media: media, mediaLinks: media.map(function (m) { return m.url; }).join('\n')
    };
    c.calls = (Number(c.calls) || 0) + 1; c.lastCall = now; c.lastCallBy = u.name;
    c.nextCall = next; c.nextCallById = next ? u.id : ''; c.nextCallBy = next ? u.name : '';
    save_('cust', [c]);
    save_('calls', [l]);
    log_('CALL', l.id, u, c.shop + ' · ' + dir + ' · ' + status + (l.purposes ? ' · ' + l.purposes : '') + (next ? ' · next call ' + fmtDay_(next) : ''));
    return { call: l, cust: c };
  });
}

function deleteCall(token, id, reason) {
  var u = auth_(token);
  need_(isAdmin_(u), 'Only admin can delete a call.');
  return softDelete_('calls', id, u, reason, 'Call');
}

/** Older calls for a date range. Executives only get their own. */
function getCallsRange(token, from, to) {
  var u = auth_(token);
  from = Number(from) || 0; to = Number(to) || Date.now();
  return load_('calls').filter(function (l) { return (isBoss_(u) || l.userId === u.id) && l.at >= from && l.at < to; });
}

/** Every visit and call of one customer, however old (the customer page's History tab). */
function getCustHistory(token, custId) {
  var u = auth_(token), boss = isBoss_(u);
  var ok = function (x) { return x.custId === custId && (boss || x.userId === u.id); };
  return { visits: load_('visits').filter(ok), calls: load_('calls').filter(ok) };
}

/* ================================================================ orders */

/** Hours a step may take (Admin ▸ Rules). Balance payment is due on delivery + credit days instead. */
// CONFIRM … BALANCE, in the order an order goes through them. Read inside a function, never at file load:
// Apps Script may load Code.gs before Shared.gs, when DEF does not exist yet.
function stepIdx_(st) { return Object.keys(DEF.orderSteps).indexOf(st); }
function stepTat_(st) { var t = getSettings_().orderTat || {}; return Number(t[st] != null ? t[st] : DEF.defaults.settings.orderTat[st]) || 0; }
function stepDue_(o, st, from) {
  if (st === 'BALANCE') return (Number(o.deliveredAt) || from) + Math.max(creditDays(o.terms), 1) * DAY_MS + 18 * 3600e3; // 6 pm on the due day
  var h = stepTat_(st);
  return h ? from + h * 3600e3 : '';
}
function inr_(n) { return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'); }
/** Money actually received: every payment that is not voided (refunds are negative). */
function paidOf_(o) { return Math.round((Array.isArray(o.payments) ? o.payments : []).reduce(function (a, x) { return a + (x.void ? 0 : Number(x.amt) || 0); }, 0) * 100) / 100; }
function balanceOf_(o) { return Math.max(0, Math.round((Number(o.invoiceAmt) || Number(o.total) || 0) - paidOf_(o))); }
/** Advance terms: the full order value must be in, unless admin / manager let it move on short (with a reason). */
function advanceOk_(o) { return paidOf_(o) >= Math.round(Number(o.total) || 0) || !!o.advOk; }
/** Steps with nothing left to do are passed over when the order moves on. */
function skipStep_(o, s) {
  if (s === 'ADVANCE') return advanceOk_(o);
  if (s === 'BILLING') return !!o.invoiceNo;
  if (s === 'PAY_DISPATCH') return balanceOf_(o) <= 0 || !!o.dispOk;
  if (s === 'BALANCE') return balanceOf_(o) <= 0;
  return false;
}
/** The step after st on this order's path (works even if st is not on the path any more). */
function nextStage_(o, st) {
  var p = orderPath(o), i = stepIdx_(st);
  for (var k = 0; k < p.length; k++) if (stepIdx_(p[k]) > i && !skipStep_(o, p[k])) return p[k];
  return 'DONE';
}
/** Where an open order belongs after its terms changed or it was reopened. */
function rightStage_(o) {
  var st = orderStage(o), p = orderPath(o), i = stepIdx_(st);
  if (!DEF.orderSteps[st]) return st;
  if (!o.confirmedAt) return 'CONFIRM';
  if (p.indexOf('ADVANCE') >= 0 && !advanceOk_(o) && i > stepIdx_('ADVANCE') && i <= stepIdx_('DISPATCH')) return 'ADVANCE';
  if (p.indexOf(st) < 0 || (st !== 'BILLING' && skipStep_(o, st))) return nextStage_(o, st);
  return st;
}
/** Step worked out from the facts alone (admin “Repair step”, e.g. after the sheet was edited by hand). */
function deriveStage_(o) {
  if (!o.confirmedAt) return 'CONFIRM';
  var bal = balanceOf_(o), done = { CONFIRM: true, ADVANCE: advanceOk_(o), BILLING: !!o.invoiceNo, DISPATCH: !!o.dispatchAt, PAY_DISPATCH: bal <= 0 || !!o.dispOk, DELIVERY: !!o.deliveredAt, BALANCE: bal <= 0 || !!o.shortClose };
  var p = orderPath(o);
  for (var k = 0; k < p.length; k++) if (!done[p[k]]) return p[k];
  return 'DONE';
}
function moveTo_(o, st, u, now) {
  o.status = st; o.statusAt = now; o.statusBy = u.name; o.stageAt = now; o.lateSent = '';
  o.due = DEF.orderSteps[st] ? stepDue_(o, st, now) : '';
  if (st === 'DONE') o.closedAt = now;
}
/** A line in the step history for something that is not a step (edit, reopen, void…). */
function hist_(o, k, u, now, info) { var h = Array.isArray(o.steps) ? o.steps : []; h.push({ k: k, done: now, by: u.name, info: info, act: 'event' }); o.steps = h; }
/** Keep the old invoice / dispatch details before a step is done again. */
function keepEarlier_(o, k, u, now, data) { var e = Array.isArray(o.earlier) ? o.earlier : []; e.push({ k: k, at: now, by: u.name, data: data }); o.earlier = e; }
function orderItems_(list) {
  var items = (Array.isArray(list) ? list : []).map(function (it) {
    var q = num_(it.qty), r = num_(it.rate);
    return { product: str_(it.product, 120), thk: str_(it.thk, 20), qty: q === '' ? 0 : q, unit: oneOf_(it.unit || 'Sq ft', DEF.units, 'unit'), rate: r };
  }).filter(function (it) { return it.product && it.qty > 0; });
  need_(items.length, 'Add at least one product with a quantity.');
  items.forEach(function (it) {
    need_(it.qty <= 1e6, it.product + ': the quantity looks wrong (more than 10,00,000).');
    need_(it.rate === '' || (it.rate >= 0 && it.rate <= 1e5), it.product + ': the rate per sq ft must be between ₹0 and ₹1,00,000 (use the Discount box for discounts).');
  });
  return items;
}
function orderSig_(x) {
  return JSON.stringify((x.items || []).map(function (it) { return [it.product, it.thk || '', Number(it.qty), it.unit, it.rate === '' || it.rate == null ? '' : Number(it.rate)]; })) + '|' + (Number(x.discount) || 0) + '|' + (x.gst || 'Incl');
}

function saveOrder(token, d) {
  var u = auth_(token), boss = isBoss_(u), Sx = getSettings_();
  d = d || {};
  var items = orderItems_(d.items), gst = d.gst === 'Excl' ? 'Excl' : 'Incl', disc = num_(d.discount) || 0, reason = str_(d.reason, 300);
  need_(disc >= 0, 'The discount cannot be negative.');
  var res = withLock_(function () {
    var o, now = Date.now(), isNew = !d.id, st = 'CONFIRM';
    if (!isNew) {
      o = get_('orders', String(d.id), 'Order'); st = orderStage(o);
      need_(DEF.orderSteps[st], 'This order is closed.');
      need_(boss || (o.byId === u.id && !o.confirmedAt), 'Only admin / manager can edit an order after it is confirmed.');
      need_(!d.ver || !o.updatedAt || Number(d.ver) === Number(o.updatedAt), 'Someone changed this order after you opened it. Close the form, open the order again and redo your change.');
    } else o = { createdAt: now, byId: u.id, by: u.name, paid: 0, steps: [], payments: [] };
    var custChanged = !isNew && String(d.custId) !== String(o.custId);
    need_(!custChanged || !o.confirmedAt, 'The customer of a confirmed order cannot be changed. Cancel it and take a new order for the right customer.');
    var c = isNew || custChanged ? liveCust_(String(d.custId)) : get_('cust', String(o.custId), 'Customer');
    items.forEach(function (it) { it.sqft = Math.round(toSqft(it.qty, it.unit, Sx) * 100) / 100; it.amt = lineAmt(it, Sx); });
    var m = orderMoney(items, disc, gst, Sx);
    need_(disc <= m.subtotal, 'The discount is more than the order value.');
    need_(m.total > 0, 'The order value is ₹0 — enter the rate per sq ft.');
    need_(m.total <= 1e9, 'The order value looks wrong (over ₹100 crore).');
    var valueChanged = !isNew && orderSig_(o) !== orderSig_({ items: items, discount: m.discount, gst: gst });
    need_(!valueChanged || !o.invoiceNo, 'This order is already invoiced (' + o.invoiceNo + ') — its items, discount and GST can no longer change.');
    var paid = paidOf_(o);
    need_(m.total >= paid, 'The order value (' + inr_(m.total) + ') cannot be less than the ' + inr_(paid) + ' already received.');
    var oldTerms = o.terms || '', terms = oldTerms && str_(d.terms) === oldTerms ? oldTerms : oneOf_(d.terms, DEF.paymentTerms, 'payment term'); // older free-text terms stay as they were
    need_(terms, 'Pick the payment terms.');
    var termsChanged = !isNew && terms !== oldTerms;
    if (isNew || termsChanged || custChanged) need_(termsFor(c).indexOf(terms) >= 0, c.shop + ' may pay only: ' + termsFor(c).join(', ') + '. Ask admin to allow other terms (Admin ▸ Orders ▸ Customers).');
    if (o.confirmedAt && (termsChanged || valueChanged)) {
      need_(reason, 'Give a reason for changing a confirmed order.');
      if (termsChanged && stepIdx_(st) > stepIdx_('DISPATCH')) need_(terms !== 'Advance' && terms !== 'On dispatch', 'The material is already dispatched — the terms can only change to credit or On delivery now.');
    }
    var dd = Number(d.deliveryDate) || '';
    if (dd && dd !== (Number(o.deliveryDate) || '')) need_(dd >= now - 2 * DAY_MS && dd <= now + 366 * DAY_MS, 'The expected delivery date must be from today to a year ahead.');
    var oldTotal = Number(o.total) || 0;
    o.custId = c.id; o.shop = c.shop; o.city = c.city || ''; o.area = c.area || '';
    o.items = items; o.subtotal = m.subtotal; o.discount = m.discount; o.gst = gst; o.gstAmt = m.gstAmt; o.total = m.total;
    o.itemsText = items.map(function (it) { return it.product + (it.thk ? ' ' + it.thk : '') + ' × ' + it.qty + ' ' + it.unit + (it.unit !== 'Sq ft' ? ' (' + it.sqft + ' sq ft)' : '') + (it.rate ? ' @ ₹' + it.rate + '/sq ft' : ''); }).join('; ') +
      (m.discount ? '; discount ' + inr_(m.discount) : '') + (gst === 'Excl' ? '; + GST ' + m.pct + '%' : '');
    o.terms = terms; o.deliveryDate = dd; o.notes = str_(d.notes, 1000);
    var moved = false, change = [];
    if (isNew) { o.id = nextId_('O', 'ORD-', 4); moveTo_(o, 'CONFIRM', u, now); } // number given only once the order is valid, so a rejected save never skips one
    else if (o.confirmedAt && (termsChanged || valueChanged)) {
      if (valueChanged) change.push('value ' + inr_(oldTotal) + ' → ' + inr_(m.total));
      if (termsChanged) change.push('terms ' + (oldTerms || '—') + ' → ' + terms);
      var to = rightStage_(o);
      if (to !== st) { moveTo_(o, to, u, now); moved = true; change.push('moved to “' + stepLabel(to, Sx) + '”'); }
      else if (st === 'BALANCE' && termsChanged) o.due = stepDue_(o, 'BALANCE', now);
      hist_(o, 'EDIT', u, now, change.join(' · ') + ' — ' + reason);
    }
    o.paid = paidOf_(o); o.balance = balanceOf_(o);
    save_('orders', [o]);
    log_('ORDER', o.id, u, (isNew ? 'New: ' : 'Edited: ') + c.shop + ' · ' + o.itemsText + (change.length ? ' · ' + change.join(' · ') + ' — ' + reason : ''));
    return { order: o, isNew: isNew, change: change.length ? change.join(' · ') + ' — ' + reason : '', moved: moved };
  });
  if (res.isNew || res.moved) notifyStep_(res.order, u);
  if (res.change) notifyEdit_(res.order, u, res.change);
  return { order: res.order };
}

/** One payment typed in a step (advance / on dispatch / balance). Never more than what is still due. */
function payment_(o, d, st, u, S, boss) {
  var amt = num_(d.amt);
  need_(amt !== '' && amt > 0, 'Enter the amount received.');
  amt = Math.round(amt * 100) / 100;
  var due = balanceOf_(o);
  need_(amt <= due, inr_(amt) + ' is more than the ' + inr_(due) + ' still due on this order.');
  var mode = oneOf_(d.mode, DEF.payModes, 'payment mode');
  need_(mode, 'Pick how it was paid.');
  var ref = str_(d.ref, 80), proof = https_(d.proof), now = Date.now(), date = Number(d.date) || now;
  if (reqOf(st, 'ref', S)) need_(ref, 'Enter the reference / UTR / cheque no.');
  if (reqOf(st, 'proof', S)) need_(proof, 'Attach the payment proof.');
  need_(date >= (Number(o.createdAt) || 0) - 2 * DAY_MS && date <= now + DAY_MS, 'The payment date must be between the order date and today.');
  var sid = str_(d.sid, 40), pays = Array.isArray(o.payments) ? o.payments : [];
  need_(!sid || !pays.some(function (x) { return x.sid === sid; }), 'This payment is already saved.');
  need_(!pays.some(function (x) { return !x.void && Number(x.amt) === amt && x.mode === mode && (x.ref || '') === ref && now - (Number(x.at) || 0) < 10 * 60e3; }),
    'The same payment (' + inr_(amt) + ', ' + mode + (ref ? ', ' + ref : '') + ') was saved a few minutes ago. If this really is a second payment, enter its own reference.');
  if (ref && mode !== 'Cash') {
    var key = ref.replace(/\s+/g, '').toUpperCase();
    var other = load_('orders').filter(function (x) { return x.id !== o.id && (x.payments || []).some(function (p) { return !p.void && Number(p.amt) > 0 && String(p.ref || '').replace(/\s+/g, '').toUpperCase() === key; }); })[0];
    if (other) need_(boss && d.refOk, 'Reference ' + ref + ' is already used on ' + other.id + ' (' + other.shop + ').' + (boss ? ' Tick “Allow a repeated reference” to save it anyway.' : ' Check it, or ask admin / manager.'));
  }
  return { id: 'PM' + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36), sid: sid, amt: amt, mode: mode, ref: ref, date: date, proof: proof, kind: DEF.orderSteps[st].l, by: u.name, at: now };
}

/**
 * Finish the order's current step with its details, and move to the next one.
 * Confirm = admin / manager only. Every other step = the people set for it (Admin ▸ Orders), or admin / manager.
 * Every rule is checked here, on the server, from the order's own facts — not from what the screen showed.
 */
function orderStep(token, id, d) {
  var u = auth_(token), boss = isBoss_(u);
  d = d || {};
  var res = withLock_(function () {
    var o = get_('orders', String(id), 'Order'), st = orderStage(o), now = Date.now(), info = '', stay = false, S = getSettings_(), path = orderPath(o);
    need_(DEF.orderSteps[st] || DEF.orderEnd[st], 'This order’s step “' + st + '” is not a known step (the Orders sheet may have been edited by hand). Admin: open the order and press “Repair step”.');
    need_(DEF.orderSteps[st], 'This order is ' + String(DEF.orderEnd[st] || st).toLowerCase() + '.');
    need_(!d.step || d.step === st, 'This order has already moved to “' + stepLabel(st, S) + '”. Refresh and try again.');
    need_(canDoStep(u, o, st, S), st === 'CONFIRM' ? 'Only admin or manager can confirm an order.' : 'You are not one of the people for “' + stepLabel(st, S) + '” on this order.');
    var hist = Array.isArray(o.steps) ? o.steps : [], remark = str_(d.remark, 500), rules = answersOf(st, S), rule = null;
    if (rules.length) { rule = rules.filter(function (r) { return r.a === str_(d.ans); })[0]; need_(rule, 'Pick the answer.'); }
    if (remark) o.lastRemark = remark;
    if (rule && rule.act !== 'next') {
      // answer rule: stay here (follow-up) / cancel / back to an earlier step
      need_(remark, 'Write a remark.');
      if (rule.act === 'cancel') {
        need_(boss, 'Only admin / manager can cancel an order.');
        need_(stepIdx_(st) <= stepIdx_('DISPATCH'), 'The material is already dispatched — this order cannot be cancelled. Use “Returned” on the delivery step, or close the balance short.');
      }
      var to = /^back:/.test(rule.act) ? String(rule.act).slice(5) : '';
      if (to) {
        need_(to !== 'CONFIRM', 'An order cannot be sent back to “Confirm order” — cancel it instead.');
        need_(DEF.orderSteps[to] && path.indexOf(to) >= 0 && stepIdx_(to) < stepIdx_(st), 'This answer can only send the order back to an earlier step.');
      }
      hist.push({ k: st, start: o.stageAt || o.createdAt, due: o.due || '', done: now, by: u.name, late: !!(o.due && now > o.due), info: rule.a + ' — ' + remark, ans: rule.a, act: rule.act });
      o.steps = hist;
      var moved = true;
      if (rule.act === 'stay') {
        var fu = Number(d.followUp);
        if (fu) { need_(fu >= now - 1.5 * DAY_MS && fu <= now + 366 * DAY_MS, 'The follow-up date must be from today to a year ahead.'); o.due = fu + 18 * 3600e3; o.lateSent = ''; }
        moved = false;
      } else if (rule.act === 'cancel') { o.cancelReason = rule.a + ': ' + remark; o.cancelledFrom = st; moveTo_(o, 'CANCELLED', u, now); }
      else moveTo_(o, to, u, now);
      save_('orders', [o]);
      log_('ORDER', o.id, u, stepLabel(st, S) + ': ' + rule.a + ' — ' + remark);
      return { order: o, moved: moved };
    }
    if (rule) info = rule.a + ' · ';

    // the steps before this one must really be done (holds even if the sheet was edited by hand)
    var fix = ' Admin: open the order and press “Repair step”.', legacy = ['NEW', 'CONFIRMED', 'DISPATCHED'].indexOf(o.status) >= 0; // orders from before the step flow
    if (legacy) fix = null;
    if (fix && st !== 'CONFIRM') need_(o.confirmedAt, 'This order was never confirmed.' + fix);
    if (fix && (st === 'BILLING' || st === 'DISPATCH') && path.indexOf('ADVANCE') >= 0) need_(advanceOk_(o), 'The advance is not fully received (' + inr_(paidOf_(o)) + ' of ' + inr_(o.total) + ').' + fix);
    if (fix && st === 'DISPATCH') need_(o.invoiceNo, 'This order has no invoice — it must be billed before dispatch.' + fix);
    if (fix && (st === 'PAY_DISPATCH' || st === 'DELIVERY')) need_(o.dispatchAt, 'This order was never dispatched.' + fix);
    if (fix && st === 'DELIVERY' && path.indexOf('PAY_DISPATCH') >= 0) need_(balanceOf_(o) <= 0 || o.dispOk, 'The payment on dispatch is not fully received.' + fix);
    if (fix && st === 'BALANCE') need_(o.deliveredAt, 'This order was never delivered.' + fix);

    if (st === 'CONFIRM') {
      // the terms were checked when the order was taken; taking a customer's permission back later only affects new orders
      o.confirmedBy = u.name; o.confirmedAt = now; info = info || 'Confirmed';
    }
    else if (st === 'BILLING') {
      var ino = str_(d.invoiceNo, 60); need_(ino, 'Enter the invoice number.');
      var idt = Number(d.invoiceDate) || ''; need_(idt, 'Pick the invoice date.');
      need_(idt >= (Number(o.createdAt) || 0) - 2 * DAY_MS && idt <= now + DAY_MS, 'The invoice date must be between the order date and today.');
      var ia = num_(d.invoiceAmt); need_(ia !== '' && ia > 0 && ia <= 1e9, 'Enter the invoice amount.');
      var tol = Number(S.invTolPct); if (isNaN(tol) || tol < 0) tol = 2;
      var tot = Number(o.total) || 0, gap = tot ? Math.abs(ia - tot) / tot * 100 : 100, note = '';
      if (gap > tol + 1e-9) {
        var gapTxt = Math.round(gap * 10) / 10 + '%';
        need_(boss, 'The invoice ' + inr_(ia) + ' is ' + gapTxt + ' away from the order value ' + inr_(tot) + ' (allowed ±' + tol + '%). Check the amount, or ask admin / manager to save it with a reason.');
        note = str_(d.invoiceReason, 300); need_(note, 'Why is the invoice ' + gapTxt + ' away from the order value?');
      }
      need_(ia >= paidOf_(o), 'The invoice cannot be less than the ' + inr_(paidOf_(o)) + ' already received.');
      var ifile = https_(d.invoiceFile); need_(ifile || !reqOf(st, 'invoiceFile', S), 'Attach the invoice photo or PDF.');
      if (o.invoiceNo) keepEarlier_(o, 'BILLING', u, now, { invoiceNo: o.invoiceNo, invoiceDate: o.invoiceDate, invoiceAmt: o.invoiceAmt, invoiceFile: o.invoiceFile || '', invoiceNote: o.invoiceNote || '' });
      o.invoiceNo = ino; o.invoiceDate = idt; o.invoiceAmt = ia; o.invoiceFile = ifile; o.invoiceNote = note;
      info += 'Invoice ' + ino + ' · ' + inr_(ia) + (note ? ' · differs from order value — ' + note : '');
    } else if (st === 'DISPATCH') {
      var rq = function (k, v, msg) { need_(v || !reqOf(st, k, S), msg); return v; }, x = {};
      x.vehicleNo = rq('vehicleNo', str_(d.vehicleNo, 30).toUpperCase(), 'Enter the vehicle number.');
      x.driverName = rq('driverName', str_(d.driverName, 60), 'Enter the driver’s name.');
      x.driverMobile = rq('driverMobile', str_(d.driverMobile, 20), 'Enter the driver’s mobile.'); need_(!x.driverMobile || mobile10_(x.driverMobile), 'Driver mobile needs 10 digits.');
      x.transporter = rq('transporter', str_(d.transporter, 80), 'Enter the transporter.'); x.lrNo = rq('lrNo', str_(d.lrNo, 40), 'Enter the LR / bilty no.');
      x.dispatchAt = Number(d.dispatchAt) || now;
      need_(x.dispatchAt >= (Number(o.createdAt) || 0) - 2 * DAY_MS && x.dispatchAt <= now + DAY_MS, 'The dispatch date must be between the order date and today.');
      x.dispatchPhoto = rq('dispatchPhoto', https_(d.dispatchPhoto), 'Attach the loaded vehicle photo.');
      if (o.dispatchAt) keepEarlier_(o, 'DISPATCH', u, now, { vehicleNo: o.vehicleNo || '', driverName: o.driverName || '', driverMobile: o.driverMobile || '', transporter: o.transporter || '', lrNo: o.lrNo || '', dispatchAt: o.dispatchAt, dispatchPhoto: o.dispatchPhoto || '' });
      Object.keys(x).forEach(function (k) { o[k] = x[k]; });
      info += o.vehicleNo + ' · ' + o.driverName + ' ' + o.driverMobile;
    } else if (st === 'DELIVERY') {
      var dat = Number(d.deliveredAt) || ''; need_(dat, 'Pick the delivery date.');
      need_(dat >= (Number(o.dispatchAt) || 0) - DAY_MS && dat <= now + DAY_MS, 'The delivery date must be between the dispatch date (' + Utilities.formatDate(new Date(Number(o.dispatchAt)), TZ, 'dd MMM') + ') and today.');
      o.deliveredAt = dat;
      o.receivedBy = str_(d.receivedBy, 60); need_(o.receivedBy || !reqOf(st, 'receivedBy', S), 'Who received the material?');
      o.deliveryCond = oneOf_(d.deliveryCond, DEF.deliveryCond, 'condition'); need_(o.deliveryCond, 'Pick the condition on delivery.');
      o.deliveryNote = str_(d.deliveryNote, 500); need_(o.deliveryCond === DEF.deliveryCond[0] || o.deliveryNote, 'Describe the damage / shortage.');
      o.podPhoto = https_(d.podPhoto); need_(o.podPhoto || !reqOf(st, 'podPhoto', S), 'Attach the delivery proof photo.');
      info += 'Delivered · ' + o.deliveryCond + ' · received by ' + o.receivedBy;
    } else { // ADVANCE · PAY_DISPATCH · BALANCE
      if (d.close) {
        need_(boss && st === 'BALANCE', 'Only admin or manager can close a payment short.');
        o.shortClose = str_(d.reason, 300); need_(o.shortClose, 'Why is the balance being closed?');
        info += 'Closed with ' + inr_(balanceOf_(o)) + ' short — ' + o.shortClose;
      } else if (d.override) {
        need_(boss && (st === 'ADVANCE' || st === 'PAY_DISPATCH'), 'Only admin / manager can let an order move on without full payment.');
        var why = str_(d.reason, 300); need_(why, 'Why may it move on without full payment?');
        var short = st === 'ADVANCE' ? Math.max(0, Math.round((Number(o.total) || 0) - paidOf_(o))) : balanceOf_(o);
        if (st === 'ADVANCE') o.advOk = why; else o.dispOk = why;
        info += 'Moved on with ' + inr_(short) + ' not received — ' + why;
      } else {
        var p = payment_(o, d, st, u, S, boss);
        o.payments = (Array.isArray(o.payments) ? o.payments : []).concat([p]);
        appendPayment_(o, p);
        info += inr_(p.amt) + ' · ' + p.mode + (p.ref ? ' · ' + p.ref : '');
        // the step stays open until it is fully paid (advance = the whole order value)
        stay = st === 'ADVANCE' ? !advanceOk_(o) : balanceOf_(o) > 0;
      }
    }
    o.paid = paidOf_(o); o.balance = balanceOf_(o);
    if (!stay) {
      hist.push({ k: st, start: o.stageAt || o.createdAt, due: o.due || '', done: now, by: u.name, late: !!(o.due && now > o.due), info: info });
      o.steps = hist;
      moveTo_(o, nextStage_(o, st), u, now);
    }
    save_('orders', [o]);
    log_('ORDER', o.id, u, stepLabel(st, S) + (stay ? ' (part payment)' : ' done') + ' · ' + info);
    return { order: o, moved: !stay };
  });
  if (res.moved) notifyStep_(res.order, u);
  return { order: res.order };
}

/** Admin: a payment typed wrongly is voided (kept, struck out, reversed in the Payments sheet) — never deleted. */
function voidPayment(token, id, pid, reason) {
  var u = auth_(token);
  need_(isAdmin_(u), 'Only admin can void a payment.');
  reason = str_(reason, 300); need_(reason, 'Give a reason for voiding this payment.');
  return withLock_(function () {
    var o = get_('orders', String(id), 'Order'), now = Date.now(), S = getSettings_(), pays = Array.isArray(o.payments) ? o.payments : [];
    var p = pays.filter(function (x, i) { return (x.id || 'i' + i) === String(pid); })[0];
    need_(p, 'Payment not found — refresh and try again.');
    need_(!p.void, 'This payment is already voided.');
    p.void = true; p.voidBy = u.name; p.voidAt = now; p.voidReason = reason;
    appendPayment_(o, { at: now, amt: -Number(p.amt), mode: p.mode, ref: p.ref || '', date: now, proof: '', kind: 'VOID ' + p.kind + ' — ' + reason, by: u.name });
    var st = orderStage(o), info = 'Voided ' + inr_(p.amt) + ' (' + p.kind + ', ' + p.mode + (p.ref ? ' ' + p.ref : '') + ') — ' + reason;
    if (st === 'DONE' && balanceOf_(o) > 0 && !o.shortClose && o.deliveredAt) { moveTo_(o, 'BALANCE', u, now); o.closedAt = ''; info += ' · back to “' + stepLabel('BALANCE', S) + '”'; }
    hist_(o, 'VOID', u, now, info);
    o.paid = paidOf_(o); o.balance = balanceOf_(o);
    save_('orders', [o]);
    log_('ORDER', o.id, u, info);
    return { order: o };
  });
}

/** Admin / manager: money paid back on a cancelled order. */
function recordRefund(token, id, d) {
  var u = auth_(token);
  need_(isBoss_(u), 'Only admin or manager can record a refund.');
  d = d || {};
  return withLock_(function () {
    var o = get_('orders', String(id), 'Order'), now = Date.now();
    need_(orderStage(o) === 'CANCELLED', 'Refunds are only for cancelled orders.');
    var due = paidOf_(o), amt = num_(d.amt);
    need_(amt !== '' && amt > 0, 'Enter the amount refunded.'); amt = Math.round(amt * 100) / 100;
    need_(amt <= due, inr_(amt) + ' is more than the ' + inr_(due) + ' received on this order.');
    var mode = oneOf_(d.mode, DEF.payModes, 'payment mode'); need_(mode, 'Pick how it was paid back.');
    var date = Number(d.date) || now; need_(date <= now + DAY_MS && date >= (Number(o.createdAt) || 0) - 2 * DAY_MS, 'The refund date must be between the order date and today.');
    var p = { id: 'PM' + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36), amt: -amt, mode: mode, ref: str_(d.ref, 80), date: date, proof: https_(d.proof), kind: 'Refund', by: u.name, at: now };
    o.payments = (Array.isArray(o.payments) ? o.payments : []).concat([p]);
    appendPayment_(o, p);
    hist_(o, 'REFUND', u, now, inr_(amt) + ' · ' + mode + (p.ref ? ' · ' + p.ref : '') + (due - amt > 0 ? ' · still to refund ' + inr_(due - amt) : ''));
    o.paid = paidOf_(o); o.balance = balanceOf_(o);
    save_('orders', [o]);
    log_('ORDER', o.id, u, 'Refund ' + inr_(amt) + ' · ' + mode);
    return { order: o };
  });
}

/** Requirement slip as a PDF in Drive (material for active, not yet dispatched orders). */
function reqSlipPdf(token, incl) {
  var u = auth_(token), all = isBoss_(u) || stepPerson_(u), S = getSettings_();
  var rows = slipRows(load_('orders').filter(function (o) { return all || o.byId === u.id; }), incl !== false, S), n2 = function (x) { return (Math.round(x * 100) / 100).toLocaleString('en-IN'); };
  need_(rows.length, 'No material needed — there are no active orders waiting for dispatch.');
  var now = new Date(), ids = {};
  rows.forEach(function (r) { r.orders.forEach(function (o) { ids[o.id] = 1; }); });
  var th = 'style="border:1px solid #999;padding:6px 8px;font-size:11px;background:#232220;color:#F2C14E;text-align:left"', td = 'style="border:1px solid #ccc;padding:6px 8px;font-size:11px"';
  var head = function (cols) { return '<tr>' + cols.map(function (c) { return '<th ' + th + '>' + c + '</th>'; }).join('') + '</tr>'; };
  var html = '<html><body style="font-family:Arial,sans-serif;color:#1B1A17"><h2 style="margin:0">Requirement slip</h2>' +
    '<div style="font-size:11px;color:#666;margin:4px 0 14px">' + h_(DEF.app) + ' · ' + Utilities.formatDate(now, TZ, 'dd MMM yyyy, HH:mm') + ' · ' + Object.keys(ids).length + ' active orders · by ' + h_(u.name) + (incl === false ? ' · confirmed orders only' : '') + '</div>' +
    '<div style="font-size:11px;margin-bottom:8px">1 slab = ' + S.slabSqft + ' sq ft</div><table style="border-collapse:collapse;width:100%">' + head(['Design', 'Thickness', 'Confirmed (sq ft)', 'Awaiting confirmation (sq ft)', 'Total sq ft', 'Total slabs', 'Orders']) +
    rows.map(function (r) { return '<tr><td ' + td + '><b>' + h_(r.product) + '</b></td><td ' + td + '>' + h_(r.thk || '—') + '</td><td ' + td + '>' + n2(r.conf) + '</td><td ' + td + '>' + n2(r.pend) + '</td><td ' + td + '><b>' + n2(r.total) + '</b></td><td ' + td + '><b>' + n2(r.slabs) + '</b></td><td ' + td + '>' + r.orders.length + '</td></tr>'; }).join('') + '</table>' +
    '<h3 style="margin:18px 0 6px;font-size:13px">Order-wise</h3><table style="border-collapse:collapse;width:100%">' + head(['Order', 'Customer', 'Design', 'Thickness', 'Qty', 'Step', 'Sales person', 'Expected delivery']) +
    rows.map(function (r) { return r.orders.map(function (o) { return '<tr><td ' + td + '>' + h_(o.id) + '</td><td ' + td + '>' + h_(o.shop) + '</td><td ' + td + '>' + h_(r.product) + '</td><td ' + td + '>' + h_(r.thk || '—') + '</td><td ' + td + '>' + o.qty + ' ' + h_(o.unit) + (o.unit !== 'Sq ft' ? ' (' + n2(o.sqft) + ' sq ft)' : '') + '</td><td ' + td + '>' + h_(stepLabel(o.st, S)) + '</td><td ' + td + '>' + h_(o.by) + '</td><td ' + td + '>' + (o.deliveryDate ? fmtDay_(o.deliveryDate) : '') + '</td></tr>'; }).join(''); }).join('') + '</table>' +
    '<div style="margin-top:28px;font-size:11px">Prepared by: ________________ &nbsp;&nbsp;&nbsp; Checked by: ________________ &nbsp;&nbsp;&nbsp; Store: ________________</div></body></html>';
  var blob = Utilities.newBlob(html, 'text/html', 'slip.html').getAs('application/pdf').setName('Requirement slip ' + Utilities.formatDate(now, TZ, 'dd-MMM-yyyy HHmm') + '.pdf');
  var f = uploadFolder_().createFile(blob);
  try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { url: f.getUrl(), name: f.getName() };
}

/** Is this user named for any order step (Admin ▸ Orders ▸ Steps & people)? They then see all orders. */
function stepPerson_(u) { var S = getSettings_(); return Object.keys(DEF.orderSteps).some(function (st) { return whoOf(st, S).users.indexOf(u.id) >= 0; }); }

/** Admin ▸ Orders: step names, hours, people, required fields, tile fields, answer rules. */
function saveOrderCfg(token, cfg) {
  var me = auth_(token);
  need_(isAdmin_(me), 'Only admin can change the order settings.');
  cfg = cfg || {};
  var cur = getSettings_(), steps = Object.keys(DEF.orderSteps), ids = load_('users').map(function (x) { return x.id; });
  var labels = {}, tat = {}, who = {}, req = {}, tile = {}, answers = {};
  steps.forEach(function (st) {
    var l = str_(((cfg.labels || {})[st]) || '', 40); if (l && l !== DEF.orderSteps[st].l) labels[st] = l;
    if (st !== 'BALANCE') { var n = Number(((cfg.tat || {})[st])); tat[st] = isNaN(n) ? cur.orderTat[st] : Math.max(0, Math.min(2000, n)); }
    var w = (cfg.who || {})[st] || whoOf(st, cur);
    who[st] = st === 'CONFIRM' ? { owner: false, users: [] } : { owner: !!w.owner, users: (Array.isArray(w.users) ? w.users : []).filter(function (x) { return ids.indexOf(x) >= 0; }) }; // confirm: admin / manager only
    var r = (cfg.req || {})[st] || {}, rr = {};
    (DEF.orderFields[st] || []).forEach(function (f) { if (!f[3] && r[f[0]] !== undefined) rr[f[0]] = !!r[f[0]]; });
    if (Object.keys(rr).length) req[st] = rr;
    tile[st] = ((cfg.tile || {})[st] || tileOf(st, cur)).filter(function (k) { return DEF.orderTileFields[k]; }).slice(0, 8);
    var seen = {};
    answers[st] = ((cfg.answers || {})[st] || []).map(function (x) { return { a: str_(x.a, 60), act: str_(x.act, 20) }; }).filter(function (x) {
      if (!x.a || seen[x.a.toUpperCase()]) return false; seen[x.a.toUpperCase()] = 1;
      need_(DEF.answerActs[x.act] || (/^back:/.test(x.act) && DEF.orderSteps[x.act.slice(5)] && x.act !== 'back:CONFIRM' && steps.indexOf(x.act.slice(5)) < steps.indexOf(st)), 'Pick what “' + x.a + '” does (“back” can only go to an earlier step, never to Confirm).');
      need_(x.act !== 'cancel' || steps.indexOf(st) <= steps.indexOf('DISPATCH'), '“' + x.a + '”: an order cannot be cancelled once the material is dispatched — use “back” or close short instead.');
      return true;
    }).slice(0, 10);
    if (answers[st].length) need_(answers[st].some(function (x) { return x.act === 'next'; }), '“' + (labels[st] || DEF.orderSteps[st].l) + '” needs at least one answer that moves to the next step.');
  });
  cur.orderLabels = labels; cur.orderTat = tat; cur.orderWho = who; cur.orderReq = req; cur.orderTile = tile; cur.orderAnswers = answers;
  return withLock_(function () {
    setCfg_('settings', cur);
    bumpVersion_(); PropertiesService.getScriptProperties().setProperty('FULL', String(Date.now()));
    log_('ADMIN', '', me, 'Order settings updated');
    return { settings: cur };
  });
}

/** Admin ▸ Orders ▸ Customers: which payment terms a customer may use (Advance always). */
function setPayAllow(token, custId, allow, maxDays) {
  var me = auth_(token);
  need_(isAdmin_(me), 'Only admin can change payment terms.');
  var days = Number(maxDays) || 60;
  need_(DEF.creditDays.indexOf(days) >= 0, 'Credit can be allowed for 15, 30, 45 or 60 days.');
  var list = (Array.isArray(allow) ? allow : []).filter(function (k) { return DEF.payAllow[k]; }).map(function (k) { return k === 'credit' ? 'credit:' + days : k; });
  return withLock_(function () {
    var c = get_('cust', String(custId), 'Customer');
    c.payAllow = list.join(',');
    save_('cust', [c]);
    log_('ADMIN', c.id, me, c.shop + ' may pay: ' + termsFor(c).join(', '));
    return { cust: c };
  });
}

/** Cancel (with a reason, only before dispatch), reopen a cancelled order at the step it stopped, or (admin) repair a broken step. */
function setOrderStatus(token, id, status, note) {
  var u = auth_(token), boss = isBoss_(u);
  need_(status === 'CANCELLED' || status === 'REOPEN' || status === 'REPAIR', 'Bad status.');
  note = str_(note, 300);
  var res = withLock_(function () {
    var o = get_('orders', String(id), 'Order'), st = orderStage(o), now = Date.now(), S = getSettings_(), info;
    if (status === 'CANCELLED') {
      need_(DEF.orderSteps[st], 'This order is already closed.');
      need_(boss || (o.byId === u.id && !o.confirmedAt), 'Only admin / manager can cancel a confirmed order.');
      need_(stepIdx_(st) <= stepIdx_('DISPATCH'), 'The material is already dispatched — this order cannot be cancelled. Use “Returned” on the delivery step, or close the balance short.');
      need_(note, 'Give a reason for cancelling.');
      o.cancelReason = note; o.cancelledFrom = st;
      moveTo_(o, 'CANCELLED', u, now);
      info = 'Cancelled at “' + stepLabel(st, S) + '” — ' + note + (paidOf_(o) > 0 ? ' · refund due ' + inr_(paidOf_(o)) : '');
      hist_(o, 'CANCELLED', u, now, info);
    } else if (status === 'REOPEN') {
      need_(boss, 'Only admin / manager can reopen an order.');
      need_(st === 'CANCELLED', 'Only a cancelled order can be reopened.');
      o.status = DEF.orderSteps[o.cancelledFrom] ? o.cancelledFrom : 'CONFIRM'; o.cancelReason = '';
      var to = rightStage_(o);
      moveTo_(o, to, u, now);
      info = 'Reopened at “' + stepLabel(to, S) + '”' + (note ? ' — ' + note : '');
      hist_(o, 'REOPEN', u, now, info);
    } else {
      need_(isAdmin_(u), 'Only admin can repair an order’s step.');
      need_(!DEF.orderEnd[st], 'This order is closed.');
      var to2 = deriveStage_(o);
      moveTo_(o, to2, u, now);
      info = 'Step “' + st + '” → “' + stepLabel(to2, S) + '” (worked out from the order’s details)' + (note ? ' — ' + note : '');
      hist_(o, 'REPAIR', u, now, info);
    }
    o.paid = paidOf_(o); o.balance = balanceOf_(o);
    save_('orders', [o]);
    log_('ORDER', o.id, u, info);
    return { order: o };
  });
  notifyStep_(res.order, u);
  return res;
}

/* ================================================================ products */

function saveProduct(token, d) {
  var u = auth_(token);
  need_(isBoss_(u), 'Only admin or manager can change products.');
  return withLock_(function () {
    var p = d.id ? get_('prod', d.id, 'Product') : { id: nextId_('P', 'P', 3), active: true };
    p.name = str_(d.name, 120); need_(p.name, 'Product name is required.');
    ['series', 'color', 'finish', 'thickness', 'size', 'unit'].forEach(function (k) { p[k] = str_(d[k], 80); });
    p.desc = str_(d.desc, 3000); p.pitch = str_(d.pitch, 3000);
    p.priceFrom = num_(d.priceFrom); p.priceTo = num_(d.priceTo);
    p.photos = (Array.isArray(d.photos) ? d.photos : []).map(https_).filter(String).slice(0, 12);
    p.pdf = https_(d.pdf); p.video = https_(d.video);
    if (d.active !== undefined) p.active = !!d.active;
    p.updatedBy = u.name;
    save_('prod', [p]);
    log_('PRODUCT', p.id, u, (d.id ? 'Edited: ' : 'New: ') + p.name);
    return { prod: p };
  });
}

function deleteProduct(token, id, reason) {
  var u = auth_(token);
  need_(isAdmin_(u), 'Only admin can delete a product. (Managers can switch it off instead.)');
  return softDelete_('prod', id, u, reason, 'Product');
}

/* ================================================================ uploads (photos, videos, PDFs) */

var UP_DIRECT = 5 * 1024 * 1024, UP_MAX = 100 * 1024 * 1024, UP_CHUNK = 8 * 1024 * 1024; // chunk: multiple of 256 KB (Drive rule)

function safeName_(s) { return String(s || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120); }

/** Small file (≤ 5 MB) in one call → Drive link. */
function uploadMedia(token, name, mime, b64) {
  var u = auth_(token);
  var file = uploadFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime || 'application/octet-stream', safeName_(u.username + '_' + name)));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { url: file.getUrl(), id: file.getId() };
}

/** Bigger files (videos, PDFs): Drive resumable upload, relayed in 8 MB pieces. */
function bigUploadStart(token, name, mime, size) {
  var u = auth_(token);
  size = Number(size);
  need_(size > 0, 'That file is empty.');
  need_(size <= UP_MAX, 'Files can be up to 100 MB. This one is ' + Math.ceil(size / 1048576) + ' MB — record a shorter video.');
  var meta = { name: safeName_(u.username + '_' + name), mimeType: String(mime || 'application/octet-stream'), parents: [uploadFolder_().getId()] };
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'post', contentType: 'application/json; charset=UTF-8', payload: JSON.stringify(meta),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': meta.mimeType, 'X-Upload-Content-Length': String(size) },
    muteHttpExceptions: true
  });
  var h = res.getHeaders() || {}, url = h.Location || h.location;
  need_(res.getResponseCode() === 200 && url, 'Google Drive did not accept the upload (' + res.getResponseCode() + '). Try again.');
  var key = Utilities.getUuid();
  CacheService.getScriptCache().put('bu_' + key, JSON.stringify({ url: url, size: size, got: 0, u: u.id }), 21600);
  return { key: key, chunk: UP_CHUNK };
}

function bigUploadChunk(token, key, offset, b64) {
  var u = auth_(token), cache = CacheService.getScriptCache();
  var st = JSON.parse(cache.get('bu_' + key) || 'null');
  need_(st && st.u === u.id, 'This upload has expired. Attach the file again.');
  need_(Number(offset) === st.got, 'The upload got out of step. Attach the file again.');
  var bytes = Utilities.base64Decode(String(b64 || ''));
  need_(bytes.length, 'Empty piece. Attach the file again.');
  var end = st.got + bytes.length - 1;
  need_(end < st.size, 'The file is larger than announced. Attach it again.');
  var res = UrlFetchApp.fetch(st.url, { method: 'put', contentType: 'application/octet-stream', payload: bytes,
    headers: { 'Content-Range': 'bytes ' + st.got + '-' + end + '/' + st.size }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 308) { st.got = end + 1; cache.put('bu_' + key, JSON.stringify(st), 21600); return { done: false, got: st.got }; }
  if (code === 200 || code === 201) {
    var id = JSON.parse(res.getContentText()).id;
    cache.remove('bu_' + key);
    var file = DriveApp.getFileById(id);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    return { done: true, url: file.getUrl(), id: id };
  }
  throw new Error('Google Drive stopped the upload (' + code + '). Try again.');
}

/* ================================================================ admin: users / lists / settings */

function adminData(token) {
  var u = auth_(token);
  need_(isAdmin_(u));
  return {
    users: load_('users').map(function (x) { var o = publicUser_(x); o.mustChange = !!x.mustChange; return o; }),
    lists: getLists_(), settings: getSettings_(), url: appUrl_(), sheetUrl: ss_().getUrl(),
    tg: { ready: !!tgToken_(), bot: tgBot_(), linked: load_('users').filter(function (x) { return x.active && x.tgChat; }).map(function (x) { return { name: x.name, tg: x.tgName || '', at: x.tgAt || '' }; }) }
  };
}

function saveUserAdmin(token, d) {
  var me = auth_(token);
  need_(isAdmin_(me));
  return withLock_(function () {
    var uname = String(d.username || '').toLowerCase().trim();
    need_(/^[a-z0-9._-]{3,}$/.test(uname), 'Username: at least 3 characters (letters, numbers, . _ -).');
    need_(str_(d.name), 'Name is required.');
    need_(DEF.roles[d.role], 'Pick a role.');
    var clash = userByName_(uname), u = d.id ? find_('users', d.id) : null;
    if (clash && (!u || clash.id !== u.id)) throw new Error('Username already taken.');
    if (!u) {
      need_(String(d.password || '').length >= 6, 'Password must be at least 6 characters.');
      u = newUserObj_(uname, str_(d.name), d.role, d.password, d.mobile);
    } else if (d.password) {
      need_(String(d.password).length >= 6, 'Password must be at least 6 characters.');
      u.salt = Utilities.getUuid().slice(0, 12); u.passHash = hash_(d.password, u.salt); u.mustChange = true;
    }
    if (u.id === me.id) need_(d.role === 'admin' && d.active !== false, 'You cannot remove your own admin access.');
    u.username = uname; u.name = str_(d.name, 60); u.role = d.role; u.mobile = str_(d.mobile, 20); u.areas = str_(d.areas, 300);
    u.active = d.active !== false;
    save_('users', [u]);
    log_('ADMIN', u.id, me, 'User saved: ' + u.username + ' (' + u.role + ')');
    return adminData(token);
  });
}

function saveLists(token, lists) {
  var me = auth_(token);
  need_(isBoss_(me), 'Only admin or manager can change the lists.');
  var out = {};
  Object.keys(DEF.defaults.lists).forEach(function (k) {
    var seen = {};
    out[k] = (Array.isArray(lists[k]) ? lists[k] : getLists_()[k]).map(function (x) { return str_(x, 80); })
      .filter(function (x) { var key = x.toUpperCase(); if (!x || seen[key]) return false; seen[key] = 1; return true; });
  });
  return withLock_(function () {
    setCfg_('lists', out);
    bumpVersion_(); PropertiesService.getScriptProperties().setProperty('FULL', String(Date.now()));
    log_('ADMIN', '', me, 'Lists updated');
    return { lists: out };
  });
}

/** Per-category questions on the customer form (admin / manager). */
function saveForms(token, forms, kind) {
  var calls = kind === 'call';
  var me = auth_(token);
  need_(isBoss_(me), 'Only admin or manager can change the customer forms.');
  need_(forms && typeof forms === 'object' && !Array.isArray(forms), 'Bad form settings.');
  var out = {};
  Object.keys(forms).slice(0, 60).forEach(function (cat) {
    var name = str_(cat, 80), seen = {};
    if (!name || !Array.isArray(forms[cat])) return;
    out[name] = forms[cat].slice(0, 30).map(function (f) {
      var k = str_(f.k, 24).replace(/[^a-z0-9_]/gi, '').toLowerCase();
      need_(k && !seen[k], 'Each question needs its own key (' + name + ').');
      seen[k] = 1;
      var x = { k: k, l: str_(f.l, 80), t: DEF.fieldTypes[f.t] ? f.t : 'text' };
      need_(x.l, 'Every question in “' + name + '” needs a label.');
      if (x.t === 'select' || x.t === 'multi') {
        var so = {};
        x.o = (Array.isArray(f.o) ? f.o : String(f.o || '').split(',')).map(function (o) { return str_(o, 60); })
          .filter(function (o) { var u = o.toUpperCase(); if (!o || so[u]) return false; so[u] = 1; return true; }).slice(0, 40);
        need_(x.o.length, '“' + x.l + '” (' + name + ') needs at least one option.');
      }
      if (f.r) x.r = true;
      return x;
    });
  });
  return withLock_(function () {
    setCfg_(calls ? 'callForms' : 'forms', out);
    bumpVersion_(); PropertiesService.getScriptProperties().setProperty('FULL', String(Date.now()));
    log_('ADMIN', '', me, calls ? 'Call questions updated' : 'Customer forms updated');
    return { forms: out };
  });
}

function saveSettings(token, s) {
  var me = auth_(token);
  need_(isAdmin_(me), 'Only admin can change the rules.');
  var cur = getSettings_();
  if (s.gstPct !== undefined && s.gstPct !== '') { var gp = Number(s.gstPct); need_(gp >= 0 && gp <= 40, 'GST must be 0–40%.'); s.gstPct = gp; }
  if (s.invTolPct !== undefined && s.invTolPct !== '') { var tp = Number(s.invTolPct); need_(tp >= 0 && tp <= 20, 'Invoice difference allowed must be 0–20%.'); s.invTolPct = tp; }
  if (s.slabSqft !== undefined && s.slabSqft !== '') { var sq = Number(s.slabSqft); need_(sq > 0 && sq < 1000, '1 slab must be between 0 and 1000 sq ft.'); s.slabSqft = sq; }
  ['premiumFrom', 'economyBelow', 'gpsRadius', 'gpsMaxAcc', 'mediaMaxAge', 'maxSpeed', 'dailyTarget', 'slabSqft', 'gstPct', 'invTolPct'].forEach(function (k) {
    if (s[k] !== undefined && s[k] !== '') { var n = Number(s[k]); need_(!isNaN(n) && n >= 0, 'Invalid number for ' + k); cur[k] = n; }
  });
  need_(cur.economyBelow <= cur.premiumFrom, '“Economy below” must be lower than “Premium from”.');
  if (s.segScore) DEF.segments.forEach(function (g) { cur.segScore[g] = Math.max(0, Math.min(5, Number(s.segScore[g]) || 0)); });
  if (s.rateUnit !== undefined) cur.rateUnit = str_(s.rateUnit, 20) || '₹/sq ft';
  if (s.ownBrand !== undefined) cur.ownBrand = str_(s.ownBrand, 60);
  if (s.orderTat) {
    var tat = {};
    Object.keys(DEF.defaults.settings.orderTat).forEach(function (k) {
      var n = s.orderTat[k] === '' || s.orderTat[k] == null ? DEF.defaults.settings.orderTat[k] : Number(s.orderTat[k]);
      need_(!isNaN(n) && n >= 0 && n <= 2000, 'Hours for “' + DEF.orderSteps[k].l + '” must be 0–2000.'); tat[k] = n;
    });
    cur.orderTat = tat;
  }
  if (s.digestAt !== undefined) { need_(/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.digestAt)), 'Daily list time must look like 09:00.'); cur.digestAt = String(s.digestAt); }
  ['tgSteps', 'tgLate', 'tgDigest'].forEach(function (k) { if (s[k] !== undefined) cur[k] = !!s[k]; });
  return withLock_(function () {
    setCfg_('settings', cur);
    bumpVersion_(); PropertiesService.getScriptProperties().setProperty('FULL', String(Date.now()));
    log_('ADMIN', '', me, 'Rules updated');
    return { settings: cur };
  });
}

function adminClearCache(token) { need_(isAdmin_(auth_(token))); reloadAll_(); return true; }

/* ================================================================ profile */

function changePassword(token, oldPw, newPw) {
  var u = auth_(token);
  need_(hash_(String(oldPw || ''), u.salt) === u.passHash, 'Current password is wrong.');
  need_(String(newPw || '').length >= 6, 'New password must be at least 6 characters.');
  return withLock_(function () {
    var x = get_('users', u.id, 'User');
    x.salt = Utilities.getUuid().slice(0, 12); x.passHash = hash_(newPw, x.salt); x.mustChange = false;
    save_('users', [x]);
    return { token: makeToken_(x) };
  });
}
