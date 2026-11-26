// ============================================================
//  Mono formula engine — error values (Phase 2)
//  Google-compatible error tokens. Functions RETURN these
//  (never throw to the UI); errors propagate through operators.
// ============================================================
export const ERR = {
  NULL: '#NULL!', DIV0: '#DIV/0!', VALUE: '#VALUE!', REF: '#REF!',
  NAME: '#NAME?', NUM: '#NUM!', NA: '#N/A', ERROR: '#ERROR!', CYCLE: '#CYCLE!', SPILL: '#SPILL!',
};

export class MonoError {
  constructor(type, message) { this.__error = true; this.type = type; this.message = message || ''; }
  toString() { return this.type; }
}
export const err = (type, message) => new MonoError(type, message);
export const isError = (v) => v instanceof MonoError || (v != null && v.__error === true);
export const errorFromText = (t) => {
  const up = String(t).toUpperCase();
  return Object.values(ERR).includes(up) ? new MonoError(up) : null;
};
