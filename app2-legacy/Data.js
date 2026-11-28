/**
 * Domestic Marketing — data layer.
 * One sheet per table (Users, Customers, Visits, Orders, Products) + Rates (write-only, for pivots), Log, Config.
 * Reads are served from CacheService (chunked JSON); writes update the sheet row(s) and the cache
 * in the same locked operation, so readers never hit the sheet twice.
 */

var TZ = Session.getScriptTimeZone() || 'Asia/Kolkata';
var CACHE_TTL = 21600; // 6h (max)
var CHUNK = 90000;

/* [key, header, kind]   kind: s string · n number · d date (ms) · j JSON · b true/false */
var T = {
  users: { sheet: 'Users', ck: 'U', cols: [
    ['id', 'User ID', 's'], ['username', 'Username', 's'], ['name', 'Name', 's'], ['role', 'Role', 's'], ['mobile', 'Mobile', 's'],
    ['areas', 'Areas', 's'], ['active', 'Active', 'b'], ['mustChange', 'Must Change Password', 'b'],
    ['passHash', 'Password Hash', 's'], ['salt', 'Salt', 's'], ['tgChat', 'Telegram Chat ID', 's'], ['tgName', 'Telegram Name', 's'], ['tgAt', 'Telegram Linked At', 'd'],
    ['createdAt', 'Created At', 'd'], ['updatedAt', 'Last Updated', 'd']] },

  cust: { sheet: 'Customers', ck: 'K', cols: [
    ['id', 'Customer ID', 's'], ['shop', 'Customer / Firm Name', 's'], ['contact', 'Contact Person', 's'], ['mobile', 'Mobile', 's'], ['type', 'Category', 's'],
    ['status', 'Lead Status', 's'], ['details', 'Category Details', 's'], ['fields', 'Category Details (JSON)', 'j'],
    ['city', 'City', 's'], ['area', 'Area', 's'], ['address', 'Address', 's'],
    ['lat', 'Latitude', 'n'], ['lng', 'Longitude', 'n'], ['locAt', 'Location Saved At', 'd'], ['locSrc', 'Location Source', 's'],
    ['brands', 'Brands Sold', 's'], ['avgRate', 'Avg Selling Rate', 'n'], ['minRate', 'Min Rate', 'n'], ['maxRate', 'Max Rate', 'n'], ['rates', 'Latest Rates (JSON)', 'j'],
    ['potential', 'Potential', 's'], ['interest', 'Interest', 's'], ['priorityManual', 'Priority (manual)', 's'],
    ['standStatus', 'Stand Status', 's'], ['standReason', 'Stand Reason', 's'], ['standNote', 'Stand Note', 's'], ['standBy', 'Stand Decided By', 's'], ['standAt', 'Stand Decided At', 'd'],
    ['standGivenAt', 'Stand Given On', 'd'], ['standQty', 'Stands Given', 'n'],
    ['standExecId', 'Stand With (ID)', 's'], ['standExec', 'Stand Handed To', 's'], ['standHandedAt', 'Stand Handed On', 'd'], ['standPlacedBy', 'Stand Placed By', 's'],
    ['standRec', 'Stand Recommended', 's'], ['standRecReason', 'Recommendation Reason', 's'], ['standRecBy', 'Recommended By', 's'],
    ['photo', 'Front Photo', 's'], ['notes', 'Notes', 's'], ['ownerId', 'Assigned To (ID)', 's'], ['ownerName', 'Assigned To', 's'],
    ['visits', 'Total Visits', 'n'], ['lastVisit', 'Last Visit', 'd'], ['lastVisitBy', 'Last Visit By', 's'], ['nextFollow', 'Next Visit Date', 'd'],
    ['nextCall', 'Next Call Reminder', 'd'], ['nextCallById', 'Call Reminder For (ID)', 's'], ['nextCallBy', 'Call Reminder For', 's'],
    ['calls', 'Total Calls', 'n'], ['lastCall', 'Last Call', 'd'], ['lastCallBy', 'Last Call By', 's'],
    ['payAllow', 'Allowed Payment Terms', 's'], ['reschedCount', 'Times Rescheduled', 'n'], ['resched', 'Reschedule History (JSON)', 'j'],
    ['closeReason', 'Result Reason', 's'], ['closedBy', 'Result By', 's'], ['closedAt', 'Result Date', 'd'],
    ['createdAt', 'Created At', 'd'], ['createdBy', 'Created By', 's'], ['deleted', 'Deleted', 'b'], ['delReason', 'Delete Reason', 's'], ['delBy', 'Deleted By', 's'], ['delAt', 'Deleted At', 'd'], ['updatedAt', 'Last Updated', 'd']] },

  visits: { sheet: 'Visits', ck: 'V', cols: [
    ['id', 'Visit ID', 's'], ['at', 'Visit Time (GPS fix)', 'd'], ['serverAt', 'Saved At (server)', 'd'], ['userId', 'Executive ID', 's'], ['userName', 'Executive', 's'],
    ['custId', 'Customer ID', 's'], ['shop', 'Customer', 's'], ['category', 'Category', 's'], ['city', 'City', 's'], ['area', 'Area', 's'], ['newShop', 'First Visit', 'b'],
    ['plan', 'Against Plan', 's'], ['source', 'Entry Type', 's'], ['lat', 'Latitude', 'n'], ['lng', 'Longitude', 'n'], ['acc', 'GPS Accuracy (m)', 'n'], ['dist', 'Distance From Pin (m)', 'n'],
    ['outcome', 'Outcome', 's'], ['leadResult', 'Lead Result', 's'], ['resultReason', 'Result Reason', 's'], ['interest', 'Interest', 's'], ['brands', 'Brands Seen', 's'], ['rates', 'Rates (JSON)', 'j'],
    ['notes', 'Notes', 's'], ['nextFollow', 'Next Visit Date', 'd'], ['standRec', 'Stand Recommendation', 's'], ['standRecReason', 'Recommendation Reason', 's'],
    ['media', 'Media (JSON)', 'j'], ['photo', 'Front Photo', 's'], ['mediaLinks', 'All Media Links', 's'], ['flags', 'Flags', 's'],
    ['verify', 'Review', 's'], ['verifyBy', 'Reviewed By', 's'], ['verifyAt', 'Reviewed At', 'd'], ['verifyNote', 'Review Note', 's'], ['deleted', 'Deleted', 'b'], ['delReason', 'Delete Reason', 's'], ['delBy', 'Deleted By', 's'], ['delAt', 'Deleted At', 'd'], ['updatedAt', 'Last Updated', 'd']] },

  calls: { sheet: 'Calls', ck: 'L', cols: [
    ['id', 'Call ID', 's'], ['at', 'Call Time', 'd'], ['userId', 'Executive ID', 's'], ['userName', 'Executive', 's'],
    ['custId', 'Customer ID', 's'], ['shop', 'Customer', 's'], ['category', 'Category', 's'], ['city', 'City', 's'], ['area', 'Area', 's'],
    ['dir', 'Direction', 's'], ['status', 'Call Status', 's'], ['purposes', 'Call About', 's'], ['answersText', 'Details', 's'], ['answers', 'Details (JSON)', 'j'],
    ['notes', 'Notes', 's'], ['nextCall', 'Next Call Reminder', 'd'], ['media', 'Recordings (JSON)', 'j'], ['mediaLinks', 'Recording Links', 's'], ['deleted', 'Deleted', 'b'], ['delReason', 'Delete Reason', 's'], ['delBy', 'Deleted By', 's'], ['delAt', 'Deleted At', 'd'], ['updatedAt', 'Last Updated', 'd']] },

  orders: { sheet: 'Orders', ck: 'O', cols: [
    ['id', 'Order No', 's'], ['createdAt', 'Order Date', 'd'], ['byId', 'Taken By (ID)', 's'], ['by', 'Taken By', 's'],
    ['custId', 'Customer ID', 's'], ['shop', 'Customer', 's'], ['city', 'City', 's'], ['area', 'Area', 's'],
    ['items', 'Items (JSON)', 'j'], ['itemsText', 'Items', 's'], ['total', 'Order Value (₹)', 'n'], ['status', 'Current Step', 's'],
    ['subtotal', 'Subtotal (₹)', 'n'], ['discount', 'Discount (₹)', 'n'], ['gst', 'GST', 's'], ['gstAmt', 'GST Amount (₹)', 'n'],
    ['deliveryDate', 'Expected Delivery', 'd'], ['terms', 'Payment Terms', 's'], ['notes', 'Notes', 's'],
    ['stageAt', 'Step Started At', 'd'], ['due', 'Step Due By', 'd'], ['lateSent', 'Late Alert Sent For', 's'],
    ['confirmedBy', 'Confirmed By', 's'], ['confirmedAt', 'Confirmed At', 'd'],
    ['invoiceNo', 'Invoice No', 's'], ['invoiceDate', 'Invoice Date', 'd'], ['invoiceAmt', 'Invoice Amount (₹)', 'n'], ['invoiceFile', 'Invoice File', 's'], ['invoiceNote', 'Invoice Difference Reason', 's'],
    ['vehicleNo', 'Vehicle No', 's'], ['driverName', 'Driver Name', 's'], ['driverMobile', 'Driver Mobile', 's'], ['transporter', 'Transporter', 's'], ['lrNo', 'LR / Bilty No', 's'],
    ['dispatchAt', 'Dispatched At', 'd'], ['dispatchPhoto', 'Dispatch Photo', 's'],
    ['deliveredAt', 'Delivered On', 'd'], ['receivedBy', 'Received By', 's'], ['deliveryCond', 'Delivery Condition', 's'], ['deliveryNote', 'Delivery Note', 's'], ['podPhoto', 'Delivery Proof', 's'],
    ['paid', 'Paid (₹)', 'n'], ['balance', 'Balance (₹)', 'n'], ['payments', 'Payments (JSON)', 'j'], ['shortClose', 'Closed Short Reason', 's'],
    ['advOk', 'Advance Short Allowed (reason)', 's'], ['dispOk', 'Dispatch Payment Short Allowed (reason)', 's'], ['earlier', 'Earlier Invoices / Dispatches (JSON)', 'j'],
    ['steps', 'Step History (JSON)', 'j'], ['lastRemark', 'Last Remark', 's'], ['cancelReason', 'Cancel Reason', 's'], ['cancelledFrom', 'Cancelled At Step', 's'], ['closedAt', 'Completed At', 'd'],
    ['statusAt', 'Status Changed At', 'd'], ['statusBy', 'Status Changed By', 's'], ['updatedAt', 'Last Updated', 'd']] },

  prod: { sheet: 'Products', ck: 'P', cols: [
    ['id', 'Product ID', 's'], ['name', 'Product Name', 's'], ['series', 'Collection / Series', 's'], ['color', 'Colour / Look', 's'], ['finish', 'Finish', 's'],
    ['thickness', 'Thickness (mm)', 's'], ['size', 'Slab Size', 's'], ['priceFrom', 'Price From', 'n'], ['priceTo', 'Price To', 'n'], ['unit', 'Price Unit', 's'],
    ['desc', 'Description', 's'], ['pitch', 'Selling Points', 's'], ['photos', 'Photos (JSON)', 'j'], ['pdf', 'Brochure / PDF', 's'], ['video', 'Video Link', 's'],
    ['active', 'Active', 'b'], ['updatedBy', 'Updated By', 's'], ['deleted', 'Deleted', 'b'], ['delReason', 'Delete Reason', 's'], ['delBy', 'Deleted By', 's'], ['delAt', 'Deleted At', 'd'], ['updatedAt', 'Last Updated', 'd']] }
};
/** Header labels renamed in a later version → setup() renames them in place so the data stays in its column. */
var RENAMED = {
  Customers: { 'Shop Name': 'Customer / Firm Name', 'Owner / Contact': 'Contact Person', 'Shop Type': 'Category', 'Shop Photo': 'Front Photo', 'Next Follow-up': 'Next Visit Date' },
  Visits: { 'Shop Name': 'Customer', 'New Shop': 'First Visit', 'Distance From Shop (m)': 'Distance From Pin (m)', 'Next Follow-up': 'Next Visit Date', 'Shop Photo': 'Front Photo' },
  Orders: { 'Shop Name': 'Customer', 'Status': 'Current Step' },
  Rates: { 'Shop': 'Customer' }
};
var RATE_COLS = ['Timestamp', 'Visit ID', 'Customer ID', 'Customer', 'City', 'Area', 'Brand', 'Product / Series', 'Rate', 'Unit', 'Executive', 'Thickness'];
var PAY_COLS = ['Timestamp', 'Order No', 'Customer ID', 'Customer', 'Step', 'Amount (₹)', 'Mode', 'Reference', 'Payment Date', 'Proof', 'Entered By'], SH_PAY = 'Payments';
var LOG_COLS = ['Timestamp', 'Type', 'Ref', 'User', 'Detail'];
var SH_RATES = 'Rates', SH_LOG = 'Log', SH_CFG = 'Config';

