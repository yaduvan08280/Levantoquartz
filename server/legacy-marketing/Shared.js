/**
 * Domestic Marketing — shared definitions.
 * Everything in this file is ALSO sent to the browser (see sharedJs_()),
 * so lists, labels and the scoring / GPS maths live in exactly one place.
 * Keep it plain ES5 JS with no Apps Script services.
 */

var DEF = {
  app: 'Domestic Marketing',
  roles: { admin: 'Admin', manager: 'Manager', exec: 'Field Executive' },
  visitDays: 120, // visits older than this are loaded only when a screen asks for an older date range

  // What happened at the shop
  outcomes: ['Product explained', 'Interested', 'Follow-up needed', 'Order taken', 'Not interested', 'Closed / person not available'],
  interest: ['Hot', 'Warm', 'Cold'],
  potential: ['High', 'Medium', 'Low'],

  // Every customer is a lead: NEW (not visited yet) -> WORKING -> WON (successful) or DEAD (red flag: not worth anyone's time)
  leadStatus: { NEW: 'New lead', WORKING: 'Working', WON: 'Successful', DEAD: 'Not worth it' },
  leadResult: { WORKING: 'Keep working', WON: 'Successful', DEAD: 'Not worth it (red flag)' },

  // Field types for the per-category customer forms (Admin > Customer forms)
  fieldTypes: { text: 'Text', number: 'Number', phone: 'Phone', select: 'Dropdown (pick one)', multi: 'Tick boxes (pick many)', yesno: 'Yes / No', date: 'Date' },

  // Sample stands
  stand: {
    UNDECIDED: 'Not decided',
    TO_GIVE: 'To give',
    HANDED: 'With executive',
    GIVEN: 'Given',
    EXCLUDED: 'Excluded'
  },

  // Order flow (FMS). Confirm = admin / manager; every other step = the executive who took the order (or admin / manager).
  orderSteps: {
    CONFIRM: { l: 'Confirm order', s: 'Confirm' },
    ADVANCE: { l: 'Advance payment', s: 'Advance' },
    BILLING: { l: 'Billing / invoice', s: 'Billing' },
    DISPATCH: { l: 'Dispatch', s: 'Dispatch' },
    PAY_DISPATCH: { l: 'Payment on dispatch', s: 'Pay on dispatch' },
    DELIVERY: { l: 'Confirm delivery', s: 'Delivery' },
    BALANCE: { l: 'Balance payment', s: 'Balance' }
  },
  orderEnd: { DONE: 'Completed', CANCELLED: 'Cancelled' },
  // Things that happen to an order outside its steps (shown in the step history)
  orderEvents: { EDIT: 'Order changed', REOPEN: 'Reopened', VOID: 'Payment voided', REFUND: 'Refund paid', REPAIR: 'Step repaired' },
  gstModes: { Incl: 'Rates include GST', Excl: 'Rates exclude GST (GST added)' },
  payModes: ['Cash', 'UPI', 'NEFT / RTGS', 'Cheque', 'Other'],
  deliveryCond: ['All OK', 'Damage', 'Shortage', 'Damage + shortage'],
  // Fields of each order step: [key, label, required by default, always required]. Admin ▸ Orders ▸ Steps & people can switch the others.
  orderFields: {
    CONFIRM: [],
    ADVANCE: [['amt', 'Amount', 1, 1], ['mode', 'Mode', 1, 1], ['date', 'Payment date', 1, 1], ['ref', 'Reference / UTR / cheque no.', 0], ['proof', 'Payment proof', 0]],
    BILLING: [['invoiceNo', 'Invoice no.', 1, 1], ['invoiceDate', 'Invoice date', 1, 1], ['invoiceAmt', 'Invoice amount', 1, 1], ['invoiceFile', 'Invoice photo / PDF', 1]],
    DISPATCH: [['vehicleNo', 'Vehicle no.', 1], ['driverName', 'Driver name', 1], ['driverMobile', 'Driver mobile', 1], ['transporter', 'Transporter', 0], ['lrNo', 'LR / bilty no.', 0], ['dispatchPhoto', 'Loaded vehicle photo', 0]],
    PAY_DISPATCH: [], DELIVERY: [['deliveredAt', 'Delivered on', 1, 1], ['receivedBy', 'Received by', 1], ['deliveryCond', 'Condition', 1, 1], ['podPhoto', 'Delivery proof photo', 0]],
    BALANCE: []
  },
  // What a board tile can show (Admin ▸ Orders ▸ Steps & people ▸ Shown on the tile)
  orderTileFields: { value: 'Value', items: 'Items', terms: 'Payment terms', area: 'Area', deliveryDate: 'Expected delivery', confirmedBy: 'Confirmed by',
    invoiceNo: 'Invoice no.', invoiceAmt: 'Invoice amount', paid: 'Received', balance: 'Balance', vehicleNo: 'Vehicle', driver: 'Driver', transporter: 'Transporter', lrNo: 'LR no.',
    dispatchAt: 'Dispatched', deliveredAt: 'Delivered', receivedBy: 'Received by', deliveryCond: 'Condition', remark: 'Last remark' },
  answerActs: { next: 'Next step', stay: 'Stay here (follow-up)', cancel: 'Cancel order' }, // cancel: only on steps before the material is dispatched, and only admin / manager
  payAllow: { credit: 'Credit', dispatch: 'On dispatch', delivery: 'On delivery' },
  creditDays: [15, 30, 45, 60],
  units: ['Slabs', 'Sq ft', 'Sq m'],
  paymentTerms: ['Advance', 'On dispatch', '15 days credit', '30 days credit', '45 days credit', '60 days credit', 'On delivery'],

  // Rate segment of a shop = the average rate it sells quartz at (₹ / sq ft by default)
  segments: ['Premium', 'Mid', 'Economy'],

  // Why a visit is flagged for the boss to look at
  flags: {
    LOW_ACC: 'GPS accuracy poor',
    FAR: 'Far from customer’s pin',
    OLD_MEDIA: 'Photo/video not taken live',
    CLOCK: 'Phone clock was wrong',
    FAST: 'Impossible travel speed',
    NO_PHOTO: 'No front photo'
  },
  verify: { PENDING: 'To review', OK: 'Verified', BAD: 'Rejected' },
  // Admin / manager may log details without being at the customer; field executives always need live GPS
  // Phone calls / follow-ups
  callStatus: ['Not received', 'Received'],
  callDir: ['Outgoing', 'Incoming'],
  entryType: { GPS: 'Field visit (GPS)', OFFICE: 'Office entry (no location)' },

  // Defaults — admin can change all of these in Admin ▸ Lists & rules
  defaults: {
    lists: {
      categories: ['Retail showroom', 'Modular kitchen studio', 'Architect', 'Interior designer', 'Distributor', 'Wholesaler', 'Fabricator', 'Builder / contractor', 'Other'],
      brands: ['Quantra', 'Kalinga Stone', 'Caesarstone', 'Silestone', 'AGL', 'Local / unbranded'],
      cities: [],
      areas: [],
      includeReasons: ['High sales volume', 'Prime location / high footfall', 'Premium rate segment', 'Good relationship', 'Has display space', 'Strategic area — no presence yet'],
      excludeReasons: ['Low sales volume', 'No display space', 'Tied to a competitor brand', 'Payment issues', 'Economy segment only', 'Too far / outside route', 'Already has our stand'],
      wonReasons: ['Order placed', 'Agreed to stock our brand', 'Became our dealer', 'Will specify our brand in projects', 'Regular buyer now'],
      redFlagReasons: ['Not interested at all', 'Volume too small', 'Only sells cheap / economy slabs', 'Payment issues / bad reputation', 'Tied to a competitor brand', 'Shop closed / not genuine', 'Wrong or fake contact details', 'Too far / outside our area'],
      thickness: ['20 mm', '30 mm'],
      callPurposes: ['Greeting call', 'Rate query', 'Order received', 'Dispatch query', 'Complaint'],
      rescheduleReasons: ['Customer not available that day', 'Customer asked for another day', 'Route changed / other area that day', 'Weather / transport problem', 'Busy with an order or delivery', 'Personal / health reason', 'Other']
    },

    // Questions per call purpose (Admin > Forms > Call purposes). Same format as the customer forms.
    callForms: {
      'Greeting call': [
        { k: 'mood', l: 'How did it go?', t: 'select', o: ['Positive', 'Neutral', 'Negative'] },
        { k: 'req', l: 'Any requirement mentioned', t: 'text' }],
      'Rate query': [
        { k: 'prod', l: 'Product(s) asked about', t: 'text', r: true },
        { k: 'thk', l: 'Thickness', t: 'multi', o: ['20 mm', '30 mm'] },
        { k: 'quoted', l: 'Rate we quoted (₹/sq ft)', t: 'number' },
        { k: 'comp', l: 'Competitor rate they mentioned (₹/sq ft)', t: 'number' },
        { k: 'resp', l: 'Their response', t: 'select', o: ['Agreed', 'Negotiating', 'Too high', 'Will confirm later'] }],
      'Order received': [
        { k: 'items', l: 'Products & quantity', t: 'text', r: true },
        { k: 'thk', l: 'Thickness', t: 'multi', o: ['20 mm', '30 mm'] },
        { k: 'value', l: 'Approx. order value (₹)', t: 'number' },
        { k: 'by', l: 'Delivery needed by', t: 'date' },
        { k: 'pay', l: 'Payment terms', t: 'select', o: ['Advance', 'On dispatch', '15 days credit', '30 days credit', '45 days credit', '60 days credit', 'On delivery'] }],
      'Dispatch query': [
        { k: 'ord', l: 'Order no.', t: 'text' },
        { k: 'issue', l: 'What they asked about', t: 'select', o: ['Dispatch status', 'Delay', 'Wrong item', 'Short quantity', 'Transport / vehicle', 'Other'], r: true },
        { k: 'upd', l: 'Update given to the customer', t: 'text' }],
      'Complaint': [
        { k: 'about', l: 'Complaint about', t: 'select', o: ['Product quality', 'Breakage / damage', 'Delivery delay', 'Wrong material', 'Billing / payment', 'Staff behaviour', 'Other'], r: true },
        { k: 'det', l: 'Details', t: 'text', r: true },
        { k: 'sev', l: 'Severity', t: 'select', o: ['Low', 'Medium', 'High'] },
        { k: 'act', l: 'Action promised', t: 'text' },
        { k: 'state', l: 'Status after the call', t: 'select', o: ['Open — needs action', 'Resolved on the call'] }]
    },

    // Extra questions per customer category. k = stored key (never changes), l = label, t = type, o = options, r = required.
    forms: {
      'Retail showroom': [
        { k: 'size', l: 'Showroom size (sq ft)', t: 'number' },
        { k: 'display', l: 'Space to display quartz', t: 'select', o: ['None', 'Small corner', 'Good space'], r: true },
        { k: 'slabs', l: 'Quartz slabs sold per month (approx.)', t: 'number' },
        { k: 'also', l: 'Also sells', t: 'multi', o: ['Granite', 'Marble', 'Tiles', 'Sanitaryware', 'Kitchen fittings'] },
        { k: 'fab', l: 'Has own cutting / fabrication', t: 'yesno' }],
      'Modular kitchen studio': [
        { k: 'kpm', l: 'Kitchens made per month', t: 'number', r: true },
        { k: 'tops', l: 'Countertop material used now', t: 'multi', o: ['Quartz', 'Granite', 'Marble', 'Solid surface', 'Other'], r: true },
        { k: 'budget', l: 'Typical kitchen budget', t: 'select', o: ['Below ₹2 lakh', '₹2–5 lakh', 'Above ₹5 lakh'] },
        { k: 'supplier', l: 'Who supplies their slabs now', t: 'text' },
        { k: 'display', l: 'Has a display kitchen in the studio', t: 'yesno' }],
      'Architect': [
        { k: 'work', l: 'Work type', t: 'select', o: ['Residential', 'Commercial', 'Both'], r: true },
        { k: 'live', l: 'Projects running now', t: 'number' },
        { k: 'ppy', l: 'Projects per year', t: 'number' },
        { k: 'spec', l: 'Specifies the quartz brand?', t: 'select', o: ['Always', 'Sometimes', 'Never — client decides'], r: true },
        { k: 'pref', l: 'Brand they usually specify', t: 'text' }],
      'Interior designer': [
        { k: 'work', l: 'Work type', t: 'select', o: ['Homes', 'Offices', 'Hotels / restaurants', 'Mixed'], r: true },
        { k: 'ppy', l: 'Projects per year', t: 'number' },
        { k: 'spec', l: 'Chooses the countertop for clients?', t: 'select', o: ['Always', 'Sometimes', 'Never — client decides'] },
        { k: 'pref', l: 'Brand they usually use', t: 'text' }],
      'Distributor': [
        { k: 'cover', l: 'Areas / cities covered', t: 'text', r: true },
        { k: 'dealers', l: 'Dealers in their network', t: 'number' },
        { k: 'dist', l: 'Brands they distribute now', t: 'text' },
        { k: 'vol', l: 'Monthly volume (slabs)', t: 'number' },
        { k: 'wh', l: 'Has a warehouse', t: 'yesno' },
        { k: 'gst', l: 'GST number', t: 'text' }],
      'Wholesaler': [
        { k: 'vol', l: 'Monthly volume (slabs)', t: 'number', r: true },
        { k: 'whs', l: 'Warehouse size (sq ft)', t: 'number' },
        { k: 'buyers', l: 'Main buyers', t: 'multi', o: ['Retail shops', 'Fabricators', 'Builders', 'Kitchen studios'] },
        { k: 'credit', l: 'Credit they expect', t: 'select', o: ['Advance', '15 days', '30 days', '45 days', '60 days'] },
        { k: 'gst', l: 'GST number', t: 'text' }],
      'Fabricator': [
        { k: 'mach', l: 'Machines', t: 'select', o: ['Manual', 'Semi-automatic', 'CNC'], r: true },
        { k: 'spm', l: 'Slabs processed per month', t: 'number' },
        { k: 'for', l: 'Works for', t: 'multi', o: ['Retail shops', 'Builders', 'Kitchen studios', 'Home owners directly'] }],
      'Builder / contractor': [
        { k: 'proj', l: 'Projects running now', t: 'number', r: true },
        { k: 'units', l: 'Units / flats under construction', t: 'number' },
        { k: 'ptype', l: 'Project type', t: 'select', o: ['Residential', 'Commercial', 'Both'] },
        { k: 'buyer', l: 'Who decides the purchase', t: 'text' }]
    },
    settings: {
      rateUnit: '₹/sq ft',
      premiumFrom: 250,     // avg selling rate ≥ this → Premium
      economyBelow: 140,    // avg selling rate < this → Economy (between = Mid)
      segScore: { Premium: 3, Mid: 2, Economy: 1 }, // which segment you prefer (higher = preferred)
      gpsRadius: 200,       // metres: a visit further than this from the shop's saved spot is flagged
      gpsMaxAcc: 100,       // metres: worse GPS accuracy than this is flagged
      mediaMaxAge: 30,      // minutes: a photo/video older than this at save time is flagged
      maxSpeed: 80,         // km/h between two visits of the same person
      dailyTarget: 10,      // visits per executive per day
      ownBrand: '',         // your own brand name (left out of competitor charts)
      orderTat: { CONFIRM: 4, ADVANCE: 24, BILLING: 24, DISPATCH: 24, PAY_DISPATCH: 24, DELIVERY: 72 }, // hours each order step may take
      gstPct: 18,           // GST % added when an order's rates exclude GST
      invTolPct: 2,         // invoice may differ from the order value by this % (more needs admin / manager + a reason)
      slabSqft: 75.35,      // 1 slab = this many sq ft (orders and the requirement slip convert with it)
      digestAt: '09:00',    // daily work list on Telegram
      tgSteps: true, tgLate: true, tgDigest: true,
      orderLabels: {},      // step names on the board
      orderWho: { CONFIRM: { owner: false, users: [] }, ADVANCE: { owner: true, users: [] }, BILLING: { owner: true, users: [] }, DISPATCH: { owner: true, users: [] },
        PAY_DISPATCH: { owner: true, users: [] }, DELIVERY: { owner: true, users: [] }, BALANCE: { owner: true, users: [] } }, // owner = the executive who took the order; admin / managers always can
      orderReq: {},         // { STEP: { field: true/false } } overrides of orderFields
      orderTile: { CONFIRM: ['value', 'items', 'terms'], ADVANCE: ['value', 'terms'], BILLING: ['value', 'items'], DISPATCH: ['invoiceNo', 'items', 'transporter'],
        PAY_DISPATCH: ['vehicleNo', 'balance'], DELIVERY: ['vehicleNo', 'driver', 'dispatchAt'], BALANCE: ['invoiceNo', 'balance', 'deliveredAt', 'remark'] },
      orderAnswers: {
        CONFIRM: [{ a: 'Confirmed', act: 'next' }, { a: 'On hold — call back', act: 'stay' }, { a: 'Rejected', act: 'cancel' }],
        ADVANCE: [{ a: 'Received', act: 'next' }, { a: 'Not received yet — follow up', act: 'stay' }],
        DISPATCH: [{ a: 'Dispatched', act: 'next' }, { a: 'Vehicle not available', act: 'stay' }],
        DELIVERY: [{ a: 'Delivered', act: 'next' }, { a: 'Not delivered yet', act: 'stay' }, { a: 'Returned', act: 'back:DISPATCH' }],
        BALANCE: [{ a: 'Payment received', act: 'next' }, { a: 'Promised a date', act: 'stay' }]
      }
    }
  }
};

