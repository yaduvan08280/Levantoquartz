/**
 * Slabworks Production Forms — Telegram
 * -------------------------------------
 * A bot that tells supervisors a slab has come out B or C, with a link that
 * opens Grade Reporting on their phone with the slab already filled in.
 *
 * SETUP LIVES IN THE APP, NOT IN HERE.
 *   Admin, once:  Menu > Notifications > paste the @BotFather token > Save,
 *                 then "Turn on alert checking".
 *   Everyone else: Menu > Notifications > Connect to Telegram, press START.
 *
 * Nothing below has to be run by hand. Opening the Notifications page makes
 * sure the bot is being polled (see the long note further down on why polling
 * and not a webhook), issues link codes per user, and hands out a t.me link
 * carrying the code. The editor functions still work — telegramDiag() is the
 * one to reach for when the bot is quiet — they are just no longer the way in.
 *
 * WHY THE TOKEN IS NOT IN THIS FILE
 * Anyone who can read the project could otherwise take over the bot and
 * message the whole shop floor. It lives in Script Properties, which is not
 * part of the source and does not travel in the zip.
 */

/* ===================== ↓↓↓  THE ONE PLACE YOU PASTE ANYTHING  ↓↓↓ ======== */
/**
 * Paste the @BotFather token between the quotes, press Run, then CLEAR IT
 * AGAIN and save. Thirty seconds, and the token never stays in the source.
 *
 *     function pasteTelegramToken() {
 *       return telegramSetToken('8123456789:AAH-xxxxxxxxxxxxxxxxxxxxxxxxxxxx');
 *     }                          ^ paste here, Run, then put it back to ''
 *
 * This wrapper exists because the Run button in the Apps Script editor cannot
 * pass an argument to a function — telegramSetToken('…') is not something you
 * can type into the toolbar.
 *
 * PREFER THE OTHER WAY IF YOU CAN: Project Settings (the gear, left-hand side)
 * → Script properties → Add script property
 *       Property   SLABWORKS_TG_TOKEN
 *       Value      the token
 * That stores exactly the same thing and never puts it in a file at all.
 */
function pasteTelegramToken() {
  return telegramSetToken('');
}
/* ===================== ↑↑↑  nothing else needs pasting  ↑↑↑ ============== */

function fTelegramToken_() {
  return PropertiesService.getScriptProperties()
    .getProperty(FORMS_ALERT.TELEGRAM_TOKEN_PROP) || '';
}

/** RUN ONCE with the token from @BotFather. */
function telegramSetToken(token) {
  token = String(token || '').trim();
  if (!token) {
    throw new Error(
      'No token given. Either paste it into pasteTelegramToken() at the top of ' +
      'this file and press Run, or — better — put it in Project Settings > ' +
      'Script properties as SLABWORKS_TG_TOKEN and skip this function entirely.');
  }
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new Error('That does not look like a bot token. It should be digits, ' +
                    'a colon, then a long string — @BotFather sends it to you.');
  }
  PropertiesService.getScriptProperties()
    .setProperty(FORMS_ALERT.TELEGRAM_TOKEN_PROP, token);
  var me = fTgCall_('getMe', {});
  if (!me || !me.ok) throw new Error('Telegram rejected that token.');
  console.log('Token stored. Bot is @' + me.result.username);
  console.log('Next: deploy the web app, then run telegramSetup().');
  return me.result.username;
}

