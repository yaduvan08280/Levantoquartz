// Ad-hoc verification of nested/vectorized formula support. Run: node __nested_test.mjs
import { Engine } from './engine.js';
import { MonoWorkbook } from '../model/workbook.js';

const wb = new MonoWorkbook();
const sh = wb.sheets[0]; const sid = sh.id;
// A: labels, B: numbers, C: yes/no
const rows = [['a', 10, 'Yes'], ['b', 20, 'No'], ['c', 30, 'Yes'], ['a', 40, 'No'], ['b', 50, 'Yes']];
rows.forEach((r, i) => { sh.setRaw(i, 0, String(r[0])); sh.setRaw(i, 1, String(r[1])); sh.setRaw(i, 2, String(r[2])); });
// lookup table in H:I
[['a', 100], ['b', 200], ['c', 300]].forEach((r, i) => { sh.setRaw(i, 7, String(r[0])); sh.setRaw(i, 8, String(r[1])); });
const eng = new Engine(wb);

let pass = 0, fail = 0;
function t(name, formula, cellR, cellC, expected) {
  eng.setRaw(sid, cellR, cellC, formula);
  const got = [];
  for (let i = 0; i < expected.length; i++) got.push(eng.getDisplay(sid, cellR + i, cellC));
  const ok = JSON.stringify(got) === JSON.stringify(expected.map(String));
  if (ok) pass++; else { fail++; console.log('FAIL', name, formula, '\n  got     ', got, '\n  expected', expected); }
}

// 1. vectorized IF inside ARRAYFORMULA
t('array IF', '=ARRAYFORMULA(IF(C1:C5="Yes", B1:B5*2, 0))', 0, 4, [20, 0, 60, 0, 100]);
// 2. nested IF + COUNTIF vectorized
t('IF+COUNTIF', '=ARRAYFORMULA(IF(COUNTIF(A1:A5, A1:A5)>1, "dup", "uniq"))', 0, 5, ['dup', 'dup', 'uniq', 'dup', 'dup']);
// 3. vectorized VLOOKUP (spills even without ARRAYFORMULA)
t('vec VLOOKUP', '=VLOOKUP(A1:A5, H1:I3, 2, FALSE)', 0, 6, [100, 200, 300, 100, 200]);
// 4. IFERROR over array with errors
t('array IFERROR', '=ARRAYFORMULA(IFERROR(B1:B5/(B1:B5-30), "-"))', 0, 9, ['-0.5', '-2', '-', '4', '2.5']);
// 5. FILTER with computed source
t('FILTER computed src', '=FILTER(B1:B5*10, C1:C5="Yes")', 0, 10, [100, 300, 500]);
// 6. deep nesting: SUM(IF(...)) style
t('SUM of array IF', '=SUM(ARRAYFORMULA(IF(C1:C5="Yes", B1:B5, 0)))', 0, 11, [90]);
// 7. SUM with broadcast expression, no ARRAYFORMULA (Excel-style)
t('SUM(range*2)', '=SUM(B1:B5*2)', 1, 11, [300]);
// 8. SWITCH vectorized
t('array SWITCH', '=ARRAYFORMULA(SWITCH(A1:A5, "a", 1, "b", 2, 99))', 0, 12, [1, 2, 99, 1, 2]);
// 9. IFS vectorized
t('array IFS', '=ARRAYFORMULA(IFS(B1:B5>=40, "hi", B1:B5>=20, "mid", TRUE, "lo"))', 0, 13, ['hi'.replace('hi','lo'), 'mid', 'mid', 'hi', 'hi']);
// 10. CHOOSE vectorized
t('array CHOOSE', '=ARRAYFORMULA(CHOOSE(IF(C1:C5="Yes",1,2), "Y", "N"))', 0, 14, ['Y', 'N', 'Y', 'N', 'Y']);
// 11. MATCH vectorized
t('vec MATCH', '=ARRAYFORMULA(MATCH(A1:A5, H1:H3, 0))', 0, 15, [1, 2, 3, 1, 2]);
// 12. monster nesting
t('monster', '=ARRAYFORMULA(IF(ISNUMBER(MATCH(A1:A5,H1:H3,0)), IFERROR(VLOOKUP(A1:A5,H1:I3,2,FALSE)/(B1:B5-30),"div0"), "na"))', 0, 16, ['-5', '-20', 'div0', 10, 10]);
// 13. SORT of computed array
t('SORT computed', '=SORT(FILTER(B1:B5*2, C1:C5="Yes"), 1, FALSE)', 0, 17, [100, 60, 20]);
// 14. scalar IF still short-circuits
t('scalar IF', '=IF(1>2, 1/0, "ok")', 1, 18, ['ok']);
// 15. XLOOKUP vectorized
t('vec XLOOKUP', '=ARRAYFORMULA(XLOOKUP(A1:A5, H1:H3, I1:I3, "?"))', 0, 19, [100, 200, 300, 100, 200]);
// 16. SUMIF with array criteria
t('vec SUMIF', '=ARRAYFORMULA(SUMIF(A1:A5, A1:A5, B1:B5))', 0, 20, [50, 70, 30, 50, 70]);
// 17. TEXT auto-mapped (existing behavior intact)
t('map TEXT', '=ARRAYFORMULA(TEXT(B1:B5, "0.0"))', 0, 21, ['10.0', '20.0', '30.0', '40.0', '50.0']);
// 18. IFNA vectorized
t('array IFNA', '=ARRAYFORMULA(IFNA(MATCH(A1:A5, H1:H2, 0), 0))', 0, 22, [1, 2, 0, 1, 2]);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