DEF.orderFields.PAY_DISPATCH = DEF.orderFields.BALANCE = DEF.orderFields.ADVANCE;

/** Metres between two GPS points (haversine). */
function geoDist(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(function (v) { return v === '' || v === null || v === undefined || isNaN(Number(v)); })) return null;
  var R = 6371000, toR = Math.PI / 180;
  var dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** The steps this order goes through (depends on the payment terms). Balance payment is skipped when nothing is due.
 *  Blank or unknown terms count as Advance, so an order can never skip the advance by leaving terms empty. */
function orderPath(o) {
  var t = o.terms || '', p = ['CONFIRM'];
  if (t === 'Advance' || DEF.paymentTerms.indexOf(t) < 0) p.push('ADVANCE');
  p.push('BILLING', 'DISPATCH');
  if (t === 'On dispatch') p.push('PAY_DISPATCH');
  p.push('DELIVERY', 'BALANCE');
  return p;
}
/* ---- order settings helpers (S = settings) */
function stepLabel(st, S) { return ((S && S.orderLabels) || {})[st] || (DEF.orderSteps[st] ? DEF.orderSteps[st].l : DEF.orderEnd[st] || DEF.orderEvents[st] || st); }
function whoOf(st, S) { var w = ((S && S.orderWho) || {})[st] || DEF.defaults.settings.orderWho[st] || { owner: true, users: [] }; return { owner: !!w.owner, users: Array.isArray(w.users) ? w.users : [] }; }
function reqOf(st, k, S) {
  var f = (DEF.orderFields[st] || []).filter(function (x) { return x[0] === k; })[0];
  if (!f) return false; if (f[3]) return true;
  var o = ((S && S.orderReq) || {})[st] || {};
  return o[k] !== undefined ? !!o[k] : !!f[2];
}
function answersOf(st, S) { var a = (S && S.orderAnswers) || {}; return Array.isArray(a[st]) ? a[st] : (DEF.defaults.settings.orderAnswers[st] || []); }
function tileOf(st, S) { var t = (S && S.orderTile) || {}; return Array.isArray(t[st]) ? t[st] : (DEF.defaults.settings.orderTile[st] || []); }
/** May this user (id + role) do the order's current step? Admin / manager always. */
function canDoStep(u, o, st, S) {
  if (!u) return false;
  if (u.role === 'admin' || u.role === 'manager') return true;
  if (st === 'CONFIRM') return false; // only admin / manager ever confirm, whatever the settings say
  var w = whoOf(st, S);
  return (w.owner && o.byId === u.id) || w.users.indexOf(u.id) >= 0;
}
/** Payment terms a customer may use. Advance always; the others only when admin ticked them (Admin ▸ Orders ▸ Customers). */
function creditMax(c) { var m = /credit(?::(\d+))?/.exec(String((c && c.payAllow) || '')); return m ? Number(m[1] || 60) : 0; }
function termsFor(c) {
  var a = String((c && c.payAllow) || ''), out = ['Advance'], max = creditMax(c);
  if (a.indexOf('dispatch') >= 0) out.push('On dispatch');
  [15, 30, 45, 60].forEach(function (d) { if (d <= max) out.push(d + ' days credit'); });
  if (a.indexOf('delivery') >= 0) out.push('On delivery');
  return out;
}