function fTgCall_(method, payload) {
  var token = fTelegramToken_();
  if (!token) return null;
  try {
    var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    return JSON.parse(res.getContentText());
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

/**
 * The old editor route, kept because it is harmless and occasionally handy:
 * makes sure the bot is polled, then prints a link line for every supervisor
 * who has not connected. The Notifications page in the app does all of this
 * by itself now.
 */
function telegramSetup() {
  if (!fTelegramToken_()) {
    throw new Error(
      'No bot token stored yet. Put it in Project Settings > Script properties ' +
      'as SLABWORKS_TG_TOKEN, or paste it into pasteTelegramToken() at the top ' +
      'of FormsTelegram.gs and press Run.');
  }
  /* Validate whichever way it was set — a token typed straight into Script
     properties never went through telegramSetToken's checks. */
  var check = fTgCall_('getMe', {});
  if (!check || !check.ok) {
    throw new Error('Telegram rejected the stored token: ' +
      ((check && check.description) || 'no answer') +
      '. Check SLABWORKS_TG_TOKEN in Project Settings > Script properties.');
  }

  console.log(fTgEnsurePolling_()
    ? 'The bot is polled every minute.'
    : 'Could not install the poll trigger — check the script.scriptapp scope.');

  /* Issue a code to every supervisor who has not linked yet. */
  var sh = fUsersSheet_();
  var data = sh.getDataRange().getValues();
  var cols = fUserCols_(data[0]);
  if (cols[FORMS_USER_EXTRA.tgCode] === undefined) {
    throw new Error('Run setupRolesAndTelegram() first — there is no Telegram Code column.');
  }
  var codeCol = cols[FORMS_USER_EXTRA.tgCode] + 1;

  var me = fTgCall_('getMe', {});
  var botName = (me && me.ok) ? me.result.username : 'your_bot';

  console.log('');
  console.log('Send each supervisor their line. They open the bot and send it as a message.');
  console.log('');
  var n = 0;
  for (var r = 1; r < data.length; r++) {
    var u = fUserFromRow_(data[r], r + 1, cols);
    if (!u.username || !u.active || u.role !== 'supervisor') continue;
    if (u.chatId) { console.log('  ' + fPad_(u.username) + 'already linked'); continue; }
    var code = u.tgCode || fTelegramCode_();
    if (!u.tgCode) sh.getRange(r + 1, codeCol).setValue(code);
    console.log('  ' + fPad_(u.username) + 'https://t.me/' + botName + '?start=' + code +
                '      (or send:  /start ' + code + ' )');
    n++;
  }
  if (!n) console.log('  (nobody to link — set Role=supervisor on some users first)');
  console.log('');
  console.log('Run alertDiag() afterwards to see who has linked.');
  return n;
}

/**
 * Telegram calls this. It is the ONLY thing doPost handles.
 *
 * Everything arriving here is written by whoever is messaging the bot, so it
 * is treated as data: the only thing acted on is a code that matches a row we
 * issued, and nothing else in the message is executed, echoed into the sheet,
 * or trusted.
 *
 * TWO GUARDS AGAINST REPEATING ITSELF
 * Telegram redelivers any update it did not get a clean 200 for, and Apps
 * Script does not reliably give it one — a web app can answer a POST with a
 * redirect, which Telegram counts as a failure. The handler still ran and the
 * reply still went out, so one /start turns into a message every minute for
 * hours. So: every update id is remembered and a repeat is dropped in silence,
 * and on top of that each kind of nudge is sent to a chat at most once every
 * ten minutes. Either one alone would stop the flood; both, because this is
 * the sort of thing that reaches thirty people at once.
 */
function fTelegramWebhook_(e) {
  var update;
  try { update = JSON.parse(e.postData.contents); } catch (err) { return; }
  fTgHandleUpdate_(update);
}

/**
 * One message from the bot, however it reached us — the poller normally, the
 * webhook if this project is ever fronted by something that can answer a POST
 * with a plain 200.
 */
function fTgHandleUpdate_(update) {
  var msg = update && update.message;
  if (!msg || !msg.chat) return;
  if (!fTgFirstSeen_(update.update_id)) return;

  var chatId = msg.chat.id;
  var text = String(msg.text || '').trim();

  /* Already linked? Say so and stop — otherwise someone tapping the button a
     second time gets told their code is wrong, which is how this looked. */
  var linked = fUserByChatId_(chatId);

  /* Three ways in: "/start CODE" (the deep link), "/link CODE", or the code on
     its own. The last matters: t.me/bot?start=CODE only carries the code when
     the chat is brand new. Once you have messaged the bot even once, tapping
     that link just opens the chat and sends nothing, which is why a bare
     /start arrived. Pasting the code has to work. */
  var code = '';
  var m = text.match(/^\/(?:start|link)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/i);
  if (m) code = String(m[1] || '').trim();
  else if (/^[A-Za-z0-9]{6}$/.test(text)) code = text;

  if (!code) {
    if (linked) {
      fTgSay_(chatId, 'already', 'You are already connected, ' +
        (linked.display || linked.username) + '. Nothing to do — alerts will ' +
        'arrive here on their own.');
      return;
    }
    /* One ration for both, on purpose: "/start" then "hello?" is one confused
       person, not two questions deserving two answers. */
    fTgSay_(chatId, 'nudge',
      'Send me your six-character code and you are connected.\n\n' +
      'It is in Slabworks under Menu › Notifications — tap Copy code there, ' +
      'then paste it here as a message.');
    return;
  }

  var u = fUserByTelegramCode_(code);
  if (!u) {
    if (linked) {
      fTgSay_(chatId, 'already', 'You are already connected, ' +
        (linked.display || linked.username) + '.');
      return;
    }
    fTgSay_(chatId, 'badcode',
      'That code is not recognised, or it has already been used.\n\n' +
      'Open Slabworks › Menu › Notifications for a fresh one, then send it ' +
      'here.');
    return;
  }

  fSetChatId_(u.row, chatId);
  /* The code is spent. Leaving it on the row would let anyone who saw it
     redirect this person's alerts to their own chat; Notifications issues a
     fresh one if they ever disconnect. */
  try { fSetTelegramCode_(u.row, ''); } catch (err2) {}
  fTgSend_(chatId, 'Linked. You are ' + (u.display || u.username) + '.\n\n' +
    'You will get a message here whenever Q.C. Final grades a slab ' +
    FORMS_ALERT.GRADES.join(' or ') + '. Each one carries a link that opens ' +
    'the Grade Reporting form with the slab already filled in.');
}

/** True the first time this update id is seen; false for a redelivery. */
function fTgFirstSeen_(updateId) {
  if (updateId === undefined || updateId === null) return true;
  var c = CacheService.getScriptCache();
  var k = 'tgu_' + updateId;
  if (c.get(k)) return false;
  c.put(k, '1', 21600);          // six hours, well past Telegram's retry window
  return true;
}

/**
 * A nudge, at most once per chat per ten minutes.
 *
 * Real answers — "Linked", an alert — always go out. Only the "I did not
 * understand" family is rationed, because that is the one a retry loop turns
 * into spam.
 */
function fTgSay_(chatId, kind, text) {
  var c = CacheService.getScriptCache();
  var k = 'tgsay_' + kind + '_' + chatId;
  if (c.get(k)) return false;
  c.put(k, '1', 600);
  return fTgSend_(chatId, text);
}

/** Who, if anyone, this chat already belongs to. */
function fUserByChatId_(chatId) {
  var id = String(chatId || '').trim();
  if (!id) return null;
  var sh = fUsersSheet_();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var cols = fUserCols_(data[0]);
  if (cols[FORMS_USER_EXTRA.chatId] === undefined) return null;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][cols[FORMS_USER_EXTRA.chatId]] || '').trim() === id) {
      return fUserFromRow_(data[r], r + 1, cols);
    }
  }
  return null;
}

