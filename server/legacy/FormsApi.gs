/**
 * Slabworks Production Forms — page builder and client API
 *
 * formsPage_() returns the HTML page. It is NOT doGet(): the router lives in
 * FormsEntry.gs (standalone) or in the dashboard's own doGet (merged), so this
 * file never collides with the dashboard project. See FormsEntry.gs.
 */

function formsPage_(e) {
  var t = HtmlService.createTemplateFromFile('FormsPage');
  /* A Telegram alert links straight to one slab. The parameters are read here
     and handed to the page as data — the page never parses its own URL, and
     nothing from them is trusted server-side: the slab is re-checked against
     the alert sheet before anything is written. */
  var p = (e && e.parameter) || {};
  t.deepLink = JSON.stringify({
    form: String(p.form || ''),
    slab: String(p.slab || ''),
    alert: String(p.alert || '')
  });
  return t.evaluate()
    .setTitle(FORMS_CFG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function formsInclude(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---- API ------------------------------------------------------------------

function api_getForm(token, key) {
  var s = fRequireSession_(token);
  if (s.forms.indexOf(key) === -1) throw new Error('That form is not assigned to you.');
  var f = FORM_DEFS[key];
  if (!f) throw new Error('Unknown form.');

  return {
    key: f.key,
    no: f.no,
    title: f.title,
    abbr: f.abbr,
    dynamicBundle: !!f.dynamicBundle,
    multiRow: f.multiRow || '',
    multiSection: f.multiSection || '',
    sectionTemplate: f.sectionTemplate ? fSectionTemplate_(f) : null,
    allowPrefill: f.allowPrefill !== false,
    prefillLines: !!f.prefillLines,
    keyField: f.keyField || '',
    /* only sent when a form actually links two fields */
    maps: fFieldMaps_(f),
    sections: f.sections.map(function (sec) {
      return {
        title: sec.title,
        grid: !!sec.grid,
        showWhen: sec.showWhen || null,
        repeat: sec.repeat || null,
        fields: sec.fields.map(function (fl) {
          return {
            id: fl.id, label: fl.label, type: fl.type,
            required: !!fl.required, help: fl.help || '',
            requiredUnless: fl.requiredUnless || '',
            optionsWhen: fl.optionsWhen ? fl.optionsWhen.field : '',
            integer: !!fl.integer,
            min: (fl.min === undefined ? null : fl.min),
            max: (fl.max === undefined ? null : fl.max),
            showWhen: fl.showWhen || null,
            isSlab: !!fl.isSlab, noPrefill: !!fl.noPrefill,
            fills: fl.fills || null,
            sumOf: fl.sumOf || null,
            calcNote: fl.calcNote || null,
            defaultToday: !!fl.defaultToday,
            uniqueLive: !!fl.uniqueLive,
            dependsOn: fl.dependsOn || null,
            weightOf: fl.weightOf || '',
            dynamic: !!(fl.source && fl.source.charAt(0) === '@'),
            grades: fl.type === 'slabgrade' ? FOPT.DISPATCH_GRADE : null
          };
        })
      };
    }),
    options: fResolveOptions_(f),
    optionSets: fOptionSets_(f),
    /* The "+ Design name" / "+ Size" buttons: admins and supervisors, with
       what has been added so far. Only an admin may take entries back out. */
    adminLists: (fCanAddList_(s) && f.adminLists) ? f.adminLists.map(function (a) {
      return { list: a.list, field: a.field, label: a.label, added: fXLists_()[a.list] || [],
               canRemove: fCanRemoveList_(s) };
    }) : null
  };
}

/** The lookup tables a form's linked fields need, and nothing more. */
function fFieldMaps_(f) {
  var want = {};
  f.sections.forEach(function (sec) {
    sec.fields.forEach(function (fl) {
      if (fl.fills && fl.fills.map) want[fl.fills.map] = true;
    });
  });
  var all = {
    nameToCode: FOPT.DESIGN_NAME_TO_CODE,
    codeToName: FOPT.DESIGN_CODE_TO_NAME
  };
  var out = {};
  for (var k in want) if (all[k]) out[k] = all[k];
  return out;
}

/**
 * Bag Invoice's tick list: bags of this material and supplier that are on the
 * Bag Form and on no invoice yet. Parallel arrays, like the dispatch list.
 */
function api_invoiceBags(token, material, supplier) {
  var s = fRequireSession_(token);
  if (s.forms.indexOf('bagInvoice') === -1) {
    throw new Error('The Bag Invoice form is not assigned to you.');
  }
  var r = fInvoiceBags_(material, supplier);
  return { ok: !r.error, bags: r.bags, weights: r.weights, error: r.error || '' };
}

/** Bag Form's live duplicate check: every Material + Bag Number already used. */
function api_usedBags(token) {
  var s = fRequireSession_(token);
  if (s.forms.indexOf('bag') === -1) throw new Error('The Bag Form is not assigned to you.');
  var r = fUsedBags_();
  return { ok: !r.error, used: r.used, error: r.error };
}

/** Slabs in one bundle — used by the Trolley form after a bundle is picked. */
function api_bundleSlabs(token, bundle) {
  fRequireSession_(token);
  return fBundleSlabs_(bundle);
}

/** Refresh a form's live lists without reloading the page. */
function api_refreshLists(token, key) {
  var s = fRequireSession_(token);
  if (s.forms.indexOf(key) === -1) throw new Error('That form is not assigned to you.');
  fClearLists_();
  return fResolveOptions_(FORM_DEFS[key]);
}

/**
 * The values this operator entered last time on this form,
 * minus slab numbers, times and anything flagged noPrefill.
 */
/**
 * `line` is 'A', 'B', or '' for forms with one prefill button. On Batching and
 * Resin the two lines run different recipes, so "the last entry" has to mean
 * the last entry ON THAT LINE — otherwise roughly every other prefill carries
 * the other line's grit, filler and quantities across.
 */
function api_previousValues(token, key, line) {
  var s = fRequireSession_(token);
  var f = FORM_DEFS[key];
  if (!f) throw new Error('Unknown form.');
  if (f.allowPrefill === false) {
    return { ok: false, error: 'This form does not carry values over.' };
  }

  line = String(line || '').trim().toUpperCase();
  if (!f.prefillLines) line = '';
  if (line && line !== 'A' && line !== 'B') {
    return { ok: false, error: 'Line must be A or B.' };
  }

  var prev = fPrevLog_(s.username, f, line) || fPrevTab_(f, line);
  if (!prev) {
    return { ok: false, error: line
      ? 'No earlier ' + line + ' line entry found on this form yet.'
      : 'No earlier entry found for this form yet.' };
  }

  var out = {}, kept = 0;
  f.sections.forEach(function (sec) {
    sec.fields.forEach(function (fl) {
      if (fl.isSlab || fl.noPrefill || fl.type === 'time') return;
      var v = prev[fl.id];
      if (v === undefined || v === null || v === '') return;
      out[fl.id] = v;
      kept++;
    });
  });
  if (!kept) return { ok: false, error: 'The last entry had nothing worth carrying over.' };

  /* The line itself is not "carried over" — the operator chose it by which
     button they pressed — so it is returned separately and does not count
     towards the fields that need confirming. */
  return { ok: true, values: out, when: prev.__when || '',
           line: line, lineField: (line && f.lineField) || '' };
}

/**
 * Which line an entry belongs to: the Line answer if the form has one, and
 * otherwise the first letter of whichever slab number it carries. Resin has no
 * Line question — A26I05001 is A line, B26I05001 is B line, and that letter is
 * the only thing that says so.
 */
function fEntryLine_(form, values) {
  if (!values) return '';
  if (form.lineField) {
    var lv = String(values[form.lineField] || '').trim().toUpperCase();
    if (lv === 'A' || lv === 'B') return lv;
  }
  var slab = values.slab || values.slabA || values.slabB || '';
  var c = String(slab).trim().charAt(0).toUpperCase();
  return (c === 'A' || c === 'B') ? c : '';
}

function fPrevLog_(username, form, line) {
  if (!FORMS_CFG.LOG_TAB) return null;
  var sh = fss_().getSheetByName(FORMS_CFG.LOG_TAB);
  if (!sh || sh.getLastRow() < 2) return null;
  var start = Math.max(2, sh.getLastRow() - 400);
  var data = sh.getRange(start, 1, sh.getLastRow() - start + 1, 7).getValues();
  for (var r = data.length - 1; r >= 0; r--) {
    if (String(data[r][1]) !== username) continue;
    if (String(data[r][2]) !== form.title) continue;
    if (String(data[r][5]).indexOf('OK') !== 0) continue;
    var v;
    try {
      v = JSON.parse(data[r][6]);
    } catch (e) { continue; }      // a payload we cannot read is not a reason
                                   // to stop looking at older ones
    if (line && fEntryLine_(form, v) !== line) continue;
    v.__when = Utilities.formatDate(new Date(data[r][0]),
      Session.getScriptTimeZone(), 'dd MMM, HH:mm');
    return v;
  }
  return null;
}

/** Fallback: rebuild the last entry from the form's own response tab. */
/**
 * Fallback when the log has nothing: the form's own tab, read newest-first.
 * Without a line this is just the last row; with one it walks back until it
 * finds a row on that line, because on a busy day the two lines interleave
 * and the last row is as likely to be the wrong one as the right one.
 */
function fPrevTab_(form, line) {
  var sh = fss_().getSheetByName(form.tab);
  if (!sh) return null;
  var hi = fHeaderIdx_(sh);
  var last = fRealLastRow_(sh, hi);
  if (last < 2) return null;
  var scan = line ? Math.min(200, last - 1) : 1;
  var rows = sh.getRange(last - scan + 1, 1, scan, hi.width).getValues();

  for (var r = rows.length - 1; r >= 0; r--) {
    var out = fRowToValues_(form, hi, rows[r]);
    if (!out) continue;
    if (line && fEntryLine_(form, out) !== line) continue;
    return out;
  }
  return null;
}

/** One sheet row back into the shape the form uses, or null if it is blank. */
function fRowToValues_(form, hi, row) {
  var out = {}, any = false;
  form.sections.forEach(function (sec) {
    sec.fields.forEach(function (fl) {
      var i = fColOf_(hi, fl.label);
      if (i === undefined) return;
      var v = row[i];
      if (v === '' || v === null) return;
      out[fl.id] = (fl.type === 'checkbox') ? String(v).split(/\s*,\s*/) : v;
      any = true;
    });
  });
  return any ? out : null;
}

function api_submit(token, key, values, submitId) {
  var s = fRequireSession_(token);
  if (s.forms.indexOf(key) === -1) throw new Error('That form is not assigned to you.');
  var f = FORM_DEFS[key];
  if (!f) throw new Error('Unknown form.');
  /* A repeatable block (Container's materials) becomes blocks 1..n here, so
     everything below sees an ordinary form. */
  f = fFormForValues_(f, values);

  var errors = fValidate_(f, values);
  if (errors.length) return { ok: false, error: errors.join(' ') };

  var idKey = submitId ? 'submit_' + submitId : '';

  /*
   * Look, decide and write under ONE lock.
   *
   * Everything in here used to happen unguarded, and in that gap two copies of
   * the same entry could both be accepted: two taps on a slow phone, or a
   * retry fired while the first attempt was still being written. Both read
   * "not saved yet", both wrote. The writers take this same lock themselves —
   * fWithLock_ counts the depth so the inner call rides on the outer one.
   */
  /* Thirty seconds, and not longer. Two minutes was tried on 19/11/2026: every
     waiting save then held one of the script's few simultaneous executions,
     and sign-in and form loading queued behind them. A save that cannot get
     its turn in thirty seconds fails, and the phone keeps it to retry. */
  F_T = { start: new Date().getTime() };           // step timings for the log
  /* Opening the workbook and reading the tab's header row take a second or
     two each and need no lock, so they happen BEFORE taking the turn. Every
     second spent inside the lock is a second every other save waits. The
     calls below then find both already in hand (fss_ / fHeaderIdx_ memo). */
  /* The fast path (FormsFast.js): the header through the Sheets API. If that
     cannot be had — the API is off, or this form keeps its own writer — the
     whole save takes the SpreadsheetApp path exactly as before. */
  var fastHi = null;
  if (fApiOk_() && fFastForm_(f)) {
    try { fastHi = fApiHeader_(f.tab); fMark_('head'); }
    catch (e) { fastHi = null; console.log('fast header failed, old path: ' + e); }
  }
  if (!fastHi) {
    try {
      var sh0 = fss_().getSheetByName(f.tab);
      fMark_('open');
      if (sh0) { fHeaderIdx_(sh0); fMark_('head'); }
    } catch (e) { /* the locked path below reports any real problem */ }
  }
  var res = fWithLock_(30000, function () {
    F_T.lock = F_T.prev = new Date().getTime();
    /* 1. The same attempt arriving twice. The browser stamps each attempt and
          reuses the stamp when it retries, so a reply lost on plant wifi
          cannot become a second row. */
    if (idKey && fCache_().get(idKey)) {
      return { already: true };
    }

    /* 2. The same ENTRY arriving again — a different attempt, filled afresh,
          for a slab this form already holds. Read from the tab, not from a
          cache: a phone that has been asleep for an hour knows nothing. */
    var scan = null;
    if (fastHi) {
      try { scan = fFastScan_(f, values, fastHi); }
      catch (e) { scan = null; console.log('fast scan failed, old path: ' + e); }
    }
    var dup = scan ? scan.dup : fDupFind_(f, values);
    F_T.check = new Date().getTime();
    if (dup && dup.error) {
      if (FDUP_STRICT) {
        return { ok: false, blocked: true,
                 error: 'The duplicate check could not run — ' + dup.error +
                        '. Nothing was saved, in case this entry is already in the ' +
                        'sheet. Tell IT to run dupDiag().' };
      }
      console.log('DUPLICATE GUARD OFF for ' + f.title + ' — ' + dup.error);
      dup = null;
    }
    if (dup && dup.blocked) {
      /* A blocked Grade Report is proof the slab HAS been reported. The alert
         that is still asking for it is wrong, and nothing else will close it —
         the code that used to is further down this function, past this return.
         That is how a slab ended up both reported and permanently overdue. */
      var cleared = 0;
      if (key === 'gradeReport') {
        try { cleared = fCloseAlertsForSlab_(values.slab, s.username, 0); } catch (e) {}
      }
      return { ok: false, blocked: true, cleared: cleared,
               error: fDupMessage_(f, dup) +
                      (cleared ? ' The grade alert for it has been cleared.' : '') };
    }

    /* The stamp is reserved BEFORE the write, not after it. Reserving after
       leaves the whole write uncovered: a retry that arrives mid-write passes
       the check above and writes a second row. A write that then fails gives
       the stamp back, two lines down. */
    if (idKey) fCache_().put(idKey, '1', 21600);      // 6h, the cache maximum

    /* Fast write when the fast scan ran. null = this tab needs the old writer
       (nothing written yet). A failure of the API write itself is NOT retried
       down the old path — it may have landed — the phone retries with the
       same stamp and the duplicate check sorts it out. */
    var r = null;
    if (scan) {
      try { r = fFastWrite_(f, values, s.username, scan.hi || fastHi, scan.lastRow); }
      catch (e) { r = { ok: false, via: 'api', error: String(e && e.message || e) }; }
      if (r) { F_T.write = new Date().getTime(); r.logLater = true; }
    }
    if (!r) r = fSubmit_(f, values, s.username, true);   // log after the lock
    if (!r.ok && idKey) fCache_().remove(idKey);
    return r;
  });
  /* The audit line is written once the turn is released (see fSubmit_). */
  if (res && res.logLater) fLogSubmit_(f, values, s.username, res);

  if (res.already) {
    return { ok: true, via: 'already-saved', note: '',
             key: fKeyValue_(f, values), duplicate: true };
  }
  if (!res.ok) {
    /* A block is not a failure to save — it is the system working. The phone
       must not queue it for retry, so it is flagged rather than left to be
       guessed at from the wording. */
    if (res.blocked) return { ok: false, blocked: true, error: res.error,
                              cleared: res.cleared || 0 };
    /* refreshBags: Bag Invoice refused bags that went onto another invoice
       while this one was being filled — the phone reloads its list. */
    return { ok: false, error: 'Could not save: ' + res.error, refreshBags: !!res.refreshBags };
  }

  fClearLists_();     // the slab just used should drop out of the lists
  /* so the oven banner clears the instant Oven Out is filled */
  if (key === 'ovenIn' || key === 'ovenOut') fCache_().remove('ovenStatus');
  return { ok: true, via: res.via, note: res.note || '', key: fKeyValue_(f, values) };
}

/* ========================================================== history ====== */
/**
 * The last N entries on this form — everyone's, not just the caller's, because
 * an operator checking "did this slab already go through?" needs the whole
 * line's work, not their own.
 *
 * Read from the form's own tab in New Base, so entries made through the old
 * Google Forms show up alongside entries made through this app.
 */
function api_history(token, key, limit) {
  var s = fRequireSession_(token);
  if (s.forms.indexOf(key) === -1) throw new Error('That form is not assigned to you.');
  var f = FORM_DEFS[key];
  if (!f) throw new Error('Unknown form.');

  var n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  var sh = fss_().getSheetByName(f.tab);
  if (!sh) return { ok: false, error: 'No tab named "' + f.tab + '"' };

  var hi = fHeaderIdx_(sh);
  var last = fRealLastRow_(sh, hi);                 // not getLastRow(): see there
  if (last < 2) return { ok: true, entries: [], form: f.title };

  /* Container: as many material blocks as the tab has columns for. */
  if (f.repeatSection) {
    var rs = fRepeatSec_(f), blocks = 1;
    while (blocks < (rs.repeat.max || 30) &&
           fColOf_(hi, rs.fields[0].label + ' (' + (blocks + 1) + ')') !== undefined) blocks++;
    var cnt = {}; cnt[rs.repeat.countId] = blocks;
    f = fFormForValues_(f, cnt);
  }

  var start = Math.max(2, last - n + 1);
  var rows = sh.getRange(start, 1, last - start + 1, hi.width).getDisplayValues();

  function colOf(name) { return fColOf_(hi, name); }

  var tsCol = colOf('Timestamp');
  var whoCol;
  ['Email address', 'Email', 'Username', 'Entered by'].forEach(function (nm) {
    if (whoCol === undefined) whoCol = colOf(nm);
  });

  /* the schema decides which columns are worth showing, and in what order */
  var cols = [], slabCols = [], bundleCol;
  f.sections.forEach(function (sec) {
    sec.fields.forEach(function (fl) {
      var i = colOf(fl.label);
      if (i === undefined) return;
      if (fl.type === 'photo') return;              // a Drive link is noise on a tile
      cols.push({ label: fl.label, i: i });
      if (fl.isSlab) slabCols.push(i);
      if (fl.id === 'bundle') bundleCol = i;
    });
  });
  if (colOf('Slab Numbers') !== undefined) slabCols.unshift(colOf('Slab Numbers'));
  if (bundleCol === undefined) bundleCol = colOf('Bundle Number');
  /* Columns the writer works out rather than asks for (Bag Invoice's count,
     total and difference) are worth seeing on the tile too. */
  (f.extraHeaders || []).forEach(function (h) {
    var i = colOf(h);
    if (i !== undefined) cols.push({ label: h, i: i });
  });

  /* Dispatch is one row per SLAB, and its tab's headers were written before
     this app existed ("Grade", "Container/Truck No"), so the schema labels
     match nothing. Resolve those columns through the same alias lists the
     writer uses, and head each tile with the slab — "has this one already
     gone out?" is the question the history is opened to answer. */
  if (f.multiRow) {
    cols = [];
    var D = FORMS_DISPATCH;
    function firstCol(names) {
      for (var i = 0; i < names.length; i++) {
        var c = colOf(names[i]);
        if (c !== undefined) return c;
      }
      return undefined;
    }
    var dSlab = firstCol(D.slabHeaders);
    var dGrade = firstCol(D.gradeHeaders);
    var dCont = firstCol(D.containerHeaders);
    var dChanged = firstCol(D.changedHeaders);
    var dQc = firstCol(D.qcGradeHeaders);
    if (dSlab !== undefined) slabCols = [dSlab];
    if (dGrade !== undefined) cols.push({ label: 'Dispatched Grade', i: dGrade });
    /* Only ever filled on an override, so the tile shows them only then —
       an empty "Grade Changed" on every ordinary row would be noise. */
    if (dQc !== undefined) cols.push({ label: 'Q.C. Grade was', i: dQc });
    if (dChanged !== undefined) cols.push({ label: 'Grade', i: dChanged });
    if (dCont !== undefined) cols.push({ label: 'Container No.', i: dCont });
    bundleCol = undefined;
  }

  /* A form with neither a slab nor a bundle (the shift summaries) names its
     entries with whatever field it nominates. */
  var keyCol;
  if (f.keyField) {
    f.sections.forEach(function (sec) {
      sec.fields.forEach(function (fl) {
        if (fl.id === f.keyField) keyCol = colOf(fl.label);
      });
    });
  }

  /* Vacuum Unloader and Trolley are one entry per BUNDLE — the slabs are the
     contents, not the identity — so those tiles are headed by the bundle. */
  var bundleFirst = bundleCol !== undefined;

  var out = [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];

    var keyVal = '';
    if (bundleFirst) keyVal = String(row[bundleCol] || '').trim();
    for (var k = 0; k < slabCols.length && !keyVal; k++) {
      keyVal = String(row[slabCols[k]] || '').trim();
    }
    if (!keyVal && keyCol !== undefined) keyVal = String(row[keyCol] || '').trim();

    var fields = [];
    for (var c = 0; c < cols.length; c++) {
      var v = String(row[cols[c].i] == null ? '' : row[cols[c].i]).trim();
      if (!v || v === keyVal) continue;
      fields.push([cols[c].label, v]);
    }

    /* The Trolley tab keeps each bundle's slabs in a column named after that
       bundle (BN01…BN60), so the tile has to look the column up by name. */
    if (f.dynamicBundle && keyVal) {
      var bc = colOf(keyVal);
      if (bc !== undefined) {
        var bv = String(row[bc] || '').trim();
        if (bv) fields.push(['Slabs', bv]);
      }
    }
    if (!keyVal && !fields.length) continue;      // blank row

    var who = whoCol === undefined ? '' : String(row[whoCol] || '').trim();
    out.push({
      row: start + r,
      when: tsCol === undefined ? '' : String(row[tsCol] || '').trim(),
      who: who.indexOf('@') > 0 ? who.split('@')[0] : who,
      key: keyVal,
      fields: fields
    });
  }

  /* A slab appearing twice on the same stage is the thing an operator most
     needs to spot, so it is counted here and flagged on every copy. Forms
     whose key repeats by design (a shift name) opt out — flagging everything
     red would make the warning worthless. */
  var seen = {};
  if (f.dupCheck !== false) {
    out.forEach(function (e) {
      if (e.key) seen[e.key] = (seen[e.key] || 0) + 1;
    });
  }
  out.forEach(function (e) { e.dup = !!(e.key && seen[e.key] > 1); });

  out.reverse();                                   // newest first
  return { ok: true, form: f.title, entries: out,
           duplicates: Object.keys(seen).filter(function (k) { return seen[k] > 1; }).length };
}

/* ======================================================== oven timer ===== */
/**
 * Slabs currently inside the oven, and how long each has left.
 *
 * Oven In records the slab, its shelf and an estimated curing time in minutes,
 * with the timestamp of the entry. A slab is still in the oven until an Oven
 * Out row appears for it that is newer than its Oven In row. Overrun is the
 * thing that damages material, so the client counts down and turns red the
 * moment a slab passes its estimate.
 *
 * Only served to operators assigned an oven form. Cached briefly so a shift's
 * worth of phones polling does not hammer the spreadsheet.
 */
function api_ovenStatus(token) {
  var s = fRequireSession_(token);
  var isOvenUser = s.forms.indexOf('ovenIn') !== -1 || s.forms.indexOf('ovenOut') !== -1;
  if (!isOvenUser) return { ok: true, enabled: false, items: [], now: Date.now() };

  var hit = fCache_().get('ovenStatus');
  if (hit) {
    var cached = JSON.parse(hit);
    cached.now = Date.now();                 // never serve a stale clock
    return cached;
  }

  var res = { ok: true, enabled: true, now: Date.now(), items: [] };
  var ss = fss_();

  function scan(tabName, want) {
    var sh = ss.getSheetByName(tabName);
    if (!sh) return [];
    var last = sh.getLastRow();
    if (last < 2) return [];
    var hi = fHeaderIdx_(sh);
    var start = Math.max(2, last - FORMS_CFG.OVEN_SCAN_ROWS + 1);
    var vals = sh.getRange(start, 1, last - start + 1, hi.width).getValues();
    var idx = {};
    want.forEach(function (w) {
      var i = fColOf_(hi, w.header);
      idx[w.as] = i;
    });
    return vals.map(function (row) {
      var o = {};
      for (var k in idx) o[k] = idx[k] === undefined ? '' : row[idx[k]];
      return o;
    });
  }

  function ms(v) {
    if (v instanceof Date) return v.getTime();
    var d = new Date(v);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  function norm(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

  /* --- who went in, and when --- */
  var inRows = scan(FORM_DEFS.ovenIn.tab, [
    { header: 'Timestamp', as: 'ts' },
    { header: 'Slab Number', as: 'slab' },
    { header: 'Shelf Number', as: 'shelf' },
    { header: 'Estimated Curing Time', as: 'est' }
  ]);
  var inMap = {};
  inRows.forEach(function (r) {
    var slab = norm(r.slab);
    if (!slab) return;
    var t = ms(r.ts);
    if (!t) return;
    if (inMap[slab] && inMap[slab].startMs >= t) return;      // keep the latest
    var num = parseFloat(String(r.est).replace(/[^0-9.]/g, ''));
    if (isNaN(num)) num = 0;
    var mins = FORMS_CFG.OVEN_ESTIMATE_UNIT === 'hours' ? num * 60 : num;
    inMap[slab] = {
      slab: String(r.slab).trim(),
      shelf: String(r.shelf == null ? '' : r.shelf).trim(),
      est: mins,
      startMs: t
    };
  });

  /* --- who came back out --- */
  var outRows = scan(FORM_DEFS.ovenOut.tab, [
    { header: 'Timestamp', as: 'ts' },
    { header: 'Slab Number', as: 'slab' }
  ]);
  var outMap = {};
  outRows.forEach(function (r) {
    var slab = norm(r.slab);
    if (!slab) return;
    var t = ms(r.ts);
    if (t && (!outMap[slab] || t > outMap[slab])) outMap[slab] = t;
  });

  /* --- still inside --- */
  var staleBefore = res.now - FORMS_CFG.OVEN_STALE_HOURS * 3600000;
  var items = [], stale = 0, noEstimate = 0, noEst = [];
  for (var slab in inMap) {
    var e = inMap[slab];
    var out = outMap[slab] || 0;
    if (out && out >= e.startMs) continue;          // taken out after going in

    /* Went in yesterday or earlier and never came out: the Oven Out entry was
       missed. Counting it as "3 days overdue" would nail a red banner to every
       oven operator's screen for good, so it is reported, not alarmed. */
    if (e.startMs < staleBefore) { stale++; continue; }

    /* No usable estimate: still in the oven, but nothing to count down to.
       Reported rather than dropped — silently ignoring it is how a slab sits
       in the oven with nobody watching it. */
    if (!e.est || e.est < FORMS_CFG.OVEN_MIN_MINUTES) {
      noEstimate++;
      noEst.push({ slab: e.slab, shelf: e.shelf, startMs: e.startMs });
      continue;
    }

    items.push({
      slab: e.slab, shelf: e.shelf, est: e.est,
      startMs: e.startMs,
      dueMs: e.startMs + e.est * 60000
    });
  }
  items.sort(function (a, b) { return a.dueMs - b.dueMs; });
  res.items = items;
  res.stale = stale;               // in the oven > OVEN_STALE_HOURS, unmatched
  res.noEstimate = noEstimate;     // in the oven but no usable estimate
  res.noEst = noEst.slice(0, 20);

  fCache_().put('ovenStatus', JSON.stringify(res), FORMS_CFG.OVEN_CACHE_SECONDS);
  return res;
}

/**
 * Run from the editor when the oven strip shows nothing and you expect it to.
 * Prints exactly what the server computed and, for anything it skipped, why.
 */
function ovenDiag() {
  var ss = fss_();
  var inSh = ss.getSheetByName(FORM_DEFS.ovenIn.tab);
  var outSh = ss.getSheetByName(FORM_DEFS.ovenOut.tab);
  console.log('Oven In tab  : ' + (inSh ? inSh.getName() + ', ' + (inSh.getLastRow() - 1) + ' rows' : 'MISSING'));
  console.log('Oven Out tab : ' + (outSh ? outSh.getName() + ', ' + (outSh.getLastRow() - 1) + ' rows' : 'MISSING'));
  console.log('unit=' + FORMS_CFG.OVEN_ESTIMATE_UNIT +
              '  min=' + FORMS_CFG.OVEN_MIN_MINUTES +
              '  stale after=' + FORMS_CFG.OVEN_STALE_HOURS + 'h');

  fCache_().remove('ovenStatus');
  var fake = { forms: ['ovenIn', 'ovenOut'], username: 'diag' };
  var token = fToken_();
  fSaveSession_(token, { username: 'diag', display: 'diag', forms: fake.forms,
                         exp: Date.now() + 60000 });
  var r = api_ovenStatus(token);
  api_logout(token);

  console.log('counting down : ' + r.items.length);
  r.items.forEach(function (i) {
    console.log('   ' + i.slab + '  shelf ' + i.shelf + '  est ' + i.est + ' min  due ' +
      new Date(i.dueMs).toLocaleString());
  });
  console.log('skipped, no usable estimate : ' + r.noEstimate);
  (r.noEst || []).forEach(function (i) {
    console.log('   ' + i.slab + '  shelf ' + i.shelf + '  in at ' +
      new Date(i.startMs).toLocaleString());
  });
  console.log('skipped, older than ' + FORMS_CFG.OVEN_STALE_HOURS + 'h : ' + r.stale);
  if (!r.items.length && !r.noEstimate && !r.stale) {
    console.log('Nothing is in the oven: every Oven In row has a matching Oven Out.');
  }
  return r;
}

/* ================================================== dispatch slabs ======= */
/**
 * The slabs still available to dispatch, with the grade Q.C. Final gave each
 * one. Sent as parallel arrays rather than a list of objects: at four thousand
 * slabs the repeated keys cost more than the values, and this crosses to a
 * phone on plant wifi.
 */
function api_dispatchSlabs(token) {
  var s = fRequireSession_(token);
  if (s.forms.indexOf('dispatch') === -1) {
    throw new Error('The Dispatch Form is not assigned to you.');
  }
  var r = fDispatchSlabs_();
  return { ok: !r.error, slabs: r.slabs, grades: r.grades, error: r.error || '' };
}

/**
 * Read-only check you can run from the editor when the list looks wrong.
 * Prints where each number came from, which is the fastest way to see whether
 * the problem is QC data or the dispatch tab.
 */
function dispatchDiag() {
  var D = FORMS_DISPATCH;
  var ss = fss_();
  var qc = ss.getSheetByName(D.qcTab);
  var out = ss.getSheetByName(D.outTab);
  console.log('QC tab            : ' + D.qcTab +
              (qc ? '  ' + Math.max(0, qc.getLastRow() - 1) + ' rows' : '  MISSING'));
  console.log('Dispatch tab      : ' + D.outTab +
              (out ? '  ' + Math.max(0, out.getLastRow() - 1) + ' rows' : '  MISSING'));
  if (out) {
    console.log('  headers         : ' +
      out.getRange(1, 1, 1, Math.max(out.getLastColumn(), 1)).getValues()[0].join(' | '));
    console.log('  slab column     : ' + (fFindCol_(out, D.slabHeaders) || 'NOT FOUND'));
    console.log('  grade column    : ' + (fFindCol_(out, D.gradeHeaders) || 'NOT FOUND'));
    console.log('  container column: ' + (fFindCol_(out, D.containerHeaders) || 'NOT FOUND'));
    console.log('  changed column  : ' + (fFindCol_(out, D.changedHeaders) ||
                'NOT FOUND — run createDispatchSheet() to add it'));
    console.log('  QC grade column : ' + (fFindCol_(out, D.qcGradeHeaders) ||
                'NOT FOUND — run createDispatchSheet() to add it'));
  }
  fClearDispatchCache_();
  var r = fDispatchSlabs_();
  var already = Object.keys(fDispatchedSet_()).length;
  var noGrade = r.grades.filter(function (g) { return !g; }).length;
  console.log('');
  console.log('graded by QC, not yet dispatched : ' + r.slabs.length);
  console.log('already dispatched               : ' + already);
  console.log('of those, no usable grade        : ' + noGrade +
              '  (they show as "grade needed" and block submit until set)');
  console.log('first five : ' + r.slabs.slice(0, 5).map(function (sl, i) {
    return sl + ' ' + (r.grades[i] || '-');
  }).join(', '));
  console.log('last five  : ' + r.slabs.slice(-5).map(function (sl, i) {
    return sl + ' ' + (r.grades[r.slabs.length - 5 + i] || '-');
  }).join(', '));
  return r.slabs.length;
}

/* ============================================= grade reporting ========== */
/**
 * The repeated block, with its option lists resolved. Sent once and cloned per
 * selected section in the browser rather than sent six times.
 */
function fSectionTemplate_(f) {
  return f.sectionTemplate.map(function (fl) {
    var o = { id: fl.id, label: fl.label, type: fl.type, required: !!fl.required,
              help: fl.help || '', options: null };
    if (fl.id === 'defects') o.options = FOPT.DEFECTS;
    if (fl.id === 'area')    o.options = FOPT.AREAS_ALL;
    if (fl.type === 'media') {
      o.limits = {
        photos: FORMS_ALERT.MAX_PHOTOS_PER_SECTION,
        videos: FORMS_ALERT.MAX_VIDEOS_PER_SECTION,
        edge:   FORMS_ALERT.PHOTO_MAX_EDGE,
        quality: FORMS_ALERT.PHOTO_QUALITY,
        videoSeconds: FORMS_ALERT.VIDEO_MAX_SECONDS,
        videoMb: FORMS_ALERT.VIDEO_MAX_MB
      };
    }
    return o;
  });
}

/** The live alerts this user should see. Operators see none. */
function api_alerts(token) {
  var s = fRequireSession_(token);
  var role = s.role || 'operator';
  if (role !== 'supervisor' && role !== 'admin') {
    return { ok: true, enabled: false, now: Date.now(), items: [] };
  }
  var open = fOpenAlerts_();
  return { ok: true, enabled: true, now: new Date().getTime(),
           canReport: s.forms.indexOf('gradeReport') !== -1,
           items: open.slice(0, 40) };
}

/**
 * One photo or video, already downscaled by the browser.
 *
 * Sent on its own rather than with the form: a submission carrying six photos
 * is a single request big enough to time out on plant wifi, and when it does
 * the supervisor loses everything they typed as well.
 */
function api_uploadMedia(token, slab, name, mime, b64) {
  var s = fRequireSession_(token);
  if (s.forms.indexOf('gradeReport') === -1 && s.forms.indexOf('container') === -1) {
    throw new Error('No form that takes photos is assigned to you.');
  }
  if (!b64) return { ok: false, error: 'Nothing was uploaded.' };

  var isVideo = /^video\//.test(String(mime || ''));
  var maxMb = isVideo ? FORMS_ALERT.VIDEO_MAX_MB : 8;
  var bytes = Math.ceil(String(b64).length * 3 / 4);
  if (bytes > maxMb * 1024 * 1024) {
    return { ok: false, error: (isVideo ? 'That video' : 'That photo') +
      ' is ' + Math.round(bytes / 1048576) + 'MB — the limit is ' + maxMb + 'MB.' };
  }

  try {
    var f = fSaveMedia_(slab, name, mime, b64);
    return { ok: true, url: f.url, id: f.id, name: f.name, video: isVideo };
  } catch (err) {
    return { ok: false, error: 'Could not save it to Drive: ' + String(err && err.message || err) };
  }
}

/** The admin Feedback page. Admin only, deliberately. */
function api_feedback(token, limit) {
  var s = fRequireSession_(token);
  if ((s.role || 'operator') !== 'admin') {
    throw new Error('The Feedback page is for administrators.');
  }
  return fFeedbackFeed_(limit);
}

/* ============================ notifications (Telegram, self-service) ==== */
/*
 * Everything below acts on the CALLER'S OWN row only — the session decides
 * whose code is issued and whose chat is unlinked, never a parameter from the
 * browser. The one admin-only endpoint is the token, which is a secret and is
 * treated like one.
 */

function fNotifyEligible_(s) {
  var role = (s && s.role) || 'operator';
  return role === 'supervisor' || role === 'admin';
}

/** What the Notifications page shows, plus the setup it quietly performs. */
function api_telegramStatus(token) {
  var s = fRequireSession_(token);
  if (!fNotifyEligible_(s)) return { ok: true, eligible: false };
  return fTgSelfStatus_(s.username, s.role === 'admin');
}

/**
 * Polled every few seconds while the page waits for the user to tap START in
 * Telegram. Deliberately cheap: one read of the user tab, nothing else.
 */
function api_telegramCheck(token) {
  var s = fRequireSession_(token);
  if (!fNotifyEligible_(s)) return { ok: true, eligible: false, linked: false };
  var u = fFindUser_(s.username);
  return { ok: true, eligible: true, linked: !!(u && u.chatId) };
}

/** Prove the chain works, to the person asking rather than to the whole team. */
function api_telegramTest(token) {
  var s = fRequireSession_(token);
  if (!fNotifyEligible_(s)) throw new Error('Notifications are for supervisors.');
  var u = fFindUser_(s.username);
  if (!u || !u.chatId) return { ok: false, error: 'You are not connected yet.' };
  var ok = fTgSend_(u.chatId,
    'Test from Slabworks. Alerts will reach you here — one message per slab ' +
    'Q.C. Final grades ' + FORMS_ALERT.GRADES.join(' or ') + '.');
  return ok ? { ok: true } : { ok: false, error: 'Telegram refused the message.' };
}

/** Stop this one person's messages. A fresh code is issued next time. */
function api_telegramUnlink(token) {
  var s = fRequireSession_(token);
  if (!fNotifyEligible_(s)) throw new Error('Notifications are for supervisors.');
  var u = fFindUser_(s.username);
  if (!u) throw new Error('Your row is missing from App Users.');
  if (u.chatId) {
    try { fTgSend_(u.chatId, 'Disconnected. You will not get Slabworks alerts here.'); }
    catch (e) {}
  }
  fSetChatId_(u.row, '');
  fSetTelegramCode_(u.row, '');
  return { ok: true };
}

/**
 * Admin only: store the @BotFather token without going near Project Settings.
 * Validated against Telegram before it is written, so a typo is rejected here
 * rather than discovered when the first alert goes nowhere.
 */
function api_telegramSaveToken(token, botToken) {
  var s = fRequireSession_(token);
  if ((s.role || 'operator') !== 'admin') {
    throw new Error('Only an administrator can set the bot token.');
  }
  var t = String(botToken || '').trim();
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(t)) {
    return { ok: false, error: 'That does not look like a bot token. @BotFather ' +
                               'sends digits, a colon, then a long string.' };
  }
  var props = PropertiesService.getScriptProperties();
  var prev = props.getProperty(FORMS_ALERT.TELEGRAM_TOKEN_PROP) || '';
  props.setProperty(FORMS_ALERT.TELEGRAM_TOKEN_PROP, t);

  var me = fTgCall_('getMe', {});
  if (!me || !me.ok) {
    /* Put the working one back rather than leaving the shop floor with a bot
       that no longer answers. */
    if (prev) props.setProperty(FORMS_ALERT.TELEGRAM_TOKEN_PROP, prev);
    else props.deleteProperty(FORMS_ALERT.TELEGRAM_TOKEN_PROP);
    return { ok: false, error: 'Telegram rejected that token: ' +
                               ((me && me.description) || 'no answer') };
  }
  props.deleteProperty(FTG_BOT_PROP);
  props.deleteProperty(FTG_HOOK_PROP);
  return fTgSelfStatus_(s.username, true);
}

/**
 * Admin only: throw away anything Telegram is still holding and make sure the
 * bot is being polled. The fix when the bot repeats itself or goes quiet.
 */
function api_telegramReset(token) {
  var s = fRequireSession_(token);
  if ((s.role || 'operator') !== 'admin') {
    throw new Error('Only an administrator can reset the bot.');
  }
  telegramDropPending();
  fTgEnsurePolling_();
  return fTgSelfStatus_(s.username, true);
}

/**
 * Admin only: the two things that used to be editor work — the alert tabs and
 * the five-minute watch on Q.C. Final.
 */
function api_alertSetup(token) {
  var s = fRequireSession_(token);
  if ((s.role || 'operator') !== 'admin') {
    throw new Error('Only an administrator can turn alert checking on.');
  }
  try { createAlertSheets(); } catch (e) {}
  if (!fAlertScanInstalled_()) installAlertTrigger();
  return fTgSelfStatus_(s.username, true);
}