/** Quantity in sq ft (1 slab = S.slabSqft sq ft, 1 sq m = 10.7639 sq ft). */
/** Line amount: the rate is always per sq ft, whatever unit the quantity was entered in. */
/** Order money from its lines: subtotal − discount; GST added on top when the rates exclude GST (gstAmt = the GST inside the value either way). */
function orderMoney(items, discount, gst, S) {
  var sub = 0; (items || []).forEach(function (it) { sub += lineAmt(it, S); });
  sub = Math.round(sub * 100) / 100;
  var disc = Math.min(Math.max(Number(discount) || 0, 0), sub), base = sub - disc, pct = Number(S && S.gstPct);
  if (isNaN(pct) || pct < 0) pct = 18;
  var excl = gst === 'Excl', g = excl ? base * pct / 100 : base * pct / (100 + pct);
  return { subtotal: sub, discount: disc, gstAmt: Math.round(g * 100) / 100, total: Math.round(excl ? base + g : base), pct: pct };
}
function lineAmt(it, S) { return Math.round(toSqft(it && it.qty, it && it.unit, S) * (Number(it && it.rate) || 0) * 100) / 100; }
function toSqft(qty, unit, S) {
  var q = Number(qty) || 0, slab = Number(S && S.slabSqft) || 75.35;
  return unit === 'Slabs' ? q * slab : unit === 'Sq m' ? q * 10.7639 : q;
}
/**
 * Requirement slip: material needed for active orders that are not dispatched yet, per design + thickness, in sq ft (and slabs).
 * incl = also count orders still waiting for confirmation.
 */