/**
 * THE EMERGENCY BUTTON. Run this if the bot starts repeating itself.
 *
 * Telegram keeps a queue of updates it believes were never delivered and works
 * through it again and again. Nothing on our side can stop that; the queue has
 * to be thrown away, which is what drop_pending_updates does. The webhook is
 * removed at the same time and re-registers itself the next time anybody opens
 * the Notifications page.
 */
function telegramDropPending() {
  var r = fTgCall_('deleteWebhook', { drop_pending_updates: true });
  PropertiesService.getScriptProperties().deleteProperty(FTG_HOOK_PROP);
  console.log(r && r.ok ? 'Queue cleared and the webhook removed. Open Menu > ' +
                          'Notifications in the app and it will register again.'
                        : 'Telegram said: ' + ((r && r.description) || 'nothing'));
  return r;
}

function fTgSend_(chatId, text, keyboard) {
  if (!chatId) return false;
  var payload = { chat_id: String(chatId), text: text, disable_web_page_preview: true };
  if (keyboard) payload.reply_markup = JSON.stringify(keyboard);
  var r = fTgCall_('sendMessage', payload);
  return !!(r && r.ok);
}

/** The web app URL with a slab pre-selected, for the button in the message. */
function fReportLink_(alertId, slab) {
  var url;
  try { url = ScriptApp.getService().getUrl(); } catch (e) { return ''; }
  if (!url) return '';
  return url + '?app=forms&form=gradeReport&slab=' + encodeURIComponent(slab) +
         '&alert=' + encodeURIComponent(alertId);
}

