// ============================================================
//  Mono — Form view renderer  (Views v3)
//
//  Design: MONO_VIEWS_LOGIC_V3.md §4.4
//  · ONE inference function derives each field's input control
//    AND its validation (INV-FORM-3 — control and check cannot
//    disagree). Priority: list validation → select · checkbox
//    validation → checkbox · colType (email/url/phone/rating/
//    progress) → typed input · sampled data → number/date · text
//  · Submitted cells are built ONLY from config.fields columns —
//    a value for an unexposed column has no code path (INV-FORM-1)
//  · 3s duplicate-payload dedupe (INV-FORM-2 — double-click safe)
//  · Fixed upstream: host.applyEdit(insertRow) now writes cells
//    into the NEW row (submissions used to overwrite the header)
// ============================================================
import { registerViewKind } from '../registry.js';
import { icon } from '../../../ui/icons.js';
import { escH, resolveField, listValidationFor, checkboxValidationFor, parsePlainDate, dateKey, keyToDate } from '../viewUtils.js';

export function render(host, mount) {
  const mv = host.materialized;
  const spec = host.spec;
  if (!mv || !spec) { mount.innerHTML = '<div class="fv-empty">No data</div>'; return; }
  const cfg = spec.config || (spec.config = {});
  const { headers, rows, colIndices } = mv;
  const sh = host.wb.sheets.find((s) => s.id === host.sheetId);
  const st = host.viewState(spec.id);
  const label = (i) => headers[i] || `Column ${i + 1}`;

  const fieldIdxs = (cfg.fields && cfg.fields.length ? cfg.fields : headers.map((_, i) => i))
    .map((f) => resolveField(f, headers, null))
    .filter((i) => i != null);
  const required = new Set((cfg.required || []).map((f) => resolveField(f, headers, null)).filter((i) => i != null));

  // ── INV-FORM-3: one inference → control + validation ──
  const fields = fieldIdxs.map((i) => {
    const phys = colIndices[i];
    return { idx: i, phys, label: label(i), req: required.has(i), ctl: inferControl(sh, phys, rows, i) };
  });

  const title = cfg.title || spec.name || 'Form';
  const desc = cfg.description || '';
  const submitLabel = cfg.submitLabel || 'Submit';
  const latest = rows.slice(-10).reverse();

  mount.innerHTML = `
    <div class="fv" id="fvRoot">
      <div class="fv-sheet">
        <div class="fv-title">${escH(title)}</div>
        ${desc ? `<div class="fv-desc">${escH(desc)}</div>` : ''}
        <div class="fv-preview-badge">${icon('eye', { size: 12 })} Responses are saved as rows in this sheet</div>
        <form class="fv-form" id="fvForm" novalidate>
          ${fields.map((f, n) => `
            <div class="fv-field" data-field="${n}">
              <label class="fv-label" for="fv-in-${n}">${escH(f.label)}${f.req ? ' <span class="fv-req">*</span>' : ''}</label>
              ${controlHTML(f, n)}
              <div class="fv-err" id="fv-err-${n}"></div>
            </div>`).join('')}
          <button type="submit" class="fv-submit">${escH(submitLabel)}</button>
          <span class="fv-success" id="fvSuccess" hidden>${icon('check', { size: 13 })} Response saved</span>
        </form>
      </div>

      <div class="fv-responses">
        <div class="fv-responses-title">${rows.length} response${rows.length === 1 ? '' : 's'}${rows.length > 10 ? ' · showing latest 10' : ''}</div>
        ${latest.map((row) => `
          <div class="fv-response">
            ${fields.map((f) => {
              const v = row.cells[f.idx];
              if (v == null || v === '') return '';
              return `<div class="fv-resp-field"><span class="fv-resp-label">${escH(f.label)}</span><span class="fv-resp-value">${escH(String(v))}</span></div>`;
            }).join('') || '<span class="fv-resp-empty">(empty)</span>'}
          </div>`).join('')}
      </div>
    </div>`;

  // ── Submit: validate (same inference), dedupe, append ──
  mount.querySelector('#fvForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    let firstBad = null;
    const values = fields.map((f, n) => {
      const el = mount.querySelector(`#fv-in-${n}`);
      const errEl = mount.querySelector(`#fv-err-${n}`);
      errEl.textContent = '';
      const { value, error } = readAndValidate(f, el);
      if (error) { errEl.textContent = error; if (!firstBad) firstBad = el; }
      return value;
    });
    if (firstBad) { firstBad.focus(); return; }

    // INV-FORM-2: identical payload within 3s of the last accepted one → drop
    const payload = JSON.stringify(values);
    if (st.lastPayload === payload && Date.now() - (st.lastAt || 0) < 3000) return;
    st.lastPayload = payload; st.lastAt = Date.now();

    // INV-FORM-1: cells built only from exposed fields
    const cells = fields
      .map((f, n) => ({ c: f.phys, raw: values[n] }))
      .filter((cl) => cl.raw !== '');
    if (!cells.length) return;
    const last = mv.rows.length ? Math.max(...mv.rows.map((r) => r.rowIndex)) : 0;
    st.flash = true;
    host.applyEdit({ type: 'insertRow', afterR: last, cells });
  });

  // Success flash after the re-render that follows a submit
  if (st.flash) {
    st.flash = false;
    const ok = mount.querySelector('#fvSuccess');
    if (ok) { ok.hidden = false; setTimeout(() => { ok.hidden = true; }, 2500); }
  }
}

