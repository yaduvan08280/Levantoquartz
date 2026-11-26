/**
 * Slabworks Production Forms — option lists read live from "New Base"
 */

function fCache_() { return CacheService.getScriptCache(); }

function fReadCol_(tab, col, firstRow) {
  var sh = fss_().getSheetByName(tab);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < firstRow) return [];
  var vals = sh.getRange(firstRow, col, last - firstRow + 1, 1).getValues();
  var out = [], seen = {};
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i][0];
    if (v === '' || v === null) continue;
    v = (v instanceof Date) ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy')
                            : String(v).trim();
    if (!v || seen[v]) continue;
    seen[v] = 1;
    out.push(v);
  }
  return out;
}

/** Named list from FORMS_LISTS (or worked out here, see below), cached. */
function fGetList_(name) {
  var key = 'list_' + name;
  var hit = fCache_().get(key);
  if (hit) return JSON.parse(hit);
  var out;
  if (FORMS_STAGE_LISTS[name]) {
    out = fStageList_(name);
  } else {
    var src = FORMS_LISTS[name];
    if (!src) return [];
    out = fReadCol_(src.tab, src.col, src.row);
  }
  try { fCache_().put(key, JSON.stringify(out), FORMS_CFG.LIST_CACHE_SECONDS); } catch (e) {}
  return out;
}

/* ================================================= stage slab lists ===== */
/*
 * Which slabs each stage may still pick, worked out HERE rather than read
 * from the formulas that used to fill Slab Numbers I–Q.
 *
 * Those formulas made the sheet do the work: every list scanned all eleven
 * thousand slabs against Q.C. Final and against its own form, and every
 * Batching or Q.C. save made Google redo all of them before anything else
 * could read the sheet. By November that was two minutes a save, and sign-in
 * and form loading queued behind it. Done here it is three column reads and a
 * few set lookups, only when a form is opened, and cached.
 *
 * The rule is the formulas' rule, unchanged:
 *   every slab on "unique codes" column C, in that order,
 *   that is not on Q.C. Final column A,
 *   and not yet on this stage's own column.
 * Oven Out is the exception, as it was: slabs on Oven In not yet on Oven Out
 * (nor Q.C.), in Oven In order. Vacuum and Trolley check the bundle columns
 * AF and AJ of Slab Numbers, which their own formulas still fill.
 *
 * Matching ignores case and surrounding spaces. An empty list is
 * ["All Filled"], which is what the formulas showed.
 */
var FORMS_STAGE_LISTS = {
  resin:       { done: ['Resin Form', 3] },          // C
  mixer:       { done: ['Mixer Form', 3] },
  pressing:    { done: ['Pressing Form', 3] },
  ovenIn:      { done: ['Oven In Form', 3] },
  ovenOut:     { from: ['Oven In Form', 3], done: ['Oven Out Form', 3] },
  vacuum:      { done: ['Slab Numbers', 32] },       // AF
  trolley:     { done: ['Slab Numbers', 36] },       // AJ
  calibration: { done: ['Calibration Form', 3] },
  qc:          {}
};
var FORMS_REGISTRY = ['unique codes', 3, 2];         // C2:C
var FORMS_QC_COL   = ['Q.C. Final Form', 1, 2];      // A2:A

/* One read per column per execution: a form with two slab lists reads Q.C.
   Final once, not twice. */
var F_COL_MEMO = {};
function fColValues_(tab, col, firstRow) {
  var k = tab + '|' + col + '|' + firstRow;
  if (F_COL_MEMO[k]) return F_COL_MEMO[k];
  var out = [];
  var sh = fss_().getSheetByName(tab);
  if (sh) {
    var last = sh.getLastRow();
    if (last >= firstRow) {
      /* Plain values: slab numbers are text either way, and asking for
         display text makes Google format every cell first. */
      out = sh.getRange(firstRow, col, last - firstRow + 1, 1).getValues()
              .map(function (r) { return r[0] == null ? '' : String(r[0]); });
    }
  }
  F_COL_MEMO[k] = out;
  return out;
}