/**
 * Tell every linked supervisor about one alert. Returns a short string that is
 * written onto the alert row, so the sheet records who was actually reached —
 * "nobody was told" is otherwise invisible until someone asks why no report
 * came in.
 */
function fNotifyAlert_(a) {
  if (!FORMS_ALERT.TELEGRAM_ENABLED) return 'telegram off';
  if (!fTelegramToken_()) return 'no token';

  var sup = fAlertAudience_();
  var linked = sup.filter(function (u) { return u.chatId; });
  if (!linked.length) return 'nobody linked (' + sup.length + ' eligible)';

  var link = fReportLink_(a.id, a.slab);
  var text = '⚠ Grade ' + a.grade + '  —  ' + a.slab + '\n\n' +
             'Q.C. Final has graded this slab ' + a.grade + '. Please inspect it and ' +
             'file a Grade Reporting form within ' + FORMS_ALERT.HOURS + ' hours.\n' +
             (link ? '\n' + link : '');

  var kb = link ? { inline_keyboard: [[{ text: 'Open the report form', url: link }]] } : null;

  var ok = 0;
  linked.forEach(function (u) { if (fTgSend_(u.chatId, text, kb)) ok++; });
  return ok + ' of ' + linked.length + ' sent';
}

/** Once someone files, tell the others so nobody photographs the same slab. */
function fNotifyHandled_(a, who) {
  if (!FORMS_ALERT.TELEGRAM_ENABLED || !fTelegramToken_()) return;
  var linked = fAlertAudience_().filter(function (u) { return u.chatId; });
  var text = '✔ ' + a.slab + ' (grade ' + a.grade + ') has been reported by ' +
             who + '. Nothing more needed.';
  linked.forEach(function (u) { fTgSend_(u.chatId, text); });
}

/** Send yourself a test message, to prove the chain works end to end. */
function telegramTest(username) {
  var u = fFindUser_(username);
  if (!u) throw new Error('No user named "' + username + '"');
  if (!u.chatId) throw new Error(u.username + ' has not linked yet — run telegramSetup() ' +
                                 'and have them send the /start line.');
  var ok = fTgSend_(u.chatId,
    'Test from Slabworks. If you can read this, alerts will reach you.');
  console.log(ok ? 'Sent to ' + u.username : 'Telegram refused it — check the token.');
  return ok;
}

/* ======================================================================== */
/*  Self-service linking — what the Notifications page in the app uses      */
/*                                                                          */
/*  Nothing here needs the editor. A supervisor opens Notifications, taps    */
/*  Connect, and Telegram opens on their phone with the code already in the  */
/*  message — tapping START sends "/start ABC123", the webhook below matches  */
/*  the code to their row, and they are linked. The webhook registers itself  */
/*  the first time the page is opened from a deployment, so telegramSetup()   */
/*  is no longer something anyone has to remember.                            */
/* ======================================================================== */

var FTG_HOOK_PROP   = 'SLABWORKS_TG_HOSTED';   // "we have stopped using webhooks"
var FTG_BOT_PROP    = 'SLABWORKS_TG_BOT';
var FTG_OFFSET_PROP = 'SLABWORKS_TG_OFFSET';
var FTG_POLL_FN     = 'telegramPoll';

/** The bot's @username, remembered so every page open is not a round trip. */
function fTgBotName_(force) {
  var props = PropertiesService.getScriptProperties();
  if (!force) {
    var cached = props.getProperty(FTG_BOT_PROP);
    if (cached) return cached;
  }
  var me = fTgCall_('getMe', {});
  if (!me || !me.ok || !me.result || !me.result.username) return '';
  props.setProperty(FTG_BOT_PROP, me.result.username);
  return me.result.username;
}

