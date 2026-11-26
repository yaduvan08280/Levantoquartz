/**
 * Slabworks Production Forms — form definitions
 * ---------------------------------------------
 * Every form is data. The renderer is generic: to change a form, change
 * the object below. To add a form, add an entry to FORM_DEFS.
 *
 * field.type      text | number | time | textarea | radio | select | checkbox
 * field.entry     the Google Forms entry id (number, no "entry." prefix)
 * field.options   a literal list of choices
 * field.source    a key in FORMS_LISTS — read live from the sheet instead
 * field.showWhen  { field: <id>, eq: <value> | in: [values] }
 * field.isSlab    true  -> never carried over by "Fill previous values"
 * field.noPrefill true  -> never carried over by "Fill previous values"
 *
 * form.allowPrefill false -> the form hides the "Fill previous values" bar
 *                            entirely. Use it wherever repeating the previous
 *                            entry would be wrong rather than merely lazy.
 * form.keyField     id of the field that names an entry in History and the
 *                   log, when the form has no slab or bundle.
 * form.dupCheck     false -> History does not flag repeats. Set it on any form
 *                   whose key repeats by design (a shift name, say), or every
 *                   tile turns red and the warning stops meaning anything.
 */

// ---- shared option lists ---------------------------------------------------

var FOPT = {
  GRIT: ['QG4CV', 'QG4AM', 'QG4AR', 'QG4LA', 'QG4KD', 'QG1CV', 'QG1AM', 'QG1AR'],

  FILLER: ['QFDM - 325', 'QFMP -325', 'QFMP - 400', 'QFTM -325', 'QFTM - 400',
           'QFNP - 325', 'QFNP - 400', 'CRISTOBALITE POWDER -325',
           'CRISTOBALITE POWDER - 400', 'QFRP - 325', 'QFRP - 400',
           'QFRR -325', 'QFRR -400', 'QFGR -325', 'QFGR -400','QF5AQ','QF4AQ'],

  SIZE: ['LQS - 3600*2080*36', 'LQS - 3600*2080*26', 'SKS - 3530*2010*36',
         'SKS - 3530*2010*26', 'DSS - 3380*2060*36', 'DSS - 3380*2060*26',
         'RGS - 3275*1655*36', 'RGS - 3275*1655*26'],

  RESIN_SUPPLIER: ['A-ONE', 'OJASWI', 'TANDON', 'SARVARTH', 'RELIANCE','SARVARTH-Y'],

  HARDENER_SUPPLIER: ['TX-21S', 'AKH-98','LP-26A'],

  IBC: (function () {
    var a = [];
    for (var i = 1; i <= 40; i++) a.push('IBC-' + i);
    return a;
  })(),

  DESIGN_CODE: ['LQ-006','LQ-007','LQ-008','LQ-009','LQ-015','LQ-039','LQ-040',
    'LQ-053','LQ-060','LQ-061','LQ-072','LQ-074','LQ-076','LQ-206','LQ-207',
    'LQ-208','LQ-214','LQ-216','LQ-225','LQ-227','LQ-236','LQ-239','LQ-240','LQ-241',
    'LQ-242','LQ-243','LQ-244','LQ-254','LQ-258','LQ-259','LQ-260','LQ-261',
    'LQ-262','LQ-263','LQ-264','LQ-265','LQ-266','LQ-268','LQ-269','LQ-271',
    'LQ-273','LQ-277','LQ-414','LQ-438','LQ-442','LQ-807','LQ-808','LQ-814','LQ-820',
    'LQ-822','LQ-825','LQ-836','LQ-838','LQ-839','LQ-840','LQ-841','LQ-842',
    'LQ-843','LQ-854','LQ-858','LQ-861','LQ-862','LQ-863','LQ-864','LQ-865',
    'LQ-866','Sample'],

  /* Design names and codes offered by the two Production Summary forms.
     Both lists arrived with repeats — 63 lines giving 50 distinct names and
     56 distinct codes — so they are deduplicated here, first occurrence kept,
     order otherwise untouched. A dropdown listing the same option twice is
     just a way to record the same thing two different ways.

     They are NOT paired: the same name is used with two different codes in
     eight cases (CALACATTA SHADOW is LQ-007 and LQ-207, CALACATTA SPONDA GOLD
     is LQ-242 and LQ-442, and six more), so picking a code cannot safely fill
     in the name. The two dropdowns stay independent. */
  SUMMARY_DESIGN_NAME: [
    'CALACATTA BELLA', 'CALACATTA WOW',
    'THASSOS WHITE', 'THASSOS CARRARA',
    'SAMPLE', 'CALACATTA SHADOW','CALACATTA STORM',
    'VENETINO GOLD', 'CALACATTA MOONLIGHT',
    'CALACATTA VENETINO GREY', 'ULTRA WHITE',
    'CALACATTA SPONDA GOLD', 'BIANCO WHITE',
    'CALACATTA TELESTO', 'CALACATTA SPONDA GREY',
    'LINCOIN GOLD', 'LINCOIN GREY',
    'CALACATTA SNOW', 'ESTADOS GREY',
    'ESTADOS GOLD', '(LOW SILICA) PURE WHITE',
    '(LOW SILICA) MOONLIGHT', 'CARRARA GOLD',
    'CALACATTA SHADOW (NATURAL)', 'CALACATTA BLACK TREE',
    'CALACATTA LUNA', 'CALACATTA SUPREME',
    'CALACATTA MISTERIO', 'CALACATTA TUSCANY',
    'CALACATTA RIO', 'CALACATTA CIELO',
    'CALACATTA SPONDA GOLD (NATURAL)', 'CALACATTA TUSCANY GREY',
    'CALACATTA LAZA GOLD', 'BIANCO LYRA',
    'TAJ MAHAL', 'CALACATTA DORADO',
    'CALACATTA RUSTA', 'CALACATTA LAZA GREY',
    'SPARKLE WHITE', 'CALACATTA AZURE',
    'BIANCO CARRARA GREY', 'BIANCO CARRARA GOLD',
    'FLORENCE GREY', 'CALACATTA LUXOR',
    'FLORENCE GOLD', 'BIANCO CARRARA',
    'CALACATTA CALYPSO', 'DYNA GOLD',
    'DYNA BLUE', 'SHIMMER WHITE'
  ],

  SUMMARY_DESIGN_CODE: [
   'LQ-006','LQ-007','LQ-008','LQ-009','LQ-015','LQ-039','LQ-040',
    'LQ-053','LQ-060','LQ-061','LQ-072','LQ-074','LQ-076','LQ-206','LQ-207',
    'LQ-208','LQ-214','LQ-216','LQ-227','LQ-236','LQ-239','LQ-240','LQ-241',
    'LQ-242','LQ-243','LQ-244','LQ-254','LQ-258','LQ-259','LQ-260','LQ-261',
    'LQ-262','LQ-263','LQ-264','LQ-265','LQ-266','LQ-268','LQ-269','LQ-271',
    'LQ-273','LQ-277','LQ-414','LQ-438','LQ-442','LQ-807','LQ-808','LQ-814','LQ-820',
    'LQ-822','LQ-825','LQ-836','LQ-838','LQ-839','LQ-840','LQ-841','LQ-842',
    'LQ-843','LQ-854','LQ-858','LQ-861','LQ-862','LQ-863','LQ-864','LQ-865',
    'LQ-866','Sample'
  ],

  /* Design name <-> design code, from the corrected pairing.
     48 of the 50 names are matched; picking either side fills the other in.

     TWO NAMES ARE DELIBERATELY ABSENT — "CALACATTA SHADOW (NATURAL)" and
     "CALACATTA SPONDA GOLD (NATURAL)". The correction gave LQ-007 to
     CALACATTA SHADOW and LQ-242 to CALACATTA SPONDA GOLD, which are the codes
     the (NATURAL) variants previously carried, and left LQ-207 and LQ-442 with
     no name at all.

     SETTLED, 22/09/2026: leave it exactly as it is. Both (NATURAL) names stay
     on the name dropdown and both freed codes stay on the code dropdown; they
     are simply not paired, so choosing one of them fills nothing in and the
     other half is picked by hand. Do not "tidy" this by guessing that the
     variants inherit the freed codes — the guess would silently repoint every
     future entry, and a name and code that disagree are worse than a field
     somebody has to fill.

     Eight codes are on the dropdown and fill in no name, and stay there for
     the same reason: LQ-207, LQ-442, SET-81, SET-107, SET-108, SET-109,
     SET-112, SET-119. */
  DESIGN_NAME_TO_CODE: {
    '(LOW SILICA) MOONLIGHT': 'SET-105',
    '(LOW SILICA) PURE WHITE': 'SET-82',
    'BIANCO CARRARA': 'LQ-273',
    'BIANCO CARRARA GOLD': 'SET-117',
    'BIANCO CARRARA GREY': 'SET-118',
    'BIANCO LYRA': 'LQ-838',
    'BIANCO WHITE': 'LQ-009',
    'CALACATTA AZURE': 'SET-114',
    'CALACATTA BELLA': 'LQ-241',
    'CALACATTA BLACK TREE': 'LQ-825',
    'CALACATTA CALYPSO': 'LQ-216',
    'CALACATTA CIELO': 'LQ-264',
    'CALACATTA DORADO': 'LQ-268',
    'CALACATTA LAZA GOLD': 'LQ-265',
    'CALACATTA LAZA GREY': 'LQ-266',
    'CALACATTA LUNA': 'LQ-820',
    'CALACATTA LUXOR': 'SET-116',
    'CALACATTA MISTERIO': 'SET-89',
    'CALACATTA MOONLIGHT': 'LQ-254',
    'CALACATTA RIO': 'LQ-015',
    'CALACATTA RUSTA': 'SET-111',
    'CALACATTA SHADOW': 'LQ-007',
    'CALACATTA SNOW': 'LQ-258',
    'CALACATTA SPONDA GOLD': 'LQ-242',
    'CALACATTA SPONDA GREY': 'LQ-243',
    'CALACATTA STORM': 'LQ-277',
    'CALACATTA SUPREME': 'LQ-822',
    'CALACATTA TELESTO': 'LQ-227',
    'CALACATTA TUSCANY': 'LQ-006',
    'CALACATTA TUSCANY GREY': 'LQ-244',
    'CALACATTA VENETINO GREY': 'LQ-259',
    'CALACATTA WOW': 'LQ-208',
    'CARRARA GOLD': 'SET-102',
    'DYNA BLUE': 'SET-120',
    'DYNA GOLD': 'SET-121',
    'ESTADOS GOLD': 'LQ-240',
    'ESTADOS GREY': 'LQ-239',
    'FLORENCE GOLD': 'LQ-074',
    'FLORENCE GREY': 'LQ-072',
    'LINCOIN GOLD': 'LQ-061',
    'LINCOIN GREY': 'LQ-060',
    'SAMPLE': 'SET-99',
    'SHIMMER WHITE': 'LQ-076',
    'SPARKLE WHITE': 'LQ-053',
    'TAJ MAHAL': 'LQ-269',
    'THASSOS CARRARA': 'LQ-236',
    'THASSOS WHITE': 'LQ-214',
    'ULTRA WHITE': 'LQ-261',
    'VENETINO GOLD': 'LQ-260'
  },

  QC_DEFECTS: ['White spots', 'Cavity / Big hole', 'Color dots / spots',
    'Crack / Breakage', 'Cutting / Edge Chipping', 'Contamination/Foreign Material',
    'Over-sized grits', 'Patches', 'Pattern Problem / Blurr',
    'Pin holes / micro-holes', 'Porosity', 'Resin Dot', 'Surface scratch',
    'Low Thickness Issue', 'Vein color / vein line', 'Shade Variation',
    'Paperdeep', 'Bend'],

  CAL_DEFECTS: ['Perfect', 'Paperdeep', 'Bend', 'Low Corner Thickness',
                'Cavity', 'Crack'],

  QC_GRADE: ['A', 'B', 'C', 'A#', 'B#', 'C#', 'Sample', 'E'],

  /* Dispatch grades. Deliberately NOT QC_GRADE: Q.C. Final also records C#
     and Sample, which never leave the plant in a container. A slab whose QC
     grade is outside this list simply arrives with no grade pre-selected. */
  DISPATCH_GRADE: ['A', 'B', 'C', 'E', 'A#', 'B#'],

  /* Grade Reporting. Spelling and order exactly as supplied — these become
     sheet values, and a defect renamed here is a defect that stops matching
     everything recorded before it. */
  DEFECTS: [
    'White spots', 'Cavity / Big hole', 'Color dots / spots', 'Crack / Breakage',
    'Cutting / Edge Chipping', 'Contamination/Foreign Material', 'Over-sized grits',
    'Patches', 'Pattern Problem / Blurr', 'Pin holes / micro-holes', 'Porosity',
    'Resin Dot', 'Surface scratch', 'Low Thickness Issue', 'Vein color / vein line',
    'Shade Variation', 'Paperdeep', 'Bend'
  ],
  AREAS: [
    'Batching', 'Resin/whitepaste', 'Mixer', 'Crafting / Labour Issue', 'Pressing',
    'Rubber Placement', 'Oven', 'Calibration', 'Polish', 'Handling', 'Levelling'
  ],
  /* The escape hatch. Choosing it makes the free-text box required, so nobody
     files "Other" with nothing after it. */
  AREA_OTHER: 'Other — not in this list',

  /* built from DESIGN_NAME_TO_CODE so the two can never disagree */
  DESIGN_CODE_TO_NAME: null,

  numbers: function (from, to) {
    var a = [];
    for (var i = from; i <= to; i++) a.push(String(i));
    return a;
  }
};

