/**
 * ============================================================================
 *  SLABWORKS — Production Control : backend
 *  ---------------------------------------------------------------------------
 *  Serves the dashboard page AND its data from one Apps Script deployment.
 *
 *  ROUTES (all on the /exec URL)
 *    /exec                      -> the dashboard page (Dashboard.html)
 *    /exec?api=meta             -> manifest: version, config, headers, chunk map
 *    /exec?api=c&i=<n>          -> wire chunk <n> of columnar rows
 *    /exec?api=ping             -> {v:"<version>"}   (~90 bytes)
 *    /exec?api=delta&since=<v>  -> only rows touched since <v>
 *    /exec?api=data             -> LEGACY full payload (works with unpatched HTML)
 *    /exec?api=diag             -> row counts, bytes, build ms, resolved columns
 *    /exec?api=me               -> who is signed in and which views they cannot see
 *    POST {action:"login"}      -> username + password in, signed sign-in key out
 *    POST {action:"saveConfig"} -> persists the Configure page to _DashboardConfig (admin only)
 *
 *  SIGN-IN: every ?api= route and every POST except login needs the sign-in
 *  key, as ?s=<key> or {s:<key>} in a POST body. See DashAuth.js.
 *
 *  WHY IT IS FAST
 *    Nothing is read from the spreadsheet during a user request. A trigger
 *    builds a columnar snapshot, slices it into ~80 KB pieces and parks those
 *    in CacheService. A request is a cache read plus string concatenation.
 *
 *    Columnar means each header name is sent once for the whole tab instead of
 *    once per row. On this sheet that alone removes ~55% of the payload.
 *
 *    A change never makes the next visitor wait for a rebuild: the snapshot is
 *    served as-is and the few rows it is missing arrive as a delta read live
 *    from the sheet. See the version_() comment for how that works.
 *
 *  SETUP: set SHEET_ID below, then run setup() once, then deploy as a web app
 *  (Execute as: Me · Who has access: Anyone).
 * ============================================================================
 */

var CFG = {

  /* ---- REQUIRED ---------------------------------------------------------- */
  SHEET_ID: '1Cy3Li1uXx_wkCcrk893WKK2DLRttKTjrsnafb5DsJbY',

  /* ---- Optional shared secret -------------------------------------------- */
  /* A web app open to "Anyone" has a public URL. Put a random string here and
     every request must carry ?k=<that string>. Paste the URL WITH ?k=... into
     the dashboard's Data source box; it is stored and reused automatically.   */
  TOKEN: '',

  /* ---- Who sees what ------------------------------------------------------ */
  /* People sign in with their App Users account (see DashAuth.js). Only admin
     and supervisor may sign in. Admin always sees every view; list here the
     views a role does NOT see. View names are the data-view names in
     Dashboard.html: overview, live, halts, feedback, times, production,
     analytics (Quality), design, supplier, consumption (Material), bags,
     costing, reports, config. A hidden view's data route is refused too
     (DASH_ROUTE_VIEW in DashAuth.js). */
  ROLE_HIDE: {
    supervisor: ['costing']
  },

  /* ---- Sub-minute sync ---------------------------------------------------- */
  /* 0  = off. The dashboard's own "Every N min" dropdown is the only timer.
     20000 = the page also asks "anything changed?" every 20 s (~90 bytes) and
     pulls just the changed rows when the answer is yes. Nothing on screen
     changes either way - this only affects how fresh the numbers are.         */
  PING_MS: 0,

  /* ---- Names of the two bookkeeping tabs the backend owns ----------------- */
  CONFIG_TAB: '_DashboardConfig',

  /* Material prices, per kilogram, per supplier code. A visible tab on purpose:
     the Costing tab writes it, but whoever does the buying can also type
     straight into it, and a hidden tab is a tab nobody remembers exists. */
  PRICES_TAB: 'Material Prices',

  /* ---- Tuning ------------------------------------------------------------- */
  STORE_BYTES: 80000,     // per CacheService entry (hard ceiling is 100 KB)
  WIRE_BYTES: 600000,     // per browser request (bigger = fewer round trips)
  CACHE_TTL: 21600,       // 6 h, the CacheService maximum
  DELTA_KEEP: 150,        // delta log entries kept before a full reload is forced
  DELTA_MAX_ROWS: 80,     // past this a delta stops being cheaper than a reload
  /* How often the heartbeat may rebuild the WHOLE snapshot while rows keep
     arriving. In between, new rows reach open dashboards as deltas. Rebuilding
     every minute meant re-reading every tab of New Base in full, all shift,
     and the forms app's saves queued behind those reads (19/11/2026). */
  REBUILD_EVERY_MS: 10 * 60 * 1000,
  /* ...or sooner once this many rows are waiting as deltas, safely under
     DELTA_MAX_ROWS, past which ?api=delta tells clients to reload in full. */
  REBUILD_AT_ROWS: 50,
  PAGE_FILE: 'Dashboard', // name of the HTML file in this project

  /* ---- Which columns hold the slab counts on the two summary tabs --------- */
  /* Left empty, the backend finds them by their ORANGE header fill. Override
     with column letters if it ever picks wrong, e.g.
       SUMMARY_COLS: { production_summary_a: ['E','F'], production_summary_b: ['E','F'] } */
  SUMMARY_COLS: {},

  /* ---- Column headers never sent ----------------------------------------- */
  DROP_HEADERS: [],

  /* ---- Who filled the row ------------------------------------------------- */
  /* The forms app writes the signed-in USERNAME into the first of these a tab
     has (fAppendSheet_ in forms/FormsSubmit.js); rows from the old Google
     Forms hold an email address. Either way only the part before "@" travels -
     a full address would add ~1 MB across the sheet - and the slab pop-up
     turns it into the App Users "Display Name". Keep this list in step with
     whoCols in fAppendSheet_.                                                  */
  WHO_HEADERS: [/^\s*email\s*address\s*$/i, /^\s*email\s*$/i,
                /^\s*username\s*$/i, /^\s*entered\s*by\s*$/i],

  /* ---- THE ALLOWLIST ------------------------------------------------------ */
  /* Only these tabs are ever opened. Everything else in the workbook -
     Responsible Persons, Bundles, QC (1) - is invisible to the
     dashboard. Names below are the real tab names in your sheet.

     keepWidth : this tab is addressed by COLUMN LETTER inside the dashboard
                 (SHEET_RULES), so its header row must be sent at full width or
                 colIdx("AF") lands on the wrong column. Rows stay sparse - only
                 the columns listed in `cols`, every column that actually holds
                 slab codes, and the column immediately left of each of those
                 (that is where the bundle id lives) are sent.
     only      : an explicit column allowlist for an ordinary tab.            */
  TABS: [
    /* -- reference tabs: not stages, read by column letter ----------------- */
    { match: /^unique\s*codes$/i,        keepWidth: true, cols: ['C'] },
    { match: /^slab\s*numbers$/i,        keepWidth: true, cols: ['AE','AF','AI','AJ'] },

    /* -- production stages, listed in sheet order -------------------------- */
    { match: /^batching\s*form$/i },
    { match: /^resin\s*form$/i },
    { match: /^mixer\s*form$/i },
    { match: /^pressing\s*form$/i },
    { match: /^oven\s*in\s*form$/i },
    { match: /^oven\s*out\s*form$/i },
    { match: /^repressing\s*form$/i },
    { match: /^vacuum\s*unloader$/i },

    /* Trolley Form is filled in per BUNDLE, not per slab - which slab is on
       which trolley comes from Slab Numbers cols AI/AJ, never from this tab.
       Its 108 BN01..BN99 columns are therefore inert: no slab row ever
       attaches to them, so nothing renders them. Shipping only the two
       columns the schema needs saves ~400 KB. Delete the `only` line to send
       the whole tab. */
    { match: /^trolley\s*form$/i, only: [/^timestamp$/i, /bundle\s*number/i, /^\s*email\s*address\s*$/i] },

    /* Slab counts per line. Not production stages - the dashboard must never
       put them on the rail - so they are marked 'ignore' in DEFAULT_CONFIG
       below and simply carried to the Production tab as data. Every column
       travels because the layout is read on the client. */
    { match: /^production\s*summary\s*a$/i, headerColors: true, forceDates: true },
    { match: /^production\s*summary\s*b$/i, headerColors: true, forceDates: true },

    /* Bag Form is a goods-received log, not a production stage: one row per
       bag of grit or filler as it arrives. It is marked 'ignore' in
       DEFAULT_CONFIG below so it never joins the stage rail, and travels only
       so the Bag ledger can compare what arrived against what Batching drew. */
    { match: /^bag\s*form$/i },

    /* Formula Form is the recipe: what a slab of one design is SUPPOSED to
       consume. Also not a production stage - nothing passes through it - so it
       is 'ignore' below and travels only for the Costing tab, which prices it
       against what Batching, Resin and Mixer say the line actually drew. */
    { match: /^formula\s*form$/i },

    { match: /^calibration\s*form$/i },
    { match: /^q\.?\s*c\.?\s*final\s*form$/i },
    { match: /^dispatch\s*form$/i },

    /* Container Form says which party a container went to. Not a stage - it
       is 'ignore' in DEFAULT_CONFIG - it travels only so the Consolidated
       table on Live Production can fill PARTY NAME from a slab's container. */
    { match: /^container\s*form$/i, only: [/^timestamp$/i, /container\s*number/i, /client\s*name/i] }
  ]
};

