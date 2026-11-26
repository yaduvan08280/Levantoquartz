/**
 * Slabworks Production Forms — the fast path (Google Sheets API)
 * --------------------------------------------------------------
 * Every SpreadsheetApp call into New Base costs about a second while the
 * plant is working, because each one goes through a copy of the whole 31-tab
 * workbook — and a save needed five or six of them. Measured on 19/11/2026:
 * open 1-2 s, header 1 s, row count 1 s, a column read 2-8 s, the write 3 s.
 *
 * The Sheets API (the "Sheets" advanced service, appsscript.json) reads and
 * writes cell ranges directly, without loading the workbook. A plain save is
 * four calls here:
 *   header row                                  (before the lock)
 *   row count + duplicate-check columns, one call (inside the lock)
 *   the row's values, then its date formats      (inside the lock)
 *   the audit line                               (after the lock)
 *
 * Only the simple one-row forms come this way. Dispatch, Grade Reporting,
 * Bag Invoice and Oven Out keep their own writers, and so does any tab that
 * has a per-row formula to copy down. Anything that goes wrong BEFORE a value
 * is written falls back to the SpreadsheetApp path (FormsSubmit.js), which is
 * the code that ran until now — so the worst case is the old speed, never a
 * lost entry. Set FAST_ON = false to switch the whole thing off.
 *
 * The same values reach the same columns: fRowCells_ builds the row for both
 * paths. Values are written USER_ENTERED, which reads them exactly as
 * SpreadsheetApp.setValue did; dates go in as day-first text, which New Base
 * (locale en_GB) reads back as real dates, and their formats are then pinned
 * as before.
 */
var FAST_ON = true;

function fApiOk_() {
  try { return FAST_ON && typeof Sheets !== 'undefined' && !!Sheets.Spreadsheets; }
  catch (e) { return false; }
}

/** Forms this path handles: one plain row, no reads of other tabs. */
function fFastForm_(f) {
  return !f.multiRow && !f.multiSection && !f.repeatOf && !f.repeatSection &&
         f.key !== 'bagInvoice' && f.key !== 'ovenOut';
}

