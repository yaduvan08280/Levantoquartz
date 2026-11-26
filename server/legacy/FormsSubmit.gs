/**
 * Slabworks Production Forms — submission
 *
 * Two paths:
 *   'form'  POST to the original Google Form endpoint. Rows land exactly as
 *           they do today, so Duplicate Check and every downstream formula
 *           keep working untouched.
 *   'sheet' Append straight to the tab in New Base, mapped by header NAME
 *           (not position), copying any formula columns down.
 *
 * FORMS_SUBMIT_MODE 'auto' tries the form first and falls back to the sheet if the
 * form rejects the post (which happens when a form is set to collect verified
 * email addresses — those refuse anonymous submissions).
 */

var FORMS_SUBMIT_MODE = 'sheet';   // 'auto' | 'form' | 'sheet'
/*
 * 'sheet' is the deployed setting. The app appends the row itself and never
 * contacts Google Forms, so one click can only ever produce one row.
 *
 * Do not switch back to 'auto' or 'form' casually: while a form collects
 * VERIFIED email addresses it refuses an anonymous post, and while it does
 * not, a successful post plus a fallback append is how you get duplicates.
 * fPostForm_ below now detects that properly (see the comment there), but
 * 'sheet' avoids the round-trip entirely and is faster on a phone.
 */

/**
 * What names one entry: the slab, the bundle, or whatever the form nominates
 * through keyField. Used by the audit log and by the value the app echoes back
 * after a save.
 */
function fKeyValue_(form, values) {
  return values.slab || values.slabA || values.slabB || values.bundle ||
         (form && form.keyField ? (values[form.keyField] || '') : '') || '';
}

// ---- visibility ------------------------------------------------------------

function fVis_(cond, values) {
  if (!cond) return true;
  var v = values[cond.field];
  if (cond.in) return cond.in.indexOf(v) !== -1;
  return v === cond.eq;
}

/** Fields that actually apply, given what the operator entered. */
function fVisibleFields_(form, values) {
  var out = [];
  form.sections.forEach(function (sec) {
    if (!fVis_(sec.showWhen, values)) return;
    sec.fields.forEach(function (f) {
      if (!fVis_(f.showWhen, values)) return;
      out.push(f);
    });
  });
  return out;
}

function fValidate_(form, values) {
  /* Grade Reporting's body is generated from the slab diagram, so its fields
     are not in form.sections at all and the generic walk below cannot see
     them. */
  if (form.multiSection) return fValidateFeedback_(values);

  var errors = [];
  fVisibleFields_(form, values).forEach(function (f) {
    var v = values[f.id];
    if (f.type === 'slabgrade') {
      var rows = fDispatchRows_(v);
      if (f.required && !rows.length) errors.push('Select at least one slab.');
      /* A row with no grade would land in the register as a blank cell, and
         nobody downstream can tell a blank from an unanswered question. */
      var noGrade = rows.filter(function (r) { return !r.grade; })
                        .map(function (r) { return r.slab; });
      if (noGrade.length) {
        errors.push(noGrade.length + ' slab' + (noGrade.length === 1 ? ' has' : 's have') +
                    ' no grade: ' + fShortList_(noGrade) + '.');
      }
      return;
    }
    /* Bag Invoice's ticks. Whether each bag really belongs to this supplier
       and is still free is decided by the writer, under the lock, against the
       sheet — this only checks the shape of what arrived. */
    if (f.type === 'bagpick') {
      var bags = fBagList_(v);
      if (f.required && !bags.length) errors.push('Tick at least one bag.');
      var odd = bags.filter(function (b) { return !/^\d+$/.test(b); });
      if (odd.length) errors.push('Not a bag number: ' + fShortList_(odd) + '.');
      return;
    }
    var empty = (v === undefined || v === null || v === '' ||
                 (Array.isArray(v) && !v.length));
    if (empty) {
      if (f.required) errors.push(f.label + ' is required.');
      return;
    }

    /* Numbers arrive as text from a browser, and "12 kg" or "1,240" would be
       written to the sheet verbatim and quietly break every sum built on the
       column. Rejected here rather than coerced: a weight nobody can read is
       not a weight to guess at. */
    if (f.type === 'number') {
      var raw = String(v).trim();
      if (!/^-?\d+(\.\d+)?$/.test(raw)) {
        errors.push(f.label + ' must be a number — "' + raw + '" is not.');
        return;
      }
      var num = Number(raw);
      if (f.integer && raw.indexOf('.') !== -1) {
        errors.push(f.label + ' must be a whole number.');
      }
      if (f.min !== undefined && num < f.min) {
        errors.push(f.label + ' cannot be less than ' + f.min + '.');
      }
      if (f.max !== undefined && num > f.max) {
        errors.push(f.label + ' cannot be more than ' + f.max + '.');
      }
      return;
    }

    /* A date box hands back YYYY-MM-DD and nothing else — but a pasted value,
       an old draft or a hand-built request can hold anything, and a summary
       filed against an unreadable date is a shift that silently never happened
       on the dashboard. */
    if (f.type === 'date') {
      var draw = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draw)) {
        errors.push(f.label + ' must be a date — "' + draw + '" is not.');
        return;
      }
      var dp = draw.split('-'), dd = new Date(+dp[0], +dp[1] - 1, +dp[2]);
      if (dd.getFullYear() !== +dp[0] || dd.getMonth() !== +dp[1] - 1 || dd.getDate() !== +dp[2]) {
        errors.push(f.label + ' is not a real date.');
      }
      return;
    }

    /* A dependent dropdown is checked against the list for the answer actually
       given, not against the union — otherwise a filler code would be accepted
       on a grit bag, which is the one mistake this form exists to prevent. */
    if (f.optionsWhen) {
      var allowed = fAllowedOptions_(form, f, values);
      if (allowed && allowed.length && allowed.indexOf(String(v)) === -1) {
        errors.push(f.label + ' "' + v + '" is not a ' +
          String(values[f.optionsWhen.field] || 'valid') + ' option.');
      }
      return;
    }

    /* A plain dropdown is NOT policed on most forms, and deliberately so: the
       lists have shifted over the years, and a form that starts rejecting a
       value which was correct when the draft was saved is a form that loses
       an operator's work.

       A form opts in with strictOptions when a value off the list would be
       worse than that. The Formula Form does: every supplier code it records
       is looked up by the Costing tab to find a price per kilogram, and a code
       nobody has priced gets no price and no complaint — the formula cost just
       comes out quietly too low, which is the one thing that tab exists to
       rule out. */
    if (form.strictOptions && f.options && f.type !== 'checkbox' &&
        f.options.indexOf(String(v)) === -1) {
      errors.push(f.label + ' "' + v + '" is not on the list.');
    }
  });
  return errors;
}

