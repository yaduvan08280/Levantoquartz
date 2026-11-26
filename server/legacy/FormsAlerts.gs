/**
 * Slabworks Production Forms — grade alerts
 * -----------------------------------------
 * Watches Q.C. Final. When a slab is graded B or C (FORMS_ALERT.GRADES) an
 * alert is raised: a row in "Grade Alerts", a Telegram message to every
 * supervisor, and a red tile in the app. The first supervisor to file a Grade
 * Reporting form closes it. Anything still open after three hours becomes
 * UNATTENDED and shows on the admin page.
 *
 * SETTING IT UP
 *   All of it is in the app: Menu > Notifications. The functions below are the
 *   editor equivalents, kept for when something needs unpicking.
 *
 * WHEN A B OR C WENT THROUGH AND NOTHING HAPPENED
 *   alertWhy()                row by row, why each recent QC entry did or did
 *                             not raise an alert — start here
 *   alertDiag()               the configuration and who is connected
 *   alertResetWatermark()     forget the past; the next entry alerts
 *
 * The scan is deliberately idempotent, and deliberately does not trust its own
 * bookmark. It records the last QC row it dealt with, but also accepts a row
 * whose QC timestamp is recent, because a row-number bookmark can be parked
 * past the end of the data by something as ordinary as an ARRAYFORMULA and
 * then nothing alerts again, silently, forever. Both paths are filtered by the
 * alerts already raised, so neither can double-message the shop floor.
 */

var FALERT_HEADERS = ['Alert ID', 'Raised At', 'Slab Number', 'Grade',
                      'QC Timestamp', 'QC Row', 'Status', 'Expires At',
                      'Handled By', 'Handled At', 'Sections Reported', 'Notified'];

var FALERT_PROP_ROW   = 'SLABWORKS_ALERT_LAST_QC_ROW';
var FALERT_PROP_SINCE = 'SLABWORKS_ALERT_SINCE';

/* ------------------------------------------------------------------ tabs -- */

function fAlertSheet_() {
  var sh = fss_().getSheetByName(FORMS_ALERT.TAB);
  if (!sh) throw new Error('Missing "' + FORMS_ALERT.TAB +
    '" tab. Run createAlertSheets() once from the Apps Script editor.');
  return sh;
}

/** Creates both tabs if missing. Never touches one that already exists. */
function createAlertSheets() {
  var ss = fss_();
  var made = [];

  function make(name, headers, widths) {
    if (ss.getSheetByName(name)) {
      console.log('exists   ' + name + '  — left untouched');
      return;
    }
    var sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#131211').setFontColor('#FFFFFF')
      .setVerticalAlignment('middle').setWrap(true);
    sh.setFrozenRows(1);
    sh.setRowHeight(1, 40);
    headers.forEach(function (h, i) { sh.setColumnWidth(i + 1, widths[i] || 150); });
    /* Same as every other tab the app writes: without the time on the cell the
       dashboard's shift maths collapses onto midnight. */
    sh.getRange('B:B').setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
    sh.getRange('A:A').setNumberFormat('@');          // ids are text, not numbers
    var extra = sh.getMaxColumns() - headers.length;
    if (extra > 0) sh.deleteColumns(headers.length + 1, extra);
    made.push(name);
    console.log('CREATED  ' + name + '  (' + headers.length + ' columns)');
  }

  make(FORMS_ALERT.TAB, FALERT_HEADERS,
       [150, 150, 130, 70, 150, 80, 110, 150, 130, 150, 130, 220]);
  make(FORMS_ALERT.RESPONSE_TAB, fFeedbackHeaders_(),
       [150, 150, 130, 70, 130, 90, 300, 160, 200, 260, 260, 300, 260]);

  console.log('');
  console.log(made.length ? made.length + ' tab(s) created.' : 'Nothing to do.');
  return made;
}

/* ------------------------------------------------------------- the scan -- */

/**
 * The whole watcher. Safe to run by hand, safe to run on a trigger, safe to
 * run twice in the same minute.
 */
function alertScan(catchUpHours) {
  return fWithJobLock_(10000, function () {
    /* Sweep first. An alert whose slab has already been reported is answered,
       whatever its row says, and leaving it open makes the red list ask for
       work that is done — which is how the duplicate reports started. */
    var swept = fSweepReported_();
    var raised = fRaiseNewAlerts_(catchUpHours);
    var expired = fExpireAlerts_();
    if (raised.length || expired || swept) fCache_().remove('alerts_open');
    return { ok: true, raised: raised.length, expired: expired, swept: swept,
             slabs: raised };
  });
}

/**
 * When each slab was last reported on, from the Feedback Response tab.
 *
 * A slab with no report is absent rather than zero, so "has this been
 * reported" and "was it reported before this alert went up" are the same
 * question asked once.
 */
