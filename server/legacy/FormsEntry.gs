/**
 * Slabworks Production Forms — web app entry point
 * ------------------------------------------------
 * THIS FILE EXISTS ONLY IN A STANDALONE FORMS PROJECT.
 *
 * If you paste the forms app into the SAME Apps Script project as the
 * Slabworks dashboard, DELETE THIS FILE — the dashboard's Code.gs already
 * defines doGet(), and two doGet() functions in one project is a fatal
 * collision (the last one loaded silently wins).
 *
 * Instead, add two lines to the dashboard's router:
 *
 *   function doGet(e) {
 *     var p = (e && e.parameter) || {};
 *     if (p.app === 'forms') return formsPage_();      // <-- add this line
 *     if (CFG.TOKEN && p.k !== CFG.TOKEN) return json_({ ok:false, error:'unauthorized' });
 *     ...
 *
 *   function doPost(e) {
 *     if (fIsTelegram_(e)) return fTelegramPost_(e);   // <-- and this one
 *     ...your own doPost, if you have one...
 *   }
 *
 * Operators then use  <your /exec url>?app=forms
 */

function doGet(e) {
  return formsPage_(e);
}

/**
 * Telegram's webhook posts here. Nothing else does, so anything that does not
 * look like a Telegram update is ignored rather than acted on — this endpoint
 * is public by necessity (the bot has to reach it) and the body is written by
 * whoever is messaging the bot.
 */
function doPost(e) {
  if (fIsTelegram_(e)) return fTelegramPost_(e);
  return ContentService.createTextOutput('ok');
}

function fIsTelegram_(e) {
  if (!e || !e.postData || !e.postData.contents) return false;
  try {
    var u = JSON.parse(e.postData.contents);
    return !!(u && (u.update_id !== undefined) && u.message);
  } catch (err) { return false; }
}

function fTelegramPost_(e) {
  try { fTelegramWebhook_(e); } catch (err) { /* never answer Telegram with a 500 */ }
  return ContentService.createTextOutput('ok');
}
