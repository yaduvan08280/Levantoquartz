/**
 * Slabworks Production Forms — configuration
 * ------------------------------------------
 * The only file you should normally need to edit.
 */

var FORMS_CFG = {

  // "New Base" spreadsheet
  SHEET_ID: '1Cy3Li1uXx_wkCcrk893WKK2DLRttKTjrsnafb5DsJbY',

  // Tab that stores app logins (created for you by setupUsersSheet())
  USERS_TAB: 'App Users',

  // Optional audit trail of every web-app submission. '' disables it.
  LOG_TAB: 'App Submission Log',

  // Header names the app must NEVER write into, because a formula owns them.
  // Batching column C ("Slab Numbers") is an ARRAYFORMULA fed by Z and AA, so
  // the app writes only Slab Number (A) / (B) and lets the formula fill C.
  // Any column with a spilled ARRAYFORMULA is also detected automatically.
  NEVER_WRITE: ['Slab Numbers', 'Duplicate Check'],

  // Session lifetime in hours
  SESSION_HOURS: 12,

  // ---- Oven timer -------------------------------------------------------
  // How far back to look for slabs still inside, and how long the computed
  // status is cached (a whole shift of phones polls this).
  OVEN_SCAN_ROWS: 800,
  OVEN_CACHE_SECONDS: 20,

  // "Estimated Curing Time" is read in these units. Oven Out's Total Curing
  // Time is recorded in minutes (65 / 70 / 75 are the common values), so
  // minutes is the matching unit. Set to 'hours' if the operators start
  // entering 3 and 4 instead of 180 and 240.
  OVEN_ESTIMATE_UNIT: 'minutes',

  // Smallest estimate that still starts a timer. Keep this at 1: operators
  // test the countdown with 1 and 2 minute estimates, and a higher value
  // silently swallows exactly those entries. Stale unmatched rows are already
  // handled by OVEN_STALE_HOURS below, which is the real guard.
  OVEN_MIN_MINUTES: 1,

  // Oven Out no longer asks the operator for "Total Curing Time". With this on,
  // the app fills that column itself from the real elapsed time between the
  // Oven In timestamp and the Oven Out one. Set false to leave the column
  // blank instead — but note it holds 500+ rows of history that other sheets
  // and the dashboard may read.
  OVEN_AUTO_TOTAL: true,

  // A slab that went in longer ago than this never got its Oven Out entry —
  // that is a records problem for a supervisor, not a live alarm, and leaving
  // it in would pin a permanent red banner on every oven operator's screen.
  OVEN_STALE_HOURS: 24,

  // How long option lists read from the sheet stay cached (seconds)
  LIST_CACHE_SECONDS: 120,

  // Number format stamped on every Timestamp cell the app writes.
  // The dashboard reads getDisplayValues() and parses day-first, so this must
  // include the time or shift-wise calculations lose it. Matches the format
  // Google Forms itself uses on these tabs.
  TIMESTAMP_FORMAT: 'dd/MM/yyyy HH:mm:ss',

  // Salt mixed into every password hash. CHANGE THIS ONCE, before you
  // create any users, and never change it again (it would invalidate
  // every existing password).
  PASSWORD_PEPPER: 'CHANGE-ME-slabworks-2026',

  APP_TITLE: 'Slabworks Production Forms'
};


/**
 * Where every option list comes from.
 * Sheet-backed lists are read live, so the master data stays in the sheet.
 * col is 1-based; row is the first row of data.
 */
var FORMS_LISTS = {
  // Available slab numbers, per production stage — "Slab Numbers" tab
  slabA:       { tab: 'Slab Numbers', col: 6,  row: 3 },  // F  "A line"
  slabB:       { tab: 'Slab Numbers', col: 7,  row: 3 },  // G  "B line"
  resin:       { tab: 'Slab Numbers', col: 9,  row: 3 },  // I
  mixer:       { tab: 'Slab Numbers', col: 10, row: 3 },  // J
  pressing:    { tab: 'Slab Numbers', col: 11, row: 3 },  // K
  ovenIn:      { tab: 'Slab Numbers', col: 12, row: 3 },  // L
  ovenOut:     { tab: 'Slab Numbers', col: 13, row: 3 },  // M
  vacuum:      { tab: 'Slab Numbers', col: 14, row: 3 },  // N
  trolley:     { tab: 'Slab Numbers', col: 15, row: 3 },  // O
  calibration: { tab: 'Slab Numbers', col: 16, row: 3 },  // P
  qc:          { tab: 'Slab Numbers', col: 17, row: 3 },  // Q

  // Bundles tab.
  //   A  All Bundles       every bundle that exists
  //   B  Available Bundles empty, ready to be FILLED  -> Vacuum Unloader
  //   C  Filled Bundles    holding slabs, ready to be EMPTIED -> Trolley
  bundlesAll:       { tab: 'Bundles', col: 1, row: 2 },   // A
  bundlesAvailable: { tab: 'Bundles', col: 2, row: 2 },   // B
  bundlesFilled:    { tab: 'Bundles', col: 3, row: 2 },   // C

  // unique codes tab
  designCodes: { tab: 'unique codes', col: 5, row: 3 }    // E
};

