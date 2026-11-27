// ============================================================
//  Mono — shared view utilities  (Views v3)
//  Small helpers used by the kanban/calendar/gallery/form
//  renderers. Pure + DOM-light; no engine writes here.
// ============================================================

export const escH = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Resolve a config field (header name or index) to a header index. */
export function resolveField(field, headers, fallback = null) {
  if (field == null || field === '') return fallback;
  if (typeof field === 'number') return field < headers.length ? field : fallback;
  const idx = headers.indexOf(field);
  return idx >= 0 ? idx : fallback;
}

/** First list-validation rule that covers data rows of physical column c. */
export function listValidationFor(sheet, c) {
  for (const v of (sheet.validations || [])) {
    if (v.kind !== 'list') continue;
    const rg = v.range;
    if (c >= rg.c1 && c <= rg.c2) return v;
  }
  return null;
}

/** Checkbox-validation rule covering physical column c (for form controls). */
export function checkboxValidationFor(sheet, c) {
  for (const v of (sheet.validations || [])) {
    if (v.kind !== 'checkbox') continue;
    const rg = v.range;
    if (c >= rg.c1 && c <= rg.c2) return v;
  }
  return null;
}

/** Deterministic pastel from any string — fallback covers, lane accents. */
export function hashColor(s) {
  let h = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 42% 88%)`;
}
export function hashColorInk(s) {
  let h = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 45% 32%)`;
}

export function isImageUrl(v) {
  return typeof v === 'string'
    && (/^data:image\//i.test(v) || (/^https?:\/\//i.test(v) && /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(v)));
}
export function isUrl(v) { return typeof v === 'string' && /^https?:\/\//i.test(v); }

/* ---------- PlainDate helpers (INV-CAL-1: never parse via UTC) ---------- */

/** Parse a cell value into LOCAL calendar-date parts. Returns Date or null. */
export function parsePlainDate(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) return isNaN(val) ? null : new Date(val.getFullYear(), val.getMonth(), val.getDate());
  if (typeof val === 'number') {
    // Spreadsheet serial: days since 1899-12-30, LOCAL arithmetic (no UTC).
    if (!isFinite(val) || val < 1 || val > 300000) return null;
    const d = new Date(1899, 11, 30);
    d.setDate(d.getDate() + Math.round(val));
    return d;
  }
  const s = String(val).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);          // ISO-ish
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s].*)?$/.exec(s);             // DD/MM/YYYY (app default)
  if (m) return mk(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);                          // DD-MM-YYYY
  if (m) return mk(+m[3], +m[2], +m[1]);
  const t = Date.parse(s);                                              // "Jul 4 2026" etc.
  if (!isNaN(t)) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  return null;
  function mk(y, mo, dd) { const d = new Date(y, mo - 1, dd); return (d.getMonth() === mo - 1 && d.getDate() === dd) ? d : null; }
}

export const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function keyToDate(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); }

export const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };

export const dayDiff = (a, b) => Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);

/** Write `d` back in the same format FAMILY as the previous raw value. */
export function formatDateLike(origRaw, d) {
  const iso = dateKey(d);
  const s = String(origRaw ?? '').trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(s)) {
    return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  }
  return iso; // ISO by default (also for serials/new cells — engine reparses it)
}

/* ---------- tiny modal / popover ---------- */

/** Modal with backdrop; returns backdrop el. html goes inside .modal. */
export function viewModal(html) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal vw-modal">${html}</div>`;
  document.body.appendChild(back);
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
  const esc = (e) => { if (e.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  return back;
}

/** Small anchored popover; closes on outside click. Returns el. */
export function viewPopover(anchorRect, html, { width = 260 } = {}) {
  document.getElementById('vwPop')?.remove();
  const el = document.createElement('div');
  el.id = 'vwPop'; el.className = 'vw-pop';
  el.style.width = width + 'px';
  el.innerHTML = html;
  document.body.appendChild(el);
  const left = Math.max(8, Math.min(anchorRect.left, innerWidth - width - 12));
  const top = anchorRect.bottom + 6 + el.offsetHeight > innerHeight
    ? Math.max(8, anchorRect.top - el.offsetHeight - 6)
    : anchorRect.bottom + 6;
  el.style.left = left + 'px'; el.style.top = top + 'px';
  setTimeout(() => {
    const h = (ev) => { if (!el.contains(ev.target)) { el.remove(); document.removeEventListener('mousedown', h); } };
    document.addEventListener('mousedown', h);
  }, 0);
  return el;
}

/* ---------- setup card (INV-V3-3: broken bindings → wizard, never a crash) ---------- */

/**
 * Render a binding setup card.
 * @param {object} opts { icon, title, hint, selects:[{id,label,options:[{v,label}],value}], cta }
 * @returns html string — caller wires [data-setup-apply] + selects by id
 */
export function setupCardHTML({ title, hint, selects, cta = 'Use this column' }) {
  return `<div class="vw-setup">
    <div class="vw-setup-title">${escH(title)}</div>
    <div class="vw-setup-hint">${escH(hint)}</div>
    ${selects.map((s) => `<label class="vw-setup-label">${escH(s.label)}
      <select class="vw-setup-select" id="${escH(s.id)}">${s.options.map((o) => `<option value="${escH(o.v)}"${String(o.v) === String(s.value ?? '') ? ' selected' : ''}>${escH(o.label)}</option>`).join('')}</select>
    </label>`).join('')}
    <button class="btn btn-primary vw-setup-apply" data-setup-apply>${escH(cta)}</button>
  </div>`;
}