var _ss = null, _mem = {}, _cfg = null;

function ss_() {
  if (_ss) return _ss;
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  _ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
  if (!_ss) throw new Error('No spreadsheet. Run setup() from the script editor first.');
  return _ss;
}
function sheet_(name) { return ss_().getSheetByName(name); }

/* ---------------------------------------------------------------- chunked cache */

function cachePut_(key, obj) {
  var c = CacheService.getScriptCache(), s = JSON.stringify(obj), n = Math.ceil(s.length / CHUNK) || 1, m = {};
  for (var i = 0; i < n; i++) m[key + '_' + i] = s.substr(i * CHUNK, CHUNK);
  m[key] = String(n);
  try { c.putAll(m, CACHE_TTL); } catch (e) { c.remove(key); }
}
function cacheGet_(key) {
  var c = CacheService.getScriptCache(), n = c.get(key);
  if (!n) return null;
  var keys = []; for (var i = 0; i < +n; i++) keys.push(key + '_' + i);
  var got = c.getAll(keys), s = '';
  for (var j = 0; j < keys.length; j++) { if (got[keys[j]] == null) return null; s += got[keys[j]]; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function version_() { return Number(PropertiesService.getScriptProperties().getProperty('VER') || 0); }
function bumpVersion_() { var v = Date.now(); PropertiesService.getScriptProperties().setProperty('VER', String(v)); return v; }

/** Drop every server copy and make every phone take a full fresh copy on its next sync. */
function reloadAll_() {
  var keys = ['G']; Object.keys(T).forEach(function (t) { keys.push(T[t].ck); });
  CacheService.getScriptCache().removeAll(keys);
  _mem = {}; _cfg = null;
  var now = String(Date.now());
  PropertiesService.getScriptProperties().setProperties({ VER: now, FULL: now });
}

/* ---------------------------------------------------------------- generic tables */

function hdrMap_(t, sh) {
  var byLabel = {}; T[t].cols.forEach(function (c) { byLabel[c[1]] = c; });
  var lc = sh.getLastColumn();
  return lc ? sh.getRange(1, 1, 1, lc).getValues()[0].map(function (h) { return byLabel[h] || null; }) : [];
}

/** All rows of a table as objects ({key: value} for non-empty cells, _r = sheet row, _x = columns added by hand). */
function load_(t) {
  if (_mem[t]) return _mem[t];
  var cached = cacheGet_(T[t].ck);
  if (cached) return (_mem[t] = cached);
  var v0 = version_(), sh = sheet_(T[t].sheet), last = sh.getLastRow(), out = [];
  if (last >= 2) {
    var map = hdrMap_(t, sh), vals = sh.getRange(2, 1, last - 1, map.length).getValues();
    vals.forEach(function (row, r) {
      if (!row[0]) return;
      var o = { _r: r + 2 };
      for (var i = 0; i < row.length; i++) {
        var col = map[i], v = row[i];
        if (v === '' || v === null) continue;
        if (!col) { (o._x = o._x || {})[i] = v instanceof Date ? { d: v.getTime() } : v; continue; }
        var k = col[2];
        if (k === 'd') { v = v instanceof Date ? v.getTime() : new Date(v).getTime(); if (isNaN(v)) continue; }
        else if (k === 'n') { v = Number(v); if (isNaN(v)) continue; }
        else if (k === 'b') v = v === true || String(v).toUpperCase() === 'TRUE';
        else if (k === 'j') { try { v = JSON.parse(v); } catch (e) { continue; } }
        else v = v instanceof Date ? Utilities.formatDate(v, TZ, 'dd MMM yyyy') : String(v);
        o[col[0]] = v;
      }
      out.push(o);
    });
  }
  _mem[t] = out;
  if (version_() === v0) cachePut_(T[t].ck, out); // don't cache if a writer raced us
  return out;
}

function find_(t, id) {
  var list = load_(t);
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function get_(t, id, what) {
  var o = find_(t, id);
  if (!o) throw new Error((what || 'Record') + ' not found — it may have been deleted. Refresh and try again.');
  return o;
}

function rowOf_(o, map) {
  return map.map(function (col, i) {
    if (!col) { var x = o._x && o._x[i]; return x === undefined ? '' : (x && x.d ? new Date(x.d) : x); } // never wipe columns we don't own
    var v = o[col[0]];
    if (v === undefined || v === null || v === '') return col[2] === 'b' ? false : '';
    if (col[2] === 'd') return new Date(Number(v));
    if (col[2] === 'j') return JSON.stringify(v);
    return v;
  });
}

/**
 * Rows shift if someone deletes, inserts or sorts rows by hand; look each record's real row up by its ID
 * (column A) before writing. A record whose ID is gone was deleted → refuse and make every app reload.
 */
function fixRows_(sh, objs) {
  objs = objs.filter(function (o) { return o._r; });
  if (!objs.length) return;
  var last = sh.getLastRow(), at = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) { if (r[0] !== '') at[String(r[0])] = i + 2; });
  objs.forEach(function (o) {
    if (at[o.id]) { o._r = at[o.id]; return; }
    reloadAll_();
    throw new Error('A record was removed from the sheet. The app is reloading its data — refresh and try again.');
  });
}

/** Persist changed / new records of one table. Must be called inside a lock. */
function save_(t, objs) {
  if (!objs.length) return;
  var sh = sheet_(T[t].sheet), map = hdrMap_(t, sh), now = Date.now(), list = load_(t);
  fixRows_(sh, objs);
  var existing = [], fresh = [];
  objs.forEach(function (o) { o.updatedAt = Math.max(now, (Number(o.updatedAt) || 0) + 1); (o._r ? existing : fresh).push(o); }); // always moves forward: it is also the record's version (stale-form check)
  existing.sort(function (a, b) { return a._r - b._r; });
  for (var i = 0; i < existing.length;) { // contiguous rows in one setValues call
    var j = i; while (j + 1 < existing.length && existing[j + 1]._r === existing[j]._r + 1) j++;
    var rows = []; for (var k = i; k <= j; k++) rows.push(rowOf_(existing[k], map));
    sh.getRange(existing[i]._r, 1, rows.length, map.length).setValues(rows);
    i = j + 1;
  }
  if (fresh.length) {
    var start = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(start, 1, fresh.length, map.length).setValues(fresh.map(function (o) { return rowOf_(o, map); }));
    fresh.forEach(function (o, idx) { o._r = start + idx; list.push(o); });
  }
  SpreadsheetApp.flush(); // rows visible before VER moves, so a racing reader can't cache the old sheet
  bumpVersion_();
  cachePut_(T[t].ck, list);
}

/** Delete records (admin). Every app takes a full fresh copy afterwards. */
function remove_(t, ids) {
  var sh = sheet_(T[t].sheet), objs = load_(t).filter(function (o) { return ids.indexOf(o.id) >= 0; });
  if (!objs.length) return;
  fixRows_(sh, objs);
  objs.map(function (o) { return o._r; }).sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
  reloadAll_();
}

/** Sequential ids per table: C0001, V000001, ORD-0001, P001. */
function nextId_(key, prefix, width) {
  var P = PropertiesService.getScriptProperties(), n = Number(P.getProperty('SEQ_' + key) || 0) + 1;
  P.setProperty('SEQ_' + key, String(n));
  return prefix + ('000000' + n).slice(-width);
}

/* ---------------------------------------------------------------- users */

function userByName_(username) {
  username = String(username || '').toLowerCase().trim();
  var us = load_('users');
  for (var i = 0; i < us.length; i++) if (String(us[i].username).toLowerCase() === username) return us[i];
  return null;
}
function publicUser_(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, mobile: u.mobile || '', areas: u.areas || '', active: !!u.active, tg: !!u.tgChat };
}