// ---- path 1: post to the Google Form --------------------------------------

function fEnc_(k, v) {
  return encodeURIComponent(k) + '=' + encodeURIComponent(v);
}

function fBody_(form, values) {
  var parts = [];
  fVisibleFields_(form, values).forEach(function (f) {
    var v = values[f.id];
    if (v === undefined || v === null || v === '') return;

    // Trolley: the checkbox entry depends on which bundle was chosen.
    var entry = f.entry;
    if (form.dynamicBundle && f.id === 'slabs') {
      entry = form.bundleEntries[String(values.bundle || '').trim().toUpperCase()];
      if (!entry) return;
    }
    if (!entry) return;

    if (f.type === 'time') {
      var m = String(v).match(/^(\d{1,2}):(\d{2})/);
      if (!m) return;
      parts.push(fEnc_('entry.' + entry + '_hour', String(parseInt(m[1], 10))));
      parts.push(fEnc_('entry.' + entry + '_minute', String(parseInt(m[2], 10))));
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(function (item) {
        if (item !== '' && item !== null) parts.push(fEnc_('entry.' + entry, item));
      });
      return;
    }
    parts.push(fEnc_('entry.' + entry, v));
  });

  var hist = [];
  for (var i = 0; i < (form.pages || 1); i++) hist.push(i);
  parts.push(fEnc_('fvv', '1'));
  parts.push(fEnc_('pageHistory', hist.join(',')));
  parts.push(fEnc_('fbzx', String(-1 * Math.floor(Math.random() * 9e18))));
  parts.push(fEnc_('submissionTimestamp', String(new Date().getTime())));
  return parts.join('&');
}

/*
 * Whether the post was accepted is decided by WHERE Google redirects to, not
 * by what the page says. Do not go back to searching the response body for
 * "accounts.google.com": every Google page contains that string in its header
 * links, so such a test reports failure even on a successful submission — and
 * with the automatic fallback that means the form row AND an appended row,
 * i.e. every entry duplicated.
 *
 *   accepted -> 302 to docs.google.com/forms/.../formResponse
 *   refused  -> 302 to accounts.google.com  (form collects verified emails)
 */
