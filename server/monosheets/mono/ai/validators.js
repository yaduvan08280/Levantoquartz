// ============================================================
//  Mono — AI Action Validator (P13)
//  Dry-runs a proposed patch in an engine-clone sandbox
//  (MonoWorkbook.fromJSON(live.toJSON()) + new Engine) and rejects
//  it if it introduces NEW #REF!/#NAME?/#CYCLE!/… errors.
//  Validates the exact op vocabulary applyPatch will later apply
//  (normalizeOps is the shared canonicalizer), so what passes
//  validation is what gets applied.
// ============================================================
import { MonoWorkbook, addrToA1 } from '../model/workbook.js';
import { Engine } from '../engine/engine.js';
import { isError } from '../engine/errors.js';
import { normalizeOps } from './patches.js';

/** Map of addr-key → "SheetName!A1: #TYPE!" for every error value the engine currently holds. */
function collectErrors(engine) {
  const out = new Map();
  for (const [addr, val] of engine.values) {
    if (!isError(val)) continue;
    const { sid, r, c } = engine.parseKey(addr);
    const sh = engine.sheetById(sid);
    out.set(addr + '|' + val.type, `${sh ? sh.name : sid}!${addrToA1(r, c)}: ${val.type}`);
  }
  return out;
}

/**
 * Applies canonical ops to a SANDBOX engine and reports newly
 * introduced errors. Exposed separately so the safety assertion
 * sits at the actual point of mutation (roadmap P13 guardrail).
 *
 * @param {Array} patchOps - proposed ops (canonical or legacy)
 * @param {Engine} sandboxEngine - the CLONE engine to mutate
 * @param {string} sid - target sheet id inside the sandbox
 * @param {Engine|null} liveEngine - the live engine, for the safety check
 * @param {Map} preexisting - errors present before the patch (ignored in the verdict)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function runProposalInSandbox(patchOps, sandboxEngine, sid, liveEngine = null, preexisting = new Map()) {
  if (liveEngine && sandboxEngine === liveEngine) {
    throw new Error('SAFETY: validator must never receive the live engine');
  }
  const { ops, warnings } = normalizeOps(patchOps);
  try {
    for (const op of ops) {
      if (op.type === 'setCell') {
        sandboxEngine.setRaw(sid, op.r, op.c, op.raw);
      } else if (op.type === 'batch') {
        sandboxEngine.setCellsBatch(sid, op.cells);
      } else if (op.type === 'insertRow') {
        sandboxEngine.insertRows(sid, op.afterR + 1, 1);
        if (op.cells) sandboxEngine.setCellsBatch(sid, op.cells);
      } else if (op.type === 'deleteRow') {
        sandboxEngine.deleteRows(sid, op.r, 1);
      }
    }
  } catch (e) {
    return { valid: false, errors: ['Patch execution crashed: ' + String(e && e.message || e)], warnings };
  }

  const after = collectErrors(sandboxEngine);
  const errors = [];
  for (const [key, msg] of after) if (!preexisting.has(key)) errors.push(msg);
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validates a proposal against a sandbox clone of the live engine.
 * Only errors NEWLY introduced by the patch count against it —
 * a sheet that already contains #DIV/0! can still receive patches.
 *
 * @param {Array} patchOps - proposed ops (canonical or legacy shape)
 * @param {Engine} liveEngine - the live engine (cloned, never mutated)
 * @param {string} [sid] - target sheet id (defaults to active sheet)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateProposal(patchOps, liveEngine, sid) {
  if (!liveEngine || !liveEngine.wb) {
    return { valid: false, errors: ['Engine missing'], warnings: [] };
  }
  const targetSid = sid || liveEngine.wb.activeSheetId;
  const cloneWb = MonoWorkbook.fromJSON(liveEngine.wb.toJSON());
  const sandbox = new Engine(cloneWb); // constructor runs recalcAll → base state
  const preexisting = collectErrors(sandbox);
  return runProposalInSandbox(patchOps, sandbox, targetSid, liveEngine, preexisting);
}

