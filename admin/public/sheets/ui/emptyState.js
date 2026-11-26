// ============================================================
//  Mono — shared empty-state component (U5)
//  icon + one-line message + optional CTA button — the one pattern
//  reused anywhere a whole list/panel (not a table cell) can be
//  empty, instead of ad-hoc "no data" text.
// ============================================================
import { icon } from './icons.js';

const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {{icon?:string, message:string, ctaLabel?:string, ctaOnclick?:string}} opts
 *   `ctaOnclick` is raw JS passed straight into an inline onclick attribute
 *   (consistent with the rest of this codebase's event wiring style).
 * @returns {string} HTML markup
 */
export function emptyStateHTML({ icon: iconName = 'grid', message, ctaLabel, ctaOnclick } = {}) {
  return `<div class="empty-state">
    <div>${icon(iconName, { size: 30 })}</div>
    <div class="es-msg">${escH(message)}</div>
    ${ctaLabel ? `<button class="btn btn-primary" onclick="${ctaOnclick || ''}">${escH(ctaLabel)}</button>` : ''}
  </div>`;
}
export default emptyStateHTML;