/**
 * DESIGN CODE -> DESIGN NAME
 * ---------------------------------------------------------------------------
 * The Batching Form records a design CODE ("LQ-241", sometimes with a finish
 * letter after it). This turns that into the design name the Design analytics
 * tab groups by.
 *
 * Keys are normalised: prefix, hyphen, number with leading zeros stripped, so
 * LQ-009, LQ-9 and "lq - 009 Y" all resolve to the same design.
 *
 * TWO CODES IN THE SUPPLIED LIST WERE GIVEN TWO DIFFERENT NAMES. The more
 * specific name was kept, so nothing is silently merged:
 *   LQ-007  kept "CALACATTA SHADOW (NATURAL)"        (list also said "CALACATTA SHADOW", which is LQ-207)
 *   LQ-242  kept "CALACATTA SPONDA GOLD (NATURAL)"   (list also said "CALACATTA SPONDA GOLD", which is LQ-442)
 * Change either line if the plain name is the right one.
 *
 * Six names carry two codes each (a SET- and an LQ-); both map to the one name,
 * so their slabs are reported together.
 *
 * A code that appears in Batching but not here is not dropped - it is grouped
 * under its raw code and flagged at the top of the tab.
 */
var DESIGN_NAMES = {
  'SET-105': '(LOW SILICA) MOONLIGHT',
  'SET-82': '(LOW SILICA) PURE WHITE',
  'LQ-273': 'BIANCO CARRARA',
  'SET-117': 'BIANCO CARRARA GOLD',
  'SET-118': 'BIANCO CARRARA GREY',
  'LQ-838': 'BIANCO LYRA',
  'LQ-9': 'BIANCO WHITE',
  'SET-114': 'CALACATTA AZURE',
  'LQ-241': 'CALACATTA BELLA',
  'LQ-825': 'CALACATTA BLACK TREE',
  'LQ-216': 'CALACATTA CALYPSO',
  'LQ-264': 'CALACATTA CIELO',
  'SET-81': 'CALACATTA CIELO',
  'LQ-268': 'CALACATTA DORADO',
  'SET-109': 'CALACATTA DORADO',
  'LQ-265': 'CALACATTA LAZA GOLD',
  'SET-107': 'CALACATTA LAZA GOLD',
  'LQ-266': 'CALACATTA LAZA GREY',
  'SET-112': 'CALACATTA LAZA GREY',
  'LQ-820': 'CALACATTA LUNA',
  'SET-116': 'CALACATTA LUXOR',
  'SET-89': 'CALACATTA MISTERIO',
  'LQ-254': 'CALACATTA MOONLIGHT',
  'LQ-15': 'CALACATTA RIO',
  'SET-111': 'CALACATTA RUSTA',
  'LQ-207': 'CALACATTA SHADOW',
  'LQ-7': 'CALACATTA SHADOW (NATURAL)',
  'LQ-258': 'CALACATTA SNOW',
  'LQ-442': 'CALACATTA SPONDA GOLD',
  'LQ-242': 'CALACATTA SPONDA GOLD (NATURAL)',
  'LQ-243': 'CALACATTA SPONDA GREY',
  'LQ-822': 'CALACATTA SUPREME',
  'SET-101': 'CALACATTA TELESTO',
  'LQ-6': 'CALACATTA TUSCANY',
  'LQ-244': 'CALACATTA TUSCANY GREY',
  'LQ-259': 'CALACATTA VENETINO GREY',
  'LQ-208': 'CALACATTA WOW',
  'SET-102': 'CARRARA GOLD',
  'SET-120': 'DYNA BLUE',
  'SET-121': 'DYNA GOLD',
  'LQ-240': 'ESTADOS GOLD',
  'LQ-239': 'ESTADOS GREY',
  'LQ-74': 'FLORENCE GOLD',
  'LQ-72': 'FLORENCE GREY',
  'SET-119': 'FLORENCE GREY',
  'LQ-61': 'LINCOIN GOLD',
  'LQ-60': 'LINCOIN GREY',
  'SET-99': 'SAMPLE',
  'LQ-76': 'SHIMMER WHITE',
  'LQ-53': 'SPARKLE WHITE',
  'LQ-269': 'TAJ MAHAL',
  'SET-108': 'TAJ MAHAL',
  'LQ-236': 'THASSOS CARRARA',
  'LQ-214': 'THASSOS WHITE',
  'LQ-261': 'ULTRA WHITE',
  'LQ-260': 'VENETINO GOLD',
};

/**
 * DEFECT -> RESPONSIBLE AREA
 * ---------------------------------------------------------------------------
 * Which parts of the line can cause each defect. One defect usually has more
 * than one owner, and every owner listed is credited with that defect, so the
 * area totals add up to more than the defect count - that is the point: it
 * shows where to look, not who to blame.
 *
 * TRANSCRIBED FROM THE DEFECT MATRIX SCREENSHOT - please check it against the
 * original. Names only have to match loosely: case, spaces and punctuation are
 * ignored, and a prefix counts either way, so "Pattern Problem" here matches
 * "Pattern Problem / Blurr" in the Q.C. form. Any defect name in the form that
 * matches nothing here is EXCLUDED from the chart and listed by the warning
 * under it - check that warning after the first load.
 */
var DEFECT_AREAS = {
  'White spots':                    ['Mixer'],
  'Cavity / Big hole':              ['Crafting / Labour Issue', 'Rubber Placement'],
  'Color dots / spot':              ['Batching', 'Crafting / Labour Issue'],
  'Crack / Breakage':               ['Resin / Whitepaste', 'Rubber Placement', 'Oven'],
  'Cutting / Edge Chipping':        ['Crafting / Labour Issue', 'Polish Handling'],
  'Contamination/Foreign Material': ['Batching', 'Crafting / Labour Issue'],
  'Over-sized grits':               ['Batching'],
  'Patches':                        ['Mixer', 'Pressing'],
  'Pattern Problem':                ['Crafting / Labour Issue', 'Pressing'],
  'Pin holes / micro':              ['Pressing'],
  'Porosity':                       ['Mixer', 'Pressing'],
  'Resin Dot':                      ['Mixer'],
  'Surface scratch':                ['Calibration'],
  'Low Thickness Issue':            ['Resin / Whitepaste', 'Oven'],
  'Vein color / vein line':         ['Crafting / Labour Issue'],
  'Shade Variation':                ['Batching', 'Resin / Whitepaste'],
  'Paperdeep':                      ['Pressing', 'Levelling'],
  'Bend':                           ['Resin / Whitepaste']
};

/* The dashboard's own idea of a slab code: A25D01034, B26G17022 ...           */
var SLAB_CODE = /^[A-Za-z]{1,2}\d{2}[A-Za-z]\d{3,6}$/;