function fSlabKey_(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

function fKeySet_(vals) {
  var s = {};
  vals.forEach(function (v) { var k = fSlabKey_(v); if (k) s[k] = true; });
  return s;
}

function fStageList_(name) {
  var def = FORMS_STAGE_LISTS[name];
  /* The three columns in one Sheets API call when it is available (FormsFast.js). */
  fPrefetchCols_([FORMS_QC_COL,
                  def.from ? [def.from[0], def.from[1], 2] : FORMS_REGISTRY]
                 .concat(def.done ? [[def.done[0], def.done[1], 2]] : []));
  var qc = fKeySet_(fColValues_(FORMS_QC_COL[0], FORMS_QC_COL[1], FORMS_QC_COL[2]));
  var src = def.from ? fColValues_(def.from[0], def.from[1], 2)
                     : fColValues_(FORMS_REGISTRY[0], FORMS_REGISTRY[1], FORMS_REGISTRY[2]);
  var done = def.done ? fKeySet_(fColValues_(def.done[0], def.done[1], 2)) : {};
  var out = [], seen = {};
  src.forEach(function (v) {
    var t = String(v == null ? '' : v).trim(), k = t.toUpperCase();
    if (!k || seen[k] || qc[k] || done[k]) return;
    seen[k] = true;
    out.push(t);
  });
  return out.length ? out : ['All Filled'];
}

/** Slabs currently sitting in one bundle, from the Bundles tab. */
function fBundleSlabs_(bundleName) {
  if (!bundleName) return [];
  var key = 'bundle_' + bundleName;
  var hit = fCache_().get(key);
  if (hit) return JSON.parse(hit);

  var sh = fss_().getSheetByName('Bundles');
  if (!sh) return [];
  var header = sh.getRange(1, FORMS_BUNDLE_COL0, 1, FORMS_BUNDLE_N).getValues()[0];
  var idx = -1;
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim().toUpperCase() === String(bundleName).trim().toUpperCase()) {
      idx = i; break;
    }
  }
  if (idx === -1) return [];
  var out = fReadCol_('Bundles', FORMS_BUNDLE_COL0 + idx, 2);
  fCache_().put(key, JSON.stringify(out), FORMS_CFG.LIST_CACHE_SECONDS);
  return out;
}

function fClearLists_() {
  var keys = Object.keys(FORMS_LISTS).map(function (k) { return 'list_' + k; });
  for (var i = 1; i <= FORMS_BUNDLE_N; i++) {
    keys.push('bundle_BN' + ('0' + i).slice(-2));
  }
  keys.push('dispatch_slabs');
  fCache_().removeAll(keys);
  return 'cache cleared';
}

/** Resolve every option list a form needs, in one pass. */
function fResolveOptions_(form) {
  var out = {};
  form.sections.forEach(function (sec) {
    sec.fields.forEach(function (f) {
      /* A field whose list depends on another answer has no single list. The
         union goes here so anything reading options generically still sees
         every legal value; the per-answer lists ride separately in
         fOptionSets_ and are what the picker actually shows. */
      if (f.optionsWhen) {
        var seen = {}, all = [];
        var map = f.optionsWhen.map || {};
        Object.keys(map).forEach(function (k) {
          (map[k] || []).forEach(function (v) {
            if (!seen[v]) { seen[v] = true; all.push(v); }
          });
        });
        out[f.id] = all;
        return;
      }
      if (f.options) { out[f.id] = fWithXList_(f, f.options); return; }
      if (!f.source) return;
      if (f.source === '@alertSlabs') { out[f.id] = fAlertSlabList_(); return; }
      if (f.source.charAt(0) === '@') { out[f.id] = []; return; }  // filled on demand
      var list = fGetList_(f.source);
      if (!list.length && f.fallback) list = f.fallback;
      out[f.id] = list;
    });
  });
  return out;
}

/* ==================================================== dispatch slabs ===== */
/*
 * The slabs that may still be dispatched, each carrying the grade Q.C. Final
 * gave it. There is no column on Slab Numbers for this — dispatch candidates
 * are a set difference, computed here:
 *
 *     everything Q.C. Final has graded   MINUS   everything already dispatched
 *
 * Two consequences worth knowing. A slab cannot be dispatched twice, because
 * the moment its row lands in Dispatch Form it leaves this list. And the list
 * needs no maintenance: it shrinks as containers go out and grows as QC works.
 *
 * The QC tab is scanned newest-last, and a slab QC'd more than once keeps its
 * LATEST grade — a re-inspection is meant to overrule the first call.
 */

