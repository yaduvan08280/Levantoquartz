
/**
 * Slabworks Production Forms — the duplicate guard
 * ------------------------------------------------
 * One entry per slab, per form. The second is refused.
 *
 * WHY THIS EXISTS
 *   The submit id already stops a RETRY writing twice: the browser stamps each
 *   attempt and reuses the stamp, so an answer lost on plant wifi cannot turn
 *   into two rows. It does nothing about the other way duplicates arrive —
 *   somebody fills the form again. A supervisor whose slab kept showing in the
 *   grade alert list filed the report four times; the sheet took all four,
 *   because nothing downstream of the browser ever asked whether that slab was
 *   already on the tab.
 *
 *   So the check is here, on the server, reading the tab itself. Not the
 *   cache, not what the phone believes: the tab. A phone that has been asleep
 *   for an hour, a second phone, a retry from a queue written yesterday — they
 *   all land on the same question asked of the same sheet.
 *
 * WHAT COUNTS AS THE SAME ENTRY
 *   FDUP_KEYS below, one line per form, and nothing is implied. A slab for the
 *   line forms. A bundle for Vacuum Unloader and Trolley. Material AND bag
 *   number for the Bag Form, because Grit bag 101 and Filler bag 101 are two
 *   bags. Production date AND shift for the two summaries — the dashboard adds
 *   those rows up, so one shift filed twice is production that never happened.
 *
 *   Two forms are deliberately not guarded:
 *     dispatch  already does it better — fAppendDispatch_ re-reads the
 *               dispatched set inside the lock and drops slabs that have gone,
 *               per slab rather than per submission.
 *     formula   a design is re-formulated whenever it is run, and the Costing
 *               tab deliberately takes the LATEST formula filed before a slab
 *               was batched. Blocking repeats there would freeze every recipe
 *               at its first version.
 *
 * WHEN A GUARD CANNOT BE APPLIED
 *   It says so, loudly, rather than passing the entry through in silence. If
 *   the key column cannot be found on the tab the submission is refused and
 *   the message names the column. A guard that quietly does nothing is worse
 *   than no guard, because everyone stops checking.
 *
 *   dupDiag()     every form, its key fields, and the column each one resolves
 *                 to on its tab — run this after any header is renamed
 *   dupReport()   the repeats already written, per tab, so they can be cleaned
 *                 up by hand
 */

/*
 * What makes two entries the same entry, per form.
 *
 * Each form maps to a list of PARTS, and every part has to match for a row to
 * count as the same entry. A part is a list of alternative field ids, because
 * one value does not always live in one column: Batching writes the slab to
 * "Slab Number (A)" or "Slab Number (B)" depending on the line, and a slab
 * entered on A and then again on B is still the same slab entered twice.
 *
 * Four forms are deliberately not guarded, and each for its own reason:
 *
 *   dispatch   already guarded, and better: fAppendDispatch_ re-reads the
 *              dispatched set inside the lock and drops slabs that have gone,
 *              per slab rather than per submission.
 *   formula    a design is re-formulated whenever it is run, and the Costing
 *              tab deliberately takes the LATEST formula filed before a slab
 *              was batched. Blocking repeats would freeze every recipe at its
 *              first version.
 *   vacuum     a bundle is filled, emptied and filled again — BN01 comes round
 *   trolley    every sixty entries. Blocking a repeated bundle number would
 *              stop the line dead after one cycle. The honest guard here is on
 *              the slabs inside the bundle, which are a checkbox list written
 *              into one cell, and that is a different job from this one.
 */
var FDUP_KEYS = {
  batching:     [['slabA', 'slabB']],      // whichever line it went down
  resin:        [['slab']],
  mixer:        [['slab']],
  pressing:     [['slab']],
  ovenIn:       [['slab']],
  ovenOut:      [['slab']],
  calibration:  [['slab']],
  qc:           [['slab']],
  gradeReport:  [['slab']],
  bag:          [['material'], ['bagNo']],  // Grit 101 and Filler 101 are two bags
  prodSummaryA: [['pdate'], ['shift']],     // the dashboard adds these rows up
  prodSummaryB: [['pdate'], ['shift']],
  dispatch:     null,
  formula:      null,
  vacuum:       null,
  trolley:      null,
  /* Guarded per BAG inside fAppendBagInvoice_ instead. The invoice number is
     not a key: one invoice's bags can arrive, and be filed, in two lots. */
  bagInvoice:   null,
  /* Shipping containers are reused: the same number on a later load is not a
     mistake. History still flags it. */
  container:    null
};

/* Why a form is unguarded, so dupDiag does not just say "no". */
var FDUP_WHY = {
  bagInvoice: 'guarded per bag inside the writer; an invoice can be filed in parts',
  container: 'a shipping container can come back on a later load; History flags repeats',
  dispatch: 'guarded per slab inside the writer',
  formula:  're-formulated by design; Costing takes the latest',
  vacuum:   'a bundle is refilled by design',
  trolley:  'a bundle is refilled by design'
};

