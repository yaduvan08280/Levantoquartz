// ============================================================
//  Mono — Pull-only anti-clobber merge  [Unified Import v1]
//  ------------------------------------------------------------
//  Google Sheets is the source of truth (pull-only). We update a
//  LOCAL sheet from a fresh remote snapshot using a three-way
//  compare against the last-synced base, honouring these rules:
//
//   1. Remote didn't touch a cell (remote == base)  → keep LOCAL.
//      (This is what protects every edit you make in cells that are
//       empty upstream — base is empty, remote is empty, no change,
//       so your local value is never overwritten.)
//   2. Remote changed a cell to a new value/format  → remote WINS
//      (source of truth), overwriting local.
//   3. Remote cleared a cell that had a value (deletion):
//         • if your local cell still equals base → accept the clear
//         • if you have since put your own content there → KEEP it
//      So a remote deletion never destroys work you layered on top.
//
//  `local` and `remote` are { "r,c": Cell } where Cell = { raw?, st?,
//  nf?, note? }. `base` may be the same shape OR - preferably - a map
//  of { "r,c": fingerprint }, because base is only ever used for
//  EQUALITY. A workbook of two lakh rows produced a base of ~558 MB as
//  full cells, which could not be stored anywhere and could not even be
//  JSON.stringify'd (past V8's max string length). Fingerprints carry
//  the same information in a fraction of the space.
//
//  Returns { writes, cleared, stats } — writes maps "r,c" -> Cell to
//  set, cleared is a list of "r,c" keys to delete.
// ============================================================

// Compare two Cell objects (raw + number format + note + style) for equality.
export function cellsEqual(a, b) {
  const ae = isEmptyCell(a), be = isEmptyCell(b);
  if (ae && be) return true;
  if (ae !== be) return false;
  if ((a.raw ?? '') !== (b.raw ?? '')) return false;
  if ((a.nf ?? '') !== (b.nf ?? '')) return false;
  if ((a.note ?? '') !== (b.note ?? '')) return false;
  return styleEqual(a.st, b.st);
}

export function isEmptyCell(c) {
  return !c || (!c.raw && !c.st && !c.nf && !c.note);
}

function styleEqual(a, b) {
  a = a || {}; b = b || {};
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (k === 'bd') { if (!bordersEqual(a.bd, b.bd)) return false; continue; }
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function bordersEqual(a, b) {
  a = a || {}; b = b || {};
  for (const side of ['t', 'r', 'b', 'l']) {
    const ea = a[side], eb = b[side];
    if (!ea && !eb) continue;
    if (!ea || !eb) return false;
    if ((ea.style || '') !== (eb.style || '') || (ea.color || '') !== (eb.color || '')) return false;
  }
  return true;
}

/* ---------- fingerprints ---------- */
// A 32-bit FNV-1a of everything cellsEqual() looks at. Fingerprints are only
// ever compared against the SAME cell position, so there is no birthday
// problem: a missed change needs one specific old value to collide with one
// specific new value (~1 in 4 billion per changed cell), not any two cells
// anywhere in the workbook to collide with each other.
export function cellFingerprint(cell) {
  if (isEmptyCell(cell)) return 0;
  const SEP = '';
  let s = (cell.raw ?? '') + SEP + (cell.nf ?? '') + SEP + (cell.note ?? '');
  const st = cell.st;
  if (st) {
    // sorted keys, falsy values skipped - so two styles that styleEqual()
    // would call equal always produce the same fingerprint
    for (const k of Object.keys(st).sort()) {
      if (k === 'bd') {
        const bd = st.bd || {};
        for (const side of ['t', 'r', 'b', 'l']) {
          const e = bd[side];
          if (e) s += SEP + side + (e.style || '') + (e.color || '');
        }
        continue;
      }
      const v = st[k];
      if (v == null || v === '' || v === false || v === 0) continue;
      s += SEP + k + v;
    }
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h || 1;                 // 0 is reserved for "empty"
}

// Fingerprint a whole { "r,c": Cell } map. This is what gets stored as the
// next sync's base.
export function fingerprintMap(cells) {
  const out = {};
  for (const k of Object.keys(cells || {})) {
    const fp = cellFingerprint(cells[k]);
    if (fp) out[k] = fp;
  }
  return out;
}

// Accept either a fingerprint or a whole Cell, so a base stored by an older
// build still works and nobody has to re-sync from scratch.
function asFingerprint(b) {
  return typeof b === 'number' ? b : cellFingerprint(b);
}

/* ---------- the merge ---------- */
// base, local, remote : { "r,c": Cell }  (all aligned to the SAME layout —
// call structuralSync first so columns line up before merging).
export function mergeCells(base, local, remote) {
  base = base || {}; local = local || {}; remote = remote || {};
  const writes = {};   // "r,c" -> Cell to set on the local sheet
  const cleared = [];  // "r,c" keys to delete on the local sheet
  const stats = { updated: 0, added: 0, cleared: 0, protected: 0, untouched: 0 };

  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const k of keys) {
    const bfp = base[k] === undefined ? 0 : asFingerprint(base[k]);
    const l = local[k] || null;
    const r = remote[k] || null;

    const remoteChanged = cellFingerprint(r) !== bfp;

    if (!remoteChanged) {
      // Rule 1: remote didn't touch it — local stands untouched.
      stats.untouched++;
      continue;
    }

    // Remote changed since last sync.
    if (isEmptyCell(r)) {
      // Rule 3: remote cleared this cell.
      if (cellFingerprint(l) === bfp) {
        if (!isEmptyCell(l)) { cleared.push(k); stats.cleared++; }
      } else {
        // user layered their own content here → protect it
        stats.protected++;
      }
    } else {
      // Rule 2: remote has a new value/format → it wins.
      writes[k] = { ...r };
      if (bfp === 0) stats.added++; else stats.updated++;
    }
  }

  return { writes, cleared, stats };
}

// Extract a { "r,c": Cell } map from a live MonoSheet (raw/st/nf/note only).
export function sheetToCellMap(sh) {
  const out = {};
  for (const [k, cell] of sh.cells) {
    if (!cell) continue;
    const o = {};
    if (cell.raw != null && cell.raw !== '') o.raw = cell.raw;
    if (cell.st && Object.keys(cell.st).length) o.st = { ...cell.st };
    if (cell.nf) o.nf = cell.nf;
    if (cell.note) o.note = cell.note;
    if (o.raw || o.st || o.nf || o.note) out[k] = o;
  }
  return out;
}

// Apply a merge result onto a live MonoSheet.
export function applyMergeToSheet(sh, mergeResult) {
  for (const k of Object.keys(mergeResult.writes)) {
    const [r, c] = k.split(',').map(Number);
    sh.setCellObj(r, c, mergeResult.writes[k]);
  }
  for (const k of mergeResult.cleared) {
    const [r, c] = k.split(',').map(Number);
    sh.setCellObj(r, c, null);
  }
}