function slipRows(orders, incl, S) {
  var steps = ['CONFIRM', 'ADVANCE', 'BILLING', 'DISPATCH'], g = {}, out = [], slab = Number(S && S.slabSqft) || 75.35;
  orders.forEach(function (o) {
    var st = orderStage(o);
    if (steps.indexOf(st) < 0 || (!incl && st === 'CONFIRM')) return;
    (o.items || []).forEach(function (it) {
      var k = String(it.product || '').trim().toUpperCase() + '|' + (it.thk || ''), r = g[k], q = Number(it.qty) || 0, sq = toSqft(q, it.unit, S);
      if (!r) { r = g[k] = { product: String(it.product || '').trim(), thk: it.thk || '', conf: 0, pend: 0, orders: [] }; out.push(r); }
      if (st === 'CONFIRM') r.pend += sq; else r.conf += sq;
      r.orders.push({ id: o.id, shop: o.shop, qty: q, unit: it.unit || '', sqft: Math.round(sq * 100) / 100, st: st, by: o.by || '', deliveryDate: o.deliveryDate || '' });
    });
  });
  out.forEach(function (r) { r.conf = Math.round(r.conf * 100) / 100; r.pend = Math.round(r.pend * 100) / 100; r.total = Math.round((r.conf + r.pend) * 100) / 100; r.slabs = Math.round(r.total / slab * 100) / 100; });
  return out.sort(function (a, b) { return a.product.localeCompare(b.product) || String(a.thk).localeCompare(String(b.thk), undefined, { numeric: true }); });
}