/* Seeded into _DashboardConfig on first run. Without these the live data
   renders with DIFFERENT stages than the built-in sample: no master registry,
   Oven In / Oven Out as two separate stages, Repressing as a stage instead of
   a rework loop. Do not remove them - the Configure page overwrites this. */
var DEFAULT_CONFIG = {

  /* The master slab list. Nothing outside "unique codes" column C is ever
     shown as a slab. The two summary tabs are reference data, not stages. */
  roles: {
    unique_codes: 'registry',
    production_summary_a: 'ignore',
    production_summary_b: 'ignore',
    bag_form: 'ignore',
    formula_form: 'ignore',
    container_form: 'ignore'
  },

  /* A rework loop, not a stage on the rail. */
  optional: ['repressing_form'],

  /* Dispatch Form has no rows yet, and a final stage nobody can reach means
     "Completed" is permanently 0 and cycle time never computes. Hiding it
     makes Q.C. the last stage, so completed counts, cycle time and the
     throughput charts work against QC-passed slabs today.
     When the dispatch form starts collecting, delete this one line. */
  hidden: ['dispatch_form'],

  /* Oven In + Oven Out are one stage with an in-time and an out-time. */
  groups: { oven: ['oven_in_form', 'oven_out_form'] },

  /* Without these the rail would read "Batching Form", "Q.C. Final Form" ... */
  names: {
    oven:             'Oven',
    batching_form:    'Batching',
    resin_form:       'Resin',
    mixer_form:       'Mixer',
    pressing_form:    'Pressing',
    repressing_form:  'Repressing',
    vacuum_unloader:  'Vacuum Unloader',
    trolley_form:     'Trolley',
    calibration_form: 'Calibration',
    q_c_final_form:   'Q.C.',
    dispatch_form:    'Dispatch'      // unused while hidden; kept for the day it goes live
  }

  /* Stage order follows the tabs left-to-right, which is confirmed correct for
     this line: Batching → Resin → Mixer → Pressing → Oven → Vacuum Unloader →
     Trolley → Calibration → Q.C.
     To pin a different order, add a stageOrder array of tab keys - or use the
     arrows on the dashboard's Configure page, which write the same setting
     back to _DashboardConfig. */
};

/* ========================================================================== */
/*  ROUTER                                                                    */
/* ========================================================================== */

