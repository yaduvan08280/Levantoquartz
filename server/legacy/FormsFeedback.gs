/**
 * Slabworks Production Forms — Grade Reporting
 * --------------------------------------------
 * The form a supervisor fills when Q.C. Final grades a slab B or C.
 *
 * A slab is six sections (two rows of three, as on the shop floor drawing).
 * The supervisor taps the ones with a problem and gets one block per section:
 * photos and an optional short video, the defects, who is responsible, why it
 * happened and what will be done. Each section becomes its own row in
 * "Feedback Response" — the same shape as Dispatch, and for the same reason: a
 * row per thing is a register you can filter, a row of comma-separated blobs
 * is not.
 *
 * Media never passes through the sheet. Photos are downscaled in the browser,
 * uploaded one at a time, and stored in Drive; the sheet holds links.
 */

var FSECTIONS = [1, 2, 3, 4, 5, 6];

/* The whole-slab block. Stored under its own key so it cannot collide with a
   numbered section, written to the sheet in words so the column reads the same
   way a person would say it, and sorted to the front because a fault across
   the whole slab is the headline, not a footnote after section 6. */
var FSEC_FULL     = 'F';
var FSEC_FULL_OUT = 'Full Slab';

function fFeedbackHeaders_() {
  return ['Timestamp', 'Alert ID', 'Slab Number', 'Grade', 'Reported By',
          'Section', 'Defects', 'Area Responsible', 'Other Area',
          'Reason', 'Solution', 'Photos', 'Videos'];
}

function fFeedbackSheet_() {
  var sh = fss_().getSheetByName(FORMS_ALERT.RESPONSE_TAB);
  if (!sh) throw new Error('Missing "' + FORMS_ALERT.RESPONSE_TAB +
    '" tab. Run createAlertSheets() once from the Apps Script editor.');
  return sh;
}

/* -------------------------------------------------------------- reading -- */

/** Slabs a report can be filed against: anything with a live alert. */
function fAlertSlabList_() {
  return fOpenAlerts_().map(function (a) { return a.slab; });
}

/* ----------------------------------------------------------- validating -- */

/**
 * Normalise whatever the browser sent into the shape the writer wants:
 *   [{ n, defects[], area, areaOther, reason, solution, photos[], videos[] }]
 * Only sections actually ticked on the diagram survive, so a block the
 * supervisor filled and then unticked cannot sneak into the sheet.
 */
function fFeedbackRows_(values) {
  var picked = (values && values.sections) || [];
  var sec = (values && values.sec) || {};
  var out = [], seen = {};

  function take(key, label, order) {
    var d = sec[key] || {};
    out.push({
      n: label,
      order: order,
      defects: Array.isArray(d.defects) ? d.defects.slice() : (d.defects ? [d.defects] : []),
      area: String(d.area || '').trim(),
      areaOther: String(d.areaOther || '').trim(),
      reason: String(d.reason || '').trim(),
      solution: String(d.solution || '').trim(),
      photos: fMediaUrls_(d.photos),
      videos: fMediaUrls_(d.videos)
    });
  }

  /* Whole slab first, then the numbered parts. Both can be present: a slab can
     be bad all over AND have two sections worth calling out separately. */
  if (values && values.fullSlab) take(FSEC_FULL, FSEC_FULL_OUT, 0);

  picked.forEach(function (raw) {
    var n = parseInt(raw, 10);
    if (FSECTIONS.indexOf(n) === -1 || seen[n]) return;
    seen[n] = true;
    take(String(n), n, n);
  });

  out.sort(function (a, b) { return a.order - b.order; });
  return out;
}

/**
 * The browser tracks each attachment as an object — url, id, name, and a
 * `pending` flag while it is still going up — so only the url is wanted here,
 * and only once it has one. Joining the objects straight into the cell is how
 * a column fills with [object Object]; a pending one has no url yet and is
 * dropped, which then trips the "at least one photo" rule rather than writing
 * a row that points at nothing.
 */
function fMediaUrls_(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  list.forEach(function (m) {
    var u = (m && typeof m === 'object') ? m.url : m;
    u = String(u || '').trim();
    if (u) out.push(u);
  });
  return out;
}

function fValidateFeedback_(values) {
  var errors = [];
  if (!String(values.slab || '').trim()) errors.push('Choose the slab number.');

  var rows = fFeedbackRows_(values);
  if (!rows.length) {
    errors.push('Tick Full Slab, or tap at least one section on the slab diagram.');
    return errors;
  }

  rows.forEach(function (r) {
    var where = (r.n === FSEC_FULL_OUT ? FSEC_FULL_OUT : 'Section ' + r.n) + ': ';
    if (!r.defects.length) errors.push(where + 'tick at least one defect.');
    if (!r.area) errors.push(where + 'choose who is responsible.');
    if (r.area === FOPT.AREA_OTHER && !r.areaOther) {
      errors.push(where + 'name the area, since you chose "' + FOPT.AREA_OTHER + '".');
    }
    if (!r.reason) errors.push(where + 'give the reason.');
    if (!r.solution) errors.push(where + 'give the solution.');
    if (!r.photos.length) errors.push(where + 'attach at least one photo.');
  });
  return errors;
}

