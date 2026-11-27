// ============================================================
//  Mono — shared sync-status indicator (U2; multi-user states per
//  UI Plan v3 §8). Kinds:
//    ok        green   "All changes saved"
//    saving    pulsing "Saving…"
//    err       red     save failed (retrying)
//    conflict  amber   "Someone else saved changes" (409 — modal owns recovery)
//    offline   grey    "Reconnecting…" (edits held locally, backoff retry)
// ============================================================
export function setSyncStatus(kind, text) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if (dot) {
    dot.className = 'sync-dot'
      + (kind === 'saving' ? ' saving' : '')
      + (kind === 'err' ? ' err' : '')
      + (kind === 'conflict' ? ' conflict' : '')
      + (kind === 'offline' ? ' offline' : '');
  }
  if (label) label.textContent = text;
}
export function showSyncStatus(show) {
  const el = document.getElementById('syncStatus');
  if (el) el.style.display = show ? '' : 'none';
}
export default { setSyncStatus, showSyncStatus };
