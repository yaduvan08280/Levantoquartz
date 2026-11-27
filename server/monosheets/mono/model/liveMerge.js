// ============================================================
//  Mono — live collaboration: which remote cells to take
//  ------------------------------------------------------------
//  The server orders every write and the last writer to a cell wins. Each
//  tab hears about everyone else's writes over an event stream and applies
//  them in place. The catch is that "hears about" and "the server applied"
//  do not happen in the same order for everyone:
//
//    - I typed in B2 and have not sent it yet. Someone's older B2 arrives.
//      My write will land AFTER theirs on the server, so mine wins there -
//      and if I applied theirs now, the save would read it back out of the
//      sheet and send THEIR value as mine. My edit would vanish.
//    - My B2 is in flight. Same thing.
//    - My B2 was accepted as version 8, and now version 7 (theirs) arrives
//      late on the stream. The server already has mine on top of it.
//
//  In all three the right move is to leave my cell alone. Anything else in
//  the patch is theirs and newer than what I have, so it is applied.
// ============================================================

const has = (sheets, sid, k) => {
  const set = sheets && sheets.get(sid);
  return set === 'full' || !!(set && set.has(k));
};

/**
 * @param sid      sheet id the cells belong to
 * @param cells    { "r,c": cell|null } from the remote patch
 * @param version  the server version that patch produced
 * @param mine     { pending, inFlight, acked }
 *                 pending  Map(sid -> Set|'full')  edits not sent yet
 *                 inFlight Map(sid -> Set|'full')  edits sent, not answered (or null)
 *                 acked    [{ v, sheets }]          recent accepted writes of ours
 * @returns the subset of `cells` to apply
 */
export function remoteCellsToApply(sid, cells, version, mine = {}) {
  const out = {};
  const later = (mine.acked || []).filter((a) => a.v > version);
  for (const k of Object.keys(cells || {})) {
    if (has(mine.pending, sid, k) || has(mine.inFlight, sid, k)) continue;
    if (later.some((a) => has(a.sheets, sid, k))) continue;
    out[k] = cells[k];
  }
  return out;
}
