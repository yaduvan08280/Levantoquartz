/**
 * ============================================================================
 *  SLABWORKS — grade alerts & Feedback, for the DASHBOARD project
 *  ---------------------------------------------------------------------------
 *  Add this file to the dashboard's Apps Script project, then make the two
 *  small edits to Code.gs described in DASHBOARD-PATCH.md.
 *
 *  It serves one new route:
 *
 *    /exec?api=feedback[&from=yyyy-mm-dd][&to=yyyy-mm-dd]
 *        { ok, open:[…], entries:[…], unattended:[…], range, truncated }
 *
 *  DELIBERATELY SELF-CONTAINED. It reads the two tabs the forms app writes —
 *  "Grade Alerts" and "Feedback Response" — straight from the sheet, and calls
 *  nothing in the forms project. So it works whether you keep the two Apps
 *  Script projects separate or merge them, and a change to the forms code
 *  cannot break the dashboard.
 *
 *  It also does NOT go through the snapshot pipeline. Two reasons: an alert
 *  with a three-hour clock on it should not be up to a minute stale, and
 *  adding the tabs to CFG.TABS would push them into every dashboard payload
 *  for every user, which is a lot of bytes for two small tables that only one
 *  view reads.
 * ============================================================================
 */

var SWFB = {
  ALERT_TAB:    'Grade Alerts',
  RESPONSE_TAB: 'Feedback Response',

  /* There used to be a LIMIT of 200 here, applied to both lists — and the
     page showed the length of each list as its count. So "Slabs reported 200"
     and "Unattended 200" were the ceiling, not the totals, and nothing on the
     screen said so. The lists are now filtered by date range and returned
     whole. MAX_RETURN is a safety ceiling only; if it is ever reached the
     reply says "truncated" and the page says it out loud. */
  MAX_RETURN:   5000,

  /* How far back a read goes, in rows. Alerts and reports both arrive at a
     few dozen a day, so this is years of history in one read. */
  SCAN_ROWS:    20000,

  CACHE_SECONDS: 15           // a burst of dashboard tabs shares one read
};

/* -------------------------------------------------------------- helpers -- */

function swfbSheet_(name) {
  return SpreadsheetApp.openById(CFG.SHEET_ID).getSheetByName(name);
}

/** Header name -> 0-based column index, trimmed, first match wins. */
function swfbHeaders_(sh) {
  var w = Math.max(sh.getLastColumn(), 1);
  var hdr = sh.getRange(1, 1, 1, w).getValues()[0];
  var map = {};
  for (var i = 0; i < hdr.length; i++) {
    var n = String(hdr[i]).trim();
    if (n && map[n] === undefined) map[n] = i;
  }
  return { map: map, width: w };
}

/**
 * Epoch milliseconds from a cell, or 0. Duck-typed rather than instanceof:
 * a Date that has crossed a realm boundary is still a date but fails the
 * test, and here that failure would quietly drop the row from every range.
 */
function swfbMs_(v) {
  if (!v) return 0;
  if (typeof v.getTime === 'function') { var n = v.getTime(); return isNaN(n) ? 0 : n; }
  if (typeof v === 'number') return v;
  var m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  var t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

/** "2026-10-22" or nothing. Anything else in a query string is ignored. */
function swfbDay_(s) {
  s = String(s == null ? '' : s).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * The span of epoch milliseconds a range needs, WIDENED by a day each side.
 *
 * The page counts on the shift day — 08:00 to 08:00, a night belonging to the
 * day it started — so a report filed at 03:00 on the 23rd belongs to the 22nd.
 * Cutting at calendar midnight here would lose it before the page could put
 * it where it belongs. So the server reads generously and the page, which
 * owns the one definition of a shift day, trims exactly.
 */
function swfbSpan_(from, to) {
  function at(day, shift) {
    var p = day.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2] + shift).getTime();
  }
  return { lo: from ? at(from, -1) : 0, hi: to ? at(to, 2) : 0 };
}

function swfbInSpan_(ms, span) {
  if (!span.lo && !span.hi) return true;
  if (!ms) return false;                      // undated rows cannot be placed in a range
  if (span.lo && ms < span.lo) return false;
  if (span.hi && ms >= span.hi) return false;
  return true;
}

/* ---------------------------------------------------------------- reads -- */