function fReportedAt_() {
  var out = {};
  var sh = fss_().getSheetByName(FORMS_ALERT.RESPONSE_TAB);
  if (!sh) return out;
  var last = sh.getLastRow();
  if (last < 2) return out;

  var hi = fHeaderIdx_(sh);
  var cSlab = fColOf_(hi, 'Slab Number');
  var cTime = fColOf_(hi, 'Timestamp');
  if (cSlab === undefined) return out;

  var from = Math.max(2, last - 5000), n = last - from + 1;
  var slabs = sh.getRange(from, cSlab + 1, n, 1).getValues();
  var times = cTime === undefined ? null : sh.getRange(from, cTime + 1, n, 1).getValues();
  for (var i = 0; i < n; i++) {
    var k = String(slabs[i][0] || '').trim().toUpperCase();
    if (!k) continue;
    var ms = times ? fMs_(times[i][0]) : 0;
    if (out[k] === undefined || ms > out[k]) out[k] = ms;
  }
  return out;
}

/**
 * Close every open alert whose slab has already been reported on.
 *
 * This is the self-healing half. Alerts raised before one-per-slab existed,
 * alerts whose id the form never carried, alerts left open because the report
 * closed only the newest of three — all of them are answered by a row in
 * Feedback Response, and none of them were being closed by anything.
 *
 * The report has to be NEWER than the alert. A slab reported last month and
 * graded B again today needs today's report, and auto-closing that alert
 * because of an old row would hide a real fault.
 */
function fSweepReported_() {
  var sh = fAlertSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;

  var reported = fReportedAt_();
  var anyReported = false;
  for (var k in reported) { anyReported = true; break; }
  if (!anyReported) return 0;

  var from = Math.max(2, last - 2000), n = last - from + 1;
  var rows = sh.getRange(from, 1, n, FALERT_HEADERS.length).getValues();
  var closed = 0, now = new Date();

  for (var i = 0; i < n; i++) {
    if (String(rows[i][6]).toUpperCase() !== 'OPEN') continue;
    var slab = String(rows[i][2] || '').trim().toUpperCase();
    if (!slab) continue;
    var when = reported[slab];
    if (when === undefined) continue;

    /*
     * Compared against the GRADING, not against when the robot noticed it.
     *
     * The alert carries the Q.C. timestamp that caused it (column 5). That is
     * the thing a report answers. Comparing against Raised At instead meant a
     * slab graded at 16:02, reported at 16:34 and re-alerted at 16:42 looked
     * unreported — the report was older than the alert, though it was newer
     * than everything the alert was about. Raised At is the fallback for an
     * alert whose Q.C. cell is blank.
     */
    var about = fMs_(rows[i][4]) || fMs_(rows[i][1]);
    if (when && about && when < about) continue;

    sh.getRange(from + i, 7).setValue('HANDLED');
    if (!String(rows[i][8] || '').trim()) sh.getRange(from + i, 9).setValue('(reported)');
    sh.getRange(from + i, 10).setValue(now).setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
    closed++;
  }
  if (closed) fCache_().remove('alerts_open');
  return closed;
}

/**
 * Why is each slab still in the red list?
 *
 * One line per open alert: when the slab was graded, when the alert went up,
 * when it was last reported on, and the verdict. "no report" means the work
 * is genuinely outstanding. "reported BEFORE the grading" means Q.C. graded it
 * again after the report, so the alert is real and new. Anything else is a
 * bug, and this is where it will be visible.
 */
function alertWhyOpen() {
  var sh = fAlertSheet_();
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) { console.log('No alerts at all.'); return out; }

  var reported = fReportedAt_();
  var from = Math.max(2, last - 2000), n = last - from + 1;
  var rows = sh.getRange(from, 1, n, FALERT_HEADERS.length).getValues();
  var tz = Session.getScriptTimeZone();
  function at(ms) {
    return ms ? Utilities.formatDate(new Date(ms), tz, 'dd/MM HH:mm:ss') : '—';
  }

  for (var i = 0; i < n; i++) {
    if (String(rows[i][6]).toUpperCase() !== 'OPEN') continue;
    var slab = String(rows[i][2] || '').trim().toUpperCase();
    var graded = fMs_(rows[i][4]), raised = fMs_(rows[i][1]);
    var about = graded || raised;
    var done = reported[slab];
    var verdict = done === undefined ? 'no report — genuinely outstanding'
      : (done && about && done < about) ? 'reported BEFORE the grading — graded again since'
      : 'REPORTED AFTER THE GRADING — should have closed; run alertClearReported()';
    out.push(slab + '  grade ' + rows[i][3] +
             '   graded ' + at(graded) + '   raised ' + at(raised) +
             '   reported ' + at(done) + '   ' + verdict);
  }
  if (!out.length) out.push('Nothing is open.');
  out.forEach(function (l) { console.log(l); });
  return out;
}