/* ------------------------------------------------------------- writing --- */

/** One row per reported section. */
function fAppendFeedback_(form, values, who) {
  var sh = fFeedbackSheet_();
  var rows = fFeedbackRows_(values);
  if (!rows.length) return { ok: false, via: 'sheet', error: 'No sections selected.' };

  var slab = String(values.slab || '').trim().toUpperCase();
  var alertId = String(values.alertId || '').trim();

  /* Grade and alert id come from the sheet, not the browser. The form is
     reached from a link the operator could edit, and a report filed against
     the wrong alert would close somebody else's. */
  var alert = alertId ? fFindAlert_(alertId) : null;
  if (alert && String(alert.values[2]).trim().toUpperCase() !== slab) alert = null;
  if (!alert) {
    var live = fAlertForSlab_(slab);
    alertId = live ? live.id : '';
    alert = alertId ? fFindAlert_(alertId) : null;
  }
  var grade = alert ? String(alert.values[3]) : fQcGrades_([slab])[slab] || '';

  var hi = fHeaderIdx_(sh);
  var protectedCols = fProtectedCols_(sh, hi);
  function colOf(name) {
    var i = fColOf_(hi, name);
    if (i !== undefined && protectedCols[i]) return undefined;
    return i;
  }

  var now = new Date();
  fWithLock_(30000, function () {
    var target = sh.getLastRow() + 1;
    var n = rows.length;
    function writeCol(name, vals) {
      var c = colOf(name);
      if (c === undefined) return;
      sh.getRange(target, c + 1, n, 1).setValues(vals.map(function (v) { return [v]; }));
    }
    writeCol('Timestamp',        rows.map(function () { return now; }));
    writeCol('Alert ID',         rows.map(function () { return alertId; }));
    writeCol('Slab Number',      rows.map(function () { return slab; }));
    writeCol('Grade',            rows.map(function () { return grade; }));
    writeCol('Reported By',      rows.map(function () { return who; }));
    writeCol('Section',          rows.map(function (r) { return r.n; }));
    writeCol('Defects',          rows.map(function (r) { return r.defects.join(', '); }));
    writeCol('Area Responsible', rows.map(function (r) { return r.area; }));
    writeCol('Other Area',       rows.map(function (r) { return r.areaOther; }));
    writeCol('Reason',           rows.map(function (r) { return r.reason; }));
    writeCol('Solution',         rows.map(function (r) { return r.solution; }));
    writeCol('Photos',           rows.map(function (r) { return r.photos.join('\n'); }));
    writeCol('Videos',           rows.map(function (r) { return r.videos.join('\n'); }));

    var tc = colOf('Timestamp');
    if (tc !== undefined) {
      sh.getRange(target, tc + 1, n, 1).setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);
    }
    sh.getRange(target, 1, n, hi.width).setVerticalAlignment('top');
  });

  /*
   * Close EVERY open alert for this slab, not just the one the form was opened
   * from.
   *
   * A slab graded B twice used to collect two alerts, and a report closed the
   * newest. The slab stayed in the red list, the supervisor filed again
   * because the list said it was still owed, and the sheet took a second copy
   * — which is where most of the duplicate reports came from. Alerts are now
   * raised one per slab, but the ones already in the sheet are closed by this.
   */
  var closed = fCloseAlertsForSlab_(slab, who, rows.length, alertId);
  if (closed) {
    try {
      fNotifyHandled_({ slab: slab, grade: grade }, who);
    } catch (e) { /* the report is saved; a failed message must not undo it */ }
  }

  return { ok: true, via: 'sheet', rows: rows.length, closed: !!closed,
           note: closed > 1 ? ('Alert closed — ' + closed + ' open alerts for this slab were cleared.')
               : closed     ? 'Alert closed — the other supervisors have been told.' : '' };
}

/* --------------------------------------------------------------- media --- */

/**
 * One file, already downscaled by the browser, into Drive.
 *
 * Uploaded one at a time rather than with the form: a submission carrying six
 * photos is one request big enough to time out on plant wifi, and losing it
 * loses everything the supervisor typed as well.
 */
function fSaveMedia_(slab, name, mime, b64) {
  var day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var subName = day + '  ' + String(slab || 'unknown').toUpperCase();
  var folder = fMediaDay_(subName);

  var blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, name);
  var file = folder.createFile(blob);

  /* Sharing is a second round trip to Drive and it can be refused outright by
     a domain policy. The file is already saved by this point, so a refusal
     must not throw away a photo somebody just took — the link still works for
     anyone the folder is shared with. */
  try {
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    console.log('Could not set sharing on ' + name + ': ' + (e && e.message));
  }
  return { id: file.getId(), url: file.getUrl(), name: file.getName() };
}