function fPostForm_(form, values) {
  var res = UrlFetchApp.fetch(form.action, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: fBody_(form, values),
    followRedirects: false,
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var loc = '';
  var h = res.getAllHeaders() || {};
  for (var k in h) if (String(k).toLowerCase() === 'location') loc = String(h[k]);

  if (/accounts\.google\.com/i.test(loc)) {
    return { ok: false, via: 'form', error: 'form requires a signed-in Google account' };
  }
  if (code === 200 || (code >= 300 && code < 400 && /docs\.google\.com/i.test(loc))) {
    return { ok: true, via: 'form' };
  }
  return { ok: false, via: 'form',
           error: 'form returned HTTP ' + code + (loc ? ' -> ' + loc : '') };
}

// ---- path 2: append to the sheet ------------------------------------------

/**
 * The header row, indexed FOUR ways.
 *
 * Why four. These tabs were typed by hand over a year and the spacing in them
 * is not consistent — the Batching tab has "GB1 Quantity Used  (Grit - kg)"
 * with two spaces, "FB1 Supplier Code  (Filler)" with two, and "FB1 Quantity
 * Used ( Filler - kg)" with a space after the bracket. Matching on the exact
 * string meant those three columns were never written: no error, no warning,
 * just a permanently empty column that looks like the operator skipped it.
 * Resin's "Resin Quantity  (B)" was going the same way.
 *
 * So the lookup falls through tiers, widest last:
 *   1  exact
 *   2  exact plus one trailing space   (the old behaviour, kept)
 *   3  runs of whitespace collapsed, case-insensitive
 *   4  all whitespace removed, case-insensitive
 *
 * Tier 4 is what catches "( Filler" — collapsing runs leaves that space where
 * it is. Earlier tiers always win, so a tab whose headers really do differ
 * only by spacing still resolves to the one that matches exactly.
 */
function fHeaderIdx_(sh) {
  /* One read, not two, and only once per tab per save: every call into New
     Base costs two or three seconds while it is busy, and the duplicate check
     and the write used to read the same header row twice each (getLastColumn
     then the row). The whole first row comes back in one call; the width is
     the last header that is filled in. */
  var tabName = sh.getName();
  if (F_HI_MEMO[tabName]) return F_HI_MEMO[tabName];
  var row = sh.getRange(1, 1, 1, sh.getMaxColumns()).getValues()[0];
  return (F_HI_MEMO[tabName] = fHeaderFromRow_(row));
}

/**
 * The row of the tab's newest real entry (1 when there is none).
 *
 * NOT getLastRow() on its own: that counts a spilled ARRAYFORMULA's empty
 * output as content, so on a tab whose formula fills to the bottom of the
 * grid (Batching column C) it returns the grid's last row, hundreds of blank
 * rows below the data. History then showed only blank rows and the
 * SpreadsheetApp writer would have left a gap (20/11/2026). Every entry has a
 * timestamp, typed by the app or by Google Forms, never by a formula — so the
 * last filled Timestamp cell is the last entry.
 *
 * Two calls in the usual case (the row getLastRow names is a real one), three
 * when it lands on a formula's tail.
 */
function fRealLastRow_(sh, hi) {
  var last = sh.getLastRow();
  if (last < 2) return last;
  var ts = fColOf_(hi || fHeaderIdx_(sh), 'Timestamp');
  var cell = sh.getRange(last, (ts === undefined ? 0 : ts) + 1);
  if (String(cell.getValue()) !== '') return last;
  return cell.getNextDataCell(SpreadsheetApp.Direction.UP).getRow();
}

/** The header index built from a header row as read (any trailing blanks). */
function fHeaderFromRow_(row) {
  var width = row.length;
  while (width > 1 && String(row[width - 1] == null ? '' : row[width - 1]).trim() === '') width--;
  var hdr = row.slice(0, Math.max(width, 1));
  var map = {}, loose = {}, tight = {};
  for (var i = 0; i < hdr.length; i++) {
    var raw = String(hdr[i] == null ? '' : hdr[i]);
    var name = raw.trim();
    if (!name) continue;
    if (map[name] === undefined) map[name] = i;             // first match wins
    var l = fLoose_(name);
    if (l && loose[l] === undefined) loose[l] = i;
    var t = fTight_(name);
    if (t && tight[t] === undefined) tight[t] = i;
  }
  return { map: map, loose: loose, tight: tight, width: hdr.length, headers: hdr };
}
/* Per execution only (Apps Script starts every call with this empty), so a
   header renamed between two saves is always seen by the second one. Code
   that writes a header cell itself calls fHeaderChanged_ straight after. */
var F_HI_MEMO = {};
function fHeaderChanged_(sh) { delete F_HI_MEMO[sh.getName()]; }

/** "GB1 Quantity Used  (Grit - kg)" -> "gb1 quantity used (grit - kg)" */
function fLoose_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}
/** "FB1 Quantity Used ( Filler - kg)" -> "fb1quantityused(filler-kg)" */
function fTight_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
}

/**
 * The one place a header name is turned into a column index. Everything that
 * reads or writes a tab goes through here, so a tab with awkward spacing
 * behaves the same for submitting, prefilling, history and the audit.
 */
function fColOf_(hi, name) {
  if (!hi || name == null) return undefined;
  var i = hi.map[name];
  if (i !== undefined) return i;
  i = hi.map[String(name).trim()];
  if (i !== undefined) return i;
  if (hi.loose) {
    i = hi.loose[fLoose_(name)];
    if (i !== undefined) return i;
  }
  if (hi.tight) {
    i = hi.tight[fTight_(name)];
    if (i !== undefined) return i;
  }
  return undefined;
}

/**
 * The cells one entry writes: { cells: {colIndex: value}, tsCol, dateCols }.
 * Shared by the SpreadsheetApp writer below and the Sheets API one
 * (FormsFast.js), so both put exactly the same values in the same columns.
 *
 * Only the cells we actually have a value for are written. Writing a whole
 * row of blanks would drop empty strings into columns that a spilled
 * ARRAYFORMULA owns (Batching column C), turning the formula into #REF!.
 */
function fRowCells_(form, values, who, extra, hi, protectedCols) {
  var cells = {};                                    // 0-based col index -> value

  function colOf(name) { return fColOf_(hi, name); }
  function put(name, val) {
    var i = colOf(name);
    if (i === undefined) return;
    if (protectedCols[i]) return;                    // formula column: never touch
    cells[i] = val;
  }

  var tsCol = colOf('Timestamp');
  put('Timestamp', new Date());

  /* Whoever made the entry, into whichever column this tab actually has.
     Turning off email collection renamed "Email address" to "Email" on some
     tabs, so try each name and stop at the first one that exists. */
  var whoCols = ['Email address', 'Email', 'Username', 'Entered by'];
  for (var wi = 0; wi < whoCols.length; wi++) {
    var wc = fColOf_(hi, whoCols[wi]);
    if (wc !== undefined && !protectedCols[wc]) { cells[wc] = who; break; }
  }

  var dateCols = [];
  fVisibleFields_(form, values).forEach(function (f) {
    var v = values[f.id];
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v = v.join(', ');
    if (form.dynamicBundle && f.id === 'slabs') {
      put(String(values.bundle || '').trim().toUpperCase(), v);
      return;
    }
    /* A date goes in as a real Date, not as the "2026-09-22" the picker hands
       back. The cell then sorts, filters and formats like every other date on
       the sheet, and the dashboard's snapshot rewrites real Date cells from
       their underlying value rather than from however the column happens to
       be displayed. */
    if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
      var dp = String(v).split('-');
      put(f.label, new Date(+dp[0], +dp[1] - 1, +dp[2]));
      var di = colOf(f.label);
      if (di !== undefined) dateCols.push(di);
      return;
    }
    put(f.label, v);
  });
  Object.keys(extra || {}).forEach(function (h) { put(h, extra[h]); });

  /* Oven Out stopped asking for Total Curing Time — the app measures it. */
  if (form.key === 'ovenOut' && FORMS_CFG.OVEN_AUTO_TOTAL) {
    var mins = fOvenElapsed_(values.slab);
    if (mins) put('Total Curing Time', mins);
  }
  return { cells: cells, tsCol: tsCol, dateCols: dateCols };
}