/** Column index (1-based) of the first header in `names`, or 0. */
function fFindCol_(sh, names) {
  if (!sh || sh.getLastColumn() < 1) return 0;
  /* Through the same tiered matcher as everything else: a header with two
     spaces in it must not be invisible here either. */
  var hi = fHeaderIdx_(sh);
  for (var n = 0; n < names.length; n++) {
    var i = fColOf_(hi, names[n]);
    if (i !== undefined) return i + 1;
  }
  return 0;
}

/** Every slab number already written into the Dispatch Form tab. */
function fDispatchedSet_() {
  var D = FORMS_DISPATCH;
  var sh = fss_().getSheetByName(D.outTab);
  var out = {};
  if (!sh) return out;
  var last = sh.getLastRow();
  if (last < 2) return out;
  var col = D.outSlabCol || fFindCol_(sh, D.slabHeaders);
  if (!col) return out;
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    var v = String(vals[i][0] || '').trim().toUpperCase();
    if (v) out[v] = true;
  }
  return out;
}

/**
 * { slabs: [...], grades: [...] } — parallel arrays, not a list of objects.
 * At four thousand slabs the repeated {"slab":…,"grade":…} keys of the obvious
 * shape cost more than the data, and this has to cross to a phone.
 */
function fDispatchSlabs_() {
  var D = FORMS_DISPATCH;
  var key = 'dispatch_slabs';
  var hit = fCache_().get(key);
  if (hit) {
    try { return fDispatchUnpack_(hit); } catch (e) { /* fall through and rebuild */ }
  }

  var sh = fss_().getSheetByName(D.qcTab);
  if (!sh) return { slabs: [], grades: [], error: 'No tab named "' + D.qcTab + '"' };
  var last = Math.min(sh.getLastRow(), D.qcFirstRow + D.maxSlabs - 1);
  if (last < D.qcFirstRow) return { slabs: [], grades: [] };

  var width = Math.max(D.qcSlabCol, D.qcGradeCol);
  var rows = sh.getRange(D.qcFirstRow, 1, last - D.qcFirstRow + 1, width).getValues();
  var gone = fDispatchedSet_();
  var allowed = {};
  FOPT.DISPATCH_GRADE.forEach(function (g) { allowed[g] = true; });

  /* Insertion order is kept so the operator sees the list in the order QC
     worked, while a later re-inspection overwrites the earlier grade. */
  var order = [], grade = {};
  for (var i = 0; i < rows.length; i++) {
    var slab = String(rows[i][D.qcSlabCol - 1] || '').trim().toUpperCase();
    if (!slab || gone[slab]) continue;
    var g = String(rows[i][D.qcGradeCol - 1] || '').trim();
    if (!allowed[g]) g = '';                       // C#, Sample, blank: no default
    if (grade[slab] === undefined) order.push(slab);
    grade[slab] = g;
  }

  var out = { slabs: order, grades: order.map(function (s) { return grade[s]; }) };
  try {
    fCache_().put(key, fDispatchPack_(out), D.cacheSeconds);
  } catch (e) { /* too big for the cache: rebuild each time rather than fail */ }
  return out;
}

/* Packed as "SLAB:GRADE," pairs. JSON of the same data is roughly twice the
   size, and CacheService rejects a value over 100 KB. */
function fDispatchPack_(o) {
  var parts = [];
  for (var i = 0; i < o.slabs.length; i++) parts.push(o.slabs[i] + ':' + o.grades[i]);
  return parts.join(',');
}
function fDispatchUnpack_(str) {
  var slabs = [], grades = [];
  if (str) {
    var parts = str.split(',');
    for (var i = 0; i < parts.length; i++) {
      var j = parts[i].lastIndexOf(':');
      if (j < 1) continue;
      slabs.push(parts[i].slice(0, j));
      grades.push(parts[i].slice(j + 1));
    }
  }
  return { slabs: slabs, grades: grades };
}

function fClearDispatchCache_() { fCache_().remove('dispatch_slabs'); }

/**
 * The grade Q.C. Final recorded for each of `slabs`, read fresh from the QC
 * tab rather than taken from the browser. The browser's copy is a snapshot it
 * was handed minutes earlier and, more to the point, an audit column that
 * records "what was changed" must not be filled in by the thing doing the
 * changing.
 *
 * Latest QC row wins, same as fDispatchSlabs_. Grades are returned RAW —
 * including values the dispatch dropdown does not offer, such as Sample —
 * because that is exactly the case the column exists to show.
 */
