// ============================================================
//  Mono formula engine — arrayAware flags + vectorization for the
//  GS-parity modules (stats, math2, misc, text2, datetime2,
//  financial, engineering). MUST be imported AFTER every builtins_*
//  module so all functions are registered.
//
//  Why: any function that consumes a whole range must be marked
//  arrayAware, otherwise mapCall (arrayMode) decomposes its range
//  arguments elementwise and silently returns garbage.
// ============================================================
import { registry } from './registry.js';
import { vectorize } from './builtins_array.js';

const RANGE_CONSUMING = [
  // stats — aggregates & tests
  'STDEV', 'STDEVA', 'STDEVP', 'STDEVPA', 'STDEV.S', 'STDEV.P', 'VAR', 'VARA', 'VARP', 'VARPA', 'VAR.S', 'VAR.P',
  'AVEDEV', 'DEVSQ', 'GEOMEAN', 'HARMEAN', 'AVERAGEA', 'MAXA', 'MINA', 'COUNTUNIQUE',
  'TRIMMEAN', 'MODE.MULT', 'AVERAGEIFS', 'MAXIFS', 'MINIFS',
  'PERCENTILE', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE', 'QUARTILE.INC', 'QUARTILE.EXC',
  'RANK', 'RANK.EQ', 'RANK.AVG', 'PERCENTRANK', 'PERCENTRANK.INC', 'PERCENTRANK.EXC',
  'FREQUENCY', 'CORREL', 'RSQ', 'COVAR', 'COVARIANCE.P', 'COVARIANCE.S',
  'SLOPE', 'INTERCEPT', 'FORECAST', 'FORECAST.LINEAR', 'STEYX', 'TREND', 'GROWTH', 'LINEST',
  'SKEW', 'SKEW.P', 'KURT', 'PROB', 'CHISQ.TEST', 'CHITEST', 'T.TEST', 'TTEST', 'F.TEST', 'FTEST', 'Z.TEST', 'ZTEST',
  // math2
  'SUMSQ', 'SUMX2MY2', 'SUMX2PY2', 'SUMXMY2', 'SERIESSUM', 'MULTINOMIAL',
  'MMULT', 'MDETERM', 'MINVERSE', 'MUNIT', 'SUBTOTAL', 'AGGREGATE',
  // misc / lookup
  'OFFSET', 'LOOKUP', 'XMATCH', 'CELL',
  // text2 (array in / array out)
  'JOIN', 'SPLIT', 'TEXTJOIN',
  // datetime2 (holiday ranges)
  'NETWORKDAYS', 'NETWORKDAYS.INTL', 'WORKDAY', 'WORKDAY.INTL',
  // financial (cash-flow ranges)
  'NPV', 'IRR', 'MIRR', 'XNPV', 'XIRR', 'FVSCHEDULE',
  // engineering (variadic complex aggregates)
  'IMSUM', 'IMSUB', 'IMPRODUCT', 'IMDIV',
  // database D-functions
  'DSUM', 'DAVERAGE', 'DCOUNT', 'DCOUNTA', 'DMAX', 'DMIN', 'DPRODUCT', 'DSTDEV', 'DSTDEVP', 'DVAR', 'DVARP', 'DGET',
];
for (const n of RANGE_CONSUMING) { const d = registry.get(n); if (d) d.arrayAware = true; }

// Vectorize the scalar key/criteria arguments of GS-parity lookups so
// e.g. ARRAYFORMULA(XMATCH(A:A, tbl)) maps row-by-row.
vectorize('XMATCH', [0]);
vectorize('LOOKUP', [0]);
vectorize('RANK', [0]);
vectorize('RANK.EQ', [0]);
vectorize('RANK.AVG', [0]);
vectorize('PERCENTRANK', [1]);
vectorize('AVERAGEIFS', (n) => { const p = []; for (let i = 2; i < n; i += 2) p.push(i); return p; });
vectorize('MAXIFS', (n) => { const p = []; for (let i = 2; i < n; i += 2) p.push(i); return p; });
vectorize('MINIFS', (n) => { const p = []; for (let i = 2; i < n; i += 2) p.push(i); return p; });

export default registry;