/**
 * Live alerts, with the milliseconds left on each. Expiry is computed here
 * rather than trusting the Status column: the forms project sweeps OPEN ->
 * UNATTENDED on a five-minute trigger, so for up to five minutes a row can
 * say OPEN when its time is already up, and showing a dead alert as live is
 * worse than showing nothing.
 */
function swfbOpenAlerts_() {
  var sh = swfbSheet_(SWFB.ALERT_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  var h = swfbHeaders_(sh);
  var last = sh.getLastRow();
  var from = Math.max(2, last - 500);
  var rows = sh.getRange(from, 1, last - from + 1, h.width).getValues();

  function c(row, name) {
    var i = h.map[name];
    return i === undefined ? '' : row[i];
  }

  var now = Date.now(), out = [];
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(c(rows[i], 'Status')).toUpperCase() !== 'OPEN') continue;
    /* swfbMs_, not instanceof Date: a text cell, or a date that has crossed a
       realm, failed that test, came back as "no expiry", and the page drew a
       countdown of half a million hours. */
    var due = swfbMs_(c(rows[i], 'Expires At'));
    if (due && due <= now) continue;                  // over, just not swept yet
    out.push({
      id:    String(c(rows[i], 'Alert ID')),
      slab:  String(c(rows[i], 'Slab Number')),
      grade: String(c(rows[i], 'Grade')),
      dueMs: due,
      notified: String(c(rows[i], 'Notified') || '')
    });
  }
  return out;
}

/** Alerts that ran out of time. This is the list that says whether the whole
    arrangement is working — if it grows, the alert volume has outrun the
    people receiving it. */
function swfbUnattended_(span) {
  var sh = swfbSheet_(SWFB.ALERT_TAB);
  if (!sh || sh.getLastRow() < 2) return { list: [], truncated: false };
  var h = swfbHeaders_(sh);
  var last = sh.getLastRow();
  var from = Math.max(2, last - SWFB.SCAN_ROWS + 1);
  var n = last - from + 1;
  var rows = sh.getRange(from, 1, n, h.width).getDisplayValues();

  /* The raw value of Raised At, for the range test. The display string is
     what the page shows; the number is what decides which day it was. */
  var iRaised = h.map['Raised At'];
  var raw = iRaised === undefined ? null : sh.getRange(from, iRaised + 1, n, 1).getValues();

  function c(row, name) {
    var i = h.map[name];
    return i === undefined ? '' : String(row[i] || '').trim();
  }

  var out = [], truncated = false;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (c(rows[i], 'Status').toUpperCase() !== 'UNATTENDED') continue;
    var ms = raw ? swfbMs_(raw[i][0]) : swfbMs_(c(rows[i], 'Raised At'));
    if (!swfbInSpan_(ms, span)) continue;
    if (out.length >= SWFB.MAX_RETURN) { truncated = true; break; }
    out.push({ id: c(rows[i], 'Alert ID'), when: c(rows[i], 'Raised At'), ms: ms,
               slab: c(rows[i], 'Slab Number'), grade: c(rows[i], 'Grade'),
               notified: c(rows[i], 'Notified') });
  }
  return { list: out, truncated: truncated };
}

/**
 * The reports, one entry per slab with its sections folded in.
 *
 * "Feedback Response" holds a row per SECTION of a slab, so the same slab
 * appears several times; grouping happens here rather than on the client
 * because the client would have to know that shape, and that is the sort of
 * knowledge that goes stale in two places at once.
 */