/**
 * RUN ONCE from the editor to clear the backlog without waiting for the
 * trigger. Prints what it closed.
 */
function alertClearReported() {
  var n = fWithJobLock_(10000, function () { return fSweepReported_(); });
  console.log(n ? n + ' alert(s) closed — already reported.' : 'Nothing to close.');
  return n;
}

/**
 * The real last row of Q.C. Final.
 *
 * NOT getLastRow(). That returns the last row with anything in it anywhere on
 * the sheet, and a tab carrying an ARRAYFORMULA has content hundreds of rows
 * past the last real entry — the formula's own output. The watermark below is
 * a row number, so one reading of getLastRow() that lands on a formula's tail
 * parks the watermark ahead of every future entry and the watcher goes silent
 * for good. That is exactly what happened here. The slab column is typed in by
 * a person, so its last filled cell is the last real entry.
 */
/**
 * Epoch milliseconds from a cell, or 0.
 *
 * Duck-typed rather than `instanceof Date` on purpose: a value that crossed a
 * realm boundary — a sheet read in one context, a test harness, a library —
 * is still a date but fails `instanceof`, and here that failure is silent and
 * means "this row is not recent", which is the difference between alerting and
 * not.
 */
function fMs_(v) {
  if (!v) return 0;
  if (typeof v.getTime === 'function') {
    var n = v.getTime();
    return isNaN(n) ? 0 : n;
  }
  if (typeof v === 'number') return v;
  var d = new Date(v);
  var t = d.getTime();
  return isNaN(t) ? 0 : t;
}

/**
 * Which column on Q.C. Final holds the timestamp.
 *
 * Found by header, not assumed. The whole "is this row recent?" test — the one
 * that catches a row the bookmark has wrongly passed — reads this column, and
 * if it reads the wrong one every timestamp comes back blank, every row looks
 * ancient, and the safety net silently does nothing. Which is precisely what
 * happened. Cached for the run; falls back to FORMS_DISPATCH.qcTimeCol.
 */
function fQcTimeCol_(qc) {
  var D = FORMS_DISPATCH;
  var width = Math.max(qc.getLastColumn(), 1);
  var hdr = qc.getRange(1, 1, 1, width).getValues()[0];
  var names = D.qcTimeHeaders || [];
  for (var n = 0; n < names.length; n++) {
    var want = fTight_(names[n]);
    for (var c = 0; c < hdr.length; c++) {
      if (fTight_(String(hdr[c] || '')) === want) return c + 1;
    }
  }
  /* Nothing named like a timestamp: take the first column after the slab that
     actually holds dates, before giving up on the configured guess. */
  var last = qc.getLastRow();
  if (last >= D.qcFirstRow) {
    var probeFrom = Math.max(D.qcFirstRow, last - 20);
    var probe = qc.getRange(probeFrom, 1, last - probeFrom + 1, width).getValues();
    for (var col = 0; col < width; col++) {
      if (col === D.qcSlabCol - 1) continue;
      for (var r = 0; r < probe.length; r++) {
        if (fMs_(probe[r][col]) && typeof probe[r][col] !== 'string' &&
            typeof probe[r][col] !== 'number') return col + 1;
      }
    }
  }
  return D.qcTimeCol;
}

function fQcLastDataRow_() {
  var D = FORMS_DISPATCH;
  var qc = fss_().getSheetByName(D.qcTab);
  if (!qc) return 0;
  var bottom = qc.getLastRow();
  if (bottom < D.qcFirstRow) return 0;
  var col = qc.getRange(1, D.qcSlabCol, bottom, 1).getValues();
  for (var r = col.length - 1; r >= D.qcFirstRow - 1; r--) {
    if (String(col[r][0] || '').trim()) return r + 1;
  }
  return 0;
}

/**
 * Look at the tail of Q.C. Final and raise an alert for anything new.
 *
 * "New" is decided two ways, and either is enough:
 *   · the row is past the watermark — the normal path, and the cheap one;
 *   · or the row's QC timestamp is recent (MAX_AGE_HOURS) and after this
 *     watcher was installed.
 *
 * The second exists because the first can be silently poisoned: a watermark is
 * a row number, and anything that makes the sheet look longer than it is —
 * an ARRAYFORMULA, a stray value pasted at the bottom, a deleted block — parks
 * it beyond every future entry and nothing ever alerts again, with no error
 * anywhere. The timestamp path notices the row anyway. Both are filtered by
 * the alerts already raised, so neither can double-message the floor.
 */