/* Bag Form's two lists. Not copies of the grit and filler lists — the same
   arrays, so a supplier added for Batching is in the Bag Form the same day and
   the two can never drift apart. */
FOPT.BAG_MATERIAL  = ['Grit', 'Filler'];
FOPT.BAG_SUPPLIERS = { 'Grit': FOPT.GRIT, 'Filler': FOPT.FILLER };

/* Pressing's moulds: MD01 ... MD45. */
FOPT.MOULD = FOPT.numbers(1, 45).map(function (n) {
  return 'MD' + ('0' + n).slice(-2);
});

FOPT.DESIGN_CODE_TO_NAME = (function () {
  var out = {};
  for (var name in FOPT.DESIGN_NAME_TO_CODE) out[FOPT.DESIGN_NAME_TO_CODE[name]] = name;
  return out;
})();

/* The Formula Form's design-code dropdown.

   Deliberately a static union of the Batching list and the Production Summary
   list rather than the live "unique codes" tab, and the reason is the name <->
   code link. Picking a design name fills the code in, and a filled-in value
   that is not in the field's own list is rejected on submit — so the code list
   has to contain every code DESIGN_NAME_TO_CODE can produce, SET- codes
   included. The live list carries only the LQ- codes, so it cannot be used
   here without the link breaking for a dozen designs. */
FOPT.FORMULA_DESIGN_CODE = (function () {
  var seen = {}, out = [];
  FOPT.DESIGN_CODE.concat(FOPT.SUMMARY_DESIGN_CODE).forEach(function (c) {
    if (!seen[c]) { seen[c] = 1; out.push(c); }
  });
  return out;
})();

function formsUrl_(id) {
  return 'https://docs.google.com/forms/d/e/' + id + '/formResponse';
}

// ---- the forms -------------------------------------------------------------

/* Container Dispatch Details — copied from the Google Form "14. Container
   Dispatch Details" on 25/11/2026, spelling and all ("CARARRA GOLD" and
   "CARRARA GOLD" are both on it), so rows from the app and from the old form
   read the same in the Container Form tab. */
FOPT.CONTAINER_SUPPLIER = ['Stone Empire', 'AGL', 'PK Industries', 'Creative',
  'Hielite', 'Rocks Forever', 'JBB', 'Tripura'];
FOPT.CONTAINER_CLIENT_OTHER = 'Other';
FOPT.CONTAINER_CLIENT = ['ISB \u2013 Houston M', 'ISB \u2013 Atlanta M', 'ISB \u2013 Richmond M',
  'ISB \u2013 Charleston M', 'ISB \u2013 Seattle M', 'ISB \u2013 New York M', 'ISB \u2013 Houston V',
  'ISB \u2013 New York V', 'ISB \u2013 Boston B', 'ISB \u2013 MD B', 'ISB \u2013 New York B',
  'ISB \u2013 Norfolk C', 'ISB \u2013 NY I', 'ISB \u2013 Houston P', 'ISB \u2013 Atlanta P',
  'ISB \u2013 Houston R', 'ISB \u2013 MD VZ', 'ISB \u2013 Florida VZ', 'ISB \u2013 FL M', 'ISB \u2013 FL E',
  'ISB \u2013 IST', 'ISB \u2013 NY T', 'ISB \u2013 NY D', 'ISB \u2013 G', 'ISB \u2013 Chicago R',
  FOPT.CONTAINER_CLIENT_OTHER];
