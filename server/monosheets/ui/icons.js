// ============================================================
//  Mono — self-hosted icon system (U1 foundation)
//  Inline-SVG icon set in a Lucide-compatible stroke style — no
//  runtime CDN dependency, no Unicode glyphs anywhere in the app.
//  Usage: icon('undo') or icon('undo', { size: 18, strokeWidth: 2 })
// ============================================================

// Each entry is the *inner* SVG markup for a 24x24 stroke-based glyph.
const PATHS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  'row-insert': '<rect x="3" y="3" width="18" height="5" rx="1"/><rect x="3" y="16" width="18" height="5" rx="1"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>',
  'col-insert': '<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="16" y="3" width="5" height="18" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="12" y1="9" x2="12" y2="15"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  bold: '<path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/>',
  italic: '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" y1="20" x2="20" y2="20"/>',
  strikethrough: '<line x1="5" y1="12" x2="19" y2="12"/><path d="M16 6.5A4 2 0 0 0 12 5h-1a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6h-1a4 2 0 0 1-4-1.5"/>',
  'text-color': '<path d="m5 18 5-14h1l5 14"/><path d="M7 13h7"/><rect x="4" y="20" width="16" height="2.4" rx="1"/>',
  'fill-color': '<path d="m19 11-8-8-8.5 8.5a2 2 0 0 0 0 2.9L9 21l10-10Z"/><path d="M5 6 12 13"/><circle cx="20" cy="17" r="2"/><rect x="2" y="20.4" width="20" height="2" rx="1"/>',
  'align-left': '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/>',
  'align-center': '<line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="6" y1="18" x2="18" y2="18"/>',
  'align-right': '<line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="6" y1="18" x2="20" y2="18"/>',
  wrap: '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="10 14.5 7 18 10 21.5"/>',
  borders: '<rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>',
  merge: '<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/><line x1="11" y1="12" x2="13" y2="12"/>',
  percent: '<circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/><line x1="18" y1="6" x2="6" y2="18"/>',
  currency: '<circle cx="12" cy="12" r="9"/><path d="M9 7.5h4a3 3 0 0 1 0 6H9"/><path d="M9 10.5h6"/><line x1="9" y1="16.5" x2="13" y2="12.5"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  filter: '<polygon points="3 4 21 4 14 12.5 14 19 10 21 10 12.5"/>',
  'sort-asc': '<line x1="4" y1="6" x2="11" y2="6"/><line x1="4" y1="12" x2="9" y2="12"/><line x1="4" y1="18" x2="7" y2="18"/><path d="M17 18V6"/><polyline points="14 9 17 6 20 9"/>',
  'sort-desc': '<line x1="4" y1="6" x2="7" y2="6"/><line x1="4" y1="12" x2="9" y2="12"/><line x1="4" y1="18" x2="11" y2="18"/><path d="M17 6v12"/><polyline points="14 15 17 18 20 15"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.3M12 18.2v2.3M20.5 12h-2.3M5.8 12H3.5M17.7 6.3l-1.6 1.6M7.9 16.1l-1.6 1.6M17.7 17.7l-1.6-1.6M7.9 7.9 6.3 6.3"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
  'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  'more-horizontal': '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  'layout-dashboard': '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>',
  kanban: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.75"/><path d="m21 15-5-5L5 21"/>',
  form: '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="12" y2="15"/>',
  'bar-chart': '<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="13" width="3" height="7"/><rect x="11" y="8" width="3" height="12"/><rect x="16" y="4" width="3" height="16"/>',
  'map-pin': '<path d="M12 21s-7-7.5-7-12a7 7 0 0 1 14 0c0 4.5-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
  sparkles: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><circle cx="19" cy="17" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="17" r="1" fill="currentColor" stroke="none"/>',
  workflow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h4a3 3 0 0 1 3 3v6"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><line x1="8.2" y1="10.8" x2="15.8" y2="6.2"/><line x1="8.2" y1="13.2" x2="15.8" y2="17.8"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="15" y1="14" x2="12" y2="12"/>',
  'message-circle': '<path d="M21 11.5a8.38 8.38 0 0 1-8.9 8.4 8.5 8.5 0 0 1-4-1L3 20l1.1-3.9a8.5 8.5 0 1 1 16.9-4.6Z"/>',
  'file-plus': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10Z"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M7 8h10v4a5 5 0 0 1-10 0Z"/>',
  // Dashboard-mode extras (U5 unicode-glyph elimination pass) — same stroke
  // style, not in the U1 minimum list but needed to fully remove glyphs.
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'refresh-cw': '<path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><polyline points="21 3 21 8 16 8"/><polyline points="3 21 3 16 8 16"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.5 12h2.3M19.2 12h2.3M4.4 19.6l1.6-1.6M18 6l1.6-1.6"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
  'alert-triangle': '<path d="M10.3 3.9 1.8 18a1.5 1.5 0 0 0 1.3 2.3h17.8a1.5 1.5 0 0 0 1.3-2.3L13.7 3.9a1.5 1.5 0 0 0-2.6 0Z"/><line x1="12" y1="9.5" x2="12" y2="13.5"/><line x1="12" y1="16.7" x2="12" y2="16.7"/>',
  play: '<path d="M6 4.5v15l13-7.5Z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  // Multi-user pass (Deployment/UI Plan v3): sharing + auth chrome.
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.9"/><path d="M17.8 14.1a6.5 6.5 0 0 1 3.7 5.9"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  // Google-Sheets-parity pass — toolbar/menu/right-click reference additions.
  printer: '<polyline points="6 9 6 3 18 3 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/>',
  'paint-roller': '<rect x="3" y="3" width="14" height="6" rx="1"/><path d="M7 9v5h4"/><rect x="11" y="14" width="6" height="7" rx="1"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.85 12.15 8.5-8.5"/><path d="m18 5 3 3"/><path d="m15 8 2 2"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  'sticky-note': '<path d="M4 4h13l3 3v13H4Z"/><path d="M17 4v6h6"/>',
  'eye-off': '<path d="M2 2l20 20"/><path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6 0 10 6 10 6a17.3 17.3 0 0 1-3.4 4"/><path d="M6.6 6.6C4 8.3 2 11 2 11s4 7 10 7a9.5 9.5 0 0 0 4-1"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/>',
  eye: '<path d="M2 11s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="11" r="3"/>',
  maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  minimize: '<polyline points="4 9 9 9 9 4"/><polyline points="20 15 15 15 15 20"/><line x1="9" y1="9" x2="3" y2="3"/><line x1="15" y1="15" x2="21" y2="21"/>',
  'align-top': '<line x1="4" y1="4" x2="20" y2="4"/><rect x="7" y="8" width="4" height="12" rx="1"/><rect x="14" y="8" width="4" height="7" rx="1"/>',
  'align-middle': '<line x1="4" y1="12" x2="20" y2="12"/><rect x="7" y="6" width="4" height="12" rx="1"/><rect x="14" y="8.5" width="4" height="7" rx="1"/>',
  'align-bottom': '<line x1="4" y1="20" x2="20" y2="20"/><rect x="7" y="4" width="4" height="12" rx="1"/><rect x="14" y="9" width="4" height="7" rx="1"/>',
  shuffle: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>',
  'zoom-in': '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
  'sigma': '<path d="M18 4H6l6 8-6 8h12"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="6" y1="9" x2="6" y2="9"/><line x1="10" y1="9" x2="10" y2="9"/><line x1="14" y1="9" x2="14" y2="9"/><line x1="18" y1="9" x2="18" y2="9"/><line x1="6" y1="13" x2="6" y2="13"/><line x1="18" y1="13" x2="18" y2="13"/><line x1="9" y1="13" x2="15" y2="13"/>',
  layers: '<polygon points="12 2 22 8 12 14 2 8"/><polyline points="2 14 12 20 22 14"/><polyline points="2 11 12 17 22 11"/>',
  'corner-down-right': '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
};

/**
 * Render an inline SVG icon.
 * @param {string} name - key from PATHS
 * @param {{size?:number, strokeWidth?:number, className?:string}} [opts]
 * @returns {string} SVG markup string
 */
export function icon(name, opts = {}) {
  const { size = 16, strokeWidth = 1.75, className = '' } = opts;
  const body = PATHS[name];
  if (!body) {
    // Unknown icon: render an empty placeholder box rather than throwing —
    // keeps the UI resilient while surfacing the gap via console.
    if (typeof console !== 'undefined') console.warn('[icons] missing icon:', name);
    return `<svg class="icon icon-missing ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"></svg>`;
  }
  return `<svg class="icon icon-${name} ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
export default icon;