function fQcGrades_(slabs) {
  var want = {};
  (slabs || []).forEach(function (s) { want[String(s).trim().toUpperCase()] = true; });
  var out = {};
  var D = FORMS_DISPATCH;
  var sh = fss_().getSheetByName(D.qcTab);
  if (!sh) return out;
  var last = Math.min(sh.getLastRow(), D.qcFirstRow + D.maxSlabs - 1);
  if (last < D.qcFirstRow) return out;

  var width = Math.max(D.qcSlabCol, D.qcGradeCol);
  var rows = sh.getRange(D.qcFirstRow, 1, last - D.qcFirstRow + 1, width).getValues();
  for (var i = 0; i < rows.length; i++) {
    var slab = String(rows[i][D.qcSlabCol - 1] || '').trim().toUpperCase();
    if (!slab || !want[slab]) continue;
    out[slab] = String(rows[i][D.qcGradeCol - 1] || '').trim();   // later row overwrites
  }
  return out;
}

/**
 * The per-answer lists for every field whose options follow another field.
 *
 *   { supplier: { on: 'material', sets: { Grit: [...], Filler: [...] } } }
 *
 * Sent with the form so the picker can switch lists without a round trip —
 * changing Material on a phone with no signal must still change the list.
 */
function fOptionSets_(form) {
  var out = null;
  form.sections.forEach(function (sec) {
    sec.fields.forEach(function (f) {
      if (!f.optionsWhen) return;
      out = out || {};
      out[f.id] = { on: f.optionsWhen.field, sets: f.optionsWhen.map || {} };
    });
  });
  return out;
}

/** The list one field may legally hold, given the answers so far. */
function fAllowedOptions_(form, f, values) {
  if (!f.optionsWhen) return f.options || null;
  var key = String((values || {})[f.optionsWhen.field] || '');
  return (f.optionsWhen.map || {})[key] || [];
}

/* ======================================================= bags ============ */
/*
 * The Bag Form tab and the Bag Invoice tab, read for two jobs:
 *
 *   the Bag Form's live duplicate check — which Material + Bag Number pairs
 *   are already on the tab (fUsedBags_)
 *
 *   the Bag Invoice tick list — which bags of one material and supplier are
 *   on no invoice yet, and what each weighs (fInvoiceBags_)
 *
 * Neither is cached. Both tabs are a few columns of a few thousand rows, one
 * read each, and a stale answer here is exactly the mistake the forms exist to
 * stop: a bag offered for a second invoice, a used number let through.
 *
 * Matching goes through fDupNorm_ (case and spacing ignored), the same rule
 * the duplicate guard uses, so the list, the live check and the guard can
 * never disagree about whether two bags are the same bag.
 */

/** The key one bag is known by within a material: "GRIT|4970". */
function fBagKey_(material, bagNo) {
  return fDupNorm_(material) + '|' + fDupNorm_(bagNo);
}

/** Every Bag Form row as {material, supplier, bag, weight, when, who}. */
function fBagRows_() {
  var form = FORM_DEFS.bag;
  var sh = fss_().getSheetByName(form.tab);
  if (!sh) return { rows: [], error: 'No tab named "' + form.tab + '"' };
  var last = sh.getLastRow();
  if (last < 2) return { rows: [] };

  var hi = fHeaderIdx_(sh);
  var cMat = fColOf_(hi, 'Material'), cSup = fColOf_(hi, 'Supplier Code'),
      cBag = fColOf_(hi, 'Bag Number'), cW = fColOf_(hi, 'Weight'),
      cTs = fColOf_(hi, 'Timestamp');
  var cWho;
  ['Email address', 'Email', 'Username', 'Entered by'].forEach(function (n) {
    if (cWho === undefined) cWho = fColOf_(hi, n);
  });
  if (cMat === undefined || cBag === undefined) {
    return { rows: [], error: 'The "' + form.tab + '" tab has no Material / Bag Number column' };
  }

  var vals = sh.getRange(2, 1, last - 1, hi.width).getValues();
  var shown = sh.getRange(2, 1, last - 1, hi.width).getDisplayValues();
  var out = [];
  for (var r = 0; r < vals.length; r++) {
    var bag = String(shown[r][cBag] || '').trim();
    if (!bag) continue;
    var w = cW === undefined ? NaN : Number(vals[r][cW]);
    out.push({
      material: String(vals[r][cMat] || '').trim(),
      supplier: cSup === undefined ? '' : String(vals[r][cSup] || '').trim(),
      bag: bag,
      weight: isNaN(w) ? 0 : w,
      when: cTs === undefined ? '' : String(shown[r][cTs] || '').trim(),
      who: cWho === undefined ? '' : String(shown[r][cWho] || '').trim().split('@')[0]
    });
  }
  return { rows: out };
}