FOPT.CONTAINER_DESIGN = ['(LOW SILICA) MOONLIGHT', '(LOW SILICA) PURE WHITE',
  'ARMANI BIEGE', 'AMAZON CARRARA', 'BIANCO CARRARA', 'BIANCO CARRARA GOLD',
  'BIANCO CARRARA GREY', 'BIANCO LYRA', 'BIANCO FLORA', 'BIANCO WHITE',
  'CALACATTA AZURE', 'CALACATTA BELLA', 'CALACATTA BLACK TREE', 'CALACATTA CALYPSO',
  'CALACATTA CIELO', 'CALACATTA DORADO', 'CALACATTA LAZA GOLD', 'CALACATTA LAZA GREY',
  'CALACATTA LINCOIN GOLD', 'CALACATTA LUNA', 'CALACATTA LUXOR', 'CALACATTA MISTERIO',
  'CALACATTA MOONLIGHT', 'CALACATTA RIO', 'CALACATTA RUSTA', 'CALACATTA SHADOW',
  'CALACATTA SHADOW (NATURAL)', 'CALACATTA SNOW', 'CALACATTA SPONDA GOLD',
  'CALACATTA SPONDA GOLD (NATURAL)', 'CALACATTA SPONDA GREY', 'CALACATTA SUPREME',
  'CALACATTA TELESTO', 'CALACATTA TUSCANY', 'CALACATTA TUSCANY GREY',
  'CALACATTA VENETINO GOLD', 'CALACATTA VENETINO GREY', 'CALACATTA LUCA',
  'CALACATTA WOW', 'CARARRA GOLD', 'CARRARA GOLD', 'CARRARA DELUXE', 'CARRARA MARMI',
  'DYNA BLUE', 'DYNA GOLD', 'ESTADOS GOLD', 'ESTADOS GREY', 'FANTASY BROWN',
  'FLORENCE GOLD', 'FLORENCE GREY', 'FROST WHITE', 'ICE BERG', 'ICED WHITE', 'LAVA',
  'LINCOIN GOLD', 'LINCOIN GOLD / VENETINO GOLD', 'LINCOIN GREY',
  'LINCOIN GREY / GOLD (VENETINO GREY / GOLD)', 'LINCOIN GREY / VENETINO GREY',
  'OCEAN BLUE', 'SILVER OPAL', 'SHIMMER WHITE', 'SNOW WHITE', 'SPARKLE GREY',
  'STROM GOLD', 'SPARKLE WHITE', 'TAJ MAHAL', 'THASSOS CARRARA', 'THASSOS WHITE',
  'ULTRA WHITE', 'VENETINO GOLD'];
FOPT.CONTAINER_SIZE = ['DSS - 131*79*20', 'DSS - 131*79*30', 'DSS - 131*80*20',
  'DSS - 131*80*30', 'LQS - 140*79*20', 'LQS - 140*79*30', 'LQS - 140*81*20',
  'LQS - 140*81*30', 'RGS - 127*64*15', 'RGS - 127*64*20', 'RGS - 127*64*30',
  'RGS - 128*64*15', 'RGS - 128*64*20', 'RGS - 128*64*30', 'RGS - 128*65*15',
  'RGS - 128*65*20', 'RGS - 128*65*30', 'SKS - 136*78*20', 'SKS - 136*78*30',
  'SKS - 137*76*20', 'SKS - 137*76*30', 'SKS - 137*78*20', 'SKS - 137*78*30',
  'SKS - 138*79*20', 'SKS - 138*79*30', 'SKS - 138*80*15', 'SKS - 138*80*20',
  'SKS - 138*80*30'];
FOPT.CONTAINER_GRADE = ['A', 'B', 'C'];