function fQ_(tab) { return "'" + String(tab).replace(/'/g, "''") + "'"; }
function fA1_(tab, col0, row1, col0b, row1b) {        // 0-based cols, 1-based rows
  return fQ_(tab) + '!' + fColLetter_(col0 + 1) + (row1 || '') +
         (col0b === undefined ? '' : ':' + fColLetter_(col0b + 1) + (row1b || ''));
}

/**
 * The tab's header row. From the cache when it is there (ten minutes), so a
 * save makes no call just for it; the scan reads the real row 1 in the same
 * call as the columns and corrects a stale copy before anything is written
 * (fFastScan_). Shares the per-execution memo.
 */
function fApiHeader_(tab) {
  if (F_HI_MEMO[tab]) return F_HI_MEMO[tab];
  var ck = 'hdr_' + tab, hit = fCache_().get(ck);
  if (hit) {
    try {
      var cached = JSON.parse(hit);
      var hc = fHeaderFromRow_(cached);
      hc.rowSeen = cached;                      // what the scan checks against
      return (F_HI_MEMO[tab] = hc);
    } catch (e) {}
  }
  var r = Sheets.Spreadsheets.Values.get(FORMS_CFG.SHEET_ID, fQ_(tab) + '!1:1');
  var row = (r && r.values && r.values[0]) || [];
  if (!row.length) throw new Error('No header row on "' + tab + '"');
  try { fCache_().put(ck, JSON.stringify(row), 600); } catch (e) {}
  var hi = fHeaderFromRow_(row);
  hi.rowSeen = row;
  return (F_HI_MEMO[tab] = hi);
}

/** Numeric sheet ids by tab name (needed to set a cell's format). */
function fSheetId_(tab) {
  var key = 'sheet_ids';
  var hit = fCache_().get(key), ids = null;
  if (hit) { try { ids = JSON.parse(hit); } catch (e) {} }
  if (!ids || ids[tab] === undefined) {
    var meta = Sheets.Spreadsheets.get(FORMS_CFG.SHEET_ID, { fields: 'sheets.properties(sheetId,title)' });
    ids = {};
    (meta.sheets || []).forEach(function (s) { ids[s.properties.title] = s.properties.sheetId; });
    try { fCache_().put(key, JSON.stringify(ids), 21600); } catch (e) {}
  }
  return ids[tab];
}

/**
 * Same answer as fTabFx_ (FormsSubmit.js), same cache key, read through the
 * API: which columns are spilled (never written) and which hold a formula on
 * every row (copied down).
 */
function fTabFxApi_(tab, width, lastRow) {
  var key = 'fx_' + tab + '_' + width;
  var hit = fCache_().get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var out = { prot: [], copy: [] };
  if (lastRow >= 2) {
    var ranges = [fQ_(tab) + '!2:' + Math.min(3, lastRow)];
    if (lastRow >= 3) ranges.push(fQ_(tab) + '!' + lastRow + ':' + lastRow);
    var r = Sheets.Spreadsheets.Values.batchGet(FORMS_CFG.SHEET_ID,
      { ranges: ranges, valueRenderOption: 'FORMULA' });
    var vr = r.valueRanges || [];
    ((vr[0] && vr[0].values) || []).forEach(function (row) {
      row.forEach(function (f, c) {
        if (c < width && /ARRAYFORMULA/i.test(String(f || '')) && out.prot.indexOf(c) === -1) out.prot.push(c);
      });
    });
    if (vr[1]) ((vr[1].values || [])[0] || []).forEach(function (f, c) {
      f = String(f || '');
      if (c < width && f.charAt(0) === '=' && !/ARRAYFORMULA/i.test(f) && out.prot.indexOf(c) === -1) out.copy.push(c);
    });
  }
  try { fCache_().put(key, JSON.stringify(out), 600); } catch (e) {}
  return out;
}

/**
 * Inside the lock: how many rows the tab has, whether this entry is already
 * on it, and the tab's real header row — one API call. Returns
 * { lastRow, dup, hi } where dup has the shape fDupFind_ returns (null,
 * { blocked… } or { error }) and hi is the header to write with.
 *
 * The row count is the longest of column A, the Timestamp column and the
 * duplicate-check columns: every row the app or a Google Form ever wrote has
 * a timestamp, and the key columns are what the check is about.
 *
 * Row 1 rides along so a cached header (fApiHeader_) is checked before it is
 * used: if a column was inserted or renamed since, the header is refreshed
 * and the scan runs once more with it, so a row is never written by a stale
 * column map.
 */
function fFastScan_(form, values, hi, again) {
  var keys = FDUP_KEYS[form.key];
  var spec = (keys && keys.length) ? fDupCols_(form, hi) : { skip: true };
  if (spec.error) return { lastRow: 0, dup: { error: spec.error }, hi: hi };

  var cols = [0];
  var ts = fColOf_(hi, 'Timestamp');
  if (ts !== undefined && cols.indexOf(ts) === -1) cols.push(ts);
  if (!spec.skip) spec.parts.forEach(function (p) {
    p.cols.forEach(function (c) { if (cols.indexOf(c) === -1) cols.push(c); });
  });
  var r = Sheets.Spreadsheets.Values.batchGet(FORMS_CFG.SHEET_ID, {
    ranges: [fQ_(form.tab) + '!1:1'].concat(cols.map(function (c) { return fA1_(form.tab, c, 2, c); })),
    majorDimension: 'ROWS'
  });
  var vrs = r.valueRanges || [];

  var row1 = ((vrs[0] && vrs[0].values) || [])[0] || [];
  if (JSON.stringify(row1) !== JSON.stringify(hi.rowSeen || [])) {
    /* The cached header is out of date: take the real one and scan again. */
    try { fCache_().put('hdr_' + form.tab, JSON.stringify(row1), 600); } catch (e) {}
    var fresh = fHeaderFromRow_(row1);
    fresh.rowSeen = row1;
    F_HI_MEMO[form.tab] = fresh;
    fMark_('hdr');
    if (!again) return fFastScan_(form, values, fresh, true);
    hi = fresh;
  }

  var data = {}, n = 0;
  cols.forEach(function (c, i) {
    var arr = ((vrs[i + 1] && vrs[i + 1].values) || []).map(function (rw) {
      return rw && rw[0] !== undefined ? rw[0] : '';
    });
    data[c] = arr;
    n = Math.max(n, arr.length);
  });
  var lastRow = n + 1;                                 // + the header row
  fMark_('scan');
  if (spec.skip || n === 0) return { lastRow: lastRow, dup: null, hi: hi };

  var wanted = spec.parts.map(function (p) {
    for (var i = 0; i < p.ids.length; i++) {
      var v = p.cmp(values[p.ids[i]]);
      if (v) return v;
    }
    return '';
  });
  if (wanted.some(function (w) { return !w; })) return { lastRow: lastRow, dup: null, hi: hi };

  var stop = Math.max(0, n - FDUP_SCAN_ROWS);
  for (var i = n - 1; i >= stop; i--) {
    var hit = true, shown = [];
    for (var k = 0; k < spec.parts.length && hit; k++) {
      var part = spec.parts[k], found = '';
      part.cols.forEach(function (c) {
        var v = (data[c] || [])[i];
        if (!found && v !== undefined && v !== '' && part.cmp(v) === wanted[k]) found = v;
      });
      if (!found) hit = false; else shown.push(String(found));
    }
    if (!hit) continue;
    var row = i + 2;
    var line = Sheets.Spreadsheets.Values.get(FORMS_CFG.SHEET_ID, fQ_(form.tab) + '!' + row + ':' + row);
    var cells = (line.values && line.values[0]) || [];
    var cellOf = function (names) {
      for (var j = 0; j < names.length; j++) {
        var c = fColOf_(hi, names[j]);
        if (c !== undefined && String(cells[c] || '').trim()) return String(cells[c]).trim();
      }
      return '';
    };
    var who = cellOf(['Reported By', 'Email address', 'Email', 'Username', 'Entered by']);
    return { lastRow: lastRow, hi: hi, dup: {
      blocked: true, row: row, key: shown.join(' · '),
      when: cellOf(['Timestamp']), who: who.indexOf('@') > 0 ? who.split('@')[0] : who
    } };
  }
  return { lastRow: lastRow, dup: null, hi: hi };
}

/**
 * Inside the lock: write the row — values and date formats in ONE call.
 * Returns null when this path should not be used for this tab (a per-row
 * formula to copy down) — nothing has been written then, and the caller takes
 * the SpreadsheetApp path. Otherwise the usual { ok, via } result.
 *
 * The values are typed here the way SpreadsheetApp.setValue read text: a
 * number string becomes a number, "=…" a formula, a Date a date serial (with
 * its format set in the same call, so it can never show as a bare number).
 * One batchUpdate is all-or-nothing: it either lands whole or not at all.
 */
function fFastWrite_(form, values, who, hi, lastRow) {
  /* Everything up to the write is allowed to fail over to the old path:
     nothing has touched the sheet yet. */
  var reqs;
  try { reqs = fFastRequests_(form, values, who, hi, lastRow); }
  catch (e) { console.log('fast prep failed, old path: ' + e); return null; }
  if (!reqs) return null;
  fMark_('prep');
  try {
    Sheets.Spreadsheets.batchUpdate({ requests: reqs.list }, FORMS_CFG.SHEET_ID);
  } catch (e) {
    /* The tab's grid is full. SpreadsheetApp grew a sheet by itself when a
       write went past its last row; the API refuses instead and writes
       nothing — which is what stopped Batching saves on 19/11/2026 at row
       10,198. Add rows and write once more. */
    if (!/grid limits|exceeds|out of bounds|beyond|after last (row|col)/i.test(String(e && e.message || e))) throw e;
    Sheets.Spreadsheets.batchUpdate({ requests: [{ appendDimension: {
      sheetId: reqs.sid, dimension: 'ROWS', length: 500 } }] }, FORMS_CFG.SHEET_ID);
    fMark_('grow');
    Sheets.Spreadsheets.batchUpdate({ requests: reqs.list }, FORMS_CFG.SHEET_ID);
  }
  fMark_('put');
  return { ok: true, via: 'api' };
}

/* A date as a Sheets serial number, in the script's (= the sheet's) time zone. */
function fSerial_(d) {
  var p = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy,MM,dd,HH,mm,ss').split(',').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000 + 25569 + (p[3] * 3600 + p[4] * 60 + p[5]) / 86400;
}

/* One cell's value, typed as SpreadsheetApp.setValue would read it. */
function fCellValue_(v) {
  if (v instanceof Date) return { numberValue: fSerial_(v) };
  if (typeof v === 'number') return { numberValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  var s = String(v == null ? '' : v);
  if (/^\s*-?\d+(\.\d+)?\s*$/.test(s)) return { numberValue: Number(s) };
  if (s.charAt(0) === '=') return { formulaValue: s };
  return { stringValue: s };
}

/** The batchUpdate requests for one row; null when the old writer must do it. */
function fFastRequests_(form, values, who, hi, lastRow) {
  var fx = fTabFxApi_(form.tab, hi.width, lastRow);
  if (fx.copy.length) return null;
  var prot = {};
  (FORMS_CFG.NEVER_WRITE || []).forEach(function (name) {
    var i = fColOf_(hi, name);
    if (i !== undefined) prot[i] = true;
  });
  fx.prot.forEach(function (c) { prot[c] = true; });

  var rc = fRowCells_(form, values, who, null, hi, prot);
  var sid = fSheetId_(form.tab);
  if (sid === undefined) throw new Error('no sheet id for "' + form.tab + '"');
  var target = lastRow + 1, list = [];

  /* Neighbouring columns in one updateCells each; a column with no value is
     never touched — the gaps are where spilled formulas live. Only the value
     is set, so whatever format a column carries is left as it is. */
  var idx = Object.keys(rc.cells).map(Number).sort(function (a, b) { return a - b; });
  for (var k = 0; k < idx.length; ) {
    var from = idx[k], run = [{ userEnteredValue: fCellValue_(rc.cells[from]) }];
    while (k + run.length < idx.length && idx[k + run.length] === from + run.length) {
      run.push({ userEnteredValue: fCellValue_(rc.cells[idx[k + run.length]]) });
    }
    list.push({ updateCells: {
      start: { sheetId: sid, rowIndex: target - 1, columnIndex: from },
      rows: [{ values: run }], fields: 'userEnteredValue' } });
    k += run.length;
  }
  if (!list.length) return null;

  /* The formats, pinned as the SpreadsheetApp writer pins them: the time must
     show (the dashboard reads the displayed text) and a production date must
     not look like a broken timestamp. Same call, so never one without the
     other. */
  function fmt(c, type, pattern) {
    list.push({ repeatCell: {
      range: { sheetId: sid, startRowIndex: target - 1, endRowIndex: target, startColumnIndex: c, endColumnIndex: c + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: type, pattern: pattern } } },
      fields: 'userEnteredFormat.numberFormat' } });
  }
  if (rc.tsCol !== undefined && rc.cells[rc.tsCol] !== undefined) fmt(rc.tsCol, 'DATE_TIME', 'dd/MM/yyyy HH:mm:ss');
  rc.dateCols.forEach(function (c) { fmt(c, 'DATE', 'dd/MM/yyyy'); });
  return { list: list, sid: sid, target: target };
}

/** The audit line, appended through the API; false if it could not be. */
function fFastLog_(row) {
  if (!fApiOk_() || !FORMS_CFG.LOG_TAB) return false;
  try {
    var tz = Session.getScriptTimeZone();
    var vals = row.map(function (v) {
      return v instanceof Date ? Utilities.formatDate(v, tz, 'dd/MM/yyyy HH:mm:ss') : v;
    });
    Sheets.Spreadsheets.Values.append({ values: [vals] }, FORMS_CFG.SHEET_ID,
      fQ_(FORMS_CFG.LOG_TAB) + '!A:G', { valueInputOption: 'USER_ENTERED', insertDataOption: 'OVERWRITE' });
    return true;
  } catch (e) { console.log('fast log failed, using appendRow: ' + e); return false; }
}

/**
 * Several whole columns in one API call, into the same per-execution memo
 * fColValues_ uses — so a form's slab list costs one read instead of three.
 * specs: [[tab, col (1-based), firstRow], ...]. Silently does nothing on
 * error; fColValues_ then reads them the old way.
 */
function fPrefetchCols_(specs) {
  if (!fApiOk_()) return;
  var need = specs.filter(function (s) { return !F_COL_MEMO[s[0] + '|' + s[1] + '|' + s[2]]; });
  if (!need.length) return;
  try {
    var r = Sheets.Spreadsheets.Values.batchGet(FORMS_CFG.SHEET_ID, {
      ranges: need.map(function (s) { return fA1_(s[0], s[1] - 1, s[2], s[1] - 1); }),
      majorDimension: 'COLUMNS', valueRenderOption: 'UNFORMATTED_VALUE'
    });
    (r.valueRanges || []).forEach(function (vr, i) {
      var s = need[i];
      F_COL_MEMO[s[0] + '|' + s[1] + '|' + s[2]] =
        ((vr.values && vr.values[0]) || []).map(function (v) { return v == null ? '' : String(v); });
    });
  } catch (e) { console.log('prefetch failed, reading the old way: ' + e); }
}
