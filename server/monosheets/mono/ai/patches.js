// ============================================================
//  Mono — AI Patches Applier (P13)
//
//  Translates AI-proposed ops into host.js's real op vocabulary
//  and applies them through host.applyEdit — the ONLY sanctioned
//  mutation path (see views/host.js header).
//
//  Canonical op shapes (identical to host.applyEdit):
//    { type:'setCell',   r, c, raw }
//    { type:'insertRow', afterR, cells? }
//    { type:'deleteRow', r }
//    { type:'batch',     cells: [{r,c,raw}] }
//
//  Undo semantics: host.applyEdit does one grid.pushUndo() per
//  call, so N cell writes collapse into ONE batch op = one undo
//  step. A patch that mixes structural ops (insertRow/deleteRow)
//  with cell writes produces one undo step per applyEdit call —
//  inherent to the host contract, documented in BUILD_LOG.md.
//
//  `sid` is intentionally dropped: applyEdit always targets the
//  active sheet by design, the LLM only ever sees active-sheet
//  context, and switching sheets implicitly on Apply would be
//  surprising. (Decision logged in BUILD_LOG.md.)
// ============================================================

const CANONICAL_TYPES = new Set(['setCell', 'insertRow', 'deleteRow', 'batch']);

/**
 * Canonicalizes a proposed op list. Accepts both the canonical
 * host vocabulary and the legacy prototype/LLM shape
 * ({op:'setCell', sid, r, c, val} / {op:'insertRow', sid, idx, count}).
 * Unknown ops are dropped with a warning, never guessed at.
 *
 * @param {Array} rawOps
 * @returns {{ ops: Array, warnings: string[] }}
 */
export function normalizeOps(rawOps) {
  const ops = [];
  const warnings = [];
  if (!Array.isArray(rawOps)) return { ops, warnings: ['ops is not an array'] };

  for (const raw of rawOps) {
    if (!raw || typeof raw !== 'object') { warnings.push('Dropped non-object op'); continue; }
    const kind = raw.type || raw.op;

    if (kind === 'setCell') {
      const r = Number(raw.r), c = Number(raw.c);
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) { warnings.push('Dropped setCell with invalid r/c'); continue; }
      const value = raw.raw !== undefined ? raw.raw : raw.val;
      ops.push({ type: 'setCell', r, c, raw: value == null ? '' : String(value) });
    } else if (kind === 'batch') {
      const cells = Array.isArray(raw.cells) ? raw.cells
        .filter((x) => x && Number.isInteger(Number(x.r)) && Number.isInteger(Number(x.c)))
        .map((x) => ({ r: Number(x.r), c: Number(x.c), raw: (x.raw !== undefined ? x.raw : x.val) == null ? '' : String(x.raw !== undefined ? x.raw : x.val) })) : [];
      if (!cells.length) { warnings.push('Dropped empty batch'); continue; }
      ops.push({ type: 'batch', cells });
    } else if (kind === 'insertRow') {
      if (raw.afterR !== undefined) {
        ops.push({ type: 'insertRow', afterR: Number(raw.afterR), ...(raw.cells ? { cells: raw.cells } : {}) });
      } else if (raw.idx !== undefined) {
        // legacy shape: insert `count` rows AT index idx → afterR = idx - 1
        const count = Math.max(1, Number(raw.count) || 1);
        for (let i = 0; i < count; i++) ops.push({ type: 'insertRow', afterR: Number(raw.idx) - 1 + i });
      } else {
        warnings.push('Dropped insertRow without afterR/idx');
      }
    } else if (kind === 'deleteRow') {
      const r = Number(raw.r !== undefined ? raw.r : raw.idx);
      if (!Number.isInteger(r) || r < 0) { warnings.push('Dropped deleteRow with invalid r'); continue; }
      ops.push({ type: 'deleteRow', r });
    } else {
      warnings.push(`Dropped unknown op "${String(kind)}"`);
    }
  }
  return { ops, warnings };
}

/**
 * Collapses consecutive setCell ops into a single batch op so a
 * multi-cell proposal costs one applyEdit call = one undo step.
 * @param {Array} ops - canonical ops (from normalizeOps)
 * @returns {Array} canonical ops with setCell runs batched
 */
export function collapseSetCells(ops) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) out.push({ type: 'batch', cells: run.map((o) => ({ r: o.r, c: o.c, raw: o.raw })) });
    run = [];
  };
  for (const op of ops) {
    if (op.type === 'setCell') { run.push(op); continue; }
    if (op.type === 'batch' && run.length) { run.push(...op.cells.map((cl) => ({ type: 'setCell', ...cl }))); continue; }
    flush();
    out.push(op);
  }
  flush();
  return out;
}

/**
 * Applies AI-proposed ops through host.applyEdit.
 * Never calls host.pushUndo — applyEdit owns undo/save/render.
 * @param {object} host - a makeHost(grid) host (views/host.js)
 * @param {Array} rawOps - proposed ops (canonical or legacy shape)
 * @returns {{ applied: number, warnings: string[] }}
 */
export function applyPatch(host, rawOps) {
  if (!host || typeof host.applyEdit !== 'function') throw new Error('applyPatch needs a host with applyEdit');
  const { ops, warnings } = normalizeOps(rawOps);
  const collapsed = collapseSetCells(ops);
  for (const op of collapsed) host.applyEdit(op);
  return { applied: collapsed.length, warnings };
}

