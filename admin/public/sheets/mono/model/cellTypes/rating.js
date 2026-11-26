import { registerCellType } from '../cellTypes.js';

const MAX = 5;

function coerce(raw) {
  if (raw === '' || raw == null) return 0;
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return Math.min(MAX, Math.max(0, Math.round(n)));
}

function renderHint(value) {
  const n = coerce(value);
  let html = '';
  for (let i = 1; i <= MAX; i++) {
    html += `<span class="ct-star${i <= n ? ' filled' : ''}" aria-hidden="true">${i <= n ? '★' : '☆'}</span>`;
  }
  return { html: `<span class="ct-rating" aria-label="${n} out of ${MAX} stars">${html}</span>` };
}

registerCellType({
  id: 'rating',
  displayName: 'Rating',
  icon: 'star',
  coerce,
  validate(v) { const n = Number(v); return (Number.isNaN(n) || n < 0 || n > MAX) ? `Must be 0–${MAX}` : true; },
  format(value) { const n = coerce(value); return '★'.repeat(n) + '☆'.repeat(MAX - n); },
  renderHint,
  serialize(value) { return String(coerce(value)); },
  deserialize(raw) { return coerce(raw); },
});