/*
 * What to do when the guard cannot run — when a key column has been renamed or
 * never existed on the tab.
 *
 * true  refuse the submission and name the column. Nothing is written, and
 *       whoever renamed the header hears about it within a minute.
 * false log it and let the entry through, unguarded.
 *
 * Strict is right: a guard that quietly does nothing is worse than no guard,
 * because everybody stops checking. But it is one line to turn off, because
 * "nobody can record production until IT wakes up" is a worse outcome than a
 * duplicate, and at three in the morning that trade is not a debate.
 *
 * Run dupDiag() once after deploying and this never comes up.
 */
var FDUP_STRICT = true;

/* How many rows back the scan looks. These tabs run to a few thousand rows and
   the scan reads one or two columns of them, which is a single call each. */
/* Was 20,000 — every row of the tab, and with each call into New Base
   costing about a second plus one more per few thousand rows read, that
   read was the slowest part of every save (19/11/2026). A repeat only ever
   comes from a retry or two phones at once, which is always recent: an older
   slab cannot even be picked, because each stage's dropdown is built from the
   whole column (fStageList_). dupReport() still checks every row. */
var FDUP_SCAN_ROWS = 2000;

/**
 * A lock that can be taken twice in the same execution.
 *
 * The check and the write have to happen under ONE lock — look, decide, write,
 * release — or two phones submitting the same slab at the same moment both
 * look, both see nothing, and both write. But the writers take the lock
 * themselves, and nesting LockService calls is not something to rely on. So
 * the depth is counted here: the outermost call takes the real lock, the inner
 * ones ride on it. Apps Script runs one execution at a time, so a plain
 * variable is enough to count with.
 */
var F_LOCK_DEPTH = 0;

/*
 * The BACKGROUND jobs' lock — the Telegram poll, the grade-alert scan and the
 * session sweep. They must not run twice at once, but they need not stop
 * anybody saving, and on the save lock they did: the alert scan held it for
 * its whole read-and-send, the poll for every call to Telegram, and saves
 * queued 20-30 s behind them (19/11/2026). This is the user lock — every
 * execution here runs as the deploying user, so it is one lock, just not the
 * one saves wait on. Writes the jobs make still take the save lock briefly
 * where they need it.
 */
