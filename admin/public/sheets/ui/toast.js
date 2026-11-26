// ============================================================
//  Mono — shared toast/feedback channel (U6)
//  The single feedback channel for every async action across the
//  whole app (save confirmations, sync results, script errors,
//  validation errors, import results, automation test-runs, …)
//  instead of alert(). Targets the one #toast element already in
//  index.html — shared by both Dashboard and Sheets mode.
// ============================================================
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) { console.warn('[toast]', msg); return; }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
export default toast;
