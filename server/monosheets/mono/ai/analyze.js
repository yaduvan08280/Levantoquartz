// ============================================================
//  Mono — Local Data Analyzer
//  Analyzes a 2D array of data locally.
// ============================================================

/**
 * Analyzes a 2D array of values.
 * @param {Array<Array<any>>} data
 * @returns {string} Summary report
 */
export function analyzeLocal(data) {
  if (!data || !data.length || !data[0].length) return 'No data to analyze.';
  
  const numRows = data.length;
  const numCols = data[0].length;
  let emptyCells = 0;
  let numericCells = 0;
  
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const v = data[r][c];
      if (v === null || v === undefined || v === '') emptyCells++;
      else if (typeof v === 'number') numericCells++;
    }
  }
  
  let report = `Selected range contains ${numRows} rows and ${numCols} columns.\n`;
  report += `- Empty cells: ${emptyCells} (${Math.round((emptyCells/(numRows*numCols))*100)}%)\n`;
  report += `- Numeric cells: ${numericCells} (${Math.round((numericCells/(numRows*numCols))*100)}%)\n`;
  
  return report;
}