/* `extra` is { header: value } for columns that are not fields — Bag
   Invoice's count, total and difference. */
function fAppendSheet_(form, values, who, extra) {
  var sh = fss_().getSheetByName(form.tab);
  if (!sh) return { ok: false, via: 'sheet', error: 'No tab named "' + form.tab + '"' };

  var hi = fHeaderIdx_(sh);
  var protectedCols = fProtectedCols_(sh, hi);
  var rc = fRowCells_(form, values, who, extra, hi, protectedCols);
  var cells = rc.cells, tsCol = rc.tsCol, dateCols = rc.dateCols;

  return fWithLock_(20000, function () {
    fMark_('prep');
    var target = fRealLastRow_(sh, hi) + 1;        // not getLastRow(): see there
    fMark_('last');
    /* Neighbouring columns go in as one write each (a Batching row is two or
       three of them instead of twenty-five), and a column with no value is
       still never touched — the gaps are where spilled formulas live. */
    var idx = Object.keys(cells).map(Number).sort(function (a, b) { return a - b; });
    for (var k = 0; k < idx.length; ) {
      var from = idx[k], run = [cells[from]];
      while (k + run.length < idx.length && idx[k + run.length] === from + run.length) {
        run.push(cells[idx[k + run.length]]);
      }
      sh.getRange(target, from + 1, 1, run.length).setValues([run]);
      k += run.length;
    }
    fMark_('put');

    /* The Date we wrote carries the time, but a fresh cell can inherit a
       date-only number format — and the dashboard reads getDisplayValues(),
       so a date-only cell silently drops the time and every shift-wise
       calculation collapses onto midnight. Pin the format explicitly. */
    if (tsCol !== undefined) {
      sh.getRange(target, tsCol + 1).setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
    }
    /* And the reverse for a date-only column: inheriting the Timestamp format
       would show a production date as "22/09/2026 00:00:00", which reads like
       a broken timestamp rather than a day. */
    dateCols.forEach(function (i) {
      sh.getRange(target, i + 1).setNumberFormat('dd/MM/yyyy');
    });

    fCopyFormulas_(sh, target, hi.width, protectedCols);
    return { ok: true, via: 'sheet' };
  });
}

/**
 * Columns the app must never write into:
 *   - anything named in FORMS_CFG.NEVER_WRITE
 *   - any column fed by a spilled ARRAYFORMULA (writing a cell inside the
 *     spill range breaks the formula with #REF!)
 * Detected by looking at the formulas in the first two data rows.
 */
function fProtectedCols_(sh, hi) {
  var out = {};
  (FORMS_CFG.NEVER_WRITE || []).forEach(function (name) {
    var i = fColOf_(hi, name);
    if (i !== undefined) out[i] = true;
  });
  fTabFx_(sh, hi.width).prot.forEach(function (c) { out[c] = true; });
  return out;
}

/*
 * Which columns of a tab hold formulas: `prot`, fed by a spilled ARRAYFORMULA
 * (never written), and `copy`, a formula on every row (copied down onto each
 * new row). Read once and cached for ten minutes.
 *
 * This used to be read on every save, and the "copy" half AFTER writing the
 * row — and a read straight after a write makes Apps Script wait until Google
 * has recalculated everything the write touched. That wait was most of what
 * was left of a save. A formula column added to a tab is picked up within ten
 * minutes.
 */
function fTabFx_(sh, width) {
  var key = 'fx_' + sh.getName() + '_' + width;
  var hit = fCache_().get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var out = { prot: [], copy: [] };
  var last = sh.getLastRow();
  if (last >= 2) {
    var head = sh.getRange(2, 1, Math.min(2, last - 1), width).getFormulas();
    head.forEach(function (row) {
      row.forEach(function (f, c) {
        if (/ARRAYFORMULA/i.test(f || '') && out.prot.indexOf(c) === -1) out.prot.push(c);
      });
    });
    if (last >= 3) {
      sh.getRange(last, 1, 1, width).getFormulas()[0].forEach(function (f, c) {
        if (f && !/ARRAYFORMULA/i.test(f) && out.prot.indexOf(c) === -1) out.copy.push(c);
      });
    }
  }
  try { fCache_().put(key, JSON.stringify(out), 600); } catch (e) {}
  return out;
}

/** Copy the per-row formula columns (see fTabFx_) down onto the new row.
    Writes only — nothing here reads the sheet after the row went in. */