function swfbEntries_(span) {
  var sh = swfbSheet_(SWFB.RESPONSE_TAB);
  if (!sh || sh.getLastRow() < 2) return { list: [], truncated: false };
  var h = swfbHeaders_(sh);
  var last = sh.getLastRow();
  var from = Math.max(2, last - SWFB.SCAN_ROWS + 1);
  var n = last - from + 1;
  var rows = sh.getRange(from, 1, n, h.width).getDisplayValues();

  var iTs = h.map['Timestamp'];
  var raw = iTs === undefined ? null : sh.getRange(from, iTs + 1, n, 1).getValues();

  function c(row, name) {
    var i = h.map[name];
    if (i === undefined) i = h.map[name + ' '];
    return i === undefined ? '' : String(row[i] || '').trim();
  }

  var bag = {}, order = [];
  for (var i = 0; i < rows.length; i++) {
    var slab = c(rows[i], 'Slab Number');
    if (!slab) continue;
    var ms = raw ? swfbMs_(raw[i][0]) : swfbMs_(c(rows[i], 'Timestamp'));
    if (!swfbInSpan_(ms, span)) continue;
    var key = slab + '|' + c(rows[i], 'Alert ID');
    if (!bag[key]) {
      bag[key] = { slab: slab, grade: c(rows[i], 'Grade'),
                   alertId: c(rows[i], 'Alert ID'), when: c(rows[i], 'Timestamp'),
                   ms: ms, who: c(rows[i], 'Reported By'), sections: [] };
      order.push(key);
    }
    var area = c(rows[i], 'Area Responsible');
    var other = c(rows[i], 'Other Area');
    bag[key].sections.push({
      n: c(rows[i], 'Section'),
      defects: c(rows[i], 'Defects'),
      /* "Other — not in this list" plus a typed name is shown as the typed
         name: the placeholder is not information. */
      area: (other && /^other/i.test(area)) ? other : area,
      reason: c(rows[i], 'Reason'),
      solution: c(rows[i], 'Solution'),
      photos: c(rows[i], 'Photos').split('\n').filter(String),
      videos: c(rows[i], 'Videos').split('\n').filter(String)
    });
  }

  var out = [], truncated = false;
  for (var k = order.length - 1; k >= 0; k--) {
    if (out.length >= SWFB.MAX_RETURN) { truncated = true; break; }
    bag[order[k]].sections.sort(function (a, b) { return (+a.n || 0) - (+b.n || 0); });
    out.push(bag[order[k]]);
  }
  return { list: out, truncated: truncated };
}

/* --------------------------------------------------------------- serving -- */

/**
 * Everything the Feedback view shows.
 *
 *   opts.from, opts.to   "yyyy-mm-dd", either or both. Filters the reports
 *                        and the unattended alerts. Live alerts are never
 *                        filtered — they are live, and at most three hours old.
 */
function swFeedback_(opts) {
  opts = opts || {};
  var from = swfbDay_(opts.from), to = swfbDay_(opts.to);

  var c = CacheService.getScriptCache();
  var key = 'swfb|' + from + '|' + to;
  var hit = c.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var missing = [];
  if (!swfbSheet_(SWFB.ALERT_TAB)) missing.push(SWFB.ALERT_TAB);
  if (!swfbSheet_(SWFB.RESPONSE_TAB)) missing.push(SWFB.RESPONSE_TAB);
  if (missing.length) {
    return { ok: true, open: [], entries: [], unattended: [], now: Date.now(),
             range: { from: from, to: to }, truncated: { entries: false, unattended: false },
             note: 'No ' + missing.join(' or ') + ' tab yet. Run ' +
                   'createAlertSheets() in the forms project.' };
  }

  var span = swfbSpan_(from, to);
  var ent = swfbEntries_(span);
  var un = swfbUnattended_(span);
  var out = {
    ok: true,
    now: Date.now(),
    range: { from: from, to: to },
    open: swfbOpenAlerts_(),
    entries: ent.list,
    unattended: un.list,
    truncated: { entries: ent.truncated, unattended: un.truncated },
    note: ''
  };
  /* A wide range can be more than the cache will hold (100KB a value). That is
     fine — it is simply not cached — so a failed put is not an error. */
  try { c.put(key, JSON.stringify(out), SWFB.CACHE_SECONDS); } catch (e) {}
  return out;
}

/** Read-only check, from the editor. */
function swFeedbackDiag(from, to) {
  var r = swFeedback_({ from: from, to: to });
  console.log('range       : ' + (r.range.from || 'start') + ' -> ' + (r.range.to || 'now'));
  console.log('live alerts : ' + r.open.length);
  r.open.forEach(function (a) {
    console.log('    ' + a.slab + '  ' + a.grade + '   ' +
      (a.dueMs ? Math.round((a.dueMs - Date.now()) / 60000) + ' min left' : 'no expiry') +
      '   ' + a.notified);
  });
  console.log('reported    : ' + r.entries.length + (r.truncated.entries ? '  (TRUNCATED)' : ''));
  console.log('unattended  : ' + r.unattended.length + (r.truncated.unattended ? '  (TRUNCATED)' : ''));
  if (r.note) console.log('NOTE: ' + r.note);
  return r;
}