function fRaiseNewAlerts_(catchUpHours) {
  var D = FORMS_DISPATCH;
  var qc = fss_().getSheetByName(D.qcTab);
  if (!qc) return [];
  var last = fQcLastDataRow_();
  if (last < D.qcFirstRow) return [];

  var props = PropertiesService.getScriptProperties();
  var seenTo = parseInt(props.getProperty(FALERT_PROP_ROW), 10);
  var since  = parseInt(props.getProperty(FALERT_PROP_SINCE), 10) || 0;

  /* First ever run: start from here rather than alerting on five thousand rows
     of history. Nobody wants the bot's first act to be 1,400 messages. */
  if (!since) {
    /* First scan under this build. Reach back a little way rather than exactly
       to this instant: somebody switches alerting on because a bad slab just
       came off the line, and that slab is usually already in the sheet. Two
       hours catches it without announcing a week of history. */
    since = new Date().getTime() - FORMS_ALERT.INSTALL_GRACE_MINUTES * 60000;
    props.setProperty(FALERT_PROP_SINCE, String(since));
  }
  if (!seenTo || seenTo < 1) {
    /* No bookmark at all: set one, but carry on — the grace window above
       decides what, if anything, from just before now is worth announcing. */
    props.setProperty(FALERT_PROP_ROW, String(last));
    seenTo = last;
  }
  /* A watermark past the end of the data is wrong by definition. */
  if (seenTo > last) seenTo = last;

  var freshFrom = Math.max(since, new Date().getTime() -
                                  FORMS_ALERT.MAX_AGE_HOURS * 3600 * 1000);
  /* Catching up on purpose: judge every row by its timestamp alone, over the
     window asked for. The bookmark is put beyond reach rather than to zero —
     zero would make the row-number path admit the entire tail regardless of
     age, which is the opposite of a bounded catch-up. Still deduped by the
     alerts already raised. */
  if (catchUpHours > 0) {
    freshFrom = new Date().getTime() - catchUpHours * 3600 * 1000;
    seenTo = Number.MAX_SAFE_INTEGER;
  }

  /* Always read the tail, not just the part past the watermark — the whole
     point is that the watermark may be lying. */
  var timeCol = fQcTimeCol_(qc);
  var from = Math.max(D.qcFirstRow, last - FORMS_ALERT.SCAN_ROWS + 1);
  var width = Math.max(D.qcSlabCol, D.qcGradeCol, timeCol, 2);
  var rows = qc.getRange(from, 1, last - from + 1, width).getValues();

  var already = fAlertedQcRows_();
  var wanted = {};
  FORMS_ALERT.GRADES.forEach(function (g) { wanted[String(g).trim().toUpperCase()] = true; });

  /*
   * One live alert per slab.
   *
   * Q.C. grades a slab B, the alert goes up; Q.C. looks at it again and grades
   * it B again, and the shop floor got a second alert for the same slab. The
   * red list then showed it twice, a report closed one of them, and the slab
   * stayed in the list looking unreported — so somebody reported it again.
   * That is where the duplicate grade reports came from.
   *
   * The second Q.C. row is still a real row and still reaches the dashboard.
   * It just does not ask for the same report a second time. When the alert is
   * handled or runs out, a later B or C raises a fresh one.
   */
  var openBySlab = fOpenAlertSlabs_();

  /*
   * And when each slab was last reported on.
   *
   * Without this the watcher loops. A report closes the alert; the next scan
   * sees the same Q.C. row, sees no open alert for the slab, and raises it
   * again; the supervisor is refused as a duplicate, which closes it again;
   * the scan after that raises it again. The slab never leaves the red list
   * and the floor is asked for work that was done an hour ago.
   *
   * A report answers the grading it came after. A LATER grading is new work
   * and still alerts — which is the whole point of keeping the timestamps
   * rather than a flag.
   */
  var reportedAt = fReportedAt_();

  var sh = fAlertSheet_();
  var now = new Date();
  var expires = new Date(now.getTime() + FORMS_ALERT.HOURS * 3600 * 1000);
  var out = [], newRows = [];

  for (var i = 0; i < rows.length; i++) {
    var qcRow = from + i;
    if (already[qcRow]) continue;

    var slab = String(rows[i][D.qcSlabCol - 1] || '').trim().toUpperCase();
    if (!slab) continue;
    var grade = String(rows[i][D.qcGradeCol - 1] || '').trim();
    if (!wanted[grade.toUpperCase()]) continue;
    if (openBySlab[slab]) continue;               // already asked for, still live

    var ts = rows[i][timeCol - 1];
    var tsMs = fMs_(ts);
    var isNew = (qcRow > seenTo) || (tsMs && tsMs >= freshFrom);
    if (!isNew) continue;

    /* Reported since this grading: answered, and asking again is the loop. */
    var done = reportedAt[slab];
    if (done !== undefined && (!tsMs || done >= tsMs)) continue;

    var id = 'AL' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyMMddHHmmss') +
             '-' + qcRow;
    newRows.push([id, now, slab, grade, ts || '', qcRow,
                  'OPEN', expires, '', '', 0, '']);
    out.push({ id: id, slab: slab, grade: grade, qcRow: qcRow, expires: expires });
    openBySlab[slab] = true;         // and not again later in this same scan
  }

  props.setProperty(FALERT_PROP_ROW, String(last));
  if (!newRows.length) return [];

  var at = sh.getLastRow() + 1;
  sh.getRange(at, 1, newRows.length, FALERT_HEADERS.length).setValues(newRows);
  sh.getRange(at, 2, newRows.length, 1).setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
  sh.getRange(at, 8, newRows.length, 1).setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);

  /* Notify AFTER the rows are committed. If the send throws, the alerts still
     exist and still show in the app — the opposite order loses them. */
  out.forEach(function (a, i) {
    var sent = fNotifyAlert_(a);
    try { sh.getRange(at + i, 12).setValue(sent); } catch (e) {}
  });
  return out;
}