/* ------------------------------------------------------------------------
 * WHY THIS ASKS TELEGRAM FOR MESSAGES INSTEAD OF BEING TOLD
 *
 * The obvious design is a webhook: register this web app's /exec and let
 * Telegram POST to it. It does not work reliably on Apps Script. A published
 * web app answers a POST with a 302 to script.googleusercontent.com, and
 * Telegram does not follow redirects — it counts the delivery as failed even
 * though the script ran and the reply went out. So every message is retried,
 * for hours, and each retry sends the reply again; and once enough deliveries
 * "fail" Telegram backs off so far that new messages stop arriving at all.
 * Both halves of that were seen on the live bot: a flood, then silence.
 *
 * So the bot is polled instead. A one-minute trigger calls getUpdates with an
 * offset; passing the offset is itself the acknowledgement, so Telegram drops
 * those updates and can never redeliver them. Nothing depends on what HTTP
 * status Apps Script chooses to return. The cost is up to a minute before the
 * bot answers — invisible here, because the only thing anyone sends it is a
 * link code, and the Notifications page waits for the link anyway.
 * ------------------------------------------------------------------------ */

/** The minute trigger. Also safe to run by hand. */
function telegramPoll() {
  if (!fTelegramToken_()) return 0;

  /* The jobs' lock, not the save lock (see fWithJobLock_). */
  var lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return 0;      // a poll is already running; fine
  try {
    var props = PropertiesService.getScriptProperties();
    var offset = parseInt(props.getProperty(FTG_OFFSET_PROP) || '0', 10) || 0;
    var done = 0;

    for (var round = 0; round < 5; round++) {
      var r = fTgCall_('getUpdates', {
        offset: offset, limit: 50, timeout: 0, allowed_updates: ['message']
      });
      if (!r || !r.ok || !r.result || !r.result.length) break;

      r.result.forEach(function (u) {
        if (u && u.update_id >= offset) offset = u.update_id + 1;
        /* One bad message must not stop the rest of the batch, and must not
           stop the offset moving past it — otherwise it is retried forever. */
        try { fTgHandleUpdate_(u); } catch (e) {}
        done++;
      });
      props.setProperty(FTG_OFFSET_PROP, String(offset));
      if (r.result.length < 50) break;
    }

    /* Confirm the offset even when the last batch was short, so Telegram
       clears its queue rather than holding the tail. */
    if (done) fTgCall_('getUpdates', { offset: offset, limit: 1, timeout: 0 });
    return done;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Make sure the bot is being polled: no webhook in the way, and a minute
 * trigger in place. Called from the Notifications page, so it fixes itself
 * without anyone opening the editor. Idempotent and cheap after the first run.
 */
function fTgEnsurePolling_() {
  var props = PropertiesService.getScriptProperties();

  /* getUpdates is refused while a webhook is registered ("Conflict"), so the
     webhook has to go. Done once and remembered. */
  if (props.getProperty(FTG_HOOK_PROP) !== 'polling') {
    var d = fTgCall_('deleteWebhook', { drop_pending_updates: false });
    if (d && d.ok) props.setProperty(FTG_HOOK_PROP, 'polling');
  }

  if (!fTgPollInstalled_()) {
    try {
      ScriptApp.newTrigger(FTG_POLL_FN).timeBased().everyMinutes(1).create();
    } catch (e) { return false; }
  }
  return true;
}

function fTgPollInstalled_() {
  try {
    return ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === FTG_POLL_FN;
    });
  } catch (e) { return false; }
}

/** RUN ONCE from the editor if you would rather not use the app's button. */
function installTelegramPoll() {
  var ok = fTgEnsurePolling_();
  console.log(ok ? 'The bot is polled every minute now.'
                 : 'Could not create the trigger — check the script.scriptapp scope.');
  return ok;
}

function removeTelegramPoll() {
  var gone = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === FTG_POLL_FN) { ScriptApp.deleteTrigger(t); gone++; }
  });
  console.log('Removed ' + gone + ' poll trigger(s). Nobody can link until one is back.');
  return gone;
}

/**
 * THE EMERGENCY BUTTON. Throws away everything Telegram is still holding.
 *
 * With polling this should never be needed — the offset acknowledges each
 * update as it is read. It is kept for the one case it does fix: a backlog
 * left over from the webhook days.
 */