/* ---------- control inference (single source for control + validation) ---------- */
function inferControl(sh, phys, rows, idx) {
  const lv = listValidationFor(sh, phys);
  if (lv && lv.values?.length) return { kind: 'select', options: lv.values };
  if (checkboxValidationFor(sh, phys)) return { kind: 'checkbox' };
  const ct = sh.colTypes?.[phys];
  if (ct === 'email') return { kind: 'email' };
  if (ct === 'url') return { kind: 'url' };
  if (ct === 'phone') return { kind: 'tel' };
  if (ct === 'rating') return { kind: 'number', min: 0, max: 5, step: 1 };
  if (ct === 'progress') return { kind: 'number', min: 0, max: 100, step: 1 };
  // Sample existing data: mostly numbers → number, mostly dates → date
  let seen = 0, nums = 0, dates = 0;
  for (const r of rows) {
    const v = r.cells[idx];
    if (v == null || v === '') continue;
    seen++;
    if (typeof v === 'number' || (String(v).trim() !== '' && !isNaN(Number(v)))) nums++;
    else if (parsePlainDate(v)) dates++;
    if (seen >= 15) break;
  }
  if (seen >= 2 && dates / seen >= 0.6) return { kind: 'date' };
  if (seen >= 2 && nums / seen >= 0.8) return { kind: 'number' };
  return { kind: 'text' };
}

function controlHTML(f, n) {
  const id = `fv-in-${n}`, c = f.ctl;
  switch (c.kind) {
    case 'select':
      return `<select class="fv-input" id="${id}"><option value=""></option>${c.options.map((o) => `<option>${escH(o)}</option>`).join('')}</select>`;
    case 'checkbox':
      return `<label class="fv-check"><input type="checkbox" id="${id}"> Yes</label>`;
    case 'number':
      return `<input class="fv-input" id="${id}" type="number"${c.min != null ? ` min="${c.min}"` : ''}${c.max != null ? ` max="${c.max}"` : ''}${c.step ? ` step="${c.step}"` : ''} />`;
    case 'date':
      return `<input class="fv-input" id="${id}" type="date" />`;
    case 'email': case 'url': case 'tel':
      return `<input class="fv-input" id="${id}" type="${c.kind}" />`;
    default:
      return `<input class="fv-input" id="${id}" type="text" />`;
  }
}

function readAndValidate(f, el) {
  const c = f.ctl;
  let value = '';
  if (c.kind === 'checkbox') value = el.checked ? 'TRUE' : '';
  else value = String(el.value ?? '').trim();

  if (f.req && value === '') return { value, error: 'Required' };
  if (value === '') return { value, error: null };

  switch (c.kind) {
    case 'select':
      if (!c.options.some((o) => String(o) === value)) return { value, error: 'Pick one of the options' };
      break;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { value, error: 'Must be a number' };
      if (c.min != null && n < c.min) return { value, error: `Minimum ${c.min}` };
      if (c.max != null && n > c.max) return { value, error: `Maximum ${c.max}` };
      break;
    }
    case 'date': {
      const d = keyToDate(value);
      if (!d || isNaN(d)) return { value, error: 'Invalid date' };
      value = dateKey(d);   // canonical ISO into the sheet; engine reparses
      break;
    }
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { value, error: 'Invalid email address' };
      break;
    case 'url':
      if (!/^https?:\/\/\S+$/i.test(value)) return { value, error: 'Must start with http:// or https://' };
      break;
    case 'tel':
      if (!/^[+\d][\d\s\-().]{4,}$/.test(value)) return { value, error: 'Invalid phone number' };
      break;
  }
  return { value, error: null };
}

export function commandBarConfig(_spec) { return null; }

registerViewKind({ kind: 'form', label: 'Form', icon: 'form', render, commandBarConfig });