/**
 * The slabs holding a live alert, read from the sheet.
 *
 * Not fOpenAlerts_ — that answer is cached for twenty seconds, and twenty
 * seconds is long enough for a scan to raise an alert the next scan cannot
 * see, which is exactly the double it is there to prevent.
 */
function fOpenAlertSlabs_() {
  var sh = fAlertSheet_();
  var last = sh.getLastRow();
  var out = {};
  if (last < 2) return out;
  var from = Math.max(2, last - 2000);
  var n = last - from + 1;
  var slab = sh.getRange(from, 3, n, 1).getValues();
  var status = sh.getRange(from, 7, n, 1).getValues();
  var exp = sh.getRange(from, 8, n, 1).getValues();
  var now = new Date().getTime();
  for (var i = 0; i < n; i++) {
    if (String(status[i][0]).toUpperCase() !== 'OPEN') continue;
    var ms = fMs_(exp[i][0]);
    if (ms && ms <= now) continue;                 // expired, just not swept yet
    var k = String(slab[i][0] || '').trim().toUpperCase();
    if (k) out[k] = true;
  }
  return out;
}

/** QC rows that already have an alert, so a rerun cannot double up. */
function fAlertedQcRows_() {
  var sh = fAlertSheet_();
  var last = sh.getLastRow();
  var out = {};
  if (last < 2) return out;
  var from = Math.max(2, last - 2000);
  var vals = sh.getRange(from, 6, last - from + 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    var r = parseInt(vals[i][0], 10);
    if (r) out[r] = true;
  }
  return out;
}

/** Anything OPEN past its expiry becomes UNATTENDED. */
function fExpireAlerts_() {
  var sh = fAlertSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var from = Math.max(2, last - 2000);
  var n = last - from + 1;
  var status = sh.getRange(from, 7, n, 1).getValues();
  var exp = sh.getRange(from, 8, n, 1).getValues();
  var now = new Date().getTime();
  var changed = 0;
  for (var i = 0; i < n; i++) {
    if (String(status[i][0]).toUpperCase() !== 'OPEN') continue;
    var ems = fMs_(exp[i][0]);
    if (!ems || ems > now) continue;
    status[i][0] = 'UNATTENDED';
    changed++;
  }
  if (changed) sh.getRange(from, 7, n, 1).setValues(status);
  return changed;
}

/* --------------------------------------------------------------- reads --- */

/** Every alert that is still live, newest first. */
function fOpenAlerts_() {
  var hit = fCache_().get('alerts_open');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var sh = fAlertSheet_();
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var from = Math.max(2, last - 500);
    var rows = sh.getRange(from, 1, last - from + 1, FALERT_HEADERS.length).getValues();
    var now = new Date().getTime();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][6]).toUpperCase() !== 'OPEN') continue;
      var ms = fMs_(rows[i][7]);
      if (ms && ms <= now) continue;               // expired but not yet swept
      out.push({ id: String(rows[i][0]), slab: String(rows[i][2]),
                 grade: String(rows[i][3]), dueMs: ms,
                 raisedMs: fMs_(rows[i][1]) });
    }
  }
  /* One row per slab in the red list. Raising is now one-per-slab, but the
     sheet already holds slabs with two or three open alerts from before, and
     a list that shows the same slab three times is a list nobody trusts. The
     most urgent one is kept, so the countdown shows the real deadline. */
  var bySlab = {}, single = [];
  out.forEach(function (a) {
    var k = String(a.slab).toUpperCase();
    var prev = bySlab[k];
    if (!prev) { bySlab[k] = a; single.push(a); return; }
    if (a.dueMs && (!prev.dueMs || a.dueMs < prev.dueMs)) {
      single[single.indexOf(prev)] = a;
      bySlab[k] = a;
    }
  });
  out = single;
  fCache_().put('alerts_open', JSON.stringify(out), FORMS_ALERT.CACHE_SECONDS);
  return out;
}

