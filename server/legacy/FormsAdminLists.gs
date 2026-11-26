/**
 * Slabworks Production Forms — dropdown entries added by admins
 * -------------------------------------------------------------
 * Some dropdowns grow on the shop floor faster than the code does: a new
 * design name or a new slab size turns up with a container. An admin or a
 * supervisor adds it from the form itself ("+ Design name", "+ Size") and
 * from then on everyone sees it in that dropdown. Only an admin can take an
 * entry back out — a supervisor cannot, not even one they added.
 *
 * The additions live in the "App Lists" tab of New Base, one row each:
 *
 *     List | Value | Added By | Added At
 *
 * so they can be read, corrected or deleted in the sheet as well. A field
 * opts in with `extendable: '<list key>'`; its options are then the schema's
 * list followed by that list's additions (fResolveOptions_). A form names the
 * buttons it shows to admins in `adminLists`.
 *
 * Read once and cached; every add or remove clears the cache, so the next
 * phone that opens the form gets the new list.
 */
var FORMS_XLIST_TAB = 'App Lists';
var FORMS_XLIST_HEAD = ['List', 'Value', 'Added By', 'Added At'];
var FORMS_XLIST_CACHE = 'xlists';

/** The list keys some form actually uses — nothing else may be written. */
function fXListKeys_() {
  var keys = {};
  FORM_KEYS.forEach(function (k) {
    (FORM_DEFS[k].adminLists || []).forEach(function (a) { keys[a.list] = a; });
  });
  return keys;
}

/** { listKey: [value, ...] } in the order they were added. */
function fXLists_() {
  var hit = fCache_().get(FORMS_XLIST_CACHE);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var out = {};
  var sh = fss_().getSheetByName(FORMS_XLIST_TAB);
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
      var list = String(r[0] || '').trim(), v = String(r[1] || '').trim();
      if (!list || !v) return;
      (out[list] = out[list] || []);
      if (out[list].indexOf(v) === -1) out[list].push(v);
    });
  }
  try { fCache_().put(FORMS_XLIST_CACHE, JSON.stringify(out), 21600); } catch (e) {}
  return out;
}

/** A field's options with the admins' additions after the schema's own. */
function fWithXList_(field, base) {
  if (!field.extendable) return base;
  var add = fXLists_()[field.extendable] || [];
  if (!add.length) return base;
  var seen = {};
  base.forEach(function (v) { seen[String(v).toUpperCase()] = true; });
  return base.concat(add.filter(function (v) { return !seen[String(v).toUpperCase()]; }));
}

/** The base (schema) list behind a list key, to refuse exact repeats. */
function fXListBase_(listKey) {
  var out = [];
  FORM_KEYS.forEach(function (k) {
    FORM_DEFS[k].sections.forEach(function (sec) {
      sec.fields.forEach(function (fl) {
        if (fl.extendable === listKey && fl.options) out = out.concat(fl.options);
      });
    });
  });
  return out;
}

function fXListSheet_() {
  var ss = fss_();
  var sh = ss.getSheetByName(FORMS_XLIST_TAB);
  if (!sh) {
    sh = ss.insertSheet(FORMS_XLIST_TAB);
    sh.getRange(1, 1, 1, FORMS_XLIST_HEAD.length).setValues([FORMS_XLIST_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* Who may add to the lists, and who may take entries back out. */
function fCanAddList_(s)    { var r = (s && s.role) || 'operator'; return r === 'admin' || r === 'supervisor'; }
function fCanRemoveList_(s) { return ((s && s.role) || 'operator') === 'admin'; }

function fRequireListAdder_(token) {
  var s = fRequireSession_(token);
  if (!fCanAddList_(s)) throw new Error('Only an admin or a supervisor can add to the dropdowns.');
  return s;
}
function fRequireListRemover_(token) {
  var s = fRequireSession_(token);
  if (!fCanRemoveList_(s)) throw new Error('Only an admin can remove entries from the dropdowns.');
  return s;
}

/**
 * Add one entry to a list. Typed text is kept as typed apart from outer
 * spaces and repeated inner spaces; an entry already on the list (in any
 * case) is refused, so "Frost White" cannot sit beside "FROST WHITE".
 */
function api_addListItem(token, listKey, value) {
  var s = fRequireListAdder_(token);
  var spec = fXListKeys_()[listKey];
  if (!spec) return { ok: false, error: 'Unknown list.' };
  var v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!v) return { ok: false, error: 'Type the ' + spec.label.toLowerCase() + ' first.' };
  if (v.length > 80) return { ok: false, error: 'That is longer than 80 characters.' };

  return fWithLock_(20000, function () {
    fCache_().remove(FORMS_XLIST_CACHE);              // read the sheet, not a copy
    var now = fXListBase_(listKey).concat(fXLists_()[listKey] || []);
    var clash = now.filter(function (x) { return String(x).toUpperCase() === v.toUpperCase(); })[0];
    if (clash) return { ok: false, error: '"' + clash + '" is already on the list.' };
    var sh = fXListSheet_();
    sh.getRange(fRealLastRow_(sh) + 1, 1, 1, 4).setValues([[listKey, v, s.username, new Date()]]);
    fCache_().remove(FORMS_XLIST_CACHE);
    return { ok: true, value: v, added: fXLists_()[listKey] || [] };
  });
}

/** Take back an entry an admin added. The schema's own entries cannot be removed here. */
function api_removeListItem(token, listKey, value) {
  fRequireListRemover_(token);
  if (!fXListKeys_()[listKey]) return { ok: false, error: 'Unknown list.' };
  var v = String(value == null ? '' : value).trim();
  return fWithLock_(20000, function () {
    var sh = fss_().getSheetByName(FORMS_XLIST_TAB);
    var gone = 0;
    if (sh && sh.getLastRow() >= 2) {
      var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues();
      for (var i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0]).trim() === listKey && String(rows[i][1]).trim() === v) {
          sh.deleteRow(i + 2);
          gone++;
        }
      }
    }
    fCache_().remove(FORMS_XLIST_CACHE);
    if (!gone) return { ok: false, error: '"' + v + '" was not added by an admin, so it cannot be removed here.' };
    return { ok: true, added: fXLists_()[listKey] || [] };
  });
}
