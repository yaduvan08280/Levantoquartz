/**
 * Computed columns.
 *
 * A handful of columns in the old workbook were filled by spreadsheet
 * formulas, and the forms app reads them as plain data: today's slab numbers,
 * which bundles are filled, the list of every slab ever batched. They are
 * reproduced here as code — each provider below states the formula it stands
 * in for and follows it exactly, including the ranges it was limited to.
 *
 * A provider runs when one of the tabs it reads has changed since it last
 * ran, the first time anything asks for its tab. Its output is visible in the
 * raw-data view but is never stored and cannot be edited.
 */
import { type Cell, displayValue, isEmpty } from './values.js';
import { MAIN, Tab, Workbook, type ComputedRange } from './workbook.js';

interface Provider {
  tab: string;
  deps: string[];
  ranges: ComputedRange[];
  formulas?: [row: number, col: number, text: string][];
  /** Extra input that changes without any tab changing (the clock). */
  clock?: () => string;
  compute(wb: Workbook, tab: Tab): void;
}

const computeVersion = new WeakMap<Tab, number>();
const lastKey = new WeakMap<Tab, Map<Provider, string>>();
const wired = new WeakSet<Tab>();
const running = new Set<Tab>();

function text(tab: Tab, row: number, col: number): string {
  return displayValue(tab.get(row, col), tab.format(row, col));
}

function headerCol(tab: Tab, name: string, fallback: number): number {
  const want = name.replace(/\s+/g, '').toLowerCase();
  const n = tab.lastCol();
  for (let c = 1; c <= n; c++) {
    if (String(tab.get(1, c)).replace(/\s+/g, '').toLowerCase() === want) return c;
  }
  return fallback;
}

/** The production day: before 08:00 the night shift is still on yesterday's date. */
export function productionDate(now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < 8) d.setDate(d.getDate() - 1);
  return d;
}

function slabPrefix(line: string, d: Date): string {
  const yy = ('0' + (d.getFullYear() % 100)).slice(-2);
  const dd = ('0' + d.getDate()).slice(-2);
  return line + yy + String.fromCharCode(65 + d.getMonth()) + dd;
}

const SLAB_SEQUENCE = 110;       // SEQUENCE(110,1): slab numbers issued per line per day
const AVAILABLE_SCAN = 199;      // C2:C200