/**
 * The folder for one slab on one day, found once and remembered.
 *
 * Uploads used to arrive four at a time and each one searched Drive for this
 * folder, found nothing, and created it — so the same slab ended up with four
 * folders holding one photo each. The client now uploads one at a time, but
 * two supervisors can still be photographing the same slab, so the lookup is
 * cached and the creation takes the lock.
 */
function fMediaDay_(subName) {
  var cache = fCache_();
  var key = 'mdir_' + subName;
  var id = cache.get(key);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: fall through */ }
  }

  var lock = LockService.getScriptLock();
  var held = false;
  try { held = lock.tryLock(20000); } catch (e) {}
  try {
    id = cache.get(key);                       // somebody may have won the race
    if (id) {
      try { return DriveApp.getFolderById(id); } catch (e2) {}
    }
    var root = fMediaFolder_();
    var it = root.getFoldersByName(subName);
    var folder = it.hasNext() ? it.next() : root.createFolder(subName);
    cache.put(key, folder.getId(), 21600);
    return folder;
  } finally {
    if (held) lock.releaseLock();
  }
}

/** The one folder everything lives under. Cached for the same reason. */
function fMediaFolder_() {
  var name = FORMS_ALERT.DRIVE_FOLDER;
  var cache = fCache_();
  var id = cache.get('mdir_root');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) {}
  }
  var it = DriveApp.getFoldersByName(name);
  var f = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  cache.put('mdir_root', f.getId(), 21600);
  return f;
}

/* ------------------------------------------------------------- the feed -- */

/**
 * Everything the admin Feedback page shows: one entry per slab, with its
 * sections folded in, plus the alerts nobody got to.
 */
function fFeedbackFeed_(limit) {
  var n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 400);
  var sh = fFeedbackSheet_();
  var last = sh.getLastRow();
  var bySlab = {}, order = [];

  if (last >= 2) {
    var hi = fHeaderIdx_(sh);
    var from = Math.max(2, last - n * 6);
    var rows = sh.getRange(from, 1, last - from + 1, hi.width).getDisplayValues();
    function col(name) { return fColOf_(hi, name); }
    var c = {
      when: col('Timestamp'), alert: col('Alert ID'), slab: col('Slab Number'),
      grade: col('Grade'), who: col('Reported By'), sec: col('Section'),
      defects: col('Defects'), area: col('Area Responsible'), other: col('Other Area'),
      reason: col('Reason'), solution: col('Solution'),
      photos: col('Photos'), videos: col('Videos')
    };
    function v(row, k) { return c[k] === undefined ? '' : String(row[c[k]] || '').trim(); }

    for (var r = 0; r < rows.length; r++) {
      var slab = v(rows[r], 'slab');
      if (!slab) continue;
      var key = slab + '|' + v(rows[r], 'alert');
      if (!bySlab[key]) {
        bySlab[key] = { slab: slab, grade: v(rows[r], 'grade'), alertId: v(rows[r], 'alert'),
                        when: v(rows[r], 'when'), who: v(rows[r], 'who'), sections: [] };
        order.push(key);
      }
      var area = v(rows[r], 'area');
      var other = v(rows[r], 'other');
      bySlab[key].sections.push({
        n: v(rows[r], 'sec'),
        defects: v(rows[r], 'defects'),
        area: (area === FOPT.AREA_OTHER && other) ? other : area,
        reason: v(rows[r], 'reason'),
        solution: v(rows[r], 'solution'),
        photos: v(rows[r], 'photos').split('\n').filter(String),
        videos: v(rows[r], 'videos').split('\n').filter(String)
      });
    }
  }

  var entries = order.map(function (k) { return bySlab[k]; }).reverse().slice(0, n);

  /* The alerts that ran out of time. This is the list that says whether the
     whole arrangement is working. */
  var un = [];
  var al = fss_().getSheetByName(FORMS_ALERT.TAB);
  if (al && al.getLastRow() >= 2) {
    var afrom = Math.max(2, al.getLastRow() - 500);
    var arows = al.getRange(afrom, 1, al.getLastRow() - afrom + 1,
                            FALERT_HEADERS.length).getDisplayValues();
    for (var i = arows.length - 1; i >= 0 && un.length < n; i--) {
      if (String(arows[i][6]).toUpperCase() !== 'UNATTENDED') continue;
      un.push({ id: arows[i][0], when: arows[i][1], slab: arows[i][2],
                grade: arows[i][3], notified: arows[i][11] });
    }
  }

  return { ok: true, entries: entries, unattended: un, open: fOpenAlerts_().length };
}