function fWithJobLock_(ms, fn) {
  var lock = LockService.getUserLock();
  lock.waitLock(ms || 10000);
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

function fWithLock_(ms, fn) {
  if (F_LOCK_DEPTH > 0) {                      // already inside one
    F_LOCK_DEPTH++;
    try { return fn(); } finally { F_LOCK_DEPTH--; }
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(ms || 30000);
  F_LOCK_DEPTH++;
  try { return fn(); } finally {
    F_LOCK_DEPTH--;
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** Comparison form of a key value: case and spacing never make two slabs. */
function fDupNorm_(v) {
  return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * A date, reduced to the day it names.
 *
 * The browser sends a date field as "2026-10-08" and the sheet gives it back
 * as "08/10/2026" — the same day, written two ways, and comparing the strings
 * says they are different. That is how a shift summary filed twice for the
 * same day slipped through the guard the first time it was tested.
 *
 * Anything that does not look like a date comes back untouched, so a field
 * that is not really one is compared as plain text.
 */
function fDupDay_(v) {
  var t = String(v == null ? '' : v).trim();
  if (!t) return '';
  var m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);                      // 2026-10-08
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);             // 08/10/2026
  if (m) return m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  }
  return fDupNorm_(t);
  function pad2(n) { return (String(n).length < 2 ? '0' : '') + n; }
}

/** The right comparison for a field: by day for a date, by text otherwise. */
function fDupCompare_(form, ids) {
  for (var i = 0; i < ids.length; i++) {
    var f = fFieldById_(form, ids[i]);
    if (f && f.type === 'date') return fDupDay_;
  }
  return fDupNorm_;
}

/** The schema field with this id, wherever it sits in the form. */
function fFieldById_(form, id) {
  var found = null;
  (form.sections || []).forEach(function (sec) {
    (sec.fields || []).forEach(function (f) { if (!found && f.id === id) found = f; });
  });
  return found;
}

/**
 * The column each key field is written to, or an explanation of why not.
 * Resolved through the same fColOf_ the writer uses, so a tab whose header has
 * odd spacing resolves the same way for the guard and for the write.
 */
function fDupCols_(form, hi) {
  var parts = FDUP_KEYS[form.key];
  if (!parts || !parts.length) return { skip: true };
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var ids = parts[i], cols = [], labels = [], missing = [];
    for (var j = 0; j < ids.length; j++) {
      var f = fFieldById_(form, ids[j]);
      if (!f) return { error: 'the form has no field "' + ids[j] + '"' };
      var c = fColOf_(hi, f.label);
      if (c === undefined) { missing.push(f.label); continue; }
      cols.push(c); labels.push(f.label);
    }
    if (!cols.length) {
      return { error: 'the "' + form.tab + '" tab has no ' +
                      missing.map(function (m) { return '"' + m + '"'; }).join(' or ') + ' column' };
    }
    out.push({ ids: ids, labels: labels, cols: cols, cmp: fDupCompare_(form, ids) });
  }
  return { parts: out };
}

/**
 * Has this entry already been filed?
 *
 * Returns null when it has not, when the form is not guarded, or when the
 * operator has not filled the key fields yet (validation deals with that).
 * Returns { blocked:true, ... } when it has, and { error } when the guard
 * could not run — which is also a refusal, on purpose.
 */
function fDupFind_(form, values) {
  var keys = FDUP_KEYS[form.key];
  if (!keys || !keys.length) return null;

  var sh = fss_().getSheetByName(form.tab);
  if (!sh) return null;                        // the writer reports this better

  /* Resolve the columns BEFORE looking at whether the tab has rows. A renamed
     header is a broken guard, and a broken guard should be heard about on the
     first entry of the day, not on the second. */
  var hi = fHeaderIdx_(sh);
  var spec = fDupCols_(form, hi);
  if (spec.skip) return null;
  if (spec.error) return { error: spec.error };

  var last = fRealLastRow_(sh, hi);
  fMark_('rows');
  if (last < 2) return null;

  /* The value of each part: the first of its alternatives the operator filled. */
  var wanted = spec.parts.map(function (p) {
    for (var i = 0; i < p.ids.length; i++) {
      var v = p.cmp(values[p.ids[i]]);
      if (v) return v;
    }
    return '';
  });
  if (wanted.some(function (w) { return !w; })) return null;   // nothing to match on

  var from = Math.max(2, last - FDUP_SCAN_ROWS + 1);
  var n = last - from + 1;

  /* One read per column rather than the whole block: these tabs are forty
     columns wide and most of them are long text. Plain values, not display
     text: formatting ten thousand cells server-side was most of the time this
     check took. A number or date comes back as itself and is compared the
     same way (fDupNorm_ / fDupDay_). */
  var read = {};
  spec.parts.forEach(function (p) {
    p.cols.forEach(function (c) {
      if (!read[c]) read[c] = sh.getRange(from, c + 1, n, 1).getValues();
    });
  });
  fMark_('read');

  for (var r = n - 1; r >= 0; r--) {           // newest first
    var hit = true, shown = [];
    for (var k = 0; k < spec.parts.length && hit; k++) {
      var found = '';
      var part = spec.parts[k];
      part.cols.forEach(function (c) {
        if (!found && part.cmp(read[c][r][0]) === wanted[k]) found = read[c][r][0];
      });
      if (found instanceof Date) {
        found = Utilities.formatDate(found, Session.getScriptTimeZone(), 'dd/MM/yyyy');
      }
      if (!found) hit = false; else shown.push(String(found));
    }
    if (!hit) continue;

    var row = from + r;
    return {
      blocked: true,
      row: row,
      key: shown.join(' \u00b7 '),
      when: fDupCell_(sh, hi, row, ['Timestamp']),
      who: fDupWho_(sh, hi, row)
    };
  }
  return null;
}

function fDupCell_(sh, hi, row, names) {
  for (var i = 0; i < names.length; i++) {
    var c = fColOf_(hi, names[i]);
    if (c !== undefined) {
      var v = String(sh.getRange(row, c + 1).getDisplayValue() || '').trim();
      if (v) return v;
    }
  }
  return '';
}

function fDupWho_(sh, hi, row) {
  var who = fDupCell_(sh, hi, row, ['Reported By', 'Email address', 'Email', 'Username', 'Entered by']);
  return who.indexOf('@') > 0 ? who.split('@')[0] : who;
}

/** The sentence the operator reads. It has to say what to do next. */
function fDupMessage_(form, hit) {
  var what = (FDUP_KEYS[form.key] || []).length > 1 ? 'That entry (' + hit.key + ')' : hit.key;
  var when = hit.when ? ' at ' + hit.when : '';
  var who = hit.who ? ' by ' + hit.who : '';
  return what + ' is already on ' + form.title + when + who +
         ' (row ' + hit.row + '). It has not been saved again. ' +
         'Open History to see the entry; if it is wrong, correct it in the sheet.';
}

/* ------------------------------------------------------------ diagnosis -- */

/**
 * Every form, the fields its guard keys on, and the column each resolves to.
 * Run it from the editor after renaming anything on a tab.
 */
function dupDiag() {
  var out = [];
  FORM_KEYS.forEach(function (k) {
    var f = FORM_DEFS[k];
    var ids = FDUP_KEYS[k];
    if (!ids || !ids.length) {
      out.push(pad(f.title) + 'not guarded' +
               (FDUP_WHY[k] ? ' — ' + FDUP_WHY[k] : ''));
      return;
    }
    var sh = fss_().getSheetByName(f.tab);
    if (!sh) { out.push(pad(f.title) + 'NO TAB "' + f.tab + '"'); return; }
    var spec = fDupCols_(f, fHeaderIdx_(sh));
    if (spec.error) { out.push(pad(f.title) + 'BROKEN — ' + spec.error); return; }
    out.push(pad(f.title) + spec.parts.map(function (p) {
      return p.labels.join(' or ');
    }).join(' + '));
  });
  function pad(s) { return (s + '                              ').slice(0, 30); }
  out.forEach(function (l) { console.log(l); });
  return out;
}

/**
 * Add any key column a tab is missing, so the guard can run.
 *
 * The Production Summary tabs are the live case: PRODUCTION DATE was added to
 * the form after those tabs were built, and a column the tab does not have is
 * a column the app was never able to write — the date was being dropped on the
 * floor long before the guard existed. Appending it fixes the guard and the
 * write at the same time.
 *
 * Only ever APPENDS a header to the right of the existing ones. Nothing is
 * renamed, nothing is moved, no data is touched. Safe to run twice.
 */
function ensureDupColumns() {
  var out = [];
  FORM_KEYS.forEach(function (k) {
    var parts = FDUP_KEYS[k];
    if (!parts || !parts.length) return;
    var f = FORM_DEFS[k];
    var sh = fss_().getSheetByName(f.tab);
    if (!sh) { out.push(f.tab + ': NO SUCH TAB'); return; }

    parts.forEach(function (ids) {
      var hi = fHeaderIdx_(sh);
      var found = false;
      ids.forEach(function (id) {
        var fl = fFieldById_(f, id);
        if (fl && fColOf_(hi, fl.label) !== undefined) found = true;
      });
      if (found) return;
      var fl = fFieldById_(f, ids[0]);
      if (!fl) { out.push(f.tab + ': the form has no field "' + ids[0] + '"'); return; }
      var at = sh.getLastColumn() + 1;
      sh.getRange(1, at).setValue(fl.label);
      fHeaderChanged_(sh);
      out.push(f.tab + ': added "' + fl.label + '" as column ' + at);
    });
  });
  if (!out.length) out.push('Every tab already has its key columns.');
  out.forEach(function (l) { console.log(l); });
  return out;
}

/**
 * The repeats already written, tab by tab. Read-only: nothing is deleted,
 * because which copy to keep is a judgement about the slab, not about the row.
 */
function dupReport() {
  var out = [];
  FORM_KEYS.forEach(function (k) {
    var f = FORM_DEFS[k];
    var ids = FDUP_KEYS[k];
    if (!ids || !ids.length) return;
    var sh = fss_().getSheetByName(f.tab);
    if (!sh) return;
    var last = sh.getLastRow();
    if (last < 3) return;
    var hi = fHeaderIdx_(sh);
    var spec = fDupCols_(f, hi);
    if (spec.error) { out.push(f.title + ': cannot check — ' + spec.error); return; }

    var from = Math.max(2, last - 20000 + 1), n = last - from + 1;   // the whole tab, unlike the save-time check
    var read = {};
    spec.parts.forEach(function (p) {
      p.cols.forEach(function (c) {
        if (!read[c]) read[c] = sh.getRange(from, c + 1, n, 1).getDisplayValues();
      });
    });
    var seen = {}, dups = [];
    for (var r = 0; r < n; r++) {
      var key = spec.parts.map(function (p) {
        for (var i = 0; i < p.cols.length; i++) {
          var v = p.cmp(read[p.cols[i]][r][0]);
          if (v) return v;
        }
        return '';
      }).join('|');
      if (key.replace(/\|/g, '') === '') continue;
      if (seen[key]) { dups.push({ key: key, first: seen[key], again: from + r }); }
      else seen[key] = from + r;
    }
    if (!dups.length) { out.push(f.title + ': clean'); return; }
    out.push(f.title + ': ' + dups.length + ' repeat row' + (dups.length === 1 ? '' : 's'));
    dups.slice(0, 40).forEach(function (d) {
      out.push('    ' + d.key.replace(/\|/g, ' · ') +
               '   first row ' + d.first + ', again row ' + d.again);
    });
    if (dups.length > 40) out.push('    … and ' + (dups.length - 40) + ' more');
  });
  out.forEach(function (l) { console.log(l); });
  return out;
}