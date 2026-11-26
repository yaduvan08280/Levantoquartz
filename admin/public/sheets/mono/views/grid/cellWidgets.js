// ============================================================
//  Mono — Grid cell widgets  (P10)
//
//  Helpers called by the grid renderer to produce rich cell HTML
//  for declared column types. Each function returns an HTML string.
//
//  widgetFor(sheet, c, value, engine) → string|null
//    — central dispatcher; returns HTML to inject inside a <td>,
//      or null to fall through to the plain display value.
//
//  Individual helpers (also exported for unit tests):
//    renderStars(n, max)      — rating widget
//    renderBar(pct)           — progress bar
//    renderBadge(text, cls)   — coloured text badge
// ============================================================
import { cellTypeFor } from '../../model/cellTypes.js';

/** @param {number} n @param {number} [max=5] @returns {string} */
export function renderStars(n, max = 5) {
  let html = '';
  for (let i = 1; i <= max; i++) {
    html += `<span class="ct-star${i <= n ? ' filled' : ''}">${i <= n ? '★' : '☆'}</span>`;
  }
  return `<span class="ct-rating">${html}</span>`;
}

/** @param {number} pct  0–100 @returns {string} */
export function renderBar(pct) {
  const safe = Math.min(100, Math.max(0, pct));
  return `<span class="ct-progress-bar" title="${safe}%"><span class="ct-progress-fill" style="width:${safe}%"></span><span class="ct-progress-label">${safe}%</span></span>`;
}

/** @param {string} text @param {string} [cls=''] @returns {string} */
export function renderBadge(text, cls = '') {
  const esc = String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<span class="ct-badge${cls ? ' ' + cls : ''}">${esc}</span>`;
}

/**
 * Central dispatcher.  Returns HTML string or null.
 * @param {MonoSheet}  sheet
 * @param {number}     c       — column index
 * @param {*}          value   — computed cell value (from engine.getValue)
 * @param {Engine}     [engine]
 * @returns {string|null}
 */
export function widgetFor(sheet, c, value, _engine) {
  const ct = cellTypeFor(sheet, c);
  if (!ct || !ct.renderHint) return null;
  const hint = ct.renderHint(value);
  if (!hint) return null;
  return hint.html ?? null;
}