var FORM_DEFS = {

  // 1 -----------------------------------------------------------------------
  batching: {
    key: 'batching',
    no: 1,
    title: 'Batching Form',
    abbr: 'BA',
    tab: 'Batching Form',
    action: formsUrl_('1FAIpQLSc4O1pp1HCT57qJlzx0FL09eX3iiIFEbNkHxsPRMU-H1yNFgA'),
    pages: 7,
    /* Two prefill buttons instead of one. A line and B line run different
       recipes — different grit, different filler, different quantities — so
       repeating "the last entry" regardless of line carries the wrong numbers
       across roughly half the time. */
    prefillLines: true,
    lineField: 'line',      // the button's choice fills this radio too
    sections: [
      { title: 'Line & Slab', fields: [
        { id: 'line',  label: 'Line', type: 'radio', entry: 51825295,
          required: true, options: ['A', 'B'], noPrefill: true },
        { id: 'slabA', label: 'Slab Number (A)', type: 'select', entry: 1192781866,
          required: true, source: 'slabA', isSlab: true,
          showWhen: { field: 'line', eq: 'A' } },
        { id: 'slabB', label: 'Slab Number (B)', type: 'select', entry: 1229587695,
          required: true, source: 'slabB', isSlab: true,
          showWhen: { field: 'line', eq: 'B' } }
      ]},
      { title: 'Design Code and Size', fields: [
        { id: 'design', label: 'Design code', type: 'select', entry: 395276618,
          required: true, source: 'designCodes', fallback: FOPT.DESIGN_CODE },
        { id: 'size', label: 'Size', type: 'radio', entry: 307824330,
          required: true, options: FOPT.SIZE }
      ]},
      { title: 'Grit Bags (A body)', fields: [
        { id: 'ga1s', label: 'GA1 Supplier Code (Grit)', type: 'select',
          entry: 1504519483, required: true, options: FOPT.GRIT },
        { id: 'ga1b', label: 'G Bag Number (GA1)', type: 'number', integer: true, min: 1, entry: 485636838, required: true },
        { id: 'ga1q', label: 'GA1 Quantity Used (Grit - kg)', type: 'number', min: 0, entry: 485570412, required: true },
        { id: 'ga2s', label: 'GA2 Supplier Code (Grit)', type: 'select', entry: 1852417181, options: FOPT.GRIT },
        { id: 'ga2b', label: 'G Bag Number (GA2)', type: 'number', integer: true, min: 1, entry: 1389012968 },
        { id: 'ga2q', label: 'GA2 Quantity Used (Grit - kg)', type: 'number', min: 0, entry: 562272048 }
      ]},
      { title: 'Filler Bags (A body)', fields: [
        { id: 'fa1s', label: 'FA1 Supplier Code (Filler)', type: 'select',
          entry: 48988076, required: true, options: FOPT.FILLER },
        { id: 'fa1b', label: 'F Bag Number (A1)', type: 'number', integer: true, min: 1, entry: 46484780, required: true },
        { id: 'fa1q', label: 'FA1 Quantity Used (Filler - kg)', type: 'number', min: 0, entry: 2145459707, required: true },
        { id: 'fa2s', label: 'FA2 Supplier Code', type: 'select', entry: 1725740179, options: FOPT.FILLER },
        { id: 'fa2b', label: 'F Bag Number (A2)', type: 'number', integer: true, min: 1, entry: 461423810 },
        { id: 'fa2q', label: 'FA2 Quantity Used (Filler - kg)', type: 'number', min: 0, entry: 1157153857 }
      ]},
      { title: 'Grit Bags (B body)', fields: [
        { id: 'gb1s', label: 'GB1 Supplier Code (Grit)', type: 'select', entry: 46095241, options: FOPT.GRIT },
        { id: 'gb1b', label: 'G Bag Number (B1)', type: 'number', integer: true, min: 1, entry: 2113194480 },
        { id: 'gb1q', label: 'GB1 Quantity Used (Grit - kg)', type: 'number', min: 0, entry: 1340852429 }
      ]},
      { title: 'Filler Bags (B body)', fields: [
        { id: 'fb1s', label: 'FB1 Supplier Code (Filler)', type: 'select', entry: 139373359, options: FOPT.FILLER },
        { id: 'fb1b', label: 'F Bag Number (B1)', type: 'number', integer: true, min: 1, entry: 707375670 },
        { id: 'fb1q', label: 'FB1 Quantity Used (Filler - kg)', type: 'number', min: 0, entry: 1272102595 }
      ]},
      { title: 'Remarks', fields: [
        { id: 'remark', label: 'Any Remarks', type: 'textarea', entry: 2040796227, noPrefill: true }
      ]}
    ]
  },

  // 2 -----------------------------------------------------------------------
  resin: {
    key: 'resin',
    no: 2,
    title: 'Resin Form',
    abbr: 'RE',
    tab: 'Resin Form',
    action: formsUrl_('1FAIpQLSegakcOlXEXEdLhVc5ROz9JAc9-qRXGOQL6Qy6Ozw31Osqbtw'),
    pages: 3,
    /* Same two buttons. Resin has no Line question — the line is the first
       letter of the slab number, so that is what the lookup reads. */
    prefillLines: true,
    sections: [
      { title: 'Slab', fields: [
        { id: 'slab', label: 'Slab Number', type: 'select', entry: 2091913018,
          required: true, source: 'resin', isSlab: true }
      ]},
      { title: 'For A body', fields: [
        { id: 'rsa', label: 'Resin Supplier Name', type: 'select', entry: 575231803,
          required: true, options: FOPT.RESIN_SUPPLIER },
        { id: 'ibca', label: 'IBC No.', type: 'select', entry: 754623124,
          required: true, options: FOPT.IBC },
        { id: 'rqa', label: 'Resin Quantity', type: 'number', min: 0, entry: 832000408, required: true },
        { id: 'wpa', label: 'Whitepaste Quantity', type: 'number', min: 0, entry: 2069390707, required: true },
        { id: 'hsa', label: 'Hardener Supplier', type: 'select', entry: 1120616827,
          required: true, options: FOPT.HARDENER_SUPPLIER },
        { id: 'hqa', label: 'Hardener Quantity', type: 'number', min: 0, entry: 590536191, required: true },
        { id: 'sqa', label: 'Silane Quantity', type: 'number', min: 0, entry: 643171136, required: true },
        { id: 'era', label: 'Extra Resin Used (kg)', type: 'number', min: 0,
          entry: 903772297, noPrefill: true }
      ]},
      { title: 'For B body', fields: [
        { id: 'rsb', label: 'Resin Supplier Name (B)', type: 'select', entry: 371705560, options: FOPT.RESIN_SUPPLIER },
        { id: 'ibcb', label: 'IBC No. (B)', type: 'select', entry: 623410714, options: FOPT.IBC },
        { id: 'rqb', label: 'Resin Quantity (B)', type: 'number', min: 0, entry: 1374418303 },
        { id: 'wpb', label: 'Whitepaste Quantity (B)', type: 'number', min: 0, entry: 761452957 },
        { id: 'hqb', label: 'Hardener Quantity (B)', type: 'number', min: 0, entry: 1236190461 },
        { id: 'sqb', label: 'Silane Quantity (B)', type: 'number', min: 0, entry: 1150715121 }
      ]},
      { title: 'Remarks', fields: [
        { id: 'remark', label: 'Remark', type: 'textarea', entry: 1494531593, noPrefill: true }
      ]}
    ]
  },

  // 3 -----------------------------------------------------------------------
  mixer: {
    key: 'mixer',
    no: 3,
    title: 'Mixer Form',
    abbr: 'MI',
    tab: 'Mixer Form',
    action: formsUrl_('1FAIpQLSeFIVcziBmSnyTcbtgB-cFSbO1YRoikVcGoWmFX8fHeVncSjg'),
    pages: 1,
    sections: [
      { title: 'Batch', fields: [
        { id: 'slab', label: 'Slab Number', type: 'select', entry: 2085349444,
          required: true, source: 'mixer', isSlab: true },
        { id: 'mixer', label: 'Mixer No.', type: 'select', entry: 1977546713,
          required: true, options: FOPT.numbers(1, 4) },
        { id: 'start', label: 'Starting Time', type: 'time', entry: 1002384436,
          required: true, noPrefill: true },
        { id: 'qty', label: 'Batch Quantity (kg)', type: 'number', min: 0, entry: 313070404, required: true },
        { id: 'disch', label: 'Discharging Time', type: 'time', entry: 187671283,
          required: true, noPrefill: true }
      ]},
      { title: 'Extra Additions', fields: [
        { id: 'eh', label: 'Extra Hardener', type: 'number', min: 0, entry: 1726538687 },
        { id: 'ew', label: 'Extra Whitepaste', type: 'number', min: 0, entry: 438941335 },
        { id: 'er', label: 'Extra Resin', type: 'number', min: 0, entry: 1245147119 },
        { id: 'es', label: 'Extra Silane', type: 'number', min: 0, entry: 1889329299 }
      ]},
      { title: 'Remarks', fields: [
        { id: 'remark', label: 'Remark', type: 'textarea', entry: 455283959, noPrefill: true }
      ]}
    ]
  },

  // 4 -----------------------------------------------------------------------
  pressing: {
    key: 'pressing',
    no: 4,
    title: 'Pressing Form',
    abbr: 'PR',
    tab: 'Pressing Form',
    action: formsUrl_('1FAIpQLSexT_rZ5V-Lj8bujjPRiG1P3y8BqIgqPUaFtz8lSzTPFWkslg'),
    pages: 2,
    sections: [
      { title: 'Slab & Press', fields: [
        { id: 'slab', label: 'Slab Number', type: 'select', entry: 1894079278,
          required: true, source: 'pressing', isSlab: true },
        { id: 'wet', label: 'Wetness', type: 'radio', entry: 1197648949,
          required: true, options: ['Perfect', 'Low', 'High'] },
        { id: 'series', label: 'Series', type: 'radio', entry: 779304677,
          required: true, options: ['Pure White', 'Calacatta', 'Carrara', 'Liquid'] },
        { id: 'xy', label: 'X & Y', type: 'radio', entry: 773147047, options: ['X', 'Y'] },
        { id: 'repressed', label: 'Repressed ?', type: 'radio', entry: 490084267,
          options: ['Yes', 'No'], noPrefill: true }
      ]},
      { title: 'Repress Parameters', showWhen: { field: 'repressed', eq: 'Yes' }, fields: [
        { id: 'f1', label: 'Frequency 1', type: 'number', entry: 1444618240, required: true },
        { id: 't1', label: 'Time 1', type: 'number', entry: 864030591, required: true },
        { id: 'f2', label: 'Frequency 2', type: 'number', entry: 1001506459, required: true },
        { id: 't2', label: 'Time 2', type: 'number', entry: 554272442, required: true },
        { id: 'f3', label: 'Frequency 3', type: 'number', entry: 1143281810, required: true },
        { id: 't3', label: 'Time 3', type: 'number', entry: 346808511, required: true },
        { id: 'f4', label: 'Frequency 4', type: 'number', entry: 934135546, required: true },
        { id: 't4', label: 'Time 4', type: 'number', entry: 1678952130, required: true },
        { id: 'f5', label: 'Frequency 5', type: 'number', entry: 349900762, required: true },
        { id: 't5', label: 'Time 5', type: 'number', entry: 2093583865, required: true }
      ]},
      /* No entry id: this question was never on the Google Form, and with
         FORMS_SUBMIT_MODE 'sheet' it does not need to be. The tab needs a
         "Mould Number" column or the answer is dropped (verifyFormColumns). */
      { title: 'Mould', fields: [
        { id: 'mould', label: 'Mould Number', type: 'select', required: true,
          options: FOPT.MOULD, noPrefill: true }
      ]},
      { title: 'Remarks', fields: [
        { id: 'remark', label: 'Remark', type: 'textarea', entry: 1256166313, noPrefill: true }
      ]}
    ]
  },

  // 5 -----------------------------------------------------------------------
  ovenIn: {
    key: 'ovenIn',
    no: 5,
    title: 'Oven In Form',
    abbr: 'OI',
    tab: 'Oven In Form',
    action: formsUrl_('1FAIpQLSdOHP7bGQrHUEyKp2pEbmjzJ4bXIc3O-1vICaLkOqCqtDs1kw'),
    pages: 2,
    sections: [
      { title: 'Oven In', fields: [
        { id: 'slab', label: 'Slab Number', type: 'select', entry: 2044868282,
          required: true, source: 'ovenIn', isSlab: true },
        { id: 'shelf', label: 'Shelf Number', type: 'select', entry: 1456288020,
          required: true, options: FOPT.numbers(1, 14) },
        { id: 'est', label: 'Estimated Curing Time', type: 'text', entry: 849742609, required: true }
      ]},
      { title: 'Temperature', fields: [
        { id: 'top', label: 'Top Shelf Temp.', type: 'number', entry: 773638069, required: true },
        { id: 'low', label: 'Lower Shelf Temp.', type: 'number', entry: 1506053255, required: true }
      ]},
      { title: 'Remarks', fields: [
        { id: 'remark', label: 'Remark', type: 'textarea', entry: 1220188003, noPrefill: true }
      ]}
    ]
  },

  // 6 -----------------------------------------------------------------------
  ovenOut: {
    key: 'ovenOut',
    no: 6,
    title: 'Oven Out Form',
    abbr: 'OO',
    tab: 'Oven Out Form',
    action: formsUrl_('1FAIpQLSckxlzvpf9Lqn8Rg_UR_zIWQ8XaVcI2gWWLLOxl0h9tF4ezsg'),
    pages: 1,
    sections: [
      { title: 'Oven Out', fields: [
        { id: 'slab', label: 'Slab Number', type: 'select', entry: 347286812,
          required: true, source: 'ovenOut', isSlab: true },
        /* "Total Curing Time" is no longer typed by the operator. The app
           already knows the Oven In timestamp and stamps the Oven Out one, so
           it works the elapsed minutes out itself — see FORMS_CFG.OVEN_AUTO_TOTAL
           in FormsConfig.gs. Entry id 846637071 if it is ever restored. */
        { id: 'reason', label: 'Reason of Extra Curing', type: 'textarea', entry: 1472359680, noPrefill: true }
      ]}
    ]
  },

  // 7 -----------------------------------------------------------------------
  vacuum: {
    key: 'vacuum',
    no: 7,
    allowPrefill: false,      // every entry is a different bundle of slabs
    title: 'Vacuum Unloader',
    abbr: 'VU',
    tab: 'Vacuum Unloader',
    action: formsUrl_('1FAIpQLScUCvHcFVeEuHUuMR5ANxJ5cB_36j04ISKvQxumuMFLrKJFbw'),
    pages: 1,
    sections: [
      { title: 'Unload', fields: [
        /* The Vacuum Unloader FILLS a bundle, so it picks from the empty ones
           (Bundles column B, "Available Bundles"). */
        { id: 'bundle', label: 'Bundle Number', type: 'select', entry: 1896681517,
          required: true, source: 'bundlesAvailable', noPrefill: true,
          help: 'Empty bundles only — the ones waiting to be filled.' },
        { id: 'slab', label: 'Slab Number', type: 'checkbox', entry: 1352512006,
          required: true, source: 'vacuum', isSlab: true,
          help: 'Tick every slab going into this bundle.' }
      ]}
    ]
  },

  // 8 -----------------------------------------------------------------------
  // The Google Form has 60 hard-coded bundle sections. Here it is two fields:
  // pick a bundle, then tick slabs loaded live from the Bundles tab.
  trolley: {
    key: 'trolley',
    no: 8,
    allowPrefill: false,      // every entry is a different bundle of slabs
    title: 'Trolley Form',
    abbr: 'TR',
    tab: 'Trolley Form',
    action: formsUrl_('1FAIpQLSffjeTs1pYZ4yJlYizKkeTHqDIhBk8EFpJDuNyPEvccN64B5w'),
    pages: 61,
    dynamicBundle: true,   // handled specially by the renderer and submitter
    sections: [
      { title: 'Trolley', fields: [
        /* The Trolley EMPTIES a bundle, so it picks from the bundles that
           currently hold slabs (Bundles column C, "Filled Bundles") — the
           opposite end of the cycle from the Vacuum Unloader. */
        { id: 'bundle', label: 'Bundle Number', type: 'select', entry: 2097431791,
          required: true, source: 'bundlesFilled', noPrefill: true,
          help: 'Filled bundles only — the ones ready to be emptied.' },
        { id: 'slabs', label: 'Slabs in this bundle', type: 'checkbox',
          entry: null, required: true, source: '@bundle', isSlab: true,
          help: 'The slabs the Vacuum Unloader put into this bundle.' }
      ]}
    ],
    // bundle name -> entry id of that bundle's checkbox question
    bundleEntries: {
      BN01:69819174,  BN02:670622402, BN03:1691887296,BN04:406058306, BN05:365447085,
      BN06:1442423976,BN07:74862319,  BN08:1704567035,BN09:1401937142,BN10:1579883,
      BN11:1051449500,BN12:147826180, BN13:607728900, BN14:1034536122,BN15:323605216,
      BN16:1270710164,BN17:781799995, BN18:1590558654,BN19:1565453957,BN20:1381176857,
      BN21:1290269978,BN22:1297057710,BN23:1390359829,BN24:942245775, BN25:715389526,
      BN26:378223336, BN27:1637405013,BN28:586898579, BN29:1698810815,BN30:57979493,
      BN31:859361448, BN32:373504993, BN33:211663150, BN34:83971096,  BN35:1933094709,
      BN36:1988779818,BN37:1287241477,BN38:1738295902,BN39:1826520274,BN40:1794763389,
      BN41:797260765, BN42:548507471, BN43:1979373951,BN44:911848381, BN45:1205917416,
      BN46:1701125404,BN47:2081727715,BN48:328187917, BN49:362387885, BN50:1750569184,
      BN51:242228769, BN52:274608028, BN53:1458457125,BN54:1695511246,BN55:1047794820,
      BN56:1277460789,BN57:833203226, BN58:1399852025,BN59:332331432, BN60:1908346416
    }
  },

  // 9 -----------------------------------------------------------------------
  calibration: {
    key: 'calibration',
    no: 9,
    allowPrefill: false,      // thicknesses are measured, never repeated
    title: 'Calibration Form',
    abbr: 'CA',
    tab: 'Calibration Form',
    action: formsUrl_('1FAIpQLSco-o6jOFzRSN0fGzdfctqYD7_3eEM6U6hsLzL53adRtC79Vg'),
    pages: 3,
    sections: [
      { title: 'Slab', fields: [
        { id: 'slab', label: 'Slab Number', type: 'select', entry: 683700543,
          required: true, source: 'calibration', isSlab: true }
      ]},
      { title: 'Thickness Details', grid: true, fields: [
        { id: 'th1', label: 'Thickness 1', type: 'number', entry: 724438189,  required: true },
        { id: 'th2', label: 'Thickness 2', type: 'number', entry: 2014495702, required: true },
        { id: 'th3', label: 'Thickness 3', type: 'number', entry: 948963801,  required: true },
        { id: 'th4', label: 'Thickness 4', type: 'number', entry: 815804557,  required: true },
        { id: 'th5', label: 'Thickness 5', type: 'number', entry: 694358511,  required: true },
        { id: 'th6', label: 'Thickness 6', type: 'number', entry: 1574601776, required: true },
        { id: 'th7', label: 'Thickness 7', type: 'number', entry: 581503047,  required: true },
        { id: 'th8', label: 'Thickness 8', type: 'number', entry: 1150593165, required: true }
      ]},
      { title: 'Quality', fields: [
        { id: 'defects', label: 'Defect Details', type: 'checkbox', entry: 2133398345,
          required: true, options: FOPT.CAL_DEFECTS, noPrefill: true },
        { id: 'remark', label: 'Remark', type: 'textarea', entry: 683338456, noPrefill: true }
      ]}
    ]
  },

  // 12 ----------------------------------------------------------------------
  qc: {
    key: 'qc',
    no: 12,
    allowPrefill: false,      // a grade must be judged per slab, never carried
    title: 'Q.C. Final Form',
    abbr: 'QC',
    tab: 'Q.C. Final Form',
    action: formsUrl_('1FAIpQLScCzpWA3DZvcBBjSHThF-aEyXF3bsTyKmXFb2rU0UVTakugOA'),
    pages: 3,
    sections: [
      { title: 'Inspection', fields: [
        { id: 'slab', label: 'Slab Number', type: 'select', entry: 1690917588,
          required: true, source: 'qc', isSlab: true },
        { id: 'quality', label: 'Quality', type: 'radio', entry: 509196519,
          required: true, options: ['Perfect', 'Defect'], noPrefill: true }
      ]},
      { title: 'Defects', showWhen: { field: 'quality', eq: 'Defect' }, fields: [
        { id: 'defects', label: 'Defects', type: 'checkbox', entry: 1459839980,
          options: FOPT.QC_DEFECTS, noPrefill: true }
      ]},
      { title: 'Grade', fields: [
        { id: 'grade', label: 'Material Final Grade', type: 'select', entry: 732832889,
          required: true, options: FOPT.QC_GRADE, noPrefill: true },
        { id: 'remark', label: 'Remark', type: 'textarea', entry: 1280659594, noPrefill: true }
      ]}
    ]
  }
,
  // 16 ----------------------------------------------------------------------
  // Reproduced field for field from PRODUCTION SUMMARY FORM(A), including the
  // labels' own spelling and spacing — "SHIFT INCHAGE", the double space in
  // "TOTAL MANPOWER  BOTH LINE", "NO F SLAB PRODUCED LINE-A(2)". The sheet
  // headers are generated from these labels, so they line up either way, but
  // changing them here would silently orphan a column later.
  prodSummaryA: {
    key: 'prodSummaryA',
    no: 16,
    title: 'Production Summary (A Line)',
    abbr: 'PA',
    tab: 'Production Summary A',
    action: formsUrl_('1FAIpQLSfWewDr4yGu0Rw7uy5O23jifPkShQSe9x6Rtdr426jl0qdtDA'),
    pages: 1,
    keyField: 'shift',
    dupCheck: false,          // every entry is DAY or NIGHT by design
    sections: [
      { title: 'Date & shift', fields: [
        /* The day the production being reported actually happened, not the day
           the form is filled. A summary entered on the 27th for the 22nd used
           to land on the 27th in the dashboard, because the only date on the
           row was the Timestamp. The Production tab now reads THIS column and
           the SHIFT below it, and ignores the Timestamp entirely. */
        { id: 'pdate', label: 'PRODUCTION DATE', type: 'date', required: true,
          defaultToday: true, noPrefill: true,
          help: 'The day this production happened — change it if you are filling this in later.' },
        { id: 'shift', label: 'SHIFT', type: 'radio', entry: 1957773668,
          options: ['DAY SHIFT', 'NIGHT SHIFT'], noPrefill: true },
        { id: 'reportedBy', label: 'REPORTED BY', type: 'radio', entry: 1753051854,
          options: ['HARISH KUMAR', 'PAVAN NANI', 'ARUN KUMAR', 'HIMMAT CHARAN', 'PRASHANTH'] },
        { id: 'incharge', label: 'SHIFT INCHAGE', type: 'radio', entry: 985125261,
          options: ['PAVAN', 'HIMMAT', 'PRASHANTH', 'PRASANTH & HIMMAT', 'PAVAN & HIMMAT'] },
        { id: 'supervisor', label: 'SHIFT SUPERVISOR', type: 'radio', entry: 1567986328,
          options: ['HARISH KUMAR', 'ARUN KUMAR'] },
        { id: 'manpower', label: 'TOTAL MANPOWER  BOTH LINE', type: 'number', entry: 989918829 }
      ]},
      { title: 'Design', fields: [
        { id: 'code1', label: 'DESIGN CODE -A LINE(1)', type: 'select', entry: 2111643544,
          options: FOPT.SUMMARY_DESIGN_CODE, fills: { field: 'name1', map: 'codeToName' } },
        { id: 'code2', label: 'DESIGN  CODE-A LINE(2)', type: 'select', entry: 450398325,
          options: FOPT.SUMMARY_DESIGN_CODE, fills: { field: 'name2', map: 'codeToName' } },
        { id: 'name1', label: 'DESIGN NAME-A LINE(1)', type: 'select', entry: 1178354381,
          options: FOPT.SUMMARY_DESIGN_NAME, fills: { field: 'code1', map: 'nameToCode' } },
        { id: 'name2', label: 'DESIGN NAME-A LINE(2)', type: 'select', entry: 1461118214,
          options: FOPT.SUMMARY_DESIGN_NAME, fills: { field: 'code2', map: 'nameToCode' } }
      ]},
      { title: 'Size & Output', fields: [
        { id: 'size1', label: 'SIZE & THICKNESS-A(1) LINE', type: 'radio', entry: 1494348707,
          options: ['3600*2080*36MM', '3380*2060*36MM', '3275*1655*36MM',
                    '3600*2080*26MM', '3380*2060*26MM', '3275*1655*26MM'] },
        { id: 'size2', label: 'SIZE& THICKNESS-A(2)', type: 'radio', entry: 745489567,
          options: ['3600*2080*36MM', '3380*2060*36MM', '3275*1655*36MM',
                    '3600*2080*26MM', '3380*2060*26MM', '3275*1655*26MM'] },
        { id: 'slabs1', label: 'NO OF SLAB PRODUCED  LINE-A(1)', type: 'number', entry: 1606343295,
          noPrefill: true },
        { id: 'slabs2', label: 'NO F SLAB PRODUCED LINE-A(2)', type: 'number', entry: 1455875146,
          noPrefill: true }
      ]},
      { title: 'Team', fields: [
        { id: 'team', label: 'CALACATTA TEAM-A', type: 'radio', entry: 2083354042,
          options: ['SUNNY TEAM', 'NANAHE TEAM', 'SANJU TEAM', 'CHHOTO TEAM',
                    'SUNNY& NANHE', 'SANJU & CHHOTO', 'SUNNY & DHARMENDRA'] }
      ]}
    ]
  },

  // 17 ----------------------------------------------------------------------
  // PRODUCTION SUMMARY(B FORM), likewise verbatim. Note B differs from A in
  // more than the line letter: TOTAL MANPOWER is a paragraph there, SIZE (1)
  // carries two extra sizes, and SIZE (2) has "3380*2060*36MMV" — left exactly
  // as it is in the form so the values match the ones already collected.
  prodSummaryB: {
    key: 'prodSummaryB',
    no: 17,
    title: 'Production Summary (B Line)',
    abbr: 'PB',
    tab: 'Production Summary B',
    action: formsUrl_('1FAIpQLSeNqwzP4xP-CzCPWvVNtdLUPgUPf3iUaE5aCbnaFN296HRqxg'),
    pages: 1,
    keyField: 'shift',
    dupCheck: false,
    sections: [
      { title: 'Date & shift', fields: [
        /* The day the production being reported actually happened, not the day
           the form is filled. A summary entered on the 27th for the 22nd used
           to land on the 27th in the dashboard, because the only date on the
           row was the Timestamp. The Production tab now reads THIS column and
           the SHIFT below it, and ignores the Timestamp entirely. */
        { id: 'pdate', label: 'PRODUCTION DATE', type: 'date', required: true,
          defaultToday: true, noPrefill: true,
          help: 'The day this production happened — change it if you are filling this in later.' },
        { id: 'shift', label: 'SHIFT', type: 'radio', entry: 452876208,
          options: ['DAY SHIFT', 'NIGHT SHIFT'], noPrefill: true },
        { id: 'reportedBy', label: 'REPORTED BY', type: 'radio', entry: 1341484634,
          options: ['PAVAN NANI', 'HARISH KUMAR', 'HIMMAT CHARAN', 'ARUN KUMAR', 'PRASHANTH'] },
        { id: 'incharge', label: 'SHIFT INCHARGE', type: 'radio', entry: 351322949,
          options: ['PAVAN', 'HIMMAT', 'PRASHANTH', 'PRASHANT & HIMMAT', 'PAVAN & HIMMAT'] },
        { id: 'supervisor', label: 'SHIFT SUPERVISOR', type: 'radio', entry: 1539343099,
          options: ['ARUN KUMAR', 'HARISH KUMAR'] },
        { id: 'manpower', label: 'TOTAL MANPOWER BOTH LINE', type: 'textarea', entry: 1105301052 }
      ]},
      { title: 'Design', fields: [
        { id: 'code1', label: 'DESIGN CODE-B LINE(1)', type: 'select', entry: 397353131,
          options: FOPT.SUMMARY_DESIGN_CODE, fills: { field: 'name1', map: 'codeToName' } },
        { id: 'code2', label: 'DESIGN CODE-B LINE(2)', type: 'select', entry: 1191437302,
          options: FOPT.SUMMARY_DESIGN_CODE, fills: { field: 'name2', map: 'codeToName' } },
        { id: 'name1', label: 'DESIGN NAME-B LINE(1)', type: 'select', entry: 748340049,
          options: FOPT.SUMMARY_DESIGN_NAME, fills: { field: 'code1', map: 'nameToCode' } },
        { id: 'name2', label: 'DESIGN NAME-B LINE(2)', type: 'select', entry: 1018775226,
          options: FOPT.SUMMARY_DESIGN_NAME, fills: { field: 'code2', map: 'nameToCode' } }
      ]},
      { title: 'Size & Output', fields: [
        { id: 'size1', label: 'SIZE & THICKNESS -B(1)', type: 'radio', entry: 1506938556,
          options: ['3600*2080*36MM', '3380*2060*36MM', '3275*1655*36MM',
                    '3600*2080*26MM', '3380*2060*26mm', '3275*1655*26mm',
                    '3530*2010*36MM', '3530*2010*26MM'] },
        { id: 'size2', label: 'SIZE & THICKNESS-B (2)', type: 'radio', entry: 1241440404,
          options: ['3600*2080*36MM', '3380*2060*36MMV', '3275*1655*36MM',
                    '3600*2080*26MM', '3380*2060*26mm', '3275*1655*26mm'] },
        { id: 'slabs1', label: 'NO OF SLAB PRODUCED LINE-B(1)', type: 'number', entry: 571712487,
          noPrefill: true },
        { id: 'slabs2', label: 'NO OF SLAB PRODUCED LINE-B(2)', type: 'number', entry: 591977527,
          noPrefill: true }
      ]},
      { title: 'Team', fields: [
        { id: 'team', label: 'CALACATTA TEAM-B', type: 'radio', entry: 87585784,
          options: ['SUNNY TEAM', 'NANHE TEAM', 'SANJU TEAM', 'SUNNAY & NANHE',
                    'SANJU & CHHOTU', 'SANJU & NANHE', 'DHARMENDRA & SUNNY','DHARMENDRA'] }
      ]}
    ]
  },

  // 17 ----------------------------------------------------------------------
  // Dispatch is the only form that writes MORE THAN ONE ROW. One row per slab
  // in the container, the container number repeated down the block. There is
  // no Google Form behind it — it was built here — so no `action` and no
  // `entry` ids, which is fine because FORMS_SUBMIT_MODE is 'sheet'.
  dispatch: {
    key: 'dispatch',
    no: 17,
    title: 'Dispatch Form',
    abbr: 'DP',
    tab: 'Dispatch Form',
    pages: 1,
    allowPrefill: false,     // a container is dispatched once; nothing to repeat
    keyField: 'container',
    dupCheck: true,          // history is keyed on the slab, and a slab twice IS an error
    multiRow: 'slabs',       // the field that fans one submission out into rows
    sections: [
      { title: 'Container', fields: [
        { id: 'container', label: 'Container No.', type: 'text', required: true,
          help: 'Typed as it appears on the container or truck.' }
      ]},
      { title: 'Slabs in this container', fields: [
        { id: 'slabs', label: 'Slab Numbers', type: 'slabgrade', required: true,
          source: '@dispatch',
          help: 'Tick each slab. The grade starts on whatever Q.C. Final recorded — ' +
                'change it only where dispatch disagrees.' }
      ]}
    ]
  },

  // 18 ----------------------------------------------------------------------
  // Grade Reporting. Two things make it unlike every other form here: the slab
  // is picked as a PICTURE (six boxes, the shop-floor drawing), and the body of
  // the form is generated from that picture — one block per section tapped.
  // Like Dispatch it writes a row per unit, here a row per section.
  gradeReport: {
    key: 'gradeReport',
    no: 18,
    title: 'Grade Reporting',
    abbr: 'GR',
    tab: 'Feedback Response',      // FORMS_ALERT.RESPONSE_TAB
    pages: 1,
    allowPrefill: false,           // every slab is its own problem
    keyField: 'slab',
    dupCheck: true,                // the same slab reported twice is worth seeing
    multiSection: 'sections',      // fans one submission out into a row per section
    sections: [
      { title: 'Slab', fields: [
        { id: 'slab', label: 'Slab Number', type: 'select', required: true,
          source: '@alertSlabs', isSlab: true,
          help: 'The slabs with a live grade alert.' }
      ]},
      { title: 'Where is the problem?', fields: [
        /* Ticked when the fault runs across the whole slab rather than sitting
           in one part of it. It adds a block of its own and takes nothing
           away: a slab can be reported whole AND have two bad sections called
           out, which is why this does not disable the diagram. */
        { id: 'fullSlab', label: 'Full Slab', type: 'toggle',
          help: 'The whole slab is affected. Adds a Full Slab block below; the six sections stay available.' },
        { id: 'sections', label: 'Sections', type: 'slabmap', required: true,
          requiredUnless: 'fullSlab',
          help: 'Tap every part of the slab with a problem. One block appears below for each.' }
      ]}
    ],
    /* The block repeated per selected section. Rendered by the client from
       this template; the server reads it back out of values.sec[n]. */
    sectionTemplate: [
      { id: 'photos',    label: 'Photos',            type: 'media',     required: true },
      { id: 'defects',   label: 'Defects',           type: 'checkbox',  required: true },
      { id: 'area',      label: 'Area Responsible',  type: 'select',    required: true },
      { id: 'areaOther', label: 'Which area?',       type: 'text' },
      { id: 'reason',    label: 'Reason',            type: 'textarea',  required: true },
      { id: 'solution',  label: 'Solution',          type: 'textarea',  required: true }
    ]
  },

  // 19 ----------------------------------------------------------------------
  // Bag Form. A bag of raw material as it is received or opened: which kind,
  // whose it is, its number and what it weighs. The supplier list follows the
  // material, so a filler code can never be recorded against a grit bag — the
  // two lists are the same ones Batching uses, so there is one place to add a
  // supplier, not three.
  bag: {
    key: 'bag',
    no: 19,
    title: 'Bag Form',
    abbr: 'BG',
    tab: 'Bag Form',
    pages: 1,
    allowPrefill: true,      // a shift usually logs a run of bags from one supplier
    keyField: 'bagNo',
    dupCheck: true,          // the same bag number twice is worth seeing
    sections: [
      { title: 'Material', fields: [
        { id: 'material', label: 'Material', type: 'radio', required: true,
          options: FOPT.BAG_MATERIAL, noPrefill: true },
        { id: 'supplier', label: 'Supplier Code', type: 'select', required: true,
          optionsWhen: { field: 'material', map: FOPT.BAG_SUPPLIERS },
          help: 'The list follows the material chosen above.' }
      ]},
      { title: 'The bag', fields: [
        /* uniqueLive: the phone holds every Material + Bag Number already on
           the tab and turns this box red the moment a used one is typed, so
           the operator hears about it before filling the weight, not after
           pressing Submit. The server guard (FDUP_KEYS.bag) still decides. */
        { id: 'bagNo', label: 'Bag Number', type: 'number', required: true,
          integer: true, min: 1, noPrefill: true, uniqueLive: true,
          help: 'Numbers only.' },
        { id: 'weight', label: 'Weight', type: 'number', required: true,
          min: 0, noPrefill: true, help: 'Numbers only, in kg.' }
      ]}
    ]
  },

  // 20 ----------------------------------------------------------------------
  // Formula Form. What a slab of one design is SUPPOSED to consume, filled the
  // day before the run: every material, whose it is, and how much of it.
  //
  // It is the other half of a comparison. Batching, Resin and Mixer record what
  // the line actually drew; this records what the recipe called for. The
  // dashboard's Costing tab prices both and shows the gap, so the quantities
  // here are the baseline every "extra" is measured against — which is why the
  // supplier lists are the SAME arrays the other forms use. A supplier priced
  // on the Costing tab has to be a supplier this form can name, or the formula
  // cost is missing a line item and nobody can see why.
  //
  // Every quantity is kilograms. Not tonnes, not bags. The fields are numeric,
  // so a letter cannot be typed into one and only one decimal point is taken.
  formula: {
    key: 'formula',
    no: 20,
    title: 'Formula Form',
    abbr: 'FO',
    tab: 'Formula Form',
    pages: 1,
    /* A formula is usually the one before it with two numbers moved, so the
       prefill bar earns its place — but the design is what makes a formula a
       formula, so that much is never carried over. */
    allowPrefill: true,
    keyField: 'dname',
    dupCheck: false,         // a design is re-formulated as often as it is run
    /* Refuse a supplier code that is not on the list. See fValidate_ — the
       Costing tab prices per code, so an unknown one costs nothing at all. */
    strictOptions: true,
    sections: [
      { title: 'Design', fields: [
        { id: 'dname', label: 'Design Name', type: 'select', required: true,
          options: FOPT.SUMMARY_DESIGN_NAME, noPrefill: true,
          fills: { field: 'dcode', map: 'nameToCode' } },
        { id: 'dcode', label: 'Design Code', type: 'select', required: true,
          options: FOPT.FORMULA_DESIGN_CODE, noPrefill: true,
          fills: { field: 'dname', map: 'codeToName' },
          help: 'Picking either one fills the other in.' },
        /* The same list Batching uses, and it has to stay the same list: the
           Costing tab matches a slab to its recipe on design code AND size,
           because a 26 mm slab of one design does not consume what a 36 mm one
           does. A size spelled differently here is a recipe no slab can find. */
        { id: 'size', label: 'Size', type: 'radio', required: true,
          options: FOPT.SIZE, noPrefill: true,
          help: 'A formula belongs to one design at one size.' }
      ]},

      { title: 'Grit (A body)', fields: [
        { id: 'gsa', label: 'Grit Supplier Code (A body)', type: 'select',
          required: true, options: FOPT.GRIT },
        { id: 'gqa', label: 'Grit Quantity (A body - kg)', type: 'number',
          required: true, min: 0, help: 'Kilograms. Numbers only.' }
      ]},

      { title: 'Filler (A body)', fields: [
        { id: 'fsa', label: 'Filler Supplier Code (A body)', type: 'select',
          required: true, options: FOPT.FILLER },
        { id: 'fqa', label: 'Filler Quantity (A body - kg)', type: 'number',
          required: true, min: 0, help: 'Kilograms. Numbers only.' }
      ]},

      /* B body is optional throughout: a single-body design leaves it empty
         and the costing simply has nothing to add for it. */
      { title: 'Grit (B body)', fields: [
        { id: 'gsb', label: 'Grit Supplier Code (B body)', type: 'select',
          options: FOPT.GRIT },
        { id: 'gqb', label: 'Grit Quantity (B body - kg)', type: 'number',
          min: 0, help: 'Kilograms. Leave empty if there is no B body.' }
      ]},

      { title: 'Filler (B body)', fields: [
        { id: 'fsb', label: 'Filler Supplier Code (B body)', type: 'select',
          options: FOPT.FILLER },
        { id: 'fqb', label: 'Filler Quantity (B body - kg)', type: 'number',
          min: 0, help: 'Kilograms. Leave empty if there is no B body.' }
      ]},

      { title: 'Resin (A body)', fields: [
        { id: 'rsa', label: 'Resin Supplier Code (A body)', type: 'select',
          required: true, options: FOPT.RESIN_SUPPLIER },
        { id: 'rqa', label: 'Resin Quantity (A body - kg)', type: 'number',
          required: true, min: 0,
          help: 'Neat resin only — the resin inside the white paste is counted ' +
                'from the TiO2 below.' }
      ]},

      { title: 'Resin (B body)', fields: [
        { id: 'rsb', label: 'Resin Supplier Code (B body)', type: 'select',
          options: FOPT.RESIN_SUPPLIER },
        { id: 'rqb', label: 'Resin Quantity (B body - kg)', type: 'number',
          min: 0, help: 'Neat resin only. Leave empty if there is no B body.' }
      ]},

      { title: 'Hardener', fields: [
        { id: 'hs', label: 'Hardener Supplier Code', type: 'select',
          required: true, options: FOPT.HARDENER_SUPPLIER },
        { id: 'hq', label: 'Hardener Quantity (kg)', type: 'number',
          required: true, min: 0, help: 'Kilograms. Numbers only.' }
      ]},

      /* No supplier is asked for TiO2 or silane — neither is bought per code
         on the line, so the Costing tab prices them as one rate each.

         TiO2 is asked for, white paste is not, because white paste IS TiO2:
         three kilograms of paste per kilogram of TiO2, the rest resin. Asking
         for both would be asking the same question twice and inviting the two
         answers to disagree. The paste it comes to is shown live under the box
         so nobody has to do the multiplication in their head, and the Costing
         tab does the same sum on its side. */
      { title: 'Additives', fields: [
        { id: 'tq', label: 'TiO2 Quantity (kg)', type: 'number',
          min: 0, help: 'Kilograms. White paste is three times this.',
          calcNote: { of: 'tq', times: 3, label: 'White paste', unit: 'kg',
                      formula: 'TiO2 × 3' } },
        { id: 'sq', label: 'Silane Quantity (kg)', type: 'number',
          min: 0, help: 'Kilograms. Numbers only.' }
      ]},

      /* Total adds itself up from everything above as the quantities are
         typed, and stops doing so the moment it is edited by hand — the recipe
         is what it is, and a formula that does not add up is worth recording
         rather than silently correcting.

         TiO2 enters this sum as WHITE PASTE, three times over, because what
         goes into the slab is the paste and not the powder. Counting the
         powder once instead would understate every batch by two kilograms per
         kilogram of TiO2 — and the resin boxes above hold neat resin only, so
         the paste's resin is not already in there waiting to be
         double-counted. */
      { title: 'Total', fields: [
        { id: 'tot', label: 'Total Quantity (kg)', type: 'number',
          required: true, min: 0, noPrefill: true,
          sumOf: ['gqa', 'fqa', 'gqb', 'fqb', 'rqa', 'rqb', 'hq', 'sq',
                  { id: 'tq', times: 3 }],
          help: 'Adds up by itself, counting TiO2 as white paste (×3). ' +
                'Type over it if the recipe says otherwise.' }
      ]},

      { title: 'Remark', fields: [
        { id: 'remark', label: 'Remark', type: 'textarea', noPrefill: true }
      ]}
    ]
  },

  // 21 ----------------------------------------------------------------------
  // Bag Invoice. Ties the bags already logged on the Bag Form to the supplier
  // invoice they came in on: pick the material and supplier, type the invoice
  // number and weight, tick the bags.
  //
  // The tick list is the point of the form. It offers only Bag Form bags of
  // the chosen material AND supplier that are on no invoice yet, so a bag
  // cannot be invoiced twice or against the wrong supplier — and the writer
  // checks both again under the lock, because the list on the phone is a
  // snapshot (fAppendBagInvoice_).
  //
  // ONE ROW PER INVOICE, the bag numbers comma-joined in one cell, with the
  // count, the bags' total weight and the difference from the invoice beside
  // them. The weights are read from the Bag Form by the server, not taken from
  // the phone.
  bagInvoice: {
    key: 'bagInvoice',
    no: 21,
    title: 'Bag Invoice',
    abbr: 'BI',
    tab: 'Bag Invoice',
    pages: 1,
    allowPrefill: false,     // every invoice is a different set of bags
    keyField: 'invoiceNo',
    /* Flagged in History, not refused: an invoice whose bags arrive in two
       lots is filed twice under one number, legitimately. */
    dupCheck: true,
    /* Written by fAppendBagInvoice_, which works these out from the Bag Form
       and puts them after the fields. Listed here so the tab generator and
       History know the columns exist. */
    extraHeaders: ['Bag Count', 'Bags Total Weight', 'Difference'],
    sections: [
      { title: 'Material', fields: [
        { id: 'material', label: 'Material', type: 'radio', required: true,
          options: FOPT.BAG_MATERIAL },
        { id: 'supplier', label: 'Supplier Code', type: 'select', required: true,
          optionsWhen: { field: 'material', map: FOPT.BAG_SUPPLIERS },
          help: 'The list follows the material chosen above.' }
      ]},
      { title: 'Invoice', fields: [
        { id: 'invoiceNo', label: 'Invoice Number', type: 'text', required: true,
          help: 'As printed on the supplier invoice.' },
        { id: 'invoiceWeight', label: 'Invoice Weight', type: 'number', required: true,
          integer: true, min: 1,
          help: 'Whole kilograms, as on the invoice. No decimals, no spaces.' }
      ]},
      { title: 'Bags on this invoice', fields: [
        /* dependsOn: the list is reloaded whenever either answer changes.
           weightOf: the field the ticked total is compared with. */
        { id: 'bags', label: 'Bag Numbers', type: 'bagpick', required: true,
          source: '@invoiceBags', dependsOn: ['material', 'supplier'],
          weightOf: 'invoiceWeight',
          help: 'Only bags of this material and supplier that are on no invoice yet. ' +
                'The weights are the ones recorded on the Bag Form.' }
      ]}
    ]
  },

  // 22 ----------------------------------------------------------------------
  // Container Dispatch Details — what went into one container: the
  // container, a photo of it, supplier(s), client, and one block per
  // material. The Google Form behind the "Container Form" tab had FIVE fixed
  // material blocks; here there is one, and "Add another material" adds as
  // many more as the container holds. They land in the same columns the
  // Google Form fills — "Design Name (1)", "Size (1)", "Grade (1)",
  // "No. of Slabs (1)", ... — and a sixth block or more gets its columns
  // added at the end of the tab the first time it is used (fAppendRepeat_).
  container: {
    key: 'container',
    no: 22,
    title: 'Container Dispatch Details',
    abbr: 'CD',
    tab: 'Container Form',
    pages: 1,
    allowPrefill: false,     // every container is its own load
    keyField: 'container',
    /* Flagged in History, not refused: shipping containers are reused, so
       the same number can honestly come back on a later load. */
    dupCheck: true,
    /* The section marked `repeat` is the block. The count rides in
       values[repeat.countId]; fFormForValues_ (server) and expandRepeat
       (client) turn it into blocks 1..n with ids "design_1" and labels
       "Design Name (1)". */
    repeatSection: true,
    extraHeaders: ['Number of Materials'],
    /* Admins get "+ Design name" and "+ Size" at the top of the form; what
       they add is kept in the App Lists tab (FormsAdminLists.js). */
    adminLists: [
      { list: 'containerDesign', field: 'design', label: 'Design name' },
      { list: 'containerSize',   field: 'size',   label: 'Size' }
    ],
    sections: [
      { title: 'Container', fields: [
        { id: 'container', label: 'Container Number', type: 'text', required: true,
          help: 'As painted on the container, e.g. MSNU 3357199.' },
        { id: 'photo', label: 'Photo of Container', type: 'photo', required: true,
          help: 'Up to three photos. Wait for each one to finish uploading.' }
      ]},
      { title: 'Supplier & client', fields: [
        { id: 'supplier', label: 'Supplier', type: 'checkbox', required: true,
          options: FOPT.CONTAINER_SUPPLIER,
          help: 'Tick every supplier whose material is in this container.' },
        { id: 'client', label: 'Client Name ', type: 'select', required: true,
          options: FOPT.CONTAINER_CLIENT },
        { id: 'clientOther', label: 'Other Client Name ', type: 'text', required: true,
          showWhen: { field: 'client', eq: FOPT.CONTAINER_CLIENT_OTHER } }
      ]},
      { title: 'Material',
        repeat: { countId: 'materials', max: 30, add: 'Add another material' },
        fields: [
        { id: 'design', label: 'Design Name', type: 'select', required: true,
          options: FOPT.CONTAINER_DESIGN, extendable: 'containerDesign' },
        { id: 'size', label: 'Size', type: 'select', required: true,
          options: FOPT.CONTAINER_SIZE, extendable: 'containerSize' },
        { id: 'grade', label: 'Grade', type: 'radio', required: true,
          options: FOPT.CONTAINER_GRADE },
        { id: 'slabs', label: 'No. of Slabs', type: 'number', required: true,
          integer: true, min: 1 }
      ]}
    ]
  }
};

/* The dropdown the form actually shows: the eleven areas plus the escape
   hatch, built once so the two can never drift apart. */
FOPT.AREAS_ALL = FOPT.AREAS.concat([FOPT.AREA_OTHER]);


var FORM_KEYS = ['batching', 'resin', 'mixer', 'pressing', 'ovenIn',
                 'ovenOut', 'vacuum', 'trolley', 'calibration', 'qc',
                 'prodSummaryA', 'prodSummaryB', 'dispatch', 'gradeReport', 'bag',
                 'formula', 'bagInvoice', 'container'];
