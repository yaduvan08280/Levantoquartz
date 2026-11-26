// ============================================================
//  Mono — Patch Diff Preview (P13; P16 version-history reuses it)
//  Renders host-vocabulary ops ({type:'setCell'|'batch'|'insertRow'
//  |'deleteRow'}) as a before → after diff. buildDiffRows() emits
//  the [{sheet, cell, before, after}] shape the roadmap locks for
//  P16's version-diff view.
// ============================================================
import { addrToA1 } from '../model/workbook.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Flattens canonical ops into displayable diff rows.
 * @param {Array} ops - canonical host ops
 * @param {MonoWorkbook} wb
 * @param {string} [sid] - target sheet id (defaults to active sheet)
 * @returns {Array<{sheet:string, cell:string, before:string, after:string, kind:string}>}
 */
export function buildDiffRows(ops, wb, sid) {
  const targetSid = sid || (wb && wb.activeSheetId);
  const sh = wb && wb.sheets ? wb.sheets.find((s) => s.id === targetSid) : null;
  const sheetName = sh ? sh.name : '';
  const rows = [];
  const cellRow = (r, c, raw) => rows.push({
    sheet: sheetName, cell: addrToA1(r, c),
    before: sh ? sh.getRaw(r, c) : '', after: raw ?? '', kind: 'setCell',
  });
  for (const op of ops || []) {
    if (op.type === 'setCell') cellRow(op.r, op.c, op.raw);
    else if (op.type === 'batch') for (const cl of op.cells || []) cellRow(cl.r, cl.c, cl.raw);
    else if (op.type === 'insertRow') {
      rows.push({ sheet: sheetName, cell: `row ${op.afterR + 2}`, before: '', after: '(new row)', kind: 'insertRow' });
      for (const cl of op.cells || []) cellRow(cl.r, cl.c, cl.raw);
    } else if (op.type === 'deleteRow') {
      rows.push({ sheet: sheetName, cell: `row ${op.r + 1}`, before: '(entire row)', after: '(deleted)', kind: 'deleteRow' });
    }
  }
  return rows;
}

/**
 * Renders a visual summary of what the patch will do.
 * @param {Array} ops - canonical host ops (run through normalizeOps first)
 * @param {MonoWorkbook} wb
 * @param {string} [sid]
 * @returns {string} HTML
 */
export function renderDiffPreview(ops, wb, sid) {
  const rows = buildDiffRows(ops, wb, sid);
  if (!rows.length) return '<div class="diff-preview empty">No changes proposed.</div>';

  let html = '<div class="diff-preview" style="font-size:11px; font-family:monospace; background:var(--bg-1); padding:8px; border-radius:4px; border:1px solid var(--border); overflow-y:auto; max-height:200px;">';
  for (const row of rows) {
    const mark = row.kind === 'deleteRow' ? '<span style="color:var(--ui-red)">−</span>' : '<span style="color:var(--ui-green)">+</span>';
    const before = row.before === '' ? '<i style="color:var(--tx-3)">empty</i>' : esc(row.before);
    html += `<div style="color:var(--tx-2);">${mark} <b style="color:var(--tx-1)">${esc(row.sheet)}!${esc(row.cell)}</b>: ${before} → <span style="color:var(--ui-blue)">${esc(row.after)}</span></div>`;
  }
  html += '</div>';
  return html;
}

