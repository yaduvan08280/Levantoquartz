/**
 * Q.C. Form — split the multi-select "Defects" checkbox answer into the
 * existing "Defect 1" .. "Defect 6" columns on every form submission.
 *
 * Google Forms writes every ticked checkbox into ONE cell (your "Defects"
 * column, M), joined by ", ". This spreads them across Defect 1..6.
 *
 * Columns are found by HEADER NAME, so the order of columns and the
 * Google Sheets "Tables" formatting don't matter.
 */

// ============ SETTINGS ============
const DEFECT_QUESTION_HEADER = 'Defects'; // the combined checkbox column (your column M)
const NUM_DEFECT_COLUMNS     = 6;         // Defect 1 .. Defect 6
// ==================================


function splitDefectsOnSubmit(e) {
  const sheet   = e.range.getSheet();
  const row     = e.range.getRow();
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  const norm     = s => String(s).trim().toLowerCase();          // "Defects" -> "defects"
  const stripped = s => norm(s).replace(/\s+/g, '');             // "Defect 1" -> "defect1"

  // 1. Find the combined checkbox column ("Defects")
  let srcCol = 0;
  for (let c = 0; c < headers.length; c++) {
    if (norm(headers[c]) === norm(DEFECT_QUESTION_HEADER)) { srcCol = c + 1; break; }
  }
  if (srcCol === 0) {
    Logger.log('Source header "%s" not found — check spelling.', DEFECT_QUESTION_HEADER);
    return;
  }

  // 2. Map each "Defect N" destination column by its header
  //    (matches "Defect 1", "Defect1", "defect 1" — all the same)
  const destCols = [];
  for (let i = 1; i <= NUM_DEFECT_COLUMNS; i++) {
    let col = 0;
    for (let c = 0; c < headers.length; c++) {
      if (stripped(headers[c]) === 'Defect' + i) { col = c + 1; break; }
    }
    destCols.push(col); // 0 = header not found (that slot is skipped)
  }

  // 3. Read the combined answer and split on commas
  const raw     = String(sheet.getRange(row, srcCol).getValue());
  const defects = raw.split(/\s*,\s*/).map(d => d.trim()).filter(d => d);

  // 4. Write one defect per column (blanks clear old values)
  for (let i = 0; i < NUM_DEFECT_COLUMNS; i++) {
    if (destCols[i] > 0) sheet.getRange(row, destCols[i]).setValue(defects[i] || '');
  }
}


/**
 * OPTIONAL — run once by hand to split rows already in the sheet.
 * Open the Q.C. response tab FIRST, then run this.
 * Note: your older rows hold free-text remarks (e.g. "patch pattern blur"),
 * not tidy checkbox labels, so those will just land whole in "Defect 1".
 */
function backfillExistingRows() {
  const sheet   = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow = sheet.getLastRow();
  for (let r = 2; r <= lastRow; r++) {
    splitDefectsOnSubmit({ range: sheet.getRange(r, 1) });
  }
}