function doGet(e) {
  var p = (e && e.parameter) || {};

  /* The forms app, if it has been merged into this project. Checked before the
     token gate because the link in a Telegram alert is built by the forms code
     and does not carry ?k=. The forms app has its own username/password login
     behind this, which is what actually protects it. */
  if (p.app === 'forms' && typeof formsPage_ === 'function') return formsPage_(e);

  if (CFG.TOKEN && p.k !== CFG.TOKEN) return json_({ ok: false, error: 'unauthorized' });

  /* The page itself carries no data - only the sign-in screen until someone
     signs in. Every data route needs a valid sign-in key in ?s=. */
  if (!p.api) return page_();

  try {
    var who = dashCheck_(p.s);
    if (!who.ok) return json_(who);
    var view = DASH_ROUTE_VIEW[p.api];
    if (view && !dashCanSee_(who.user, view)) return json_({ ok: false, error: 'not available for your role' });

    switch (p.api) {
      case 'me':    return json_(dashWho_(who.user));          // who is signed in, what they cannot see
      case 'feedback': return json_(swFeedback_({ from: p.from, to: p.to }));   // grade alerts + reports, by range
      case 'ping':  return json_({ ok: true, v: version_() });   // current, may be ahead of the snapshot
      case 'meta':  return raw_(metaJson_());
      case 'c':     return raw_(chunkJson_(+(p.i || 0)));
      case 'delta': return json_(delta_(p.since || ''));
      case 'data':  return raw_(legacyJson_());
      case 'diag':  return json_(diag_());
      case 'prices': return json_(readPrices_());
      case 'build': return json_(buildSnapshot_(true));
      default:      return page_();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var p = (e && e.parameter) || {};

  /* Telegram's webhook, if the forms app has been merged into this project.
     Before the token gate on purpose: Telegram posts from its own servers and
     cannot carry ?k=. fIsTelegram_ only accepts a body that is actually a
     Telegram update, and the handler only acts on a /start carrying a link
     code we issued — everything else in the message is ignored. */
  if (typeof fIsTelegram_ === 'function' && fIsTelegram_(e)) return fTelegramPost_(e);

  if (CFG.TOKEN && p.k !== CFG.TOKEN) return json_({ ok: false, error: 'unauthorized' });
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    /* Sign-in posts the password in the body, never in a URL. */
    if (body.action === 'login') return json_(dashLogin_(body.username, body.password));

    var who = dashCheck_(body.s || p.s);
    if (!who.ok) return json_(who);
    var view = DASH_ROUTE_VIEW[body.action];
    if (view && !dashCanSee_(who.user, view)) return json_({ ok: false, error: 'not available for your role' });

    if (body.action === 'saveConfig') {
      /* The config changes the dashboard for everybody, so only an admin saves it. */
      if (who.user.role !== 'admin') return json_({ ok: false, error: 'only an admin can save the configuration' });
      writeConfig_(body.config || {});
      noteFullChange_();             // config is not a row: clients reload cleanly
      buildSnapshot_(true);
      return json_({ ok: true });
    }
    if (body.action === 'savePrices') {
      return json_(writePrices_(body.prices || {}, who.user.username));
    }
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * Serves the dashboard file untouched, with one line injected into <head> so
 * the page knows its own data URL and connects itself with nothing pasted.
 * The file stays valid standalone HTML - no scriptlets in it.
 */
function page_() {
  var html = HtmlService.createHtmlOutputFromFile(CFG.PAGE_FILE).getContent();
  var self = ScriptApp.getService().getUrl() +
             (CFG.TOKEN ? '?k=' + encodeURIComponent(CFG.TOKEN) : '');
  var inject = '<script>window.SW_SELF_URL=' + JSON.stringify(self) + ';<\/script>';
  html = html.replace(/<head([^>]*)>/i, '<head$1>' + inject);
  return HtmlService.createHtmlOutput(html)
    .setTitle('Slabworks — Production Control')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function raw_(s) {
  return ContentService.createTextOutput(s)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========================================================================== */
/*  VERSION + PROPERTIES                                                      */
/* ========================================================================== */

function props_() { return PropertiesService.getScriptProperties(); }
function cache_() { return CacheService.getScriptCache(); }

/**
 * TWO versions, and the difference is the whole trick.
 *
 *   SW_VERSION  the data version. Moves the instant a row or the config
 *               changes. Never moves because a snapshot was rebuilt.
 *   SW_BUILD    the data version the CURRENT snapshot represents. Moves only
 *               when the builder finishes.
 *
 * A page load is served the snapshot and is told v = SW_BUILD. Its next ping
 * gets SW_VERSION, sees it is ahead, and pulls the difference as a delta -
 * read live from the sheet, so it is correct even though the snapshot is a
 * few minutes behind. That is what keeps a rebuild off the request path: a
 * form submission never makes the next visitor wait for a rebuild.
 *
 * Versions are plain counters ('v41') so delta compares them numerically
 * instead of trusting timestamp ordering.
 */
function version_() {
  var v = props_().getProperty('SW_VERSION');
  if (!v) { v = 'v1'; props_().setProperty('SW_VERSION', v); }
  return v;
}
function buildVersion_() { return props_().getProperty('SW_BUILD') || ''; }
function seq_(v) { var n = parseInt(String(v || '').replace(/^v/, ''), 10); return isNaN(n) ? -1 : n; }
function bump_() {
  var v = 'v' + (seq_(version_()) + 1);
  props_().setProperty('SW_VERSION', v);
  return v;
}

/**
 * A fingerprint of the tab configuration.
 *
 * The snapshot is cached for six hours and the heartbeat only watches tabs the
 * manifest ALREADY knows about, so adding a tab to CFG.TABS used to change
 * nothing at all until the cache went cold — the deployment ran the new code
 * and still served the old tab list. Now the manifest carries this signature
 * and any change to it forces a rebuild on the next request.
 */
function cfgSig_() {
  var parts = [];
  for (var i = 0; i < CFG.TABS.length; i++) {
    var t = CFG.TABS[i];
    parts.push(String(t.match) + (t.only ? '|only:' + t.only.length : '') +
               (t.cols ? '|cols:' + t.cols.join(',') : '') +
               (t.keepWidth ? '|w' : '') + (t.headerColors ? '|hc' : '') +
               (t.forceDates ? '|fd' : ''));
  }
  /* Which columns are dropped or shortened changes what a snapshot holds too. */
  parts.push('drop:' + CFG.DROP_HEADERS.join(',') + '|who:' + CFG.WHO_HEADERS.join(','));
  return parts.join('||');
}

/* The manifest is a few KB - too big for a 9 KB script property, so it lives
   in cache under the build it describes. */
function readManifest_() {
  var b = buildVersion_();
  if (!b) return null;
  var s = cache_().get('sw:' + b + ':man');
  if (s) { try { return JSON.parse(s); } catch (e) {} }
  return null;
}

function ensureManifest_() {
  var m = readManifest_();
  /* A manifest built under a different tab list describes a sheet we are no
     longer configured to read. Rebuilding is the only honest answer. */
  if (m && m.cfgSig === cfgSig_()) return m;
  buildSnapshot_(true);                 // cold cache, or the configuration moved
  m = readManifest_();
  if (!m) throw new Error('snapshot build failed - run setup() once from the editor');
  return m;
}

/* ========================================================================== */
/*  SNAPSHOT BUILDER                                                          */
/*  Runs on a trigger, never inside a user request.                           */
/* ========================================================================== */

function buildSnapshot_(force) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'another build is running' };

  var t0 = Date.now();
  try {
    if (!force && readManifest_()) return { ok: true, skipped: true };

    var v  = version_();                 // the data version this build captures
    var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
    var tz = ss.getSpreadsheetTimeZone();
    var sheets = ss.getSheets();

    var man = { v: v, built: Date.now(), tz: tz, cfgSig: cfgSig_(),
                config: readConfig_(), tabs: [], chunks: [], stats: [] };
    var puts = {}, pieces = [];

    for (var i = 0; i < CFG.TABS.length; i++) {
      var spec = CFG.TABS[i];
      var sheet = matchSheet_(sheets, spec);
      if (!sheet) { man.stats.push({ spec: String(spec.match), found: false }); continue; }

      var built = buildTab_(sheet, spec, tz);
      if (!built) { man.stats.push({ name: sheet.getName(), found: true, rows: 0 }); continue; }

      /* slice this tab's rows into cache-sized pieces */
      var parts = sliceRows_(built.rows);
      for (var pi = 0; pi < parts.length; pi++) {
        puts['sw:' + v + ':' + built.key + ':' + pi] = parts[pi].json;
        pieces.push({ t: built.key, p: pi, bytes: parts[pi].json.length });
      }

      man.tabs.push({
        key: built.key, name: built.name, index: built.index, gid: built.gid,
        headers: built.headers, idx: built.idx,
        /* keep = the sheet column index behind each payload column. idx is the
           same list but only where the client needs it (full-width reference
           tabs); keep is always present, because delta has to rebuild a single
           row from the live sheet and must line it up the same way.          */
        keep: built.keep,
        who: built.who,                       // payload positions shortened by shortWho_
        sumCols: built.sumCols,
        rowCount: built.rows.length, parts: parts.length,
        /* set only on a tab with a formula's blank tail: heartbeat must then
           count entries by the Timestamp column, not by getLastRow() */
        tail: built.tail ? { tsCol: built.tsCol } : undefined
      });

      man.stats.push({
        name: built.name, found: true, rows: built.rows.length,
        summed: built.sumIdx ? built.sumIdx.map(function (i) {
          return colLetter_(i) + ' "' + (built.fullHead[i] || '') + '" ' +
                 (built.headerBg ? built.headerBg[i] : '');
        }) : undefined,
        headerFills: built.headerBg || undefined,
        cols: built.idx ? built.idx.length : built.headers.length,
        width: built.headers.length, bytes: built.bytes,
        sparse: !!built.idx, picked: built.pickedLetters || null
      });

      built = null; parts = null;   // let the sheet data go before the next tab
    }

    /* Pack the cache pieces into browser-sized requests. A request may span
       several small tabs - what costs time is the round trip, not the bytes,
       so twelve tiny tabs must not become twelve requests.                   */
    man.chunks = packChunks_(pieces);

    man.buildMs = Date.now() - t0;
    puts['sw:' + v + ':man'] = JSON.stringify(man);
    putAllChunked_(puts);
    props_().setProperty('SW_BUILD', v);          // the snapshot now represents v
    cacheConfigCopy_(man);
    props_().setProperty('SW_BUILT', String(man.built));

    return { ok: true, v: v, buildMs: man.buildMs, tabs: man.stats };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Greedy pack of storage pieces into wire chunks, keeping each tab's pieces
 * contiguous and in order. Returns [{i, items:[{t,a,b}]}].
 */
function packChunks_(pieces) {
  var chunks = [], cur = [], acc = 0;
  function flush() {
    if (!cur.length) return;
    chunks.push({ i: chunks.length, items: cur });
    cur = []; acc = 0;
  }
  for (var i = 0; i < pieces.length; i++) {
    var pc = pieces[i];
    if (acc && acc + pc.bytes > CFG.WIRE_BYTES) flush();
    var tail = cur.length ? cur[cur.length - 1] : null;
    if (tail && tail.t === pc.t && tail.b === pc.p - 1) tail.b = pc.p;
    else cur.push({ t: pc.t, a: pc.p, b: pc.p });
    acc += pc.bytes;
  }
  flush();
  return chunks;
}

/* CacheService.putAll caps out well below a full snapshot, so post in batches */
function putAllChunked_(obj) {
  var c = cache_(), batch = {}, n = 0;
  for (var k in obj) {
    batch[k] = obj[k]; n++;
    if (n >= 25) { c.putAll(batch, CFG.CACHE_TTL); batch = {}; n = 0; }
  }
  if (n) c.putAll(batch, CFG.CACHE_TTL);
}

function matchSheet_(sheets, spec) {
  for (var i = 0; i < sheets.length; i++) {
    if (spec.match.test(String(sheets[i].getName()).trim())) return sheets[i];
  }
  return null;
}

/**
 * Reads one tab and returns it in columnar form.
 *   headers : full header row (keepWidth tabs) or the filtered set
 *   idx     : which header positions the row arrays carry (omitted = all)
 *   rows    : array of arrays, strings only
 */
function buildTab_(sheet, spec, tz) {
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return null;

  var head = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) {
    return String(h == null ? '' : h).trim();
  });

  var n = lastRow - 1;
  var dv = n > 0 ? sheet.getRange(2, 1, n, lastCol).getDisplayValues() : [];

  /* A form tab whose ARRAYFORMULA spills to the bottom of the grid (Batching
     column C shows "" on every empty row) makes getLastRow() the grid's last
     row - hundreds of blank rows under the newest entry. Those trailing blank
     rows are dropped, so rowCount is the real entry count and the rows the
     forms app appends next are seen as new (heartbeat). Only on tabs with a
     Timestamp column: every entry there has one, so a blank row at the end is
     never an entry. Positions are untouched - only the tail goes. */
  var tsCol = -1;
  for (var h = 0; h < head.length; h++) if (/^timestamp$/i.test(head[h])) { tsCol = h; break; }
  var tail = false;
  if (tsCol >= 0) {
    while (n > 0 && dv[n - 1].every(function (x) { return x === '' || x == null; })) { n--; tail = true; }
    if (tail) dv.length = n;
  }

  /* On the summary tabs a date can be shown as "2-Sep-26", which the day-first
     check below never sees. These tabs are small, so every real Date cell is
     rewritten from its underlying value rather than from how it is displayed. */
  if (spec.forceDates && n > 0) {
    var raw = sheet.getRange(2, 1, n, lastCol).getValues();
    for (var fr = 0; fr < n; fr++)
      for (var fc = 0; fc < lastCol; fc++)
        if (raw[fr][fc] instanceof Date) dv[fr][fc] = fmtDate_(raw[fr][fc], tz);
    raw = null;
  }

  /* --- date normalisation ------------------------------------------------
     The dashboard's parseDateTime is day-first: 07/05/2026 is 7 May. A sheet
     in a US locale displays 7 May as 05/07/2026 and every date in the app
     silently shifts. Any column that displays as d/m/y is checked, and rewritten
     from the underlying Date object when the sheet is not day-first.          */
  var dateCols = [];
  for (var c = 0; c < lastCol; c++) {
    if (looksDated_(dv, c)) dateCols.push(c);
  }
  if (dateCols.length && n > 0 && !dayFirst_(dv, dateCols)) {
    for (var d = 0; d < dateCols.length; d++) {
      var col = dateCols[d];
      var vals = sheet.getRange(2, col + 1, n, 1).getValues();
      for (var r = 0; r < n; r++) {
        var val = vals[r][0];
        if (val instanceof Date) dv[r][col] = fmtDate_(val, tz);
      }
    }
  }

  /* --- the two ORANGE headers name the columns to sum -------------------- */
  var headerBg = null, sumCols = null, built_sumIdx = null;
  if (spec.headerColors) {
    headerBg = sheet.getRange(1, 1, 1, lastCol).getBackgrounds()[0];
    var manual = CFG.SUMMARY_COLS[tabKey_(sheet.getName())];
    var idxs = manual ? manual.map(colIdx_) : orangeCols_(headerBg);
    /* Sent as header NAMES, not indices: the client receives a filtered header
       list, so a raw sheet-column index would land on the wrong column. */
    sumCols = idxs.map(function (i) { return head[i]; }).filter(Boolean);
    built_sumIdx = idxs;
  }

  /* --- which columns travel --------------------------------------------- */
  var keep, picked = null;
  if (spec.keepWidth) {
    keep = pickReferenceCols_(head, dv, spec.cols || []);
    picked = keep.map(colLetter_);
  } else {
    keep = [];
    for (var k = 0; k < lastCol; k++) {
      if (!head[k]) continue;                 // unnamed column: nothing reads it
      if (dropped_(head[k])) continue;
      if (spec.only && !matchesAny_(spec.only, head[k])) continue;
      keep.push(k);
    }
  }

  /* --- emit --------------------------------------------------------------- */
  var headersOut, idxOut;
  if (spec.keepWidth) {
    headersOut = head;                        // full width, positions intact
    idxOut = keep;
  } else if (keep.length === lastCol) {
    headersOut = head;
    idxOut = null;
  } else {
    headersOut = keep.map(function (i) { return head[i]; });
    idxOut = null;
  }

  /* Every row travels, blank ones included: the delta merge addresses rows by
     position, so payload index must stay equal to sheetRow - 2. getLastRow()
     already excludes trailing empties, so this only keeps interior gaps.      */
  var who = whoCols_(head, keep);
  var rows = [], bytes = 0;
  for (var rr = 0; rr < n; rr++) {
    var srcRow = dv[rr], out = new Array(keep.length);
    for (var kk = 0; kk < keep.length; kk++) {
      var cell = srcRow[keep[kk]];
      out[kk] = (cell == null) ? '' : String(cell);
      if (who[kk]) out[kk] = shortWho_(out[kk]);
    }
    rows.push(out);
  }
  bytes = JSON.stringify(rows).length;

  return {
    key: tabKey_(sheet.getName()), name: sheet.getName(),
    index: sheet.getIndex() - 1, gid: String(sheet.getSheetId()),
    headers: headersOut, idx: idxOut, keep: keep, who: who, rows: rows, bytes: bytes,
    pickedLetters: picked, headerBg: headerBg, sumCols: sumCols,
    sumIdx: built_sumIdx, fullHead: spec.headerColors ? head : null,
    tsCol: tsCol, tail: tail
  };
}

/**
 * For the two tabs the dashboard addresses by column letter, work out which
 * columns must travel so resolveCodeCol() behaves exactly as it would against
 * the untouched sheet:
 *   - the letters pinned in SHEET_RULES (C / AE,AF,AI,AJ)
 *   - every column that actually holds slab codes (its fallback scan)
 *   - the column immediately left of each of those (where the bundle id lives)
 */
function pickReferenceCols_(head, dv, letters) {
  var want = {}, i;
  for (i = 0; i < letters.length; i++) want[colIdx_(letters[i])] = true;

  var sample = Math.min(dv.length, 200);
  for (var c = 0; c < head.length; c++) {
    var hits = 0;
    for (var r = 0; r < sample; r++) {
      var v = String(dv[r][c] == null ? '' : dv[r][c]).trim();
      if (v && SLAB_CODE.test(v)) { hits++; if (hits >= 3) break; }
    }
    if (hits >= 3) { want[c] = true; if (c > 0) want[c - 1] = true; }
  }

  var out = [];
  for (var key in want) out.push(+key);
  out.sort(function (a, b) { return a - b; });
  return out;
}

function looksDated_(dv, c) {
  var sample = Math.min(dv.length, 60), hits = 0;
  for (var r = 0; r < sample; r++) {
    var v = String(dv[r][c] == null ? '' : dv[r][c]).trim();
    if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(v)) { hits++; if (hits >= 3) return true; }
  }
  return false;
}

/* true  -> the sheet already displays d/m/y (leave it alone)
   false -> m/d/y or too ambiguous to trust (rewrite from the Date object)    */
function dayFirst_(dv, cols) {
  for (var i = 0; i < cols.length; i++) {
    var c = cols[i], lim = Math.min(dv.length, 400);
    for (var r = 0; r < lim; r++) {
      var m = String(dv[r][c] == null ? '' : dv[r][c]).match(/^(\d{1,2})\/(\d{1,2})\/\d{4}/);
      if (!m) continue;
      if (+m[1] > 12) return true;    // 25/06 - can only be day-first
      if (+m[2] > 12) return false;   // 06/25 - can only be month-first
    }
  }
  return false;                       // ambiguous: normalise, it is free
}

function fmtDate_(d, tz) {
  if (d.getFullYear() < 1900) return Utilities.formatDate(d, tz, 'HH:mm:ss');  // time-only cell
  return Utilities.formatDate(d, tz, 'dd/MM/yyyy HH:mm:ss');
}

/**
 * Header cells filled ORANGE mark the columns whose values are summed.
 *
 * These sheets use yellow for ordinary headers, so the test has to separate
 * orange from yellow. Both are red-dominant with little blue; what splits them
 * is the green channel — yellow's sits almost level with its red (#FFD966 is
 * 0.85), orange's is roughly half (#ED7D31 is 0.53).
 */
function orangeCols_(bg) {
  var out = [];
  for (var i = 0; i < bg.length; i++) {
    var c = hexRgb_(bg[i]);
    if (!c) continue;
    var r = c[0], g = c[1], b = c[2];
    if (r < 170) continue;                 // too dark to be a highlight
    if (b > r * 0.62) continue;            // too much blue: pink, grey, white
    var ratio = g / (r || 1);
    if (ratio >= 0.28 && ratio <= 0.80) out.push(i);   // 0.80+ would be yellow
  }
  return out;
}
function hexRgb_(s) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
  if (!m) return null;
  var n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function matchesAny_(pats, h) {
  for (var i = 0; i < pats.length; i++) if (pats[i].test(h)) return true;
  return false;
}

function dropped_(h) {
  for (var i = 0; i < CFG.DROP_HEADERS.length; i++) if (CFG.DROP_HEADERS[i].test(h)) return true;
  return false;
}

/* {payload position: true} for every kept column that records who filled the row. */
function whoCols_(head, keep) {
  var out = {};
  for (var k = 0; k < keep.length; k++) {
    if (matchesAny_(CFG.WHO_HEADERS, String(head[keep[k]] || ''))) out[k] = true;
  }
  return out;
}

/* "rahul@ggminerals.com" -> "rahul"; a username passes through untouched. */
function shortWho_(v) {
  var at = v.indexOf('@');
  return at > 0 ? v.slice(0, at) : v;
}

/* Must match the dashboard's own key derivation exactly. */
function tabKey_(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function colIdx_(letter) {
  var n = 0, s = String(letter).toUpperCase();
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}
function colLetter_(i) {
  var s = '', x = i;
  while (true) { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; if (x < 0) break; }
  return s;
}

/* Slice rows into pieces that fit a cache entry. Each piece is stored as the
   JSON text of an array of row-arrays, so serving is pure concatenation.      */
function sliceRows_(rows) {
  var parts = [], buf = [], size = 2;
  for (var i = 0; i < rows.length; i++) {
    var s = JSON.stringify(rows[i]);
    if (buf.length && size + s.length + 1 > CFG.STORE_BYTES) {
      parts.push({ json: '[' + buf.join(',') + ']', rows: buf.length });
      buf = []; size = 2;
    }
    buf.push(s); size += s.length + 1;
  }
  if (buf.length) parts.push({ json: '[' + buf.join(',') + ']', rows: buf.length });
  if (!parts.length) parts.push({ json: '[]', rows: 0 });
  return parts;
}

/* ========================================================================== */
/*  SERVING                                                                   */
/* ========================================================================== */

function metaJson_() {
  var m = ensureManifest_();
  var tabs = m.tabs.map(function (t) {
    return { key: t.key, name: t.name, index: t.index, gid: t.gid,
             headers: t.headers, idx: t.idx, rowCount: t.rowCount,
             sumCols: t.sumCols };
  });                                   // `keep` and `parts` stay server-side
  return JSON.stringify({
    ok: true, v: m.v, cur: version_(), built: m.built, ping: CFG.PING_MS,
    config: m.config, defectAreas: DEFECT_AREAS, designNames: DESIGN_NAMES,
    tabs: tabs, chunks: m.chunks
  });                                   // cur > v means "snapshot is a moment behind" 
}

function chunkJson_(i, retried) {
  var m = ensureManifest_(), v = m.v;
  var ch = (m.chunks || [])[i];
  if (!ch) return '{"ok":false,"error":"no chunk ' + i + '"}';

  var keys = [];
  ch.items.forEach(function (it) {
    for (var p = it.a; p <= it.b; p++) keys.push('sw:' + v + ':' + it.t + ':' + p);
  });

  var got = cache_().getAll(keys);
  for (var q = 0; q < keys.length; q++) {
    if (got[keys[q]] == null) {                 // evicted: rebuild once, retry once
      if (retried) return '{"ok":false,"error":"chunk missing after rebuild","v":"' + v + '"}';
      buildSnapshot_(true);
      return chunkJson_(i, true);
    }
  }

  var out = [], k = 0;
  ch.items.forEach(function (it) {
    var body = [];
    for (var p = it.a; p <= it.b; p++) {
      var s = got[keys[k++]].slice(1, -1);      // strip the [ ]
      if (s) body.push(s);
    }
    out.push('{"t":"' + it.t + '","a":' + it.a + ',"rows":[' + body.join(',') + ']}');
  });

  return '{"ok":true,"v":"' + v + '","i":' + i + ',"parts":[' + out.join(',') + ']}';
}

/* The shape the UNPATCHED dashboard expects: rows as objects, one request.
   Still served from the snapshot, so it skips the read+stringify cost.        */
function legacyJson_() {
  var m = ensureManifest_(), v = m.v, out = [];
  for (var i = 0; i < m.tabs.length; i++) {
    var t = m.tabs[i], keys = [];
    for (var p = 0; p < t.parts; p++) keys.push('sw:' + v + ':' + t.key + ':' + p);
    var got = cache_().getAll(keys), rows = [];
    for (var q = 0; q < keys.length; q++) {
      var s = got[keys[q]];
      if (s == null) { buildSnapshot_(true); return legacyJson_(); }
      rows = rows.concat(JSON.parse(s));
    }
    out.push({
      key: t.key, name: t.name, index: t.index, gid: t.gid,
      headers: t.headers, rows: hydrate_(t, rows), rowCount: rows.length
    });
  }
  return JSON.stringify({ ok: true, v: v, tabs: out, config: m.config });
}

function hydrate_(t, rows) {
  var H = t.headers, idx = t.idx, out = new Array(rows.length);
  for (var r = 0; r < rows.length; r++) {
    var a = rows[r], o = {};
    for (var c = 0; c < a.length; c++) {
      var val = a[c]; if (val === '') continue;
      var h = idx ? H[idx[c]] : H[c];
      if (h) o[h] = val;
    }
    out[r] = o;
  }
  return out;
}

/* ========================================================================== */
/*  DELTA  (built now, dormant until CFG.PING_MS is non-zero)                  */
/* ========================================================================== */

function delta_(since) {
  var m = ensureManifest_();
  var cur = version_();                          // may be ahead of the snapshot
  var from = seq_(since), now = seq_(cur);

  if (!since || from < 0 || from > now) return { ok: true, v: cur, full: true };
  if (from === now) return { ok: true, v: cur, tabs: {} };

  var log = readDeltaLog_();

  /* Older than the log keeps: the client may have missed trimmed entries. */
  if (log.length && from < log[0].v - 1) return { ok: true, v: cur, full: true };

  /* Every bump appends something - a row entry, or a '*' meaning "this change
     cannot be expressed as rows". If nothing in the log covers the gap, the
     client is missing something we cannot name, so it reloads properly rather
     than being told it is up to date when it is not. */
  var seen = {}, touched = {}, covered = false, count = 0;
  for (var i = 0; i < log.length; i++) {
    if (log[i].v <= from) continue;
    covered = true;
    if (log[i].t === '*') return { ok: true, v: cur, full: true };
    var id = log[i].t + ':' + log[i].r;
    if (seen[id]) continue;
    seen[id] = true;
    count++;
    (touched[log[i].t] || (touched[log[i].t] = [])).push(log[i].r);
  }
  if (!covered) return { ok: true, v: cur, full: true };

  /* Past a certain size a delta stops being cheaper than a chunked reload -
     each row costs a round trip to the sheet. */
  if (count > CFG.DELTA_MAX_ROWS) return { ok: true, v: cur, full: true };
  if (!count) return { ok: true, v: cur, tabs: {}, config: m.config };

  var ss = SpreadsheetApp.openById(CFG.SHEET_ID), tz = ss.getSpreadsheetTimeZone();
  var byKey = {};
  m.tabs.forEach(function (t) { byKey[t.key] = t; });

  var outTabs = {};
  for (var key in touched) {
    var meta = byKey[key]; if (!meta) continue;
    var sheet = ss.getSheetByName(meta.name); if (!sheet) continue;

    var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    var wanted = touched[key].filter(function (r) { return r >= 2 && r <= lastRow; })
                             .sort(function (a, b) { return a - b; });
    if (!wanted.length) continue;

    /* One block read covering the touched rows beats one read per row whenever
       the edits are near each other, which appended form rows always are. */
    var lo = wanted[0], hi = wanted[wanted.length - 1], span = hi - lo + 1;
    var disp, vals;
    if (span <= wanted.length * 4 + 8) {
      disp = sheet.getRange(lo, 1, span, lastCol).getDisplayValues();
      vals = sheet.getRange(lo, 1, span, lastCol).getValues();
    }

    var take = meta.keep || meta.idx || rangeArr_(meta.headers.length);
    var rowsOut = [];
    for (var w = 0; w < wanted.length; w++) {
      var sr = wanted[w], d, vv;
      if (disp) { d = disp[sr - lo]; vv = vals[sr - lo]; }
      else {
        d = sheet.getRange(sr, 1, 1, lastCol).getDisplayValues()[0];
        vv = sheet.getRange(sr, 1, 1, lastCol).getValues()[0];
      }
      for (var c = 0; c < d.length; c++) if (vv[c] instanceof Date) d[c] = fmtDate_(vv[c], tz);
      var cells = [];
      for (var k = 0; k < take.length; k++) {
        var cell = d[take[k]];
        cell = cell == null ? '' : String(cell);
        cells.push(meta.who && meta.who[k] ? shortWho_(cell) : cell);
      }
      rowsOut.push({ i: sr - 2, cells: cells });
    }
    if (rowsOut.length) outTabs[key] = rowsOut;
  }
  return { ok: true, v: cur, tabs: outTabs, config: m.config };
}

function rangeArr_(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }

function readDeltaLog_() {
  var s = props_().getProperty('SW_DELTA');
  if (!s) return [];
  try { return JSON.parse(s); } catch (e) { return []; }
}

/* A script property tops out at 9 KB, so the log is trimmed by BYTES, not just
   by entry count. Losing the oldest entries is safe - a client that far behind
   is told to reload. */
function writeDeltaLog_(log) {
  if (log.length > CFG.DELTA_KEEP) log = log.slice(log.length - CFG.DELTA_KEEP);
  var s = JSON.stringify(log);
  while (s.length > 8000 && log.length > 1) {
    log = log.slice(Math.ceil(log.length / 4));
    s = JSON.stringify(log);
  }
  props_().setProperty('SW_DELTA', s);
}

function noteChange_(sheetName, firstRow, numRows) {
  var spec = null;
  for (var i = 0; i < CFG.TABS.length; i++) {
    if (CFG.TABS[i].match.test(String(sheetName).trim())) { spec = CFG.TABS[i]; break; }
  }
  if (!spec) return;                              // a tab the dashboard never sees

  var log = readDeltaLog_();
  var n = seq_(bump_());
  var key = tabKey_(sheetName);
  var rows = Math.min(numRows || 1, CFG.DELTA_MAX_ROWS + 1);
  for (var r = 0; r < rows; r++) log.push({ v: n, t: key, r: firstRow + r });
  writeDeltaLog_(log);
  props_().setProperty('SW_DIRTY', '1');
}

/* "Something changed that cannot be described as a list of rows." */
function noteFullChange_() {
  var log = readDeltaLog_();
  log.push({ v: seq_(bump_()), t: '*', r: 0 });
  writeDeltaLog_(log);
  props_().setProperty('SW_DIRTY', '1');
}

function onFormSubmitTrigger(e) {
  try {
    if (!e || !e.range) return;
    noteChange_(e.range.getSheet().getName(), e.range.getRow(), e.range.getNumRows());
  } catch (err) { console.warn('onFormSubmit: ' + err); }
}

function onEditTrigger(e) {
  try {
    if (!e || !e.range) return;
    noteChange_(e.range.getSheet().getName(), e.range.getRow(), e.range.getNumRows());
  } catch (err) { console.warn('onEdit: ' + err); }
}

/**
 * The row of the newest entry on a tab whose formula fills the grid: the last
 * filled cell of its Timestamp column. One read when getLastRow() already
 * names a real entry, two when it lands on the formula's tail.
 */
function realLastRow_(sh, tsCol, last) {
  if (last < 2) return last;
  var cell = sh.getRange(last, tsCol + 1);
  if (String(cell.getValue()) !== '') return last;
  return cell.getNextDataCell(SpreadsheetApp.Direction.UP).getRow();
}

/**
 * Keeps the cache warm, folds pending edits in, and catches changes the
 * triggers never saw - rows written by another script, an import, or an edit
 * made while triggers were disabled - by comparing row counts. Cheap: one
 * getLastRow() per allowlisted tab (plus one or two reads on a tab whose
 * formula fills the grid - see realLastRow_).
 *
 * Rows the forms app appends fire no trigger, so this is how they arrive. They
 * are noted as row deltas - open dashboards fetch just those rows through
 * ?api=delta - and the full snapshot is rebuilt at most every
 * CFG.REBUILD_EVERY_MS, or once CFG.REBUILD_AT_ROWS rows are waiting. It used
 * to rebuild on every change, i.e. every minute of every shift, re-reading
 * every tab of New Base in full each time; the forms app's saves queued behind
 * those reads. A tab that SHRANK (a row deleted) still rebuilds at once, since
 * that cannot be described as new rows.
 */
function heartbeat() {
  var p = props_();

  var m = readManifest_();
  if (!m) { p.deleteProperty('SW_DIRTY'); buildSnapshot_(true); return; }   // cache went cold overnight
  /* A tab added to CFG.TABS is in no manifest yet, so the row-count walk below
     can never notice it. Catch it here instead of six hours later. */
  if (m.cfgSig !== cfgSig_()) { p.deleteProperty('SW_DIRTY'); buildSnapshot_(true); return; }

  try {
    var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
    var seen = readSeen_(m), grew = false;
    for (var i = 0; i < m.tabs.length; i++) {
      var t = m.tabs[i];
      var sh = ss.getSheetByName(t.name);
      if (!sh) continue;
      var now = Math.max(0, sh.getLastRow() - 1), was = seen.counts[t.key];
      if (was === undefined) was = t.rowCount;
      if (t.tail) {
        /* getLastRow() is the bottom of the grid here and never moves when a
           row is added; the last Timestamp does. A deletion on such a tab is
           not caught here (it would need a full read); the next rebuild
           takes care of it. */
        now = Math.max(was, realLastRow_(sh, t.tail.tsCol, now + 1) - 1);
      }
      if (now < was) {                            // a row deleted: reload cleanly
        noteFullChange_();
        p.deleteProperty('SW_DIRTY');
        buildSnapshot_(true);
        return;
      }
      if (now > was) {
        noteChange_(t.name, was + 2, now - was);  // sheet rows of the new data rows
        seen.counts[t.key] = now;
        grew = true;
      }
    }
    if (grew) p.setProperty('SW_SEEN', JSON.stringify(seen));
  } catch (e) { console.warn('heartbeat: ' + e); }

  if (p.getProperty('SW_DIRTY') === '1') {
    var age = Date.now() - Number(p.getProperty('SW_BUILT') || 0);
    if (age >= CFG.REBUILD_EVERY_MS || deltaRowsSince_(m.v) >= CFG.REBUILD_AT_ROWS) {
      p.deleteProperty('SW_DIRTY');
      buildSnapshot_(true);
    }
  }
}

/* The row counts the heartbeat has already turned into deltas, for the
   snapshot currently built. A new build starts from its own counts. */
function readSeen_(m) {
  var s = null;
  try { s = JSON.parse(props_().getProperty('SW_SEEN') || 'null'); } catch (e) {}
  if (!s || s.v !== m.v || !s.counts) s = { v: m.v, counts: {} };
  return s;
}

/* Delta rows recorded since snapshot version v - what a dashboard opening now
   would have to fetch on top of the snapshot. */
function deltaRowsSince_(v) {
  var from = seq_(v), n = 0;
  readDeltaLog_().forEach(function (e) { if (seq_(e.v) > from) n++; });
  return n;
}

/* ========================================================================== */
/*  CONFIG TAB                                                                */
/* ========================================================================== */

function configSheet_() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(CFG.CONFIG_TAB);
  if (!sh) {
    sh = ss.insertSheet(CFG.CONFIG_TAB);
    sh.getRange('A1').setValue(JSON.stringify(DEFAULT_CONFIG));
    sh.hideSheet();
  }
  return sh;
}

/**
 * A config saved before a new tab existed has no opinion about it, and a
 * top-level merge would never add one - the `roles` key is already present, so
 * a new role would be silently dropped and the tab would appear on the rail.
 * Missing SUB-keys of roles and names are filled in too; anything the user has
 * actually set is left exactly as they set it.
 */
function readConfig_() {
  try {
    var raw = String(configSheet_().getRange('A1').getValue() || '');
    var c = raw ? JSON.parse(raw) : {};
    for (var k in DEFAULT_CONFIG) if (!(k in c)) c[k] = DEFAULT_CONFIG[k];
    ['roles', 'names'].forEach(function (key) {
      var def = DEFAULT_CONFIG[key] || {};
      c[key] = c[key] || {};
      for (var sub in def) if (!(sub in c[key])) c[key][sub] = def[sub];
    });
    return c;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function writeConfig_(cfg) {
  configSheet_().getRange('A1').setValue(JSON.stringify(cfg || {}));
}

/* ========================================================================== */
/*  MATERIAL PRICES                                                           */
/* ========================================================================== */
/*
 * One rupee-per-kilogram figure per material and supplier code, shared by
 * everyone who opens the dashboard.
 *
 * Deliberately NOT part of the snapshot. The snapshot is a cached photograph
 * of the sheet rebuilt on a trigger, and a price typed into the Costing tab
 * has to change every table on the page in the same second - not after the
 * next build. So prices are their own small read and their own small write,
 * cached for half a minute so a page that re-reads them costs nothing.
 *
 * Four columns, and the last two are there so an argument about a number has
 * an answer:
 *
 *     Material | Supplier Code | Price per kg | Updated
 *
 * SILANE and TIO2 have no supplier code on any form, so they are stored under
 * the code "-" and priced as one flat rate each. WHITEPASTE is never stored:
 * it is 67% resin and 33% TiO2 and is computed from those two on the client,
 * so a resin price can never disagree with the whitepaste made from it.
 */
var PRICE_CACHE_KEY = 'sw:prices';

function pricesSheet_() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(CFG.PRICES_TAB);
  if (!sh) {
    sh = ss.insertSheet(CFG.PRICES_TAB);
    sh.getRange(1, 1, 1, 4)
      .setValues([['Material', 'Supplier Code', 'Price per kg', 'Updated']])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 120);
    sh.setColumnWidth(2, 220);
    sh.setColumnWidth(3, 110);
    sh.setColumnWidth(4, 170);
  }
  return sh;
}

/** "GRIT|QG4CV" - one key, so the client never has to join two fields. */
function priceKey_(material, code) {
  return String(material || '').trim().toUpperCase() + '|' +
         String(code === '' || code == null ? '-' : code).trim();
}

function readPrices_() {
  var hit = cache_().get(PRICE_CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var sh = pricesSheet_();
  var out = { ok: true, prices: {}, updated: {} };
  var last = sh.getLastRow();
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, 4).getValues();
    for (var i = 0; i < vals.length; i++) {
      var mat = String(vals[i][0] || '').trim();
      if (!mat) continue;
      var n = Number(vals[i][2]);
      if (!isFinite(n)) continue;
      var k = priceKey_(mat, vals[i][1]);
      out.prices[k] = n;
      out.updated[k] = vals[i][3] instanceof Date
        ? vals[i][3].toISOString() : String(vals[i][3] || '');
    }
  }
  try { cache_().put(PRICE_CACHE_KEY, JSON.stringify(out), 30); } catch (e) {}
  return out;
}

/**
 * Rewrites the tab from the map the client sends.
 *
 * A whole rewrite rather than a per-row patch, and under the script lock: two
 * people editing prices at the same moment is a real thing on a shift change,
 * and a half-applied price list is worse than a late one. The client always
 * sends the complete map it is holding, so a rewrite is exactly what it means.
 *
 * A key the client omits is a price deleted on purpose. A key it sends with a
 * blank or non-numeric value is the same thing - an emptied input box.
 */
function writePrices_(prices, who) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'another save is running' };
  try {
    var rows = [], stamp = new Date();
    var keys = Object.keys(prices || {}).sort();
    for (var i = 0; i < keys.length; i++) {
      var n = Number(prices[keys[i]]);
      if (!isFinite(n) || prices[keys[i]] === '' || prices[keys[i]] === null) continue;
      var bits = String(keys[i]).split('|');
      rows.push([bits[0] || '', bits[1] === undefined ? '-' : bits[1], n, stamp]);
    }

    var sh = pricesSheet_();
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, 4).clearContent();
    if (rows.length) {
      sh.getRange(2, 1, rows.length, 4).setValues(rows);
      sh.getRange(2, 3, rows.length, 1).setNumberFormat('0.00');
      sh.getRange(2, 4, rows.length, 1).setNumberFormat('dd/MM/yyyy HH:mm');
    }
    try { cache_().remove(PRICE_CACHE_KEY); } catch (e) {}
    return { ok: true, rows: rows.length, at: stamp.toISOString(), who: String(who || '') };
  } finally {
    lock.releaseLock();
  }
}

