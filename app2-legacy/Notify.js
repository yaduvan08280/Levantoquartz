/**
 * Domestic Marketing — Telegram (same set-up as Leads & Orders).
 *
 *   Bot        Admin ▸ Telegram: the admin pastes the token from @BotFather. It is kept in Script Properties
 *              (TG_TOKEN), never in a sheet and never sent to a page.
 *   Linking    Profile ▸ Connect Telegram → a one-time t.me link → "Start" in the bot.
 *              The bot is read with getUpdates (no webhook) by notifyTick and whenever the page asks.
 *   Messages   · order steps: whoever must do the next step (confirm → admin / managers, other steps → the executive)
 *              · late steps: the person responsible + managers, once per step
 *              · daily work list at 09:00 (time in Admin ▸ Telegram) for everyone who is connected
 *   notifyTick runs every 10 minutes (installed by setup). A Telegram failure never blocks a save.
 */

var TG_API = 'https://api.telegram.org/bot';
var SH_NLOG = 'Notify Log', NLOG_COLS = ['Timestamp', 'User', 'Kind', 'Message', 'Result'];

function tgToken_() { return PropertiesService.getScriptProperties().getProperty('TG_TOKEN') || ''; }
function tgBot_() { return PropertiesService.getScriptProperties().getProperty('TG_BOT') || ''; }
function tgApi_(method, payload) {
  var t = tgToken_();
  if (!t) throw new Error('Telegram is not set up yet (Admin ▸ Telegram).');
  var r = UrlFetchApp.fetch(TG_API + t + '/' + method, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true });
  var j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) {}
  if (!j.ok) throw new Error('Telegram: ' + (j.description || ('HTTP ' + r.getResponseCode())));
  return j.result;
}
function h_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