/**
 * Mark every open alert for a slab handled, and say how many there were.
 *
 * fCloseAlert_ below closes one alert by id, which is right when you know the
 * id and wrong when the question is "has this slab been reported". A slab is
 * reported or it is not; it cannot be half reported because Q.C. happened to
 * look at it twice.
 */
function fCloseAlertsForSlab_(slab, who, sections, preferId) {
  slab = String(slab || '').trim().toUpperCase();
  if (!slab) return 0;

  var sh = fAlertSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var from = Math.max(2, last - 2000);
  var rows = sh.getRange(from, 1, last - from + 1, FALERT_HEADERS.length).getValues();

  var hits = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][2]).trim().toUpperCase() !== slab) continue;
    if (String(rows[i][6]).toUpperCase() !== 'OPEN') continue;
    hits.push({ row: from + i, values: rows[i] });
  }
  if (!hits.length) return 0;

  /* The sections reported are counted against the alert the form was opened
     from, or the newest if the form named none — not against all of them, or
     a slab with three alerts would show three times the work. */
  var counted = null;
  if (preferId) {
    for (var k = 0; k < hits.length; k++) {
      if (String(hits[k].values[0]).trim() === String(preferId).trim()) counted = hits[k];
    }
  }
  if (!counted) counted = hits[hits.length - 1];

  var now = new Date();
  hits.forEach(function (h) {
    if (h === counted) {
      var already = parseInt(h.values[10], 10) || 0;
      sh.getRange(h.row, 11).setValue(already + (sections || 0));
    }
    /* With FIRST_CLOSES off the alert stays open on purpose — every
       supervisor may file on the same slab — and only the counter moves. */
    if (!FORMS_ALERT.FIRST_CLOSES) return;
    sh.getRange(h.row, 7).setValue('HANDLED');
    sh.getRange(h.row, 9).setValue(who || '');
    sh.getRange(h.row, 10).setValue(now).setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
  });
  fCache_().remove('alerts_open');
  return FORMS_ALERT.FIRST_CLOSES ? hits.length : 0;
}

/** One alert row by id: {row, values} or null. */
function fFindAlert_(id) {
  id = String(id || '').trim();
  if (!id) return null;
  var sh = fAlertSheet_();
  var last = sh.getLastRow();
  if (last < 2) return null;
  var from = Math.max(2, last - 2000);
  var rows = sh.getRange(from, 1, last - from + 1, FALERT_HEADERS.length).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]).trim() === id) return { row: from + i, values: rows[i] };
  }
  return null;
}

/** The newest live alert for a slab, if there is one. */
function fAlertForSlab_(slab) {
  slab = String(slab || '').trim().toUpperCase();
  if (!slab) return null;
  var open = fOpenAlerts_();
  for (var i = 0; i < open.length; i++) if (open[i].slab.toUpperCase() === slab) return open[i];
  return null;
}

/**
 * Mark an alert handled. Called when a Grade Reporting form is submitted.
 * With FIRST_CLOSES off the alert stays OPEN and only the counter moves.
 */
function fCloseAlert_(id, who, sections) {
  var a = fFindAlert_(id);
  if (!a) return false;
  var sh = fAlertSheet_();
  var already = parseInt(a.values[10], 10) || 0;
  sh.getRange(a.row, 11).setValue(already + (sections || 0));
  if (String(a.values[6]).toUpperCase() !== 'OPEN') return false;
  if (!FORMS_ALERT.FIRST_CLOSES) return false;

  sh.getRange(a.row, 7).setValue('HANDLED');
  sh.getRange(a.row, 9).setValue(who || '');
  sh.getRange(a.row, 10).setValue(new Date())
    .setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
  fCache_().remove('alerts_open');
  return true;
}

/* ---------------------------------------------------------- the trigger -- */

/** RUN ONCE. Installs the five-minute scan. Safe to run again. */
function installAlertTrigger() {
  var gone = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'alertScan') { ScriptApp.deleteTrigger(t); gone++; }
  });
  ScriptApp.newTrigger('alertScan').timeBased().everyMinutes(5).create();
  console.log((gone ? 'Replaced ' + gone + ' existing trigger(s). ' : '') +
              'alertScan now runs every 5 minutes.');
  console.log('A B or C grade will reach Telegram within five minutes of QC ' +
              'saving it. Delete the trigger to stop alerting entirely.');
}

