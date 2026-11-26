/**
 * Slabworks Production Forms — response sheet generator
 * -----------------------------------------------------
 * Creates the tab a form writes into, with the header row built FROM THE
 * SCHEMA. That is the point: the app maps values to columns by header name, so
 * generating the headers from the same field labels means they cannot drift
 * apart. Hand-typing them is how you get a column that silently never fills.
 *
 * WHAT TO RUN
 *   createSummarySheets()   the two Production Summary tabs (A and B)
 *   ensureAllFormTabs()     every form in the schema that has no tab yet
 *   describeFormTabs()      read-only: what exists, what is missing, and any
 *                           header that does not match the schema
 *
 * Nothing here ever deletes or rewrites an existing tab. If a tab is already
 * there it is left completely alone and reported as "exists".
 */

/** The header row a form's tab should have, in order. */
function fExpectedHeaders_(form) {
  /* Dispatch fans one submission out into a row per slab, so its columns are
     not its fields: the "Slab Numbers" field becomes one "Slab Number" cell
     per row, and the grade rides alongside it. Named from FORMS_DISPATCH so
     the generator and the writer can never disagree about a column name. */
  if (form.multiRow) {
    var D = FORMS_DISPATCH;
    return ['Timestamp', 'Email address',
            D.containerHeaders[0], D.slabHeaders[0], D.gradeHeaders[0],
            D.changedHeaders[0], D.qcGradeHeaders[0]];
  }

  var out = ['Timestamp', 'Email address'];
  form.sections.forEach(function (sec) {
    sec.fields.forEach(function (fl) {
      /* The Trolley slab list has no column of its own — each bundle owns one
         (BN01…BN60) — so it is not a header. */
      if (form.dynamicBundle && fl.source === '@bundle') return;
      if (out.indexOf(fl.label) === -1) out.push(fl.label);
    });
  });
  /* Columns the writer works out itself (Bag Invoice's count and totals). */
  (form.extraHeaders || []).forEach(function (h) {
    if (out.indexOf(h) === -1) out.push(h);
  });
  return out;
}

/** Create one form's tab if it does not already exist. */
function fCreateFormTab_(formKey) {
  var form = FORM_DEFS[formKey];
  if (!form) throw new Error('Unknown form key: ' + formKey);

  var ss = fss_();
  var existing = ss.getSheetByName(form.tab);
  if (existing) {
    return { key: formKey, tab: form.tab, created: false,
             note: 'already exists, left untouched (' +
                   Math.max(0, existing.getLastRow() - 1) + ' rows)' };
  }

  var headers = fExpectedHeaders_(form);
  var sh = ss.insertSheet(form.tab);

  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold')
    .setBackground('#131211')
    .setFontColor('#FFFFFF')
    .setVerticalAlignment('middle')
    .setWrap(true);
  fHeaderChanged_(sh);
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 40);

  /* Same format the app stamps on every timestamp it writes: without the time
     the dashboard's shift-wise numbers collapse onto midnight. */
  sh.getRange('A:A').setNumberFormat(FORMS_CFG.TIMESTAMP_FORMAT);

  sh.setColumnWidth(1, 150);                       // Timestamp
  sh.setColumnWidth(2, 150);                       // Email address
  for (var c = 3; c <= headers.length; c++) sh.setColumnWidth(c, 170);

  /* Trim the empty columns Google gives a new sheet, so the tab is exactly as
     wide as the form. fHeaderIdx_ reads getLastColumn(), and a wall of unnamed
     columns to the right just makes every read wider than it needs to be. */
  var extra = sh.getMaxColumns() - headers.length;
  if (extra > 0) sh.deleteColumns(headers.length + 1, extra);

  return { key: formKey, tab: form.tab, created: true,
           columns: headers.length, headers: headers };
}

/**
 * THE ONE TO RUN for the two new forms.
 * Creates "Production Summary A" and "Production Summary B" in New Base.
 */