function telegramDropPending() {
  var r = fTgCall_('deleteWebhook', { drop_pending_updates: true });
  var props = PropertiesService.getScriptProperties();
  props.setProperty(FTG_HOOK_PROP, 'polling');
  props.deleteProperty(FTG_OFFSET_PROP);
  /* getUpdates with offset -1 returns only the newest update; stepping past it
     discards the rest without processing any of them. */
  var last = fTgCall_('getUpdates', { offset: -1, limit: 1, timeout: 0 });
  if (last && last.ok && last.result && last.result.length) {
    var next = last.result[last.result.length - 1].update_id + 1;
    props.setProperty(FTG_OFFSET_PROP, String(next));
    fTgCall_('getUpdates', { offset: next, limit: 1, timeout: 0 });
  }
  fTgEnsurePolling_();
  console.log(r && r.ok ? 'Backlog cleared. The bot is polled every minute.'
                        : 'Telegram said: ' + ((r && r.description) || 'nothing'));
  return r;
}

/**
 * What Telegram itself thinks is going on. Run this when the bot is quiet —
 * it is the only view that distinguishes "nothing is asking for messages"
 * from "the token is wrong" from "the trigger is not installed".
 */
function telegramDiag() {
  var tok = fTelegramToken_();
  console.log('token stored       : ' + (tok ? 'yes' : 'NO — set it in Menu > Notifications'));
  if (!tok) return;

  var me = fTgCall_('getMe', {});
  console.log('bot                : ' + (me && me.ok ? '@' + me.result.username
                                                     : 'REJECTED — ' + (me && me.description)));
  var info = fTgCall_('getWebhookInfo', {});
  if (info && info.ok) {
    var w = info.result || {};
    console.log('webhook url        : ' + (w.url ? w.url + '   <-- should be EMPTY when polling'
                                                 : '(none — correct)'));
    console.log('waiting updates    : ' + (w.pending_update_count || 0));
    if (w.last_error_message) {
      console.log('last webhook error : ' + w.last_error_message);
    }
  }
  console.log('poll trigger       : ' + (fTgPollInstalled_() ? 'installed (every minute)'
                                                             : 'MISSING — run installTelegramPoll()'));
  console.log('offset             : ' +
    (PropertiesService.getScriptProperties().getProperty(FTG_OFFSET_PROP) || '0'));
  console.log('');
  console.log('Polling now, to see it work:');
  console.log('  handled ' + telegramPoll() + ' message(s) this run');
}

/**
 * Everything the Notifications page shows one user, and the side effects that
 * make the Connect button work: columns added if missing, webhook registered,
 * and a fresh single-use code issued if they have none.
 */
function fTgSelfStatus_(username, isAdmin) {
  var out = {
    ok: true, eligible: true, admin: !!isAdmin, enabled: !!FORMS_ALERT.TELEGRAM_ENABLED,
    configured: false, linked: false, bot: '', code: '', link: '',
    grades: FORMS_ALERT.GRADES.join(' or '), hours: FORMS_ALERT.HOURS,
    polling: false, scanning: false, error: ''
  };
  if (!out.enabled) return out;

  if (!fTelegramToken_()) return out;
  var bot = fTgBotName_();
  if (!bot) {
    bot = fTgBotName_(true);
    if (!bot) {
      out.error = 'Telegram will not accept the saved bot token. It may have been ' +
                  'revoked in @BotFather.';
      return out;
    }
  }
  out.configured = true;
  out.bot = bot;
  out.polling = !!fTgEnsurePolling_();

  fEnsureUserCols_();
  var u = fFindUser_(username);
  if (!u) { out.error = 'Your row is missing from App Users.'; return out; }

  if (u.chatId) {
    out.linked = true;
  } else {
    var code = u.tgCode || fTelegramCode_();
    if (!u.tgCode) fSetTelegramCode_(u.row, code);
    out.code = code;
    out.link = 'https://t.me/' + bot + '?start=' + code;
  }

  if (isAdmin) {
    out.scanning = fAlertScanInstalled_();
    out.team = fAlertAudience_().map(function (p) {
      return { name: p.display || p.username, role: p.role, linked: !!p.chatId };
    });
  }
  return out;
}

/** Is the five-minute QC watch actually running? */
function fAlertScanInstalled_() {
  try {
    return ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'alertScan';
    });
  } catch (e) { return false; }
}