var _nlog = [];
/** Send to one user (if connected). Never throws. */
function tgTo_(u, html, kind) {
  if (!u || !u.tgChat || !u.active || !tgToken_()) return false;
  var res = 'sent';
  try { tgApi_('sendMessage', { chat_id: u.tgChat, text: String(html).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (e) { res = String(e.message || e).slice(0, 200); }
  _nlog.push([new Date(), u.name, kind || '', String(html).replace(/<[^>]+>/g, '').slice(0, 500), res]);
  return res === 'sent';
}
function flushNlog_() {
  if (!_nlog.length) return;
  try {
    var sh = sheet_(SH_NLOG) || ensureSheet_(SH_NLOG, NLOG_COLS);
    sh.getRange(sh.getLastRow() + 1, 1, _nlog.length, NLOG_COLS.length).setValues(_nlog);
  } catch (e) {}
  _nlog = [];
}
function bosses_() { return load_('users').filter(function (x) { return x.active && (x.role === 'admin' || x.role === 'manager'); }); }
function appLink_() { var u = appUrl_(); return u ? '\n<a href="' + h_(u) + '">Open Domestic Marketing</a>' : ''; }
function tgDate_(ms) { return ms ? Utilities.formatDate(new Date(Number(ms)), TZ, 'dd MMM, HH:mm') : ''; }

/* ---------------------------------------------------------------- linking */

/** Reads what people sent the bot: "/start <code>" connects that person. */
function tgPoll_() {
  if (!tgToken_()) return 0;
  var cache = CacheService.getScriptCache();
  if (cache.get('tg_polling')) return 0;
  cache.put('tg_polling', '1', 25);
  try {
    var P = PropertiesService.getScriptProperties(), off = Number(P.getProperty('TG_OFFSET') || 0), n = 0;
    var ups = tgApi_('getUpdates', off ? { offset: off, timeout: 0, allowed_updates: ['message'] } : { timeout: 0, allowed_updates: ['message'] });
    ups.forEach(function (up) {
      off = Math.max(off, up.update_id + 1);
      var m = up.message;
      if (!m || !m.chat || m.chat.type !== 'private') return;
      var txt = String(m.text || '').trim(), st = /^\/start(?:\s+(\S+))?/.exec(txt);
      try {
        if (st && st[1]) {
          var uid = cache.get('tglink_' + st[1]);
          if (!uid) { tgApi_('sendMessage', { chat_id: m.chat.id, text: 'This link has expired. Open Domestic Marketing → your profile → Connect Telegram again.' }); return; }
          cache.remove('tglink_' + st[1]);
          withLock_(function () {
            var u = get_('users', uid, 'User');
            u.tgChat = String(m.chat.id); u.tgName = [m.from && m.from.first_name, m.from && m.from.last_name].filter(String).join(' ') + (m.from && m.from.username ? ' (@' + m.from.username + ')' : ''); u.tgAt = Date.now();
            save_('users', [u]);
            log_('TELEGRAM', u.id, u, 'Connected ' + u.tgName);
          });
          tgApi_('sendMessage', { chat_id: m.chat.id, parse_mode: 'HTML', text: '✅ Connected to <b>Domestic Marketing</b>.\nYour order steps, late alerts and the 9 AM work list will come here.' });
          n++;
        } else tgApi_('sendMessage', { chat_id: m.chat.id, text: 'I send your work and alerts from Domestic Marketing. To connect, open the app → your profile → Connect Telegram.' });
      } catch (e) { Logger.log('tg reply: ' + e); }
    });
    if (ups.length) P.setProperty('TG_OFFSET', String(off));
    return n;
  } finally { cache.remove('tg_polling'); }
}

/** My Telegram state (poll = read the bot first, right after the person pressed Start). */
function tgStatus(token, poll) {
  var u = auth_(token);
  if (poll) { try { tgPoll_(); } catch (e) {} _mem = {}; u = find_('users', u.id) || u; }
  return { ready: !!tgToken_(), bot: tgBot_(), linked: !!u.tgChat, tg: u.tgName || '', at: u.tgAt || '' };
}
function tgLinkStart(token) {
  var u = auth_(token), bot = tgBot_();
  need_(bot && tgToken_(), 'Telegram is not set up yet. Ask the admin (Admin ▸ Telegram).');
  var code = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  CacheService.getScriptCache().put('tglink_' + code, u.id, 1800);
  return { url: 'https://t.me/' + bot + '?start=' + code, bot: bot };
}
function tgTest(token) {
  var u = auth_(token);
  need_(u.tgChat, 'Connect Telegram first.');
  var ok = tgTo_(u, '👋 Test from <b>Domestic Marketing</b> — your work and alerts will arrive here.', 'test');
  flushNlog_();
  need_(ok, 'Telegram did not accept the message. Press Start in the bot again.');
  return { msg: 'Test message sent to your Telegram.' };
}
function tgUnlink(token) {
  var u = auth_(token);
  return withLock_(function () { var x = get_('users', u.id, 'User'); x.tgChat = ''; x.tgName = ''; x.tgAt = ''; save_('users', [x]); return tgStatus(token); });
}

/** Admin pastes the bot token (from @BotFather). Checked with Telegram, then kept in Script Properties. */
function tgSetToken(token, botToken) {
  var me = auth_(token);
  need_(isAdmin_(me), 'Only admin can set up Telegram.');
  var tok = str_(botToken), P = PropertiesService.getScriptProperties();
  if (!tok) { P.deleteProperty('TG_TOKEN'); P.deleteProperty('TG_BOT'); P.deleteProperty('TG_OFFSET'); return adminData(token); }
  need_(/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(tok), 'That does not look like a bot token. It looks like 123456789:AAH… (from @BotFather).');
  var old = P.getProperty('TG_TOKEN'), bot;
  P.setProperty('TG_TOKEN', tok);
  try { bot = tgApi_('getMe'); tgApi_('deleteWebhook', { drop_pending_updates: false }); }
  catch (e) { if (old) P.setProperty('TG_TOKEN', old); else P.deleteProperty('TG_TOKEN'); throw e; }
  P.setProperty('TG_BOT', bot.username);
  if (old !== tok) P.deleteProperty('TG_OFFSET');
  installNotifyTrigger_();
  log_('ADMIN', '', me, 'Telegram bot @' + bot.username); flushLog_();
  return adminData(token);
}
function installNotifyTrigger_() {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'notifyTick') ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('notifyTick').timeBased().everyMinutes(10).create();
  } catch (e) {}
}

/* ---------------------------------------------------------------- order step messages */

function orderLine_(o) {
  return '<b>' + h_(o.id) + '</b> · ' + h_(o.shop) + (o.total || o.invoiceAmt ? ' · ₹' + Math.round(o.invoiceAmt || o.total).toLocaleString('en-IN') : '');
}
/** Tell whoever has to do the order's new step. */
/** People responsible for an order's step: the owner (if the step is the owner's) + named people; confirm → admin / managers too. */
function respOf_(o, st) {
  var S = getSettings_(), w = whoOf(st, S), out = [], seen = {};
  var add = function (x) { if (x && x.active && !seen[x.id]) { seen[x.id] = 1; out.push(x); } };
  if (w.owner) add(find_('users', o.byId));
  w.users.forEach(function (id) { add(find_('users', id)); });
  if (st === 'CONFIRM' || !out.length) bosses_().forEach(add);
  return out;
}
function notifyStep_(o, by) {
  try {
    if (getSettings_().tgSteps === false || !tgToken_()) return;
    var S = getSettings_(), st = orderStage(o), owner = find_('users', o.byId), head = orderLine_(o) + (o.terms ? ' · ' + h_(o.terms) : '');
    if (st === 'CONFIRM') respOf_(o, st).forEach(function (b) { if (!by || b.id !== by.id) tgTo_(b, '🧾 <b>New order to confirm</b>\n' + head + '\nTaken by ' + h_(o.by) + '\n' + h_(o.itemsText) + appLink_(), 'step'); });
    else if (st === 'DONE') { if (!by || !owner || owner.id !== by.id) tgTo_(owner, '✅ <b>Order completed</b>\n' + head + appLink_(), 'step'); }
    else if (st === 'CANCELLED') { if (!by || !owner || owner.id !== by.id) tgTo_(owner, '✖️ <b>Order cancelled</b>\n' + head + (o.cancelReason ? '\nReason: ' + h_(o.cancelReason) : '') + appLink_(), 'step'); }
    else respOf_(o, st).forEach(function (x) {
      if (by && x.id === by.id) return;
      tgTo_(x, '➡️ <b>Your next step: ' + h_(stepLabel(st, S)) + '</b>\n' + head + (o.due ? '\nDue by ' + tgDate_(o.due) : '') +
        (st === 'BALANCE' ? '\nBalance ₹' + balanceOf_(o).toLocaleString('en-IN') : '') + (by ? '\nPrevious step done by ' + h_(by.name) : '') + appLink_(), 'step');
    });
  } catch (e) { Logger.log('notifyStep: ' + e); }
  flushNlog_();
}

/** A confirmed order was changed (value / terms): tell its owner and whoever has its current step. */
function notifyEdit_(o, by, change) {
  try {
    if (getSettings_().tgSteps === false || !tgToken_()) return;
    var st = orderStage(o), seen = {}, to = [find_('users', o.byId)].concat(DEF.orderSteps[st] ? respOf_(o, st) : []);
    to.forEach(function (x) { if (!x || seen[x.id] || (by && x.id === by.id)) return; seen[x.id] = 1; tgTo_(x, '✏️ <b>Order changed</b>\n' + orderLine_(o) + '\n' + h_(change) + '\nBy ' + h_(by ? by.name : '') + appLink_(), 'edit'); });
  } catch (e) { Logger.log('notifyEdit: ' + e); }
  flushNlog_();
}

/* ---------------------------------------------------------------- every 10 minutes */

function notifyTick() {
  try { tgPoll_(); } catch (e) { Logger.log('poll: ' + e); }
  if (!tgToken_()) return;
  var S = getSettings_();
  try { if (S.tgLate !== false) lateAlerts_(); } catch (e) { Logger.log('late: ' + e); }
  try {
    var now = new Date(), day = Utilities.formatDate(now, TZ, 'yyyyMMdd'), hm = Utilities.formatDate(now, TZ, 'HH:mm'), P = PropertiesService.getScriptProperties();
    if (S.tgDigest !== false && hm >= (S.digestAt || '09:00') && P.getProperty('DIGEST_DAY') !== day) { P.setProperty('DIGEST_DAY', day); dailyDigest_(); }
  } catch (e) { Logger.log('digest: ' + e); }
  flushNlog_();
}

/** A step that ran past its due time: the person responsible (+ managers), once per step. */
function lateAlerts_() {
  var now = Date.now(), late = load_('orders').filter(function (o) { var st = orderStage(o); return DEF.orderSteps[st] && o.due && o.due < now && o.lateSent !== st; });
  if (!late.length) return;
  withLock_(function () {
    late.forEach(function (o) {
      o = find_('orders', o.id); if (!o) return;
      var st = orderStage(o), msg = '⏰ <b>Late: ' + h_(stepLabel(st, getSettings_())) + '</b>\n' + orderLine_(o) + '\nWas due ' + tgDate_(o.due) + ' · ' + h_(o.by) + appLink_();
      var to = respOf_(o, st).concat(bosses_());
      var seen = {}; to.forEach(function (u) { if (u && !seen[u.id]) { seen[u.id] = 1; tgTo_(u, msg, 'late'); } });
      o.lateSent = st;
    });
    save_('orders', late.map(function (o) { return find_('orders', o.id); }).filter(Boolean));
  });
}

/** Everyone's work for today, at 09:00. */
function dailyDigest_() {
  var t0 = new Date(); t0.setHours(0, 0, 0, 0);
  var end = t0.getTime() + DAY_MS, cust = load_('cust').filter(function (c) { return !c.deleted; }), orders = load_('orders'), visits = load_('visits');
  var fmtD = function (ms) { return Utilities.formatDate(new Date(Number(ms)), TZ, 'dd MMM'); };
  var li = function (arr, f, max) { return arr.slice(0, max || 8).map(f).join('\n') + (arr.length > (max || 8) ? '\n… and ' + (arr.length - (max || 8)) + ' more' : ''); };
  load_('users').forEach(function (u) {
    if (!u.active || !u.tgChat) return;
    var boss = u.role === 'admin' || u.role === 'manager', parts = [];
    var vis = cust.filter(function (c) { return c.ownerId === u.id && c.nextFollow && c.nextFollow < end && leadOf(c) !== 'DEAD'; }).sort(function (a, b) { return a.nextFollow - b.nextFollow; });
    if (vis.length) parts.push('📅 <b>Visits (' + vis.length + ')</b>\n' + li(vis, function (c) { return '• ' + h_(c.shop) + ' — ' + h_(c.area || c.city || '') + (c.nextFollow < t0.getTime() ? ' <i>(overdue ' + fmtD(c.nextFollow) + ')</i>' : ''); }));
    var calls = cust.filter(function (c) { return c.nextCallById === u.id && c.nextCall && c.nextCall < end; }).sort(function (a, b) { return a.nextCall - b.nextCall; });
    if (calls.length) parts.push('📞 <b>Calls (' + calls.length + ')</b>\n' + li(calls, function (c) { return '• ' + h_(c.shop) + (c.mobile ? ' — ' + h_(c.mobile) : '') + (c.nextCall < t0.getTime() ? ' <i>(overdue)</i>' : ''); }));
    var mine = orders.filter(function (o) { var st = orderStage(o); return DEF.orderSteps[st] && (boss ? true : o.byId === u.id && st !== 'CONFIRM'); })
      .filter(function (o) { return boss ? orderStage(o) === 'CONFIRM' || (o.due && o.due < Date.now()) || o.byId === u.id : true; })
      .sort(function (a, b) { return (a.due || 9e15) - (b.due || 9e15); });
    if (mine.length) parts.push('🧾 <b>Order steps (' + mine.length + ')</b>\n' + li(mine, function (o) {
      var st = orderStage(o); return '• ' + h_(o.id) + ' ' + h_(o.shop) + ' — ' + h_(DEF.orderSteps[st].l) + (o.due ? (o.due < Date.now() ? ' <i>(late)</i>' : ' · due ' + tgDate_(o.due)) : '');
    }, 10));
    if (boss) {
      var flagged = visits.filter(function (v) { return !v.deleted && v.verify === 'PENDING' && v.flags; }).length;
      var rec = cust.filter(function (c) { return c.standRec === 'Yes' && (!c.standStatus || c.standStatus === 'UNDECIDED'); }).length;
      if (flagged || rec) parts.push('🔎 <b>To review</b>' + (flagged ? '\n• ' + flagged + ' flagged visits' : '') + (rec ? '\n• ' + rec + ' sample stands recommended' : ''));
    }
    var hello = '☀️ <b>Good morning, ' + h_(u.name.split(' ')[0]) + '</b> — your work for ' + Utilities.formatDate(new Date(), TZ, 'EEE dd MMM');
    tgTo_(u, hello + '\n\n' + (parts.length ? parts.join('\n\n') : 'Nothing planned today. Add customers with visit dates, or set call reminders.') + appLink_(), 'digest');
  });
}