/** Current step of an order (older orders: New / Confirmed / Dispatched / Delivered). */
function orderStage(o) { var m = { NEW: 'CONFIRM', CONFIRMED: 'BILLING', DISPATCHED: 'DELIVERY', DELIVERED: 'DONE' }; return m[o.status] || o.status || 'CONFIRM'; }
function creditDays(terms) { var m = /^(\d+) days credit$/.exec(terms || ''); return m ? Number(m[1]) : 0; }

/** Lead status of a customer (older rows without one: visited = Working). */
function leadOf(c) { return c.status || (Number(c.visits) ? 'WORKING' : 'NEW'); }

/** Average selling rate → segment. */
function rateSegment(avg, s) {
  if (avg === '' || avg === null || avg === undefined) return '';
  avg = Number(avg);
  if (isNaN(avg) || avg <= 0) return '';
  return avg >= Number(s.premiumFrom) ? 'Premium' : avg < Number(s.economyBelow) ? 'Economy' : 'Mid';
}

/**
 * Who to prefer. Score = rate segment (admin weights) + potential + interest. A ≥ 6, B ≥ 4, else C.
 * A manual priority set by admin/manager always wins.
 */
function custPriority(c, s) {
  if (c.priorityManual) return { p: c.priorityManual, manual: true, score: null };
  var seg = rateSegment(c.avgRate, s), w = s.segScore || {};
  var score = (seg ? Number(w[seg]) || 0 : 1) + ({ High: 2, Medium: 1, Low: 0 }[c.potential] || 0) + ({ Hot: 2, Warm: 1, Cold: 0 }[c.interest] || 0);
  return { p: score >= 6 ? 'A' : score >= 4 ? 'B' : 'C', manual: false, score: score, seg: seg };
}