function fCopyFormulas_(sh, targetRow, width, protectedCols) {
  if (targetRow < 3) return;
  fTabFx_(sh, width).copy.forEach(function (c) {
    if (protectedCols && protectedCols[c]) return;        // spilled array: leave alone
    sh.getRange(targetRow - 1, c + 1).copyTo(sh.getRange(targetRow, c + 1),
      SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
  });
}

// ---- audit log -------------------------------------------------------------

/*
 * How long a save took, and where, written after "OK" in the log's Result
 * column: "OK · 5.2 s (wait 0.0 · check 1.1 · write 4.1)".
 *   wait   for another save to finish (the script lock)
 *   check  the duplicate guard reading the tab
 *   write  the row going in
 * Saves slowed from five seconds to two minutes in November 2026 with nobody
 * able to say where the time went; this is so the next time it can be read
 * straight off the log. Set by api_submit; "OK" alone when it is not.
 */
var F_T = null;
/* A finer split, in the order they happen: open, head, rows, read (the
   duplicate check) and last, put (the write). Shown after the totals. */
function fMark_(name) {
  if (!F_T) return;
  var now = new Date().getTime();
  (F_T.marks = F_T.marks || []).push([name, now - (F_T.prev || F_T.start)]);
  F_T.prev = now;
}
function fTimingNote_() {
  var t = F_T;
  if (!t || !t.start || !t.write) return '';
  function s(ms) { return (Math.max(0, ms) / 1000).toFixed(1); }
  var lock = t.lock || t.start, check = t.check || lock;
  var marks = (t.marks || []).map(function (m) { return m[0] + ' ' + s(m[1]); }).join(' ');
  return ' · ' + s(t.write - t.start) + ' s (wait ' + s(lock - t.start) +
         ' · check ' + s(check - lock) + ' · write ' + s(t.write - check) + ')' +
         (marks ? ' [' + marks + ']' : '');
}

function fLogSubmit_(form, values, who, result) {
  if (!FORMS_CFG.LOG_TAB) return;
  var line = [new Date(), who, form.title, fKeyValue_(form, values), result.via || '',
              result.ok ? 'OK' + fTimingNote_() : ('FAILED: ' + result.error),
              fLogPayload_(form, values).slice(0, 5000)];
  /* Through the Sheets API when it can (FormsFast.js) — no workbook to open. */
  if (fFastLog_(line)) return;
  try {
    var ss = fss_();
    var sh = ss.getSheetByName(FORMS_CFG.LOG_TAB);
    if (!sh) {
      sh = ss.insertSheet(FORMS_CFG.LOG_TAB);
      sh.appendRow(['Timestamp', 'User', 'Form', 'Key value', 'Delivered via', 'Result', 'Payload']);
      sh.getRange(1, 1, 1, 7).setFontWeight('bold')
        .setBackground('#131211').setFontColor('#FFFFFF');
      sh.setFrozenRows(1);
      sh.getRange('A:A').setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
    }
    sh.appendRow(line);
  } catch (e) { /* logging must never block a submission */ }
}

// ---- repeatable blocks -----------------------------------------------------
/*
 * A form with `repeatSection: true` has one section marked `repeat` — a block
 * the operator can add again and again (Container's materials). The schema
 * holds the block once; the number of copies arrives in
 * values[repeat.countId]. This turns that into an ordinary form with blocks
 * 1..n, ids "design_1", labels "Design Name (1)", so validation, the writer
 * and History all treat it like any other form. The client does the same
 * (expandRepeat in FormsJs.html), so both sides agree on every id.
 */
function fRepeatSec_(form) {
  for (var i = 0; i < form.sections.length; i++) {
    if (form.sections[i].repeat) return form.sections[i];
  }
  return null;
}

function fRepeatCount_(form, values) {
  var sec = fRepeatSec_(form);
  if (!sec) return 0;
  var n = parseInt((values || {})[sec.repeat.countId], 10);
  if (!isFinite(n) || n < 1) n = 1;
  return Math.min(n, sec.repeat.max || 30);
}

function fFormForValues_(form, values) {
  if (!form || !form.repeatSection) return form;
  var n = fRepeatCount_(form, values);
  var out = {};
  Object.keys(form).forEach(function (k) { out[k] = form[k]; });
  out.repeatOf = form.key;
  out.repeatN = n;
  out.sections = [];
  form.sections.forEach(function (sec) {
    if (!sec.repeat) { out.sections.push(sec); return; }
    for (var k = 1; k <= n; k++) {
      out.sections.push({
        title: sec.title + ' ' + k,
        block: k,                                    // a copy of the repeat block
        fields: sec.fields.map(function (fl) {
          var c = {};
          Object.keys(fl).forEach(function (x) { c[x] = fl[x]; });
          c.id = fl.id + '_' + k;
          c.label = fl.label + ' (' + k + ')';
          return c;
        })
      });
    }
  });
  return out;
}

/**
 * The repeatable form's writer: make sure every block has its columns, then
 * write the row like any other. The Google Form behind Container stopped at
 * five blocks, so "Design Name (6)" and on do not exist until somebody first
 * needs them; they are added after the tab's last header, under the lock, so
 * two saves cannot both add them.
 */
function fAppendRepeat_(form, values, who) {
  var sh = fss_().getSheetByName(form.tab);
  if (!sh) return { ok: false, via: 'sheet', error: 'No tab named "' + form.tab + '"' };

  var want = [];
  /* Only the blocks' columns are ever added. Any other question whose column
     is missing is a renamed header, and the writer already skips those
     rather than inventing a column for them. */
  form.sections.forEach(function (sec) {
    if (!sec.block) return;
    sec.fields.forEach(function (fl) { want.push(fl.label); });
  });
  (form.extraHeaders || []).forEach(function (h) { want.push(h); });

  function missing(hi) {
    return want.filter(function (h) { return fColOf_(hi, h) === undefined; });
  }
  if (missing(fHeaderIdx_(sh)).length) {
    fWithLock_(20000, function () {
      fHeaderChanged_(sh);
      var hi = fHeaderIdx_(sh);
      var add = missing(hi);
      if (!add.length) return;
      var at = hi.width;                             // after the last header
      var room = sh.getMaxColumns() - at;
      if (room < add.length) sh.insertColumnsAfter(sh.getMaxColumns(), add.length - room);
      sh.getRange(1, at + 1, 1, add.length).setValues([add]);
      fHeaderChanged_(sh);
      try { fCache_().remove('hdr_' + form.tab); } catch (e) {}
    });
  }

  var extra = {};
  if ((form.extraHeaders || []).indexOf('Number of Materials') !== -1) {
    extra['Number of Materials'] = form.repeatN;
  }
  return fAppendSheet_(form, values, who, extra);
}

// ---- entry point -----------------------------------------------------------

/* deferLog: the caller writes the audit line itself, after releasing the
   lock — appending to a 40,000-row log is a second nobody needs to queue
   behind. */
function fSubmit_(form, values, who, deferLog) {
  var result;
  if (form.multiSection) {
    /* One row per reported section of the slab. */
    result = fAppendFeedback_(form, values, who);
  } else if (form.multiRow) {
    /* One row per slab. There is no Google Form behind this one, so the
       'form' and 'auto' modes have nothing to post to. */
    result = fAppendDispatch_(form, values, who);
  } else if (form.key === 'bagInvoice') {
    /* One row, but only after every bag has been checked against the sheet. */
    result = fAppendBagInvoice_(form, values, who);
  } else if (form.repeatOf) {
    /* One row, with as many material blocks as were added (Container). */
    result = fAppendRepeat_(form, values, who);
  } else if (FORMS_SUBMIT_MODE === 'sheet') {
    result = fAppendSheet_(form, values, who);
  } else {
    result = fPostForm_(form, values);
    if (!result.ok && FORMS_SUBMIT_MODE === 'auto') {
      var first = result.error;
      result = fAppendSheet_(form, values, who);
      result.note = 'Google Form refused the post (' + first + '); written straight to the sheet instead.';
    }
  }
  if (F_T) F_T.write = new Date().getTime();
  if (deferLog) result.logLater = true;
  else fLogSubmit_(form, values, who, result);
  return result;
}

/**
 * RUN ONCE from the editor to fix rows already written.
 *
 * The app has always stored a full Date; some of those cells were left with a
 * date-only display format, which is what the dashboard reads. This stamps the
 * timestamp column of every form tab with the full format. It changes no
 * values — only how they are displayed and therefore exported.
 */
function repairTimestampFormats() {
  var ss = fss_(), fixed = [];
  FORM_KEYS.forEach(function (k) {
    var f = FORM_DEFS[k];
    var sh = ss.getSheetByName(f.tab);
    if (!sh || sh.getLastRow() < 2) return;
    var hi = fHeaderIdx_(sh);
    var i = fColOf_(hi, 'Timestamp');
    if (i === undefined) { fixed.push(f.tab + ': no Timestamp column'); return; }
    sh.getRange(2, i + 1, sh.getLastRow() - 1, 1)
      .setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
    fixed.push(f.tab + ': ' + (sh.getLastRow() - 1) + ' rows');
  });
  if (FORMS_CFG.LOG_TAB) {
    var lg = ss.getSheetByName(FORMS_CFG.LOG_TAB);
    if (lg && lg.getLastRow() > 1) {
      lg.getRange(2, 1, lg.getLastRow() - 1, 1).setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
      fixed.push(FORMS_CFG.LOG_TAB + ': ' + (lg.getLastRow() - 1) + ' rows');
    }
  }
  console.log('Timestamp format set to "' + FORMS_CFG.TIMESTAMP_FORMAT + '"');
  fixed.forEach(function (l) { console.log('  ' + l); });
  return fixed;
}

/**
 * Minutes between a slab's most recent Oven In entry and now — what the
 * operator used to type into "Total Curing Time". Returns 0 when the slab has
 * no Oven In row, in which case the column is simply left blank rather than
 * filled with a wrong number.
 */
function fOvenElapsed_(slab) {
  var want = String(slab == null ? '' : slab).trim().toUpperCase();
  if (!want) return 0;

  var sh = fss_().getSheetByName(FORM_DEFS.ovenIn.tab);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;

  var hi = fHeaderIdx_(sh);
  var tsCol = fColOf_(hi, 'Timestamp');
  var slabCol = fColOf_(hi, 'Slab Number');
  if (tsCol === undefined || slabCol === undefined) return 0;

  var start = Math.max(2, last - FORMS_CFG.OVEN_SCAN_ROWS + 1);
  var rows = sh.getRange(start, 1, last - start + 1, hi.width).getValues();

  var newest = 0;
  for (var r = rows.length - 1; r >= 0; r--) {
    if (String(rows[r][slabCol] || '').trim().toUpperCase() !== want) continue;
    var v = rows[r][tsCol];
    var t = (v instanceof Date) ? v.getTime() : new Date(v).getTime();
    if (!isNaN(t) && t > newest) newest = t;
  }
  if (!newest) return 0;

  var mins = Math.round((Date.now() - newest) / 60000);
  return mins > 0 ? mins : 0;
}

/* ================================================ dispatch: many rows ==== */
/*
 * Every other form writes one row. Dispatch writes one row PER SLAB, with the
 * container number repeated down the block — sixty ticks in the app become
 * sixty rows in the sheet, which is what makes the tab usable as a dispatch
 * register rather than a list of comma-separated blobs.
 *
 * Three things this has to get right:
 *
 *   Column names. The tab that already exists in New Base calls them "Grade"
 *   and "Container/Truck No"; a tab this app generates calls them "Dispatched
 *   Grade" and "Container No.". Both are accepted, so nobody has to rename a
 *   column to make the app work.
 *
 *   Slabs dispatched while the operator was picking. The candidate list is a
 *   snapshot; two people loading it at once can both tick the same slab. The
 *   sheet is re-read inside the lock, and any slab that arrived in the
 *   meantime is skipped and named in the reply rather than written twice.
 *
 *   Writes per column, not per cell. Sixty rows x three columns is a hundred
 *   and eighty setValue round-trips, which times out. One setValues per
 *   column is three.
 */
function fAppendDispatch_(form, values, who) {
  var D = FORMS_DISPATCH;
  var sh = fss_().getSheetByName(form.tab);
  if (!sh) return { ok: false, via: 'sheet', error: 'No tab named "' + form.tab + '"' };

  var picked = fDispatchRows_(values[form.multiRow]);
  if (!picked.length) return { ok: false, via: 'sheet', error: 'No slabs selected.' };

  var container = String(values.container || '').trim();
  var hi = fHeaderIdx_(sh);
  var protectedCols = fProtectedCols_(sh, hi);

  function colOf(names) {
    for (var i = 0; i < names.length; i++) {
      var c = fColOf_(hi, names[i]);
      if (c !== undefined && !protectedCols[c]) return c;
    }
    return undefined;
  }

  var cSlab = colOf(D.slabHeaders);
  var cGrade = colOf(D.gradeHeaders);
  var cCont = colOf(D.containerHeaders);
  var cChanged = colOf(D.changedHeaders);
  var cQcGrade = colOf(D.qcGradeHeaders);
  var cTime = colOf(['Timestamp']);
  var cWho = colOf(['Email address', 'Email', 'Username', 'Entered by']);

  if (cSlab === undefined) {
    return { ok: false, via: 'sheet',
             error: 'The "' + form.tab + '" tab has no ' + D.slabHeaders[0] +
                    ' column. Run createDispatchSheet() to see what it expects.' };
  }

  var skipped = [], nChanged = 0;
  var early = fWithLock_(30000, function () {
    /* Re-read inside the lock: the snapshot the phone was holding may be
       minutes old, and a slab already dispatched must not get a second row. */
    var gone = fDispatchedSet_();
    var rows = picked.filter(function (r) {
      if (gone[r.slab]) { skipped.push(r.slab); return false; }
      return true;
    });
    if (!rows.length) {
      return { ok: false, via: 'sheet',
               error: 'Every slab you selected has already been dispatched (' +
                      fShortList_(skipped) + ').' };
    }

    var target = fRealLastRow_(sh) + 1;
    var n = rows.length;
    var now = new Date();

    /* Read QC ourselves. The browser sent what it was shown minutes ago, and
       an audit column recording "this was overridden" must not be filled in by
       the thing that did the overriding. */
    var qc = (cChanged !== undefined || cQcGrade !== undefined)
      ? fQcGrades_(rows.map(function (r) { return r.slab; }))
      : {};
    var changed = rows.map(function (r) {
      var was = qc[r.slab];
      /* No QC grade at all is not an override — there was nothing to override,
         and marking it "changed" would make the column mean two things. */
      if (!was) return false;
      return String(was) !== String(r.grade);
    });

    function writeCol(c, vals) {
      if (c === undefined) return;
      sh.getRange(target, c + 1, n, 1).setValues(vals.map(function (v) { return [v]; }));
    }
    writeCol(cSlab, rows.map(function (r) { return r.slab; }));
    writeCol(cGrade, rows.map(function (r) { return r.grade; }));
    writeCol(cCont, rows.map(function () { return container; }));
    writeCol(cWho, rows.map(function () { return who; }));
    writeCol(cChanged, changed.map(function (c) { return c ? D.changedWord : ''; }));
    writeCol(cQcGrade, rows.map(function (r, i) { return changed[i] ? qc[r.slab] : ''; }));
    if (cTime !== undefined) {
      writeCol(cTime, rows.map(function () { return now; }));
      sh.getRange(target, cTime + 1, n, 1).setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
    }

    /* If someone later adds a lookup column to this tab — design name from the
       slab, say — pull it down over the whole block, not just the first row. */
    fCopyFormulasBlock_(sh, target, n, hi.width, protectedCols);
    nChanged = changed.filter(Boolean).length;
    return null;
  });
  if (early) return early;           // every slab had already gone out

  fClearDispatchCache_();       // those slabs have left the candidate list

  var notes = [];
  if (skipped.length) {
    notes.push(skipped.length + ' slab' + (skipped.length === 1 ? ' was' : 's were') +
               ' already dispatched and skipped: ' + fShortList_(skipped));
  }
  if (nChanged) {
    notes.push(nChanged === 1
      ? '1 grade differs from Q.C. Final and is marked "' + D.changedWord + '" in the sheet.'
      : nChanged + ' grades differ from Q.C. Final and are marked "' +
        D.changedWord + '" in the sheet.');
  }
  return { ok: true, via: 'sheet', rows: picked.length - skipped.length,
           changed: nChanged, note: notes.join(' ') };
}

/* ============================================== bag invoice: one row ==== */
/*
 * The tick list the phone showed was a snapshot, so every bag is checked
 * again here, inside the lock, against the two tabs themselves:
 *
 *   it is on the Bag Form under THIS material and supplier — a hand-built
 *   request or an old draft cannot put a grit bag on a filler invoice
 *
 *   it is on no invoice yet — two people ticking the same bag at once cannot
 *   both get it
 *
 * Either failure refuses the whole invoice rather than saving the rest: an
 * invoice quietly missing three of its bags reads as complete and its total
 * is wrong. The phone reloads its list and the operator re-ticks.
 *
 * Each bag's weight comes from the Bag Form, never from the phone, and the
 * total and difference are worked out here. Bags heavier than the invoice
 * are SAVED — the phone has already warned and asked — and the reply says so.
 */
function fAppendBagInvoice_(form, values, who) {
  var material = String(values.material || '').trim();
  var supplier = String(values.supplier || '').trim();
  var picked = fBagList_(values.bags);
  if (!picked.length) return { ok: false, via: 'sheet', error: 'No bags ticked.' };

  return fWithLock_(30000, function () {
    /* The tab makes itself the first time an invoice is saved, exactly as
       createBagInvoiceSheet() would — so going live needs no editor run.
       Inside the lock, so two first invoices cannot both try to create it. */
    if (!fss_().getSheetByName(form.tab)) createBagInvoiceSheet();

    var got = fBagRows_();
    if (got.error) return { ok: false, via: 'sheet', error: got.error };
    var m = fDupNorm_(material), s = fDupNorm_(supplier);

    /* this material's bags on the Bag Form: number -> {supplier, weight} */
    var mine = {};
    got.rows.forEach(function (r) {
      if (fDupNorm_(r.material) !== m) return;
      mine[fDupNorm_(r.bag)] = r;               // latest row wins
    });

    var invoiced = fInvoicedBags_();
    var unknown = [], wrongSup = [], taken = [], total = 0;
    picked.forEach(function (b) {
      var r = mine[fDupNorm_(b)];
      if (!r) { unknown.push(b); return; }
      if (fDupNorm_(r.supplier) !== s) { wrongSup.push(b + ' (' + r.supplier + ')'); return; }
      var inv = invoiced[m + '|' + s + '|' + fDupNorm_(b)];
      if (inv) { taken.push(b + ' (invoice ' + inv + ')'); return; }
      total += r.weight;
    });

    var why = [];
    if (unknown.length) why.push('not on the Bag Form as ' + material + ': ' + fShortList_(unknown));
    if (wrongSup.length) why.push('not ' + supplier + ' bags: ' + fShortList_(wrongSup));
    if (taken.length) why.push('already on another invoice: ' + fShortList_(taken));
    if (why.length) {
      return { ok: false, via: 'sheet', refreshBags: true,
               error: 'Some ticked bags cannot go on this invoice — ' + why.join('; ') +
                      '. Nothing was saved; the bag list has been reloaded.' };
    }

    picked.sort(function (a, b) { return Number(a) - Number(b); });
    total = Math.round(total * 100) / 100;
    var inv = Number(values.invoiceWeight);
    var diff = Math.round((total - inv) * 100) / 100;

    var row = {};
    Object.keys(values).forEach(function (k) { row[k] = values[k]; });
    row.bags = picked.join(', ');
    var res = fAppendSheet_(form, row, who, {
      'Bag Count': picked.length,
      'Bags Total Weight': total,
      'Difference': diff
    });
    if (res.ok && diff > 0) {
      res.note = 'Saved with the bags ' + diff + ' kg heavier than the invoice (' +
                 total + ' kg against ' + inv + ' kg).';
    }
    return res;
  });
}

/** Normalise whatever the browser sent into [{slab, grade}], de-duplicated. */
function fDispatchRows_(raw) {
  var out = [], seen = {};
  (raw || []).forEach(function (r) {
    if (!r) return;
    var slab = String(r.slab || r.s || '').trim().toUpperCase();
    if (!slab || seen[slab]) return;
    seen[slab] = true;
    out.push({ slab: slab, grade: String(r.grade || r.g || '').trim() });
  });
  return out;
}

/** "A, B, C and 12 more" — a readable list that cannot run to a page. */
function fShortList_(arr) {
  if (arr.length <= 4) return arr.join(', ');
  return arr.slice(0, 3).join(', ') + ' and ' + (arr.length - 3) + ' more';
}

/**
 * What goes in the log's Payload column. For most forms that is the values
 * object as-is. For dispatch it is flattened to "A26I02022 A, A26I02023 B" —
 * sixty {slab, grade} objects as JSON overflow the 5,000-character cut and
 * the tail, which is where a problem would show, is what gets lost.
 */
function fLogPayload_(form, values) {
  if (form.multiSection) {
    /* Photo URLs are long and there are up to five per section; the payload
       column would be nothing but Drive links. Count them instead. */
    var rows = fFeedbackRows_(values);
    return JSON.stringify({
      slab: values.slab, alertId: values.alertId,
      sections: rows.map(function (r) {
        return { n: r.n, defects: r.defects.length, area: r.area,
                 photos: r.photos.length, videos: r.videos.length };
      })
    });
  }
  if (!form.multiRow) return JSON.stringify(values);
  var rows = fDispatchRows_(values[form.multiRow]);
  var flat = {};
  Object.keys(values).forEach(function (k) {
    if (k !== form.multiRow) flat[k] = values[k];
  });
  flat[form.multiRow] = rows.map(function (r) { return r.slab + ' ' + r.grade; }).join(', ');
  flat.slabCount = rows.length;
  return JSON.stringify(flat);
}

/** fCopyFormulas_, but filling a block of new rows rather than a single one. */
function fCopyFormulasBlock_(sh, targetRow, n, width, protectedCols) {
  if (targetRow < 3 || n < 1) return;
  fTabFx_(sh, width).copy.forEach(function (c) {
    if (protectedCols && protectedCols[c]) return;        // spilled array: leave alone
    sh.getRange(targetRow - 1, c + 1).copyTo(sh.getRange(targetRow, c + 1, n, 1),
      SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
  });
}