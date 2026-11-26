// ============================================================
//  Mono — XLSX (OOXML) importer  [Unified Import v1]  FULL FIDELITY
//  ------------------------------------------------------------
//  Parses a real .xlsx into a SheetImage, capturing:
//   • values + formulas (with cached results)
//   • number formats (builtin + custom)
//   • fonts (bold/italic/underline/strike/colour/family/size)
//   • fills (background colour)
//   • borders (per side style + colour)
//   • alignment (h/v) + wrap
//   • merged cells, frozen panes
//   • column widths + hidden columns, row heights + hidden rows
//   • data validation (dropdowns / checkboxes / lists)
//   • conditional formatting (ranges + resolved differential style)
//   • hidden sheets
//
//  SheetJS's free build drops styling, so we parse the OOXML parts
//  ourselves. Runs in the browser/Electron (uses DOMParser +
//  DecompressionStream). Protected ranges are intentionally skipped.
// ============================================================
import { zipDirectory, openEntryStream } from './zipReader.js';
import { streamSheetBytes } from './xlsxStream.js';
import { CellStore } from '../model/columnStore.js';
import { emptyImage, emptySheetImage, normStyle } from './sheetImage.js';

/* ---------- A1 helpers ---------- */
function lettersToCol(s) { let c = 0; for (const ch of String(s).toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; }
function parseA1(a1) { const m = /^([A-Z]+)(\d+)$/.exec(String(a1).toUpperCase()); if (!m) return null; return { c: lettersToCol(m[1]), r: parseInt(m[2], 10) - 1 }; }
function parseRange(ref) {
  const [a, b] = String(ref).split(':');
  const p1 = parseA1(a); const p2 = b ? parseA1(b) : p1;
  if (!p1 || !p2) return null;
  return { r1: Math.min(p1.r, p2.r), c1: Math.min(p1.c, p2.c), r2: Math.max(p1.r, p2.r), c2: Math.max(p1.c, p2.c) };
}

/* ---------- XML helpers ---------- */
function parseXml(text) {
  if (typeof DOMParser === 'undefined') throw new Error('DOMParser unavailable — open .xlsx in the app (browser) environment');
  return new DOMParser().parseFromString(text, 'application/xml');
}
const tags = (el, name) => (el ? Array.from(el.getElementsByTagNameNS('*', name)) : []);
const tag1 = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
const attr = (el, name) => (el ? el.getAttribute(name) : null);

/* ---------- colour resolution ---------- */
const INDEXED = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#808080'];
const THEME = ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
function colorHex(colorEl) {
  if (!colorEl) return null;
  const rgb = attr(colorEl, 'rgb');
  if (rgb) return '#' + rgb.slice(-6).toUpperCase();
  const idx = attr(colorEl, 'indexed');
  if (idx != null && INDEXED[+idx]) return INDEXED[+idx];
  const theme = attr(colorEl, 'theme');
  if (theme != null) {
    let hex = THEME[+theme] || null;
    const tint = parseFloat(attr(colorEl, 'tint') || '0');
    if (hex && tint) hex = applyTint(hex, tint);
    return hex;
  }
  return null;
}
function applyTint(hex, tint) {
  const n = parseInt(hex.slice(1), 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => tint < 0 ? Math.round(v * (1 + tint)) : Math.round(v * (1 - tint) + 255 * tint);
  r = f(r); g = f(g); b = f(b);
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* ---------- number formats ---------- */
const BUILTIN_NF = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 44: '_("$"* #,##0.00_)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@' };
function isDateFmt(code) { return code && /[dmyhs]/i.test(code) && !/[#0]/.test(code.replace(/\[[^\]]*\]/g, '')); }

/* ---------- styles.xml ---------- */
function parseStyles(doc) {
  const numFmts = {};
  for (const nf of tags(doc, 'numFmt')) numFmts[attr(nf, 'numFmtId')] = attr(nf, 'formatCode');
  const nfCode = (id) => numFmts[id] != null ? numFmts[id] : BUILTIN_NF[id];

  const fontsEl = tag1(doc, 'fonts');
  const fonts = tags(fontsEl, 'font').map((f) => ({
    b: !!tag1(f, 'b'), i: !!tag1(f, 'i'), u: !!tag1(f, 'u'), s: !!tag1(f, 'strike'),
    fc: colorHex(tag1(f, 'color')),
    ff: attr(tag1(f, 'name'), 'val') || attr(tag1(f, 'rFont'), 'val') || null,
    fs: attr(tag1(f, 'sz'), 'val') ? Math.round(+attr(tag1(f, 'sz'), 'val')) : null,
  }));

  const fillsEl = tag1(doc, 'fills');
  const fills = tags(fillsEl, 'fill').map((f) => {
    const pf = tag1(f, 'patternFill');
    if (!pf) return null;
    const type = attr(pf, 'patternType');
    if (!type || type === 'none') return null;
    return colorHex(tag1(pf, 'fgColor'));
  });

  const bordersEl = tag1(doc, 'borders');
  const borders = tags(bordersEl, 'border').map((bd) => {
    const side = (nm) => { const e = tag1(bd, nm); if (!e) return null; const style = attr(e, 'style'); if (!style || style === 'none') return null; return { style: mapBorderStyle(style), color: colorHex(tag1(e, 'color')) || '#000000' }; };
    const out = {}; const t = side('top'), r = side('right'), b = side('bottom'), l = side('left');
    if (t) out.t = t; if (r) out.r = r; if (b) out.b = b; if (l) out.l = l;
    return Object.keys(out).length ? out : null;
  });

  const cellXfsEl = tag1(doc, 'cellXfs');
  const xfs = tags(cellXfsEl, 'xf').map((xf) => resolveXf(xf, { fonts, fills, borders, nfCode }));

  // dxfs — differential formats used by conditional formatting.
  const dxfsEl = tag1(doc, 'dxfs');
  const dxfs = tags(dxfsEl, 'dxf').map((dxf) => {
    const st = {}; const font = tag1(dxf, 'font');
    if (font) { if (tag1(font, 'b')) st.b = true; if (tag1(font, 'i')) st.i = true; const fc = colorHex(tag1(font, 'color')); if (fc) st.fg = fc; }
    const fill = tag1(dxf, 'fill'); if (fill) { const bg = colorHex(tag1(tag1(fill, 'patternFill') || fill, 'bgColor')) || colorHex(tag1(tag1(fill, 'patternFill') || fill, 'fgColor')); if (bg) st.bg = bg; }
    return normStyle(st);
  });

  return { xfs, dxfs, nfCode };
}
function mapBorderStyle(s) { if (/dash/i.test(s)) return 'dashed'; if (/dot/i.test(s)) return 'dotted'; if (/double/i.test(s)) return 'double'; return 'solid'; }
function resolveXf(xf, res) {
  const st = {};
  const fontId = +attr(xf, 'fontId') || 0; const f = res.fonts[fontId];
  if (f) { if (f.b) st.b = true; if (f.i) st.i = true; if (f.u) st.u = true; if (f.s) st.s = true; if (f.fc && f.fc !== '#000000') st.fg = f.fc; if (f.ff && f.ff !== 'Calibri') st.ff = f.ff; if (f.fs && f.fs !== 11) st.fs = f.fs; }
  const fillId = +attr(xf, 'fillId') || 0; const bg = res.fills[fillId]; if (bg && bg !== '#FFFFFF') st.bg = bg;
  const borderId = +attr(xf, 'borderId') || 0; const bd = res.borders[borderId]; if (bd) st.bd = bd;
  const al = tag1(xf, 'alignment');
  if (al) {
    // Full CSS words, not initials. The grid pushes these straight into a
    // style attribute, so 'c' became "text-align:c" — invalid, silently
    // dropped by every browser. setAlign()/setVAlign() in grid.js have always
    // written 'center' / 'middle'; only this importer spoke initials.
    const h = attr(al, 'horizontal'); if (h === 'center' || h === 'right' || h === 'left') st.ha = h;
    const v = attr(al, 'vertical');
    if (v === 'top') st.va = 'top'; else if (v === 'center') st.va = 'middle'; else if (v === 'bottom') st.va = 'bottom';
    if (attr(al, 'wrapText') === '1') st.wrap = 1;
  }
  const numFmtId = attr(xf, 'numFmtId');
  const nf = numFmtId != null ? res.nfCode(numFmtId) : null;
  return { st: normStyle(st), nf: nf && nf !== 'General' ? nf : null };
}

/* ---------- shared strings ---------- */
function parseSharedStrings(doc) {
  if (!doc) return [];
  return tags(doc, 'si').map((si) => tags(si, 't').map((t) => t.textContent).join(''));
}

/* ---------- date serial ---------- */
function serialToDate(n) {
  // Excel epoch 1899-12-30 (accounts for the 1900 leap-year bug)
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d)) return null;
  const pad = (x) => String(x).padStart(2, '0');
  if (n < 1) return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/* ---------- Google Sheets' unexportable-formula stub ----------
   Exporting a Google Sheet to .xlsx rewrites any formula Excel cannot express
   (ARRAYFORMULA, LET over a whole column, QUERY, custom functions) as

       =IFERROR(__xludf.DUMMYFUNCTION("""COMPUTED_VALUE"""), <last computed value>)

   Excel shows #NAME? for these because __xludf.DUMMYFUNCTION does not exist —
   that is what the user sees in Excel too, not a Mono bug. The real formula is
   NOT in the file and cannot be recovered from it; the only thing Google
   preserved is the value, sitting in the IFERROR fallback.

   Measured on a real 25-sheet export: 30,000 of 31,409 formulas were these
   stubs. Evaluating each one — fail the lookup, build a #NAME? error, let
   IFERROR swallow it — cost ~280 us, so recalcAll took 9.0 s and EVERY edit
   paid it again: insert row 9,387 ms, clear one cell 8,927 ms.

   So take the value Google left and drop the dead stub. Returns the literal
   text, or null when this is not a stub. */
/** True when (r,c) holds the cached OUTPUT of an array formula anchored
    elsewhere: inside one of `ranges` but not its top-left cell. Excel writes
    those cells with a <v> and no <f> of their own. Importing them as literals
    puts data inside the anchor's spill range and blocks it, so the anchor
    shows #SPILL! and the column freezes at whatever the exporter last
    computed. They must be left empty for the anchor to fill. */
export function isCachedArrayOutput(ranges, r, c) {
  return ranges.some((a) => r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2
    && !(r === a.r1 && c === a.c1));
}
export function xludfFallback(formula) {
  const HEAD = '=IFERROR(__xludf.DUMMYFUNCTION(';
  if (typeof formula !== 'string' || !formula.startsWith(HEAD)) return null;
  // Walk to the ')' that closes DUMMYFUNCTION, respecting quotes.
  let i = HEAD.length, depth = 1, q = false;
  for (; i < formula.length && depth > 0; i++) {
    const ch = formula[i];
    if (q) { if (ch === '"') q = false; continue; }
    if (ch === '"') q = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  if (depth !== 0 || formula[i] !== ',') return null;
  const tail = formula.slice(i + 1).trim();
  if (!tail.endsWith(')')) return null;
  const arg = tail.slice(0, -1).trim();
  if (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) {
    return arg.slice(1, -1).replace(/""/g, '"');     // xlsx doubles inner quotes
  }
  return arg;                                        // a number, TRUE/FALSE, or empty
}

/* ---------- worksheet ---------- */
function parseSheet(doc, meta, styles, sst, index) {
  const s = emptySheetImage(meta.name, index);
  s.hidden = meta.state === 'hidden' || meta.state === 'veryHidden';

  const fmt = tag1(doc, 'sheetFormatPr');
  const defColW = fmt ? +attr(fmt, 'defaultColWidth') || 0 : 0;

  // columns: widths + hidden
  for (const col of tags(tag1(doc, 'cols'), 'col')) {
    const min = +attr(col, 'min'), max = +attr(col, 'max');
    const width = +attr(col, 'width');
    const hidden = attr(col, 'hidden') === '1';
    for (let c = min - 1; c <= max - 1; c++) {
      if (width && attr(col, 'customWidth') === '1') s.colWidths[c] = Math.round(width * 7 + 5); // char->px approx
      if (hidden) s.hiddenCols.push(c);
    }
  }

  // frozen panes
  const pane = tag1(doc, 'pane');
  if (pane && (attr(pane, 'state') === 'frozen' || attr(pane, 'state') === 'frozenSplit')) {
    s.frozen = { rows: Math.round(+attr(pane, 'ySplit') || 0), cols: Math.round(+attr(pane, 'xSplit') || 0) };
  }

  // rows + cells
  let maxR = 0, maxC = 0;
  /* Excel marks a spilled array formula on its top-left cell only:
       <c r="H7"><f t="array" ref="H7:H3614">IF(G7:G3614="",...)</f><v>..</v></c>
     Every other cell of that ref carries just the CACHED value, with no <f>
     of its own. Two things follow, and both used to be lost on import:
       * t="array" means "evaluate in array mode" - exactly what ARRAYFORMULA
         does here. Without it a formula like IF(G7:G3614="",..) collapses to
         a single value and returns #VALUE!.
       * the cached cells are that formula's OUTPUT, not data. Imported as
         literals they sat inside the spill range and blocked it, so the
         anchor rendered #SPILL! and the column showed frozen values that
         could never recompute. A Google Sheets export writes every array
         formula this way, so this hit whole columns at a time.
     ponytail: linear scan of the ranges per cell. Real sheets have a handful
     (16 in the workbook this came from); index by column if one ever has
     thousands. */
  const arrayRanges = [];
  for (const row of tags(tag1(doc, 'sheetData'), 'row')) {
    const r = (+attr(row, 'r') || 0) - 1;
    if (r < 0) continue;
    if (attr(row, 'hidden') === '1') s.hiddenRows.push(r);
    const ht = attr(row, 'ht'); if (ht && attr(row, 'customHeight') === '1') s.rowHeights[r] = Math.round(+ht * 1.33);
    for (const c of tags(row, 'c')) {
      const pos = parseA1(attr(c, 'r')); if (!pos) continue;
      const type = attr(c, 't');
      const sIdx = +attr(c, 's') || 0;
      const xf = styles.xfs[sIdx] || { st: null, nf: null };
      const fEl = tag1(c, 'f');
      const vEl = tag1(c, 'v');
      const isEl = tag1(c, 'is');
      const cell = {};

      if (fEl) {
        const f = '=' + fEl.textContent;
        const stub = xludfFallback(f);
        if (stub !== null) { if (stub !== '') cell.raw = stub; }
        else {
          // Only claim the spill range when the formula is actually kept - a
          // stub cannot recompute the cells below it, so their cached values
          // are the only copy of that data and must stay.
          const aRef = attr(fEl, 't') === 'array' ? parseRange(attr(fEl, 'ref')) : null;
          if (aRef) arrayRanges.push(aRef);
          cell.raw = (aRef && !/^=\s*ARRAYFORMULA\s*\(/i.test(f)) ? '=ARRAYFORMULA(' + f.slice(1) + ')' : f;
          if (vEl) cell.dv = vEl.textContent;
        }
      } else if (isCachedArrayOutput(arrayRanges, pos.r, pos.c)) {
        // Output of an array formula above/left of here: leave it empty so the
        // anchor can spill into it. Styling below still applies.
      } else if (type === 's') {
        cell.raw = sst[+vEl?.textContent] ?? '';
      } else if (type === 'inlineStr' || (isEl && !vEl)) {
        cell.raw = tags(isEl, 't').map((t) => t.textContent).join('');
      } else if (type === 'str') {
        cell.raw = vEl ? vEl.textContent : '';
      } else if (type === 'b') {
        cell.raw = vEl && vEl.textContent === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        cell.raw = vEl ? vEl.textContent : '#ERR';
      } else if (vEl != null) {
        // number — convert to a date/time string if the format is a date format
        const num = vEl.textContent;
        if (xf.nf && isDateFmt(xf.nf) && num !== '' && !isNaN(+num)) {
          cell.raw = serialToDate(+num) || String(num);
        } else cell.raw = String(num);
      }

      if (xf.st) cell.st = xf.st;
      if (xf.nf) cell.nf = xf.nf;
      if (cell.raw != null || cell.st || cell.nf) {
        s.cells[pos.r + ',' + pos.c] = cell;
        if (pos.r > maxR) maxR = pos.r; if (pos.c > maxC) maxC = pos.c;
      }
    }
  }

  // merged cells
  for (const mc of tags(tag1(doc, 'mergeCells'), 'mergeCell')) {
    const rng = parseRange(attr(mc, 'ref')); if (rng) s.merges.push(rng);
  }

  // data validation (dropdowns / checkboxes / lists)
  for (const dv of tags(doc, 'dataValidation')) {
    const type = attr(dv, 'type') || 'list';
    const sqref = attr(dv, 'sqref') || '';
    const f1 = tag1(dv, 'formula1');
    let values = [];
    if (f1) {
      const raw = f1.textContent.trim();
      if (/^".*"$/.test(raw)) values = raw.slice(1, -1).split(',').map((x) => x.trim());
    }
    let kind = type;
    if (type === 'list') {
      const up = values.map((v) => v.toUpperCase());
      kind = (values.length === 2 && up.includes('TRUE') && up.includes('FALSE')) ? 'checkbox' : 'list';
    }
    for (const ref of sqref.split(/\s+/).filter(Boolean)) {
      const rng = parseRange(ref);
      if (rng) s.validations.push({ ...rng, kind, values, allowInvalid: attr(dv, 'allowBlank') === '1' });
    }
  }

  // conditional formatting
  for (const cf of tags(doc, 'conditionalFormatting')) {
    const sqref = attr(cf, 'sqref') || '';
    for (const rule of tags(cf, 'cfRule')) {
      const dxfId = attr(rule, 'dxfId');
      const style = dxfId != null ? styles.dxfs[+dxfId] || null : null;
      for (const ref of sqref.split(/\s+/).filter(Boolean)) {
        const rng = parseRange(ref);
        if (rng) s.conditionalFormats.push({ ...rng, type: attr(rule, 'type') || 'expression', op: attr(rule, 'operator') || '', formula: tags(rule, 'formula').map((f) => f.textContent), style });
      }
    }
  }

  s.rows = Math.max(50, maxR + 1, s.hiddenRows.length ? Math.max(...s.hiddenRows) + 1 : 0);
  s.cols = Math.max(26, maxC + 1);
  // colMeta from header row so re-imports line up with structural sync
  s.colMeta = [];
  for (let c = 0; c < s.cols; c++) {
    const h = s.cells['0,' + c]?.raw || '';
    s.colMeta.push({ id: h ? 'h:' + String(h).toLowerCase() : 'pos:' + c, header: String(h) });
  }
  return s;
}

/* ---------- top level ---------- */
export async function readXlsxImage(input, name = 'Imported workbook', { onProgress } = {}) {
  // zipDirectory, not readZip: readZip inflates EVERY entry up front, which on
  // a big workbook means materialising the worksheet before anything has
  // looked at how large it is. Read the directory, then inflate on demand.
  const dir = zipDirectory(input);
  const textOf = async (path) => {
    const e = dir.get(path);
    return e ? new Response(openEntryStream(input, e)).text() : null;
  };

  const stylesDoc = await textOf('xl/styles.xml');
  const styles = stylesDoc ? parseStyles(parseXml(stylesDoc)) : { xfs: [], dxfs: [], nfCode: () => null };
  const sstDoc = await textOf('xl/sharedStrings.xml');
  const sst = sstDoc ? parseSharedStrings(parseXml(sstDoc)) : [];

  const wbDoc = parseXml(await textOf('xl/workbook.xml'));
  const relsDoc = parseXml((await textOf('xl/_rels/workbook.xml.rels')) || '<x/>');
  const relMap = {};
  for (const rel of tags(relsDoc, 'Relationship')) relMap[attr(rel, 'Id')] = attr(rel, 'Target');

  const image = emptyImage({ kind: 'xlsx', name });
  const sheetEls = tags(tag1(wbDoc, 'sheets'), 'sheet');
  let idx = 0;
  for (const sheetEl of sheetEls) {
    const rid = attr(sheetEl, 'r:id') || attr(sheetEl, 'id');
    let target = relMap[rid] || ('worksheets/sheet' + (idx + 1) + '.xml');
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^xl\//, '').replace(/^\//, '');
    const entry = dir.get(target) || dir.get('xl/' + target.replace(/^xl\//, ''));
    if (!entry) { idx++; continue; }
    const meta = { name: attr(sheetEl, 'name') || ('Sheet' + (idx + 1)), state: attr(sheetEl, 'state') || 'visible' };
    if (entry.size > STREAM_ABOVE_BYTES) {
      image.sheets.push(await streamSheetImage(input, entry, meta, styles, sst, idx, onProgress));
    } else {
      image.sheets.push(parseSheet(parseXml(await new Response(openEntryStream(input, entry)).text()), meta, styles, sst, idx));
    }
    idx++;
  }
  return image;
}

/* ---------- streaming path, for a worksheet too big to materialise ----------
   The DOM path stays the default below this threshold. Above it the numbers
   stop working: a 1,000,000 x 10 sheet is 431.8 MB of XML and a
   452,778,215-character string, against V8's 536,870,888 ceiling — the same
   sheet at 12 columns throws RangeError outright. DOMParser then builds ~21M
   nodes (21.2 s in Chrome) and the cell loop makes 30M getElementsByTagNameNS
   calls; measured end to end in a browser, the tab never finished.

   64 MB of XML is roughly 150,000 cells, comfortably inside what the DOM path
   handles today, so nothing that already works changes path. */
export const STREAM_ABOVE_BYTES = 64 * 1024 * 1024;

/* The OOXML grid: 1,048,576 rows by 16,384 columns (column XFD). */
export const XLSX_MAX_ROWS = 1048576;
export const XLSX_MAX_COLS = 16384;

async function streamSheetImage(input, entry, meta, styles, sst, index, onProgress) {
  const s = emptySheetImage(meta.name, index);
  s.hidden = meta.state === 'hidden' || meta.state === 'veryHidden';
  // A CellStore, not a plain object: 10,000,000 keys on an object is what made
  // toJSON() run 20 minutes without finishing, and MonoSheet adopts a
  // CellStore directly rather than copying every cell back out of it.
  const cells = new CellStore();
  const stPool = new Map();                     // intern styles as they arrive

  const put = (r, c, cell, sIdx) => {
    const xf = styles.xfs[sIdx];
    if (xf) {
      if (xf.st) {
        const sig = JSON.stringify(xf.st);
        let canon = stPool.get(sig);
        if (!canon) { canon = xf.st; stPool.set(sig, canon); }
        cell.st = canon;
      }
      if (xf.nf) cell.nf = xf.nf;
    }
    cells.setAt(r, c, cell);
  };
  const dateAware = (v, sIdx) => {
    const xf = styles.xfs[sIdx];
    return (xf && xf.nf && isDateFmt(xf.nf) && v !== '' && !isNaN(+v)) ? (serialToDate(+v) || String(v)) : String(v);
  };
  const isDateCol = (sIdx) => { const xf = styles.xfs[sIdx]; return !!(xf && xf.nf && isDateFmt(xf.nf)); };

  await streamSheetBytes(openEntryStream(input, entry), {
    onProgress,
    onRowFlag(r, kind, v) { if (kind === 'hidden' && v === '1') s.hiddenRows.push(r); },
    // The number goes in AS A NUMBER. Stringifying it here only for CellStore
    // to call Number() and String() straight back on it round-trips every cell
    // through two throwaway strings: 56.6 s on a 10,000,000-cell sheet. A
    // numeric raw is already a first-class shape in the store — it is what
    // decode() hands back for a tiled cell — and the engine treats any raw
    // whose [0] is not '=' as a literal, which a number satisfies.
    onNumber(r, c, n, sIdx) { put(r, c, { raw: isDateCol(sIdx) ? dateAware(n, sIdx) : n }, sIdx); },
    onCell(r, c, kind, v, sIdx) {
      if (kind === 'fv') return;                // cached value; the engine recomputes
      let raw;
      if (kind === 'f') {
        const stub = xludfFallback('=' + v);
        if (stub !== null) { if (stub === '') { put(r, c, {}, sIdx); return; } raw = stub; }
        else raw = '=' + v;
      }
      else if (kind === 's') raw = sst[+v] ?? '';
      else if (kind === 'b') raw = v === '1' ? 'TRUE' : 'FALSE';
      else if (kind === 'style') { put(r, c, {}, sIdx); return; }
      else if (kind === 'n') raw = dateAware(v, sIdx);
      else raw = v;                             // str | inline | e
      put(r, c, { raw }, sIdx);
    },
  });

  s.cells = cells;
  let maxR = 0, maxC = 0;
  for (const k of cells.keys()) {
    const i = k.indexOf(',');
    const r = +k.slice(0, i), c = +k.slice(i + 1);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  // Clamp to the OOXML grid. A corrupt or hostile r="999999999999" otherwise
  // becomes sheet.rows, and the grid then tries to size a scroller for 10^12
  // rows. No real file exceeds these, so clamping cannot lose data.
  s.rows = Math.min(maxR + 1, XLSX_MAX_ROWS);
  s.cols = Math.min(maxC + 1, XLSX_MAX_COLS);
  // ponytail: merges, data validation, conditional formats, column widths and
  // frozen panes are skipped on this path. They live outside <sheetData> and
  // the byte scanner only understands row/c/v/f/is. A sheet this size is a
  // machine-generated dump, which does not carry them. Upgrade path: have
  // streamSheetBytes hand back the non-sheetData spans, which are tiny, and
  // run the existing DOM parsers over just those.
  return s;
}