/**
 * Append any header a form asks for that the tab does not have.
 *
 * fAppendSheet_ writes only the cells it has a column for and says nothing
 * about the rest, so a field added to a form after its tab was made is a field
 * whose answers vanish silently. Existing rows keep an empty cell there, which
 * is correct: nobody was asked.
 */
function fAddMissingColumns_(formKey) {
  var form = FORM_DEFS[formKey];
  var sh = fss_().getSheetByName(form.tab);
  if (!sh) return [];
  var have = fHeaderIdx_(sh), added = [];
  fExpectedHeaders_(form).forEach(function (h) {
    if (fColOf_(have, h) !== undefined) return;
    var at = sh.getLastColumn() + 1;
    if (at > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    sh.getRange(1, at).setValue(h)
      .setFontWeight('bold').setBackground('#131211').setFontColor('#FFFFFF')
      .setVerticalAlignment('middle').setWrap(true);
    added.push(h);
    fHeaderChanged_(sh);
    have = fHeaderIdx_(sh);
  });
  return added;
}

function createSummarySheets() {
  var res = ['prodSummaryA', 'prodSummaryB'].map(fCreateFormTab_);
  res.forEach(function (r) {
    console.log((r.created ? 'CREATED  ' : 'exists   ') + r.tab +
                (r.created ? '  (' + r.columns + ' columns)' : '  — ' + r.note));
    if (r.created) console.log('           ' + r.headers.join(' | '));
  });

  /* Both tabs have been in use for months, so PRODUCTION DATE has to be added
     to them rather than created with them. */
  ['prodSummaryA', 'prodSummaryB'].forEach(function (k) {
    var added = fAddMissingColumns_(k);
    if (!added.length) return;
    console.log('ADDED to ' + FORM_DEFS[k].tab + ': ' + added.join(' | '));
  });

  console.log('');
  console.log('Assign them in the App Users tab: put prodSummaryA and/or');
  console.log('prodSummaryB in a user Assigned Forms cell (ALL covers both).');
  return res;
}

/** Create a tab for every form in the schema that does not have one yet. */
function ensureAllFormTabs() {
  var res = FORM_KEYS.map(fCreateFormTab_);
  var made = res.filter(function (r) { return r.created; });
  res.forEach(function (r) {
    console.log((r.created ? 'CREATED  ' : 'exists   ') + r.tab);
  });
  console.log(made.length + ' tab' + (made.length === 1 ? '' : 's') + ' created, ' +
              (res.length - made.length) + ' already there.');
  return res;
}

/**
 * Read-only check. Lists every form, whether its tab exists, and any schema
 * label with no matching header — those are the fields that would be silently
 * dropped on submit.
 */
function describeFormTabs() {
  var ss = fss_(), report = [];
  FORM_KEYS.forEach(function (k) {
    var form = FORM_DEFS[k];
    var sh = ss.getSheetByName(form.tab);
    if (!sh) {
      console.log('MISSING  ' + form.tab + '   (run ensureAllFormTabs)');
      report.push({ key: k, tab: form.tab, exists: false });
      return;
    }
    var hi = fHeaderIdx_(sh);
    var missing;
    if (form.multiRow) {
      /* Dispatch accepts either spelling of each column — the tab that was
         already in New Base uses "Grade" and "Container/Truck No" — so check
         the alias lists, not the one preferred name. */
      var D = FORMS_DISPATCH;
      missing = [['Container No.', D.containerHeaders],
                 ['Slab Number', D.slabHeaders],
                 ['Dispatched Grade', D.gradeHeaders],
                 ['Grade Changed', D.changedHeaders],
                 ['Q.C. Grade', D.qcGradeHeaders]]
        .filter(function (c) { return !fFindCol_(sh, c[1]); })
        .map(function (c) { return c[0]; });
    } else {
      missing = fExpectedHeaders_(form).filter(function (h) {
        return fColOf_(hi, h) === undefined;
      });
    }
    console.log((missing.length ? 'CHECK    ' : 'ok       ') + form.tab +
                '  ' + Math.max(0, sh.getLastRow() - 1) + ' rows' +
                (missing.length ? '  — no column for: ' + missing.join(', ') : ''));
    report.push({ key: k, tab: form.tab, exists: true,
                  rows: Math.max(0, sh.getLastRow() - 1), missingColumns: missing });
  });
  return report;
}

/**
 * THE ONE TO RUN for the Dispatch Form.
 *
 * New Base already had an empty "Dispatch Form" tab when this was written,
 * with columns Slab Number / Grade / Client Name / New Client Name /
 * Container/Truck No. That tab is left exactly as it is — the app writes into
 * it, matching those names through FORMS_DISPATCH, and simply leaves the two
 * client columns empty. Nothing has to be renamed.
 *
 * If the tab is missing, this creates it with the names the app prefers:
 * Timestamp | Email address | Container No. | Slab Number | Dispatched Grade.
 */
function createDispatchSheet() {
  var D = FORMS_DISPATCH;
  var form = FORM_DEFS.dispatch;
  var ss = fss_();
  var sh = ss.getSheetByName(form.tab);

  if (!sh) {
    var r = fCreateFormTab_('dispatch');
    console.log('CREATED  ' + r.tab + '  (' + r.columns + ' columns)');
    console.log('         ' + r.headers.join(' | '));
    return r;
  }

  console.log('The "' + form.tab + '" tab already exists — its columns are left');
  console.log('exactly as they are (' + Math.max(0, sh.getLastRow() - 1) + ' rows).');
  console.log('  headers : ' +
    sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].join(' | '));
  console.log('');

  /* container / slab / grade must already exist — those hold the entry itself
     and guessing at them would be reckless. The two audit columns are new, so
     if they are missing they are APPENDED on the right: nothing is renamed,
     reordered, or overwritten, and no data cell is touched. */
  var required = [
    ['container', D.containerHeaders],
    ['slab',      D.slabHeaders],
    ['grade',     D.gradeHeaders]
  ];
  var addable = [
    ['grade changed', D.changedHeaders],
    ['q.c. grade',    D.qcGradeHeaders]
  ];

  var missing = [];
  required.forEach(function (c) {
    var col = fFindCol_(sh, c[1]);
    console.log('  ' + fPad_(c[0]) + ': ' +
      (col ? 'column ' + fColLetter_(col) + '  "' + sh.getRange(1, col).getValue() + '"'
           : 'NOT FOUND — add a column named "' + c[1][0] + '"'));
    if (!col) missing.push(c[1][0]);
  });

  var added = [];
  addable.forEach(function (c) {
    var col = fFindCol_(sh, c[1]);
    if (col) {
      console.log('  ' + fPad_(c[0]) + ': column ' + fColLetter_(col) +
                  '  "' + sh.getRange(1, col).getValue() + '"');
      return;
    }
    var at = sh.getLastColumn() + 1;
    if (at > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    sh.getRange(1, at).setValue(c[1][0])
      .setFontWeight('bold').setBackground('#131211').setFontColor('#FFFFFF')
      .setVerticalAlignment('middle').setWrap(true);
    sh.setColumnWidth(at, 140);
    fHeaderChanged_(sh);
    added.push(c[1][0] + ' (' + fColLetter_(at) + ')');
    console.log('  ' + fPad_(c[0]) + ': ADDED as column ' + fColLetter_(at) +
                '  "' + c[1][0] + '"');
  });

  console.log('');
  if (missing.length) {
    console.log('Add ' + missing.length + ' column' + (missing.length === 1 ? '' : 's') +
                ' to the tab yourself and run this again: ' + missing.join(', '));
  } else {
    if (added.length) console.log('Added: ' + added.join(', '));
    console.log('Ready. One row per slab, and on any row where the dispatched');
    console.log('grade differs from Q.C. Final: "' + D.changedWord + '" in ' +
                D.changedHeaders[0] + ', and the');
    console.log('original in ' + D.qcGradeHeaders[0] + '. Both stay empty when nothing changed.');
  }
  return { key: 'dispatch', tab: form.tab, created: false,
           missingColumns: missing, addedColumns: added };
}

/** Pads a label so the log lines up. */
function fPad_(s) { return (s + '                ').slice(0, 15); }

/** 1 -> A, 27 -> AA. Only used to make the log above readable. */
function fColLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

/* ============================================ column health check ======== */
/**
 * RUN THIS after any change to a tab's header row.
 *
 * For every form, every field, it answers one question: will a value typed
 * into this field actually land in a cell? A field whose label matches no
 * column is not an error anywhere — the value is simply dropped, the column
 * stays empty, and it looks exactly like an operator who skipped the question.
 * Three Batching columns and one Resin column were being lost that way for
 * weeks before anyone noticed.
 *
 * Reports three states per field:
 *   ok        matched a column exactly
 *   matched   matched only after ignoring spacing or case — works, but the
 *             header is worth tidying so the two read the same
 *   DROPPED   no column at all; this field's value goes nowhere
 */
function verifyFormColumns() {
  var ss = fss_();
  var problems = 0, loose = 0, checked = 0;

  FORM_KEYS.forEach(function (key) {
    var f = FORM_DEFS[key];
    var sh = ss.getSheetByName(f.tab);
    if (!sh) { console.log('MISSING TAB   ' + f.tab); problems++; return; }
    var hi = fHeaderIdx_(sh);

    var names = [];
    if (f.multiRow) {
      var D = FORMS_DISPATCH;
      names = [D.containerHeaders[0], D.slabHeaders[0], D.gradeHeaders[0],
               D.changedHeaders[0], D.qcGradeHeaders[0]];
    } else if (f.multiSection) {
      names = fFeedbackHeaders_();
    } else {
      f.sections.forEach(function (sec) {
        sec.fields.forEach(function (fl) {
          if (f.dynamicBundle && fl.source === '@bundle') return;
          names.push(fl.label);
        });
      });
      names = names.concat(f.extraHeaders || []);
    }

    var bad = [], soft = [];
    names.forEach(function (n) {
      checked++;
      if (hi.map[n] !== undefined) return;                 // exact
      var i = fColOf_(hi, n);
      if (i === undefined) { bad.push(n); return; }
      soft.push({ label: n, header: String(hi.headers[i]), col: fColLetter_(i + 1) });
    });

    if (!bad.length && !soft.length) {
      console.log('ok            ' + f.tab + '   ' + names.length + ' fields');
      return;
    }
    console.log('');
    console.log(f.tab);
    soft.forEach(function (x) {
      loose++;
      console.log('  matched     "' + x.label + '"');
      console.log('              column ' + x.col + ' is "' + x.header +
                  '"  — spacing differs, tidy when convenient');
    });
    bad.forEach(function (n) {
      problems++;
      console.log('  DROPPED     "' + n + '"  — no column matches. This value goes nowhere.');
    });
  });

  console.log('');
  console.log(checked + ' fields checked · ' + problems + ' dropped · ' +
              loose + ' matched only by ignoring spacing');
  if (problems) {
    console.log('');
    console.log('A DROPPED field needs a column on that tab whose header is the');
    console.log('field label, or the label changed in FormsSchema.gs to match.');
  }
  return { checked: checked, dropped: problems, loose: loose };
}

/* ================================================ recovering the lost ==== */
/**
 * Fills in cells that WERE typed by an operator but never reached the sheet,
 * from App Submission Log.
 *
 * Every submission's full payload is written to that log, keyed by field id,
 * so a value the writer dropped because of a header mismatch is still on
 * record. This walks the log and puts those values where they belong.
 *
 * Only ever fills a BLANK cell. It never overwrites anything, and it skips a
 * log row it cannot tie to exactly one sheet row — a value written against the
 * wrong slab is worse than a missing one.
 *
 *   backfillFromLog('batching')          show what it would do, change nothing
 *   backfillFromLog('batching', true)    actually write
 */
function backfillFromLog(formKey, apply) {
  var f = FORM_DEFS[formKey];
  if (!f) throw new Error('Unknown form key: ' + formKey +
    '. One of: ' + FORM_KEYS.join(', '));
  if (f.multiRow || f.multiSection) {
    throw new Error(formKey + ' writes many rows per submission; this only ' +
                    'handles the one-row-per-submission forms.');
  }

  var ss = fss_();
  var logSh = ss.getSheetByName(FORMS_CFG.LOG_TAB);
  if (!logSh || logSh.getLastRow() < 2) throw new Error('No submission log to read.');
  var sh = ss.getSheetByName(f.tab);
  if (!sh) throw new Error('No tab named "' + f.tab + '"');

  var hi = fHeaderIdx_(sh);
  var protectedCols = fProtectedCols_(sh, hi);

  /* field id -> column, for the fields that have one */
  var cols = {};
  f.sections.forEach(function (sec) {
    sec.fields.forEach(function (fl) {
      var c = fColOf_(hi, fl.label);
      if (c !== undefined && !protectedCols[c]) cols[fl.id] = c;
    });
  });

  var tsCol = fColOf_(hi, 'Timestamp');
  if (tsCol === undefined) throw new Error('"' + f.tab + '" has no Timestamp column.');

  /* index the sheet by slab */
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, hi.width).getValues() : [];
  var bySlab = {};
  for (var r = 0; r < rows.length; r++) {
    var slab = '';
    ['slab', 'slabA', 'slabB'].forEach(function (id) {
      if (slab || cols[id] === undefined) return;
      slab = String(rows[r][cols[id]] || '').trim().toUpperCase();
    });
    if (!slab) continue;
    (bySlab[slab] || (bySlab[slab] = [])).push(r);
  }

  var logLast = logSh.getLastRow();
  var log = logSh.getRange(2, 1, logLast - 1, 7).getValues();

  var writes = {}, filled = 0, skippedAmbiguous = 0, skippedNoRow = 0, already = 0;
  var byField = {};

  for (var i = 0; i < log.length; i++) {
    if (String(log[i][2]).trim() !== f.title) continue;
    if (String(log[i][5]).indexOf('OK') !== 0) continue;
    var payload;
    try { payload = JSON.parse(log[i][6]); } catch (e) { continue; }

    var key = String(payload.slab || payload.slabA || payload.slabB || '').trim().toUpperCase();
    if (!key) continue;
    var candidates = bySlab[key];
    if (!candidates || !candidates.length) { skippedNoRow++; continue; }

    /* One slab can legitimately appear twice. Pick the row whose timestamp is
       nearest the log entry, and only if it is within two minutes — otherwise
       there is no way to know which submission this was. */
    var when = log[i][0] instanceof Date ? log[i][0].getTime() : 0;
    var pick = -1, bestGap = Infinity;
    for (var ci = 0; ci < candidates.length; ci++) {
      var rowTs = rows[candidates[ci]][tsCol];
      var gap = (rowTs instanceof Date && when) ? Math.abs(rowTs.getTime() - when) : Infinity;
      if (gap < bestGap) { bestGap = gap; pick = candidates[ci]; }
    }
    if (pick < 0 || bestGap > 120000) {
      if (candidates.length === 1 && !when) pick = candidates[0];
      else { skippedAmbiguous++; continue; }
    }

    Object.keys(cols).forEach(function (id) {
      var v = payload[id];
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v)) v = v.join(', ');
      var c = cols[id];
      var cur = rows[pick][c];
      if (cur !== '' && cur !== null && cur !== undefined) { already++; return; }
      writes[(pick + 2) + ':' + (c + 1)] = v;
      rows[pick][c] = v;                       // so a later log row sees it filled
      filled++;
      byField[id] = (byField[id] || 0) + 1;
    });
  }

  console.log((apply ? 'BACKFILL — writing' : 'DRY RUN — nothing will be written') +
              '   form: ' + f.title);
  console.log('');
  var ids = Object.keys(byField).sort();
  if (!ids.length) {
    console.log('Nothing to recover: every logged value is already in the sheet.');
  } else {
    ids.forEach(function (id) {
      var label = '';
      f.sections.forEach(function (sec) {
        sec.fields.forEach(function (fl) { if (fl.id === id) label = fl.label; });
      });
      console.log('  ' + String(byField[id]).padStart(4) + '  cells   ' + label);
    });
  }
  console.log('');
  console.log('  total blanks fillable : ' + filled);
  console.log('  already had a value   : ' + already + '  (left alone)');
  console.log('  log rows with no sheet row : ' + skippedNoRow);
  console.log('  could not be tied to one row : ' + skippedAmbiguous + '  (skipped on purpose)');

  if (!apply) {
    console.log('');
    console.log("Run  backfillFromLog('" + formKey + "', true)  to write these.");
    return { filled: filled, applied: false, byField: byField };
  }

  var keys = Object.keys(writes);
  for (var w = 0; w < keys.length; w++) {
    var rc = keys[w].split(':');
    sh.getRange(+rc[0], +rc[1]).setValue(writes[keys[w]]);
  }
  console.log('');
  console.log(keys.length + ' cells written.');
  return { filled: filled, applied: true, byField: byField };
}