function removeAlertTrigger() {
  var gone = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'alertScan') { ScriptApp.deleteTrigger(t); gone++; }
  });
  console.log('Removed ' + gone + ' trigger(s). Nothing is watching QC now.');
}

/* ------------------------------------------------------------ diagnostic -- */

function alertDiag() {
  var D = FORMS_DISPATCH;
  var ss = fss_();
  var qc = ss.getSheetByName(D.qcTab);
  var al = ss.getSheetByName(FORMS_ALERT.TAB);
  var fb = ss.getSheetByName(FORMS_ALERT.RESPONSE_TAB);

  console.log('grades that alert   : ' + FORMS_ALERT.GRADES.join(', ') +
              (FORMS_ALERT.DIGEST_GRADES.length
                ? '   (digest only: ' + FORMS_ALERT.DIGEST_GRADES.join(', ') + ')' : ''));
  console.log('alert lifetime      : ' + FORMS_ALERT.HOURS + ' hours');
  console.log('first report closes : ' + (FORMS_ALERT.FIRST_CLOSES ? 'yes' : 'no'));
  console.log('');
  console.log('Q.C. Final tab      : ' + (qc ? qc.getLastRow() - 1 + ' rows' : 'MISSING'));
  console.log('Grade Alerts tab    : ' + (al ? al.getLastRow() - 1 + ' rows' : 'MISSING — run createAlertSheets()'));
  console.log('Feedback Response   : ' + (fb ? fb.getLastRow() - 1 + ' rows' : 'MISSING — run createAlertSheets()'));

  var wm = PropertiesService.getScriptProperties().getProperty(FALERT_PROP_ROW);
  console.log('watermark (QC row)  : ' + (wm || 'not set — the first scan will set it'));

  var sup = fUsersByRole_('supervisor');
  var admins = fUsersByRole_('admin');
  console.log('');
  console.log('admins      : ' + (admins.length ? admins.map(function (u) { return u.username; }).join(', ') : 'NONE — set Role=admin on someone'));
  console.log('supervisors : ' + (sup.length ? sup.length : 'NONE — set Role=supervisor on someone'));
  var linked = sup.filter(function (u) { return u.chatId; });
  console.log('  linked to Telegram : ' + linked.length + ' of ' + sup.length);
  sup.forEach(function (u) {
    console.log('    ' + (u.username + '            ').slice(0, 14) +
                (u.chatId ? 'chat ' + u.chatId : 'NOT LINKED — code ' + (u.tgCode || '(none issued)')));
  });

  console.log('');
  var open = fOpenAlerts_();
  console.log('live alerts now     : ' + open.length);
  open.slice(0, 10).forEach(function (a) {
    var mins = Math.round((a.dueMs - new Date().getTime()) / 60000);
    console.log('    ' + a.slab + '  ' + a.grade + '   ' + mins + ' min left');
  });

  var trig = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'alertScan';
  }).length;
  console.log('');
  console.log('scan trigger        : ' + (trig ? 'installed' : 'NOT installed — run installAlertTrigger()'));
  console.log('telegram token      : ' + (fTelegramToken_() ? 'set' : 'NOT set — run telegramSetToken()'));
  return { open: open.length, supervisors: sup.length, linked: linked.length };
}

/* ------------------------------------------------------- why nothing fired */

/**
 * RUN THIS when a B or C went through and nothing happened.
 *
 * alertDiag() says what the watcher is configured to do. This says what it
 * actually saw, row by row, and names the reason each recent QC row did or did
 * not raise an alert — which is the question you actually have.
 */