/** Bag numbers written in one Bag Numbers cell: "4970, 4971 4972" -> [...]. */
function fBagList_(raw) {
  var list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,;\s]+/);
  var out = [], seen = {};
  list.forEach(function (b) {
    var v = String(b == null ? '' : b).trim();
    var k = fDupNorm_(v);
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push(v);
  });
  return out;
}

/**
 * Every bag already on an invoice, keyed "GRIT|QG1CV|4970" — material,
 * supplier and number, because that is what the tick list is filtered on.
 * The value says which invoice holds it, for the refusal message.
 */
function fInvoicedBags_() {
  var form = FORM_DEFS.bagInvoice;
  var out = {};
  var sh = fss_().getSheetByName(form.tab);
  if (!sh || sh.getLastRow() < 2) return out;
  var hi = fHeaderIdx_(sh);
  var cMat = fColOf_(hi, 'Material'), cSup = fColOf_(hi, 'Supplier Code'),
      cBags = fColOf_(hi, 'Bag Numbers'), cInv = fColOf_(hi, 'Invoice Number');
  if (cMat === undefined || cBags === undefined) return out;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, hi.width).getDisplayValues();
  rows.forEach(function (row) {
    var pre = fDupNorm_(row[cMat]) + '|' + fDupNorm_(cSup === undefined ? '' : row[cSup]) + '|';
    var inv = cInv === undefined ? '' : String(row[cInv] || '').trim();
    fBagList_(row[cBags]).forEach(function (b) { out[pre + fDupNorm_(b)] = inv || '(no number)'; });
  });
  return out;
}

/**
 * The bags one invoice may take: on the Bag Form under this material and
 * supplier, and on no invoice yet. Parallel arrays, sorted by bag number.
 * A bag logged twice (only possible before the duplicate guard) is offered
 * once, at its latest weight.
 */
function fInvoiceBags_(material, supplier) {
  var got = fBagRows_();
  if (got.error) return { bags: [], weights: [], error: got.error };
  var m = fDupNorm_(material), s = fDupNorm_(supplier);
  if (!m || !s) return { bags: [], weights: [] };

  var done = fInvoicedBags_();
  var weight = {}, order = [];
  got.rows.forEach(function (r) {
    if (fDupNorm_(r.material) !== m || fDupNorm_(r.supplier) !== s) return;
    var k = fDupNorm_(r.bag);
    if (done[m + '|' + s + '|' + k]) return;
    if (weight[r.bag] === undefined) order.push(r.bag);
    weight[r.bag] = r.weight;                 // a later row overwrites
  });
  order.sort(function (a, b) {
    var x = Number(a), y = Number(b);
    return (isNaN(x) || isNaN(y)) ? String(a).localeCompare(String(b)) : x - y;
  });
  return { bags: order, weights: order.map(function (b) { return weight[b]; }) };
}

/**
 * Every Material + Bag Number already on the Bag Form, with a line saying
 * where: { "FILLER|4970": "QFTM - 400 · 1278 kg · 31/10/2026 12:18:35 by rajendra" }.
 * Sent to the phone once per form load for the live duplicate check.
 */
function fUsedBags_() {
  var got = fBagRows_();
  var out = {};
  got.rows.forEach(function (r) {
    out[fBagKey_(r.material, r.bag)] =
      [r.supplier, r.weight ? r.weight + ' kg' : '', r.when ? r.when + (r.who ? ' by ' + r.who : '') : '']
        .filter(String).join(' · ');
  });
  return { used: out, error: got.error || '' };
}