/**
 * RUN ONCE to create the "Bag Form" tab.
 *
 * Six columns: Timestamp, Email address, Material, Supplier Code, Bag Number,
 * Weight. Bag Number and Weight are formatted as numbers so the column sums
 * without anyone having to clean it first — the form refuses anything that is
 * not a number, so the format is a promise it can keep.
 */
function createBagSheet() {
  var form = FORM_DEFS.bag;
  var ss = fss_();
  var sh = ss.getSheetByName(form.tab);

  if (sh) {
    console.log('The "' + form.tab + '" tab already exists — left exactly as it is (' +
                Math.max(0, sh.getLastRow() - 1) + ' rows).');
    console.log('  headers : ' +
      sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].join(' | '));
    console.log('');
    console.log('Run verifyFormColumns() to check every field has a column to land in.');
    return { tab: form.tab, created: false };
  }

  var r = fCreateFormTab_('bag');
  sh = ss.getSheetByName(form.tab);

  var hi = fHeaderIdx_(sh);
  [['Bag Number', '0'], ['Weight', '0.00']].forEach(function (c) {
    var i = fColOf_(hi, c[0]);
    if (i === undefined) return;
    sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat(c[1]);
  });

  console.log('CREATED  ' + r.tab + '  (' + r.columns + ' columns)');
  console.log('         ' + r.headers.join(' | '));
  console.log('');
  console.log('Assign it to whoever fills it:');
  console.log('  addFormsUser("<username>", "<NAME>", ["bag"], "<password>")');
  console.log('or add "bag" to their Assigned Forms cell on the App Users tab.');
  return r;
}