/* ---------------------------------------------------------------- config (key | JSON value) */

function loadCfg_() {
  if (_cfg) return _cfg;
  var cached = cacheGet_('G');
  if (cached) return (_cfg = cached);
  var sh = sheet_(SH_CFG), last = sh.getLastRow(), out = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    if (!r[0]) return;
    try { out[r[0]] = JSON.parse(r[1]); } catch (e) { out[r[0]] = r[1]; }
  });
  _cfg = out;
  cachePut_('G', out);
  return out;
}
function setCfg_(key, value) {
  var sh = sheet_(SH_CFG), last = sh.getLastRow(), json = JSON.stringify(value);
  var keys = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  var i = keys.indexOf(key);
  if (i >= 0) sh.getRange(i + 2, 2).setValue(json);
  else sh.getRange(last + 1, 1, 1, 2).setValues([[key, json]]);
  loadCfg_()[key] = value;
  cachePut_('G', _cfg);
}
function getLists_() {
  var l = loadCfg_().lists || {}, out = {};
  Object.keys(DEF.defaults.lists).forEach(function (k) { out[k] = Array.isArray(l[k]) ? l[k] : DEF.defaults.lists[k]; });
  if (out.thickness.join() === '12 mm,15 mm,16 mm,18 mm,20 mm,30 mm') out.thickness = DEF.defaults.lists.thickness; // the first default list, saved before it was cut to 20 / 30 mm
  return out;
}
/** Extra questions per category (Admin ▸ Customer forms). */
function getForms_() {
  var f = loadCfg_().forms;
  return f && typeof f === 'object' && !Array.isArray(f) ? f : DEF.defaults.forms;
}
function getCallForms_() {
  var f = loadCfg_().callForms;
  return f && typeof f === 'object' && !Array.isArray(f) ? f : DEF.defaults.callForms;
}
function getSettings_() {
  var s = loadCfg_().settings || {}, out = {};
  Object.keys(DEF.defaults.settings).forEach(function (k) { out[k] = s[k] !== undefined && s[k] !== '' ? s[k] : DEF.defaults.settings[k]; });
  return out;
}

/* ---------------------------------------------------------------- rates (append only) & log */

function appendRates_(rows) {
  if (!rows.length) return;
  var sh = sheet_(SH_RATES);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, RATE_COLS.length).setValues(rows);
}

/** Every payment also gets a row in the Payments sheet (write-only, for accounts). */
function appendPayment_(o, p) {
  var sh = sheet_(SH_PAY);
  sh.getRange(sh.getLastRow() + 1, 1, 1, PAY_COLS.length).setValues([[new Date(p.at), o.id, o.custId, o.shop, p.kind, p.amt, p.mode, p.ref, new Date(p.date), p.proof, p.by]]);
}

var _logBuf = [];
function log_(type, ref, user, detail) {
  _logBuf.push([new Date(), type, ref || '', user ? user.name : 'System', detail || '']);
}
function flushLog_() {
  if (!_logBuf.length) return;
  var sh = sheet_(SH_LOG);
  sh.getRange(sh.getLastRow() + 1, 1, _logBuf.length, LOG_COLS.length).setValues(_logBuf);
  _logBuf = [];
}