function alertWhy() {
  var D = FORMS_DISPATCH;
  var qc = fss_().getSheetByName(D.qcTab);
  if (!qc) { console.log('No tab named "' + D.qcTab + '".'); return; }

  var props = PropertiesService.getScriptProperties();
  var sheetBottom = qc.getLastRow();
  var last = fQcLastDataRow_();
  var seenTo = parseInt(props.getProperty(FALERT_PROP_ROW), 10) || 0;
  var since = parseInt(props.getProperty(FALERT_PROP_SINCE), 10) || 0;

  console.log('last row with anything on it : ' + sheetBottom);
  console.log('last row with a slab number  : ' + last);
  if (sheetBottom > last) {
    console.log('  ^ ' + (sheetBottom - last) + ' rows below the data have content — ' +
                'an ARRAYFORMULA, most likely. The watcher ignores them now.');
  }
  console.log('watermark                    : ' + (seenTo || 'not set'));
  if (seenTo > last) {
    console.log('  ^ THIS WAS THE FAULT: the watermark sat past the end of the ' +
                'data, so every new row looked old. It is corrected below.');
  }
  console.log('watching since               : ' +
    (since ? new Date(since).toString() : 'not recorded'));
  console.log('grades that alert            : ' + FORMS_ALERT.GRADES.join(', '));
  console.log('scan trigger                 : ' +
    (fAlertScanInstalled_() ? 'installed' : 'MISSING — nothing is running'));
  console.log('');

  var already = fAlertedQcRows_();
  var wanted = {};
  FORMS_ALERT.GRADES.forEach(function (g) { wanted[String(g).trim().toUpperCase()] = true; });
  var freshFrom = Math.max(since, new Date().getTime() -
                                  FORMS_ALERT.MAX_AGE_HOURS * 3600 * 1000);

  var from = Math.max(D.qcFirstRow, last - 14);
  if (last >= D.qcFirstRow) {
    var timeCol = fQcTimeCol_(qc);
    console.log('timestamp read from column ' +
      String.fromCharCode(64 + timeCol) + ' (' +
      String(qc.getRange(1, timeCol).getValue() || '(no header)') + ')');
    console.log('');
    var width = Math.max(D.qcSlabCol, D.qcGradeCol, timeCol, 2);
    var rows = qc.getRange(from, 1, last - from + 1, width).getValues();
    console.log('The last ' + rows.length + ' Q.C. Final entries:');
    console.log('  row   slab              grade  when              verdict');
    rows.forEach(function (r, i) {
      var qcRow = from + i;
      var slab = String(r[D.qcSlabCol - 1] || '').trim().toUpperCase();
      var grade = String(r[D.qcGradeCol - 1] || '').trim();
      var ts = r[timeCol - 1];
      var tsMs = fMs_(ts);
      var why;
      if (!slab) why = 'no slab number — skipped';
      else if (already[qcRow]) why = 'ALREADY ALERTED';
      else if (!wanted[grade.toUpperCase()]) why = 'grade does not alert';
      else if (qcRow > seenTo) why = 'WOULD ALERT (past the watermark)';
      else if (tsMs && tsMs >= freshFrom) why = 'WOULD ALERT (recent enough)';
      else why = 'too old, and behind the watermark';
      var when = tsMs ? Utilities.formatDate(new Date(tsMs),
                          Session.getScriptTimeZone(), 'dd/MM HH:mm')
                      : 'NO TIMESTAMP';
      console.log('  ' + (qcRow + '     ').slice(0, 6) +
                  (slab + '                  ').slice(0, 18) +
                  (grade + '       ').slice(0, 7) +
                  (when + '                  ').slice(0, 18) + why);
    });
  }

  console.log('');
  console.log('Running the scan now:');
  var r2 = alertScan();
  console.log('  raised ' + (r2.raised || 0) + ', expired ' + (r2.expired || 0));
  (r2.slabs || []).forEach(function (a) {
    console.log('    ' + a.slab + '  ' + a.grade);
  });
  if (!r2.raised) {
    console.log('  Nothing new.');
    console.log('');
    console.log('  If a B or C above should have alerted and says "too old", it ' +
                'was entered');
    console.log('  before alerting was switched on. Run  alertCatchUp(6)  to pick ' +
                'up anything');
    console.log('  from the last six hours that never got an alert.');
  }
}

/**
 * Forget the watermark and start watching from the current last row.
 *
 * The blunt instrument, for when the sheet has been restructured under the
 * watcher. Nothing already in Q.C. Final will alert; the next entry will.
 */
function alertResetWatermark() {
  var last = fQcLastDataRow_();
  var props = PropertiesService.getScriptProperties();
  props.setProperty(FALERT_PROP_ROW, String(last));
  props.setProperty(FALERT_PROP_SINCE, String(new Date().getTime()));
  console.log('Watermark reset to QC row ' + last + '. The next entry alerts.');
  return last;
}

/**
 * RUN THIS to pick up B and C slabs that were graded before alerting was
 * switched on, or that the watcher passed over for any other reason.
 *
 *     alertCatchUp(6)      the last six hours
 *
 * Ignores the bookmark and the install time; honours everything else. A slab
 * that already has a row in "Grade Alerts" is left alone, so running it twice
 * costs nothing and nobody is messaged twice. Supervisors DO get a Telegram
 * message for each one it raises, so pick the window deliberately — six hours
 * of a bad shift is a lot of messages.
 */
function alertCatchUp(hours) {
  var h = Number(hours);
  if (!h || h <= 0) h = 6;
  if (h > 72) h = 72;
  var r = alertScan(h);
  console.log('Looked back ' + h + ' hour(s): raised ' + (r.raised || 0) + '.');
  (r.slabs || []).forEach(function (a) {
    console.log('    ' + a.slab + '  ' + a.grade + '   (QC row ' + a.qcRow + ')');
  });
  if (!r.raised) {
    console.log('Nothing to pick up — every B and C in that window already has ' +
                'an alert, or there were none.');
  }
  return r.raised || 0;
}