/**
 * RUN ONCE to create the "Bag Invoice" tab.
 *
 * One row per invoice: Timestamp, Email address, Material, Supplier Code,
 * Invoice Number, Invoice Weight, Bag Numbers, Bag Count, Bags Total Weight,
 * Difference. Bag Numbers is plain text, so an invoice with a single bag keeps
 * "4970" as written instead of turning it into a number; the weights are
 * numbers, so the columns sum. Difference is bags minus invoice: above zero,
 * the bags weigh more than the invoice says.
 */
function createBagInvoiceSheet() {
  var form = FORM_DEFS.bagInvoice;
  var ss = fss_();
  var sh = ss.getSheetByName(form.tab);

  if (sh) {
    var added = fAddMissingColumns_('bagInvoice');
    console.log('The "' + form.tab + '" tab already exists — left as it is (' +
                Math.max(0, sh.getLastRow() - 1) + ' rows).' +
                (added.length ? ' Added: ' + added.join(' | ') : ''));
    return { tab: form.tab, created: false, added: added };
  }

  var r = fCreateFormTab_('bagInvoice');
  sh = ss.getSheetByName(form.tab);
  var hi = fHeaderIdx_(sh);
  [['Invoice Number', '@'], ['Bag Numbers', '@'], ['Invoice Weight', '0'],
   ['Bag Count', '0'], ['Bags Total Weight', '0.00'], ['Difference', '0.00']].forEach(function (c) {
    var i = fColOf_(hi, c[0]);
    if (i === undefined) return;
    sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat(c[1]);
  });
  var bi = fColOf_(hi, 'Bag Numbers');
  if (bi !== undefined) sh.setColumnWidth(bi + 1, 320);

  console.log('CREATED  ' + r.tab + '  (' + r.columns + ' columns)');
  console.log('         ' + r.headers.join(' | '));
  console.log('');
  console.log('Assign it: add "bagInvoice" to a user\'s Assigned Forms cell on App Users');
  console.log('(ALL already covers it).');
  return r;
}