function cacheConfigCopy_(man) {
  try {
    var sh = configSheet_();
    sh.getRange('A2').setValue('built ' + new Date(man.built).toISOString() +
      ' · ' + man.tabs.length + ' tabs · ' + man.buildMs + ' ms · ' + man.v);
  } catch (e) {}
}

/* ========================================================================== */
/*  DIAGNOSTICS                                                               */
/* ========================================================================== */

function diag_() {
  var m = readManifest_();
  var fresh = !!m;
  if (!m) { buildSnapshot_(true); m = ensureManifest_(); }

  var wire = 0, rows = 0;
  m.tabs.forEach(function (t) { rows += t.rowCount; });

  var probe = m.chunks.length ? chunkJson_(0).length : 0;

  return {
    ok: true,
    version: m.v,
    builtAt: new Date(m.built).toISOString(),
    buildMs: m.buildMs,
    cacheWasWarm: fresh,
    totalRows: rows,
    tabsFound: m.tabs.length,
    tabsConfigured: CFG.TABS.length,
    tabNames: m.tabs.map(function (t) { return t.name; }),
    configMatchesSnapshot: m.cfgSig === cfgSig_(),
    wireChunks: m.chunks.length,
    firstChunkBytes: probe,
    pingMs: CFG.PING_MS,
    config: m.config,
    defectAreas: DEFECT_AREAS,
    designNames: DESIGN_NAMES,
    tabs: m.stats,
    triggers: ScriptApp.getProjectTriggers().map(function (t) {
      return t.getHandlerFunction() + ' / ' + t.getEventType();
    })
  };
}