const providers: Provider[] = [

  /* Batching Form C  "Slab Numbers"
       =ARRAYFORMULA(Z2:Z & AA2:AA)
     One entry is on line A or line B; this is whichever slab number it has. */
  {
    tab: 'Batching Form',
    deps: ['Batching Form'],
    ranges: [{ firstRow: 2, firstCol: 3, lastCol: 3 }],
    formulas: [[2, 3, '=ARRAYFORMULA(Z2:Z & AA2:AA)']],
    compute(_wb, tab) {
      const a = headerCol(tab, 'Slab Number (A)', 26);
      const b = headerCol(tab, 'Slab Number (B)', 27);
      const out: Cell[] = [];
      /* Only as far down as there is an entry — the spreadsheet's formula
         spilled empty text to the bottom of the grid, which is what the app's
         "real last row" logic exists to see past. */
      let last = 1;
      for (let r = tab.rows.length; r >= 2; r--) {
        const row = tab.rows[r - 1];
        if (!row) continue;
        let any = false;
        for (let c = 0; c < row.length; c++) if (c !== 2 && !isEmpty(row[c])) { any = true; break; }
        if (any) { last = r; break; }
      }
      for (let r = 2; r <= last; r++) out.push(text(tab, r, a) + text(tab, r, b));
      tab.setComputedColumn(3, 2, out);
      tab.trimComputed();
    }
  },

  /* unique codes C2  =UNIQUE('Batching Form'!C2:C)
     Every slab number that has ever been batched, in the order it first
     appeared. This is the registry every stage's pick-list starts from. */
  {
    tab: 'unique codes',
    deps: ['Batching Form'],
    ranges: [{ firstRow: 2, firstCol: 3, lastCol: 3 }],
    formulas: [[2, 3, "=UNIQUE('Batching Form'!C2:C)"]],
    compute(wb, tab) {
      const src = wb.rawTab('Batching Form');
      const out: Cell[] = [];
      if (src) {
        /* UNIQUE keeps one blank, where the first blank row is. */
        const seen = new Set<string>();
        for (let r = 2; r <= src.rows.length; r++) {
          const v = text(src, r, 3);
          if (seen.has(v)) continue;
          seen.add(v);
          out.push(v);
        }
      }
      tab.setComputedColumn(3, 2, out);
      tab.trimComputed();
    }
  },

  /* Slab Numbers — today's numbers and the bundle bookkeeping. */
  {
    tab: 'Slab Numbers',
    deps: ['Batching Form', 'Vacuum Unloader', 'Trolley Form'],
    ranges: [
      { firstRow: 2, firstCol: 1, lastCol: 1 },     // A2
      { firstRow: 2, firstCol: 3, lastCol: 4 },     // C:D
      { firstRow: 3, firstCol: 6, lastCol: 7 },     // F:G
      { firstRow: 2, firstCol: 30, lastCol: 32 },   // AD:AF
      { firstRow: 2, firstCol: 34, lastCol: 36 },   // AH:AJ
      { firstRow: 2, firstCol: 38, lastCol: 39 }    // AL:AM
    ],
    formulas: [
      [2, 1, '=IF(HOUR(NOW())<8, TODAY()-1, TODAY())'],
      [2, 3, '="A" & TEXT($A$2, "yy") & CHAR(64+MONTH($A$2)) & TEXT($A$2, "dd") & TEXT(SEQUENCE(110,1), "000")'],
      [2, 4, '="B" & TEXT($A$2, "yy") & CHAR(64+MONTH($A$2)) & TEXT($A$2, "dd") & TEXT(SEQUENCE(110,1), "000")'],
      [3, 6, '=IFERROR(UNIQUE(FILTER(C2:C200, C2:C200<>"", COUNTIF(\'Batching Form\'!Z:Z, C2:C200)=0)), "")'],
      [3, 7, '=IFERROR(UNIQUE(FILTER(D2:D200, D2:D200<>"", COUNTIF(\'Batching Form\'!AA:AA, D2:D200)=0)), "")']
    ],
    clock: () => String(productionDate().getTime()),
    compute(wb, tab) {
      const day = productionDate();

      /* A2  =IF(HOUR(NOW())<8, TODAY()-1, TODAY()) */
      tab.setComputed(2, 1, day);

      /* C2, D2  ="A" & TEXT($A$2,"yy") & CHAR(64+MONTH($A$2)) & TEXT($A$2,"dd")
                     & TEXT(SEQUENCE(110,1),"000")                              */
      const lineA: string[] = [], lineB: string[] = [];
      for (let i = 1; i <= SLAB_SEQUENCE; i++) {
        const seq = ('00' + i).slice(-3);
        lineA.push(slabPrefix('A', day) + seq);
        lineB.push(slabPrefix('B', day) + seq);
      }
      tab.setComputedColumn(3, 2, lineA);
      tab.setComputedColumn(4, 2, lineB);

      /* F3, G3  =IFERROR(UNIQUE(FILTER(C2:C200, C2:C200<>"",
                     COUNTIF('Batching Form'!Z:Z, C2:C200)=0)), "")
         Today's numbers that Batching has not used yet. */
      const batching = wb.rawTab('Batching Form');
      const usedA = new Set<string>(), usedB = new Set<string>();
      if (batching) {
        for (let r = 1; r <= batching.rows.length; r++) {
          const a = text(batching, r, 26), b = text(batching, r, 27);
          if (a) usedA.add(a.toUpperCase());
          if (b) usedB.add(b.toUpperCase());
        }
      }
      const free = (list: string[], used: Set<string>) =>
        list.slice(0, AVAILABLE_SCAN).filter((v) => !used.has(v.toUpperCase()));
      tab.setComputedColumn(6, 3, free(lineA, usedA));
      tab.setComputedColumn(7, 3, free(lineB, usedB));

      /* AD2  one row per slab the Vacuum Unloader has put in a bundle:
           ARRAYFORMULA(LET(raw_B, 'Vacuum Unloader'!B2:B, raw_C, …!D2:D, raw_D, …!C2:C,
             split_D, IFERROR(TRIM(SPLIT(raw_D, ","))),
             combined, IF(raw_B="", , raw_B & "||" & raw_C & "||" & split_D), …
             VSTACK(headers, FILTER(result, INDEX(result,,3)<>""))))
         A row with no "Email address" is skipped, as the formula skips it. */
      const vEmail: Cell[] = ['Email address'], vBundle: Cell[] = ['Bundle Number'], vSlab: Cell[] = ['Slab Number'];
      const vacuum = wb.rawTab('Vacuum Unloader');
      if (vacuum) {
        for (let r = 2; r <= vacuum.rows.length; r++) {
          const email = text(vacuum, r, 2);
          if (email === '') continue;
          const bundle = text(vacuum, r, 4);
          for (const part of text(vacuum, r, 3).split(',')) {
            const slab = part.trim();
            if (!slab) continue;
            vEmail.push(email); vBundle.push(bundle); vSlab.push(slab);
          }
        }
      }
      tab.setComputedColumn(30, 2, vEmail);
      tab.setComputedColumn(31, 2, vBundle);
      tab.setComputedColumn(32, 2, vSlab);

      /* AH2  one row per slab the Trolley has taken out of a bundle:
           REDUCE({"Email","Bundle Number","Slab Number"},
             FILTER(ROW('Trolley Form'!A2:A), 'Trolley Form'!C2:C<>""), LAMBDA(acc, r,
               … TEXTJOIN(",", TRUE, INDEX('Trolley Form'!D:AV, r)) …))
         D:AV is BN01–BN45. The later bundle columns are not in the formula's
         range, so slabs unloaded from BN46–BN60 are never counted here. */
      const tEmail: Cell[] = ['Email'], tBundle: Cell[] = ['Bundle Number'], tSlab: Cell[] = ['Slab Number'];
      const trolley = wb.rawTab('Trolley Form');
      if (trolley) {
        for (let r = 2; r <= trolley.rows.length; r++) {
          const bundle = text(trolley, r, 3);
          if (bundle === '') continue;
          const email = text(trolley, r, 2);
          const joined: string[] = [];
          for (let c = 4; c <= 48; c++) {
            const v = text(trolley, r, c);
            if (v !== '') joined.push(v);
          }
          const raw = joined.join(',');
          if (raw === '') { tEmail.push(email); tBundle.push(bundle); tSlab.push(''); continue; }
          for (const part of raw.split(',')) {
            if (part === '') continue;
            tEmail.push(email); tBundle.push(bundle); tSlab.push(part.trim());
          }
        }
      }
      tab.setComputedColumn(34, 2, tEmail);
      tab.setComputedColumn(35, 2, tBundle);
      tab.setComputedColumn(36, 2, tSlab);

      /* AL2  slabs sitting in a bundle right now — loaded, not yet unloaded:
           IFERROR(FILTER(AE3:AF, ISNA(MATCH(AF3:AF, AJ3:AJ, 0)), AF3:AF<>""), "") */
      const unloaded = new Set<string>();
      for (let i = 1; i < tSlab.length; i++) {
        const s = String(tSlab[i]);
        if (s !== '') unloaded.add(s.toUpperCase());
      }
      const inBundle: Cell[] = [], inSlab: Cell[] = [];
      for (let i = 1; i < vSlab.length; i++) {
        const s = String(vSlab[i]);
        if (s === '' || unloaded.has(s.toUpperCase())) continue;
        inBundle.push(vBundle[i]); inSlab.push(s);
      }
      tab.setComputedColumn(38, 2, inBundle);
      tab.setComputedColumn(39, 2, inSlab);
      tab.trimComputed();
    }
  },

  /* Bundles
       D2  IFNA(LET(headers, D1:BL1, res, REDUCE(…, headers, LAMBDA(acc, b, HSTACK(acc,
             IFERROR(FILTER('Slab Numbers'!$AM$2:$AM63, 'Slab Numbers'!$AL$2:$AL63 = b), "")))), …), "")
       B2  TRANSPOSE(FILTER(D1:BL1, TRIM(D2:BL2)=""))     empty bundles
       C2  TRANSPOSE(FILTER(D1:BL1, TRIM(D2:BL2)<>""))    filled bundles
     The exported formula text names AM2:AM63, but the sheet's own results
     cover the whole in-bundle list, so the whole list is used. */
  {
    tab: 'Bundles',
    deps: ['Slab Numbers'],
    ranges: [
      { firstRow: 2, firstCol: 2, lastCol: 3 },
      { firstRow: 2, firstCol: 4, lastCol: 64 }
    ],
    formulas: [
      [2, 2, '=TRANSPOSE(FILTER(D1:BL1, TRIM(D2:BL2)=""))'],
      [2, 3, '=TRANSPOSE(FILTER(D1:BL1, TRIM(D2:BL2)<>""))']
    ],
    compute(wb, tab) {
      const sn = wb.rawTab('Slab Numbers');
      const pairs: [string, string][] = [];
      if (sn) {
        for (let r = 2; r <= sn.rows.length; r++) {
          pairs.push([text(sn, r, 38).toUpperCase(), text(sn, r, 39)]);
        }
      }
      const empty: Cell[] = [], filled: Cell[] = [];
      for (let c = 4; c <= 64; c++) {
        const name = text(tab, 1, c);
        const slabs: Cell[] = name === '' ? []
          : pairs.filter((p) => p[0] === name.toUpperCase() && p[0] !== '').map((p) => p[1]);
        tab.setComputedColumn(c, 2, slabs);
        if (name === '') continue;
        if (String(slabs[0] === undefined ? '' : slabs[0]).trim() === '') empty.push(name);
        else filled.push(name);
      }
      /* FILTER with nothing to return is an error cell, and that is what the
         sheet showed when every bundle was full (or every one empty). */
      tab.setComputedColumn(2, 2, empty.length ? empty : ['#N/A']);
      tab.setComputedColumn(3, 2, filled.length ? filled : ['#N/A']);
      tab.trimComputed();
    }
  },

  /* Feedback Response N1
       ={"Duplicate Check"; IF(C2:C="", "", IF(COUNTIF(C:C, C2:C)>1, "Duplicate", ""))} */
  {
    tab: 'Feedback Response',
    deps: ['Feedback Response'],
    ranges: [{ firstRow: 1, firstCol: 14, lastCol: 14 }],
    formulas: [[1, 14, '={"Duplicate Check"; ARRAYFORMULA(IF(C2:C="", "", IF(COUNTIF(C:C, C2:C)>1, "Duplicate", "")))}']],
    compute(_wb, tab) {
      const counts = new Map<string, number>();
      let last = 1;
      for (let r = 1; r <= tab.rows.length; r++) {
        const row = tab.rows[r - 1];
        if (row) for (let c = 0; c < row.length; c++) if (c !== 13 && !isEmpty(row[c])) { last = r; break; }
        const k = text(tab, r, 3).toUpperCase();
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
      const out: Cell[] = ['Duplicate Check'];
      for (let r = 2; r <= last; r++) {
        const k = text(tab, r, 3).toUpperCase();
        out.push(k && (counts.get(k) || 0) > 1 ? 'Duplicate' : '');
      }
      tab.setComputedColumn(14, 1, out);
      tab.trimComputed();
    }
  }
];

const byTab = new Map<string, Provider[]>();
for (const p of providers) {
  const list = byTab.get(p.tab) || [];
  list.push(p);
  byTab.set(p.tab, list);
}

export function hasComputed(name: string): boolean { return byTab.has(name); }

function versionOf(tab: Tab | null, self: Tab): string {
  if (!tab) return '-';
  /* A tab's own computed output must not count as a change to itself. */
  return tab === self ? String(tab.version) : tab.version + '.' + (computeVersion.get(tab) || 0);
}

/** Bring one tab's computed columns up to date. Installed as Workbook.freshHook. */
export function ensureFresh(wb: Workbook, tab: Tab): void {
  if (tab.book !== MAIN) return;                 // these are New Base's formulas
  const list = byTab.get(tab.name);
  if (!list || running.has(tab)) return;
  running.add(tab);
  try {
    if (!wired.has(tab)) {
      tab.computed = list.flatMap((p) => p.ranges);
      tab.formulas = new Map();
      list.forEach((p) => (p.formulas || []).forEach(([r, c, f]) => tab.formulas.set(r + ':' + c, f)));
      wired.add(tab);
    }
    let keys = lastKey.get(tab);
    if (!keys) { keys = new Map(); lastKey.set(tab, keys); }
    for (const p of list) {
      for (const d of p.deps) {
        if (d === tab.name) continue;
        const dep = wb.rawTab(d);
        if (dep) ensureFresh(wb, dep);
      }
      const key = p.deps.map((d) => versionOf(wb.rawTab(d), tab)).join('|') + '|' + (p.clock ? p.clock() : '');
      if (keys.get(p) === key) continue;
      p.compute(wb, tab);
      keys.set(p, key);
      computeVersion.set(tab, (computeVersion.get(tab) || 0) + 1);
    }
  } finally {
    running.delete(tab);
  }
}

/** Recompute everything — after a load or an import. */
export function refreshAll(wb: Workbook): void {
  for (const name of byTab.keys()) {
    const t = wb.rawTab(name);
    if (t) ensureFresh(wb, t);
  }
}

export function installComputed(wb: Workbook): void {
  wb.freshHook = ensureFresh;
}