/* =========================================================== formula ===== */
/*
 * Create the "Formula Form" tab.
 *
 * Twenty columns of recipe, and the ones that matter to the Costing tab are
 * the quantities — so they are formatted as kilograms to two places here,
 * once, rather than arriving as whatever the first entry happened to look
 * like. Nothing is touched if the tab already exists: a tab with rows in it is
 * the plant's data, not this script's.
 */
function createFormulaSheet() {
  var form = FORM_DEFS.formula;
  var ss = fss_();
  var sh = ss.getSheetByName(form.tab);

  if (sh) {
    /* The tab is already there, so nothing in it is touched — but a field added
       to the form after the tab was made has no column to land in, and
       fAppendSheet_ drops such a value in silence. A missing header is appended
       rather than reported, because a recipe quietly saved without its size is
       a recipe the Costing tab can never match. */
    var have = fHeaderIdx_(sh);
    var added = [];
    fExpectedHeaders_(form).forEach(function (h) {
      if (fColOf_(have, h) !== undefined) return;
      var at = sh.getLastColumn() + 1;
      if (at > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
      sh.getRange(1, at).setValue(h)
        .setFontWeight('bold').setBackground('#131211').setFontColor('#FFFFFF')
        .setVerticalAlignment('middle').setWrap(true);
      added.push(h);
      fHeaderChanged_(sh);
      have = fHeaderIdx_(sh);
    });

    console.log('The "' + form.tab + '" tab already exists — its ' +
                Math.max(0, sh.getLastRow() - 1) + ' rows are untouched.');
    if (added.length) {
      console.log('ADDED ' + added.length + ' missing column' + (added.length === 1 ? '' : 's') +
                  ': ' + added.join(' | '));
      console.log('  Rows entered before now have that cell empty, which is correct — ' +
                  'nobody was asked for it.');
    } else {
      console.log('Every field already has a column.');
    }
    console.log('  headers : ' +
      sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].join(' | '));
    return { tab: form.tab, created: false, added: added };
  }

  var r = fCreateFormTab_('formula');
  sh = ss.getSheetByName(form.tab);

  var hi = fHeaderIdx_(sh);
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  form.sections.forEach(function (sec) {
    sec.fields.forEach(function (fl) {
      if (fl.type !== 'number') return;
      var i = fColOf_(hi, fl.label);
      if (i === undefined) return;
      sh.getRange(2, i + 1, rows, 1).setNumberFormat('0.00');
    });
  });

  console.log('CREATED  ' + r.tab + '  (' + r.columns + ' columns)');
  console.log('         ' + r.headers.join(' | '));
  console.log('');
  console.log('Assign it to whoever fills it:');
  console.log('  addFormsUser("<username>", "<NAME>", ["formula"], "<password>")');
  console.log('or add "formula" to their Assigned Forms cell on the App Users tab.');
  return r;
}
