// ============================================================
//  Mono Sheets — conditional formatting evaluator (Phase 3, pure)
//  Rule = { range:{r1,c1,r2,c2}, cond:{op,v1,v2}, style:{bg?,fg?,bold?} }
// ============================================================
const numOf = (v) => (typeof v === 'number' ? v : Number(String(v).replace(/[,%\s₹$€£]/g, '')));
function looseEq(a, b) { if (typeof a === 'number') return a === numOf(b); return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(); }

export function ruleMatches(value, cond) {
  if (value && value.__error) return false;
  const { op, v1, v2 } = cond;
  const n = numOf(value);
  switch (op) {
    case 'empty': return value == null || value === '';
    case 'notEmpty': return !(value == null || value === '');
    case 'eq': return looseEq(value, v1);
    case 'ne': return !looseEq(value, v1);
    case 'gt': return !Number.isNaN(n) && n > Number(v1);
    case 'gte': return !Number.isNaN(n) && n >= Number(v1);
    case 'lt': return !Number.isNaN(n) && n < Number(v1);
    case 'lte': return !Number.isNaN(n) && n <= Number(v1);
    case 'between': return !Number.isNaN(n) && n >= Number(v1) && n <= Number(v2);
    case 'contains': return String(value ?? '').toLowerCase().includes(String(v1).toLowerCase());
    case 'startsWith': return String(value ?? '').toLowerCase().startsWith(String(v1).toLowerCase());
    default: return false;
  }
}
const inRange = (rg, r, c) => r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2;

export function cfStyleFor(value, rules, r, c) {
  if (!rules || !rules.length) return null;
  for (const rule of rules) {
    // A rule with no range or no condition cannot be evaluated. It is kept on
    // the sheet (so it survives a round trip) but skipped here. This used to
    // dereference rule.range blindly, and one imported rule took down the
    // ENTIRE grid render - the app came up blank.
    if (!rule || !rule.range || !rule.cond) continue;
    if (rule.type === 'scale' || rule.type === 'databar' || rule.type === 'gradient') continue;
    try {
      if (inRange(rule.range, r, c) && ruleMatches(value, rule.cond)) return rule.style || null;
    } catch { /* never let one bad rule stop the sheet from rendering */ }
  }
  return null;
}

/* ---------- normalising imported rules ----------
   The UI writes { range, cond, style }. Importers write the range flat and
   describe the condition in their source's own vocabulary:
     xlsx    { r1,c1,r2,c2, type:'cellIs', op:'greaterThan', formula:['5'] }
     Google  { r1,c1,r2,c2, type:'NUMBER_GREATER', values:['5'] }
   Left as-is those rules have no `.range` and no `.cond`, which is what
   crashed the grid. This maps them onto the one shape everything else
   expects, so imported conditional formatting actually WORKS rather than
   merely stopping being fatal. */
const XLSX_OPS = {
  greaterThan: 'gt', greaterThanOrEqual: 'gte',
  lessThan: 'lt', lessThanOrEqual: 'lte',
  equal: 'eq', notEqual: 'ne', between: 'between',
  containsText: 'contains', beginsWith: 'startsWith',
};
const XLSX_TYPES = {
  containsText: 'contains', beginsWith: 'startsWith',
  containsBlanks: 'empty', notContainsBlanks: 'notEmpty',
};
const SHEETS_TYPES = {
  NUMBER_GREATER: 'gt', NUMBER_GREATER_THAN_EQ: 'gte',
  NUMBER_LESS: 'lt', NUMBER_LESS_THAN_EQ: 'lte',
  NUMBER_EQ: 'eq', NUMBER_NOT_EQ: 'ne', NUMBER_BETWEEN: 'between',
  TEXT_CONTAINS: 'contains', TEXT_STARTS_WITH: 'startsWith', TEXT_EQ: 'eq',
  BLANK: 'empty', NOT_BLANK: 'notEmpty',
};

const VALID_OPS = new Set(['empty', 'notEmpty', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'startsWith']);

export function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;

  let range = rule.range;
  if (!range || range.r1 == null) {
    if (rule.r1 == null || rule.c1 == null) return null;      // cannot be placed anywhere
    range = { r1: rule.r1, c1: rule.c1, r2: rule.r2 ?? rule.r1, c2: rule.c2 ?? rule.c1 };
  }

  let cond = rule.cond && VALID_OPS.has(rule.cond.op) ? rule.cond : null;
  if (!cond) {
    const op = XLSX_OPS[rule.op] || XLSX_TYPES[rule.type] || SHEETS_TYPES[rule.type] || null;
    if (op) {
      const vals = Array.isArray(rule.values) ? rule.values
        : (Array.isArray(rule.formula) ? rule.formula : []);
      cond = { op, v1: vals[0] ?? '', v2: vals[1] ?? '' };
    }
  }

  const out = { ...rule, range };
  delete out.r1; delete out.c1; delete out.r2; delete out.c2;
  if (cond) out.cond = cond; else delete out.cond;   // unevaluatable: kept, skipped at render
  return out;
}

export function normalizeRules(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const rule of list) { const n = normalizeRule(rule); if (n) out.push(n); }
  return out;
}