/* ========================================================================== */
/*  ONE-TIME SETUP                                                            */
/* ========================================================================== */

function setup() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);

  /* A config seeded by an earlier run may reference tab keys that do not exist
     (oven_in vs oven_in_form). Anything the current DEFAULT_CONFIG does not
     recognise is replaced rather than merged. */
  reseedConfigIfStale_();

  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    var h = existing[i].getHandlerFunction();
    if (h === 'onFormSubmitTrigger' || h === 'onEditTrigger' || h === 'heartbeat') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger('onFormSubmitTrigger').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('onEditTrigger').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('heartbeat').timeBased().everyMinutes(1).create();

  var res = buildSnapshot_(true);

  var url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) {}

  console.log('SETUP COMPLETE');
  console.log('web app url : ' + (url || '(deploy first, then re-run setup to see it)'));
  console.log('build       : ' + JSON.stringify(res, null, 2));
  return res;
}

/**
 * Replaces a saved config whose group/optional keys name tabs that are not in
 * the workbook. Anything the user set that still resolves is kept.
 */
function reseedConfigIfStale_() {
  var sh = configSheet_();
  var cur;
  try { cur = JSON.parse(String(sh.getRange('A1').getValue() || '{}')); } catch (e) { cur = {}; }

  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var live = {};
  ss.getSheets().forEach(function (x) { live[tabKey_(x.getName())] = true; });

  var refs = [];
  Object.keys(cur.groups || {}).forEach(function (g) { refs = refs.concat(cur.groups[g] || []); });
  refs = refs.concat(cur.optional || []);

  var stale = refs.some(function (k) { return !live[k]; });
  if (!refs.length || stale) {
    var merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (cur.stageOrder) merged.stageOrder = cur.stageOrder;
    if (cur.haltKeywords) merged.haltKeywords = cur.haltKeywords;
    sh.getRange('A1').setValue(JSON.stringify(merged));
    console.log(stale ? 'config reseeded (it referenced tabs that do not exist)'
                      : 'config seeded');
  }
}

/* Handy from the editor while tuning. */
function rebuildNow() { return buildSnapshot_(true); }
function showDiag()   { console.log(JSON.stringify(diag_(), null, 2)); }