/*
 * Dispatch candidates are not a column on Slab Numbers — there is no such
 * column, and adding one would mean maintaining a formula. They are derived:
 * every slab Q.C. Final has graded, minus every slab already written into the
 * Dispatch Form tab. That way a slab cannot be dispatched twice, and the list
 * shrinks by itself as containers go out.
 */
/*
 * Grade alerts.
 *
 * GRADES is the one line to change. It is set to B and C because that is what
 * was asked for, but be aware of the volume it implies: across the 5,186 rows
 * in Q.C. Final at the time this was written, B was 1,204 and C was 196 —
 * together 27% of every slab, which is 25 to 40 alerts on a normal day and was
 * 143 on 06/09. If supervisors start muting the bot, narrow this to ['C'] or
 * switch B to the digest below rather than letting every alert age into the
 * unattended list.
 *
 * DIGEST_GRADES are collected instead of alerted: no Telegram, no 3-hour
 * clock, one summary message per shift. Move 'B' here and it stops being an
 * interruption without disappearing from the record. Nothing else changes.
 */
var FORMS_ALERT = {
  GRADES:        ['B', 'C'],
  DIGEST_GRADES: [],
  HOURS:         3,              // how long an alert stays live
  TAB:           'Grade Alerts',
  RESPONSE_TAB:  'Feedback Response',
  SCAN_ROWS:     400,            // QC rows to look back over on each scan

  /* A second way of deciding a row is new, used when the row watermark cannot
     be trusted (see fRaiseNewAlerts_). A QC row timestamped inside this window
     alerts even if the watermark says it has been passed; anything older never
     does, so history is never re-announced. */
  MAX_AGE_HOURS: 12,

  /* How far back the FIRST scan after installation is allowed to look. A slab
     graded shortly before somebody switched alerting on still deserves an
     alert; a week of history does not. */
  INSTALL_GRACE_MINUTES: 120,
  CACHE_SECONDS: 20,

  /* First report closes the alert for everyone. Set false and every
     supervisor can file on the same slab until the clock runs out. */
  FIRST_CLOSES:  true,

  /* Media. Videos are capped hard: a 30-second clip off a modern phone is
     40-60MB and Apps Script refuses a request over 50MB. */
  MAX_PHOTOS_PER_SECTION: 4,
  MAX_VIDEOS_PER_SECTION: 1,
  PHOTO_MAX_EDGE: 1600,          // px, longest side, before upload
  PHOTO_QUALITY:  0.72,          // JPEG
  VIDEO_MAX_SECONDS: 15,
  VIDEO_MAX_MB: 12,
  DRIVE_FOLDER: 'Slabworks Grade Reports',

  /* Telegram. The token is NOT here — it lives in Script Properties, because
     anyone who can read this file can otherwise take over the bot. Set it with
     telegramSetToken('...') once. */
  TELEGRAM_TOKEN_PROP: 'SLABWORKS_TG_TOKEN',
  TELEGRAM_ENABLED: true
};

var FORMS_DISPATCH = {
  qcTab:       'Q.C. Final Form',
  qcSlabCol:   1,    // A  Slab Number
  /* The timestamp is looked up BY HEADER first — see fQcTimeCol_. This number
     is only the fallback for a sheet whose header does not say any of these. */
  qcTimeCol:    2,
  qcTimeHeaders: ['Timestamp', 'Time Stamp', 'Time stamp', 'Date', 'Date & Time',
                  'Date and Time', 'Submitted At'],
  qcGradeCol:  5,    // E  Material Final Grade
  qcFirstRow:  2,

  outTab:      'Dispatch Form',
  outSlabCol:  0,    // 0 = find it by header name (below) rather than by letter
  slabHeaders:  ['Slab Number', 'Slab number', 'Slab No.'],
  gradeHeaders: ['Dispatched Grade', 'Grade'],
  containerHeaders: ['Container No.', 'Container/Truck No', 'Container Number'],

  /* Two audit columns. "Grade Changed" says "changed" on any row where the
     dispatched grade differs from what Q.C. Final recorded, and is left EMPTY
     otherwise — so the column filters to exactly the overrides. "Q.C. Grade"
     carries the original, and only on those rows: repeating it on every row
     would just duplicate the Grade column. */
  changedHeaders: ['Grade Changed'],
  qcGradeHeaders: ['Q.C. Grade', 'QC Grade'],
  changedWord:    'changed',

  cacheSeconds: 120,
  maxSlabs:     20000
};

// Bundles tab: BN01 lives in column D (4), BN02 in E (5), ... BN60 in BK.
var FORMS_BUNDLE_COL0 = 4;
var FORMS_BUNDLE_N = 60;
