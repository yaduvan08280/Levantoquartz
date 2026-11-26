// ============================================================
//  Mono formula engine — lexer (Phase 2)
//  Turns a formula body (without the leading '=') into tokens.
// ============================================================
import { errorFromText } from './errors.js';

const T = {
  WS: /^\s+/,
  NUM: /^(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/,
  STR: /^"(?:[^"]|"")*"/,
  ERR: /^(?:#REF!|#DIV\/0!|#N\/A|#NAME\?|#NULL!|#NUM!|#VALUE!|#ERROR!|#CYCLE!)/i,
  SHEETQ: /^'((?:[^']|'')*)'!/,
  SHEETB: /^([A-Za-z_][A-Za-z0-9_]*)!/,
  CELL: /^\$?[A-Za-z]{1,3}\$?\d+/,
  IDENT: /^[A-Za-z_][A-Za-z0-9_.]*/,
  OP: /^(?:<=|>=|<>|[-+*/^&=<>])/,
};
const PUNCT = { '(': 'lp', ')': 'rp', '{': 'lbrace', '}': 'rbrace', ',': 'comma', ';': 'semi', ':': 'colon' };

export function lex(src) {
  const toks = []; let s = src;
  while (s.length) {
    let m;
    if ((m = T.WS.exec(s))) { s = s.slice(m[0].length); continue; }
    if ((m = T.STR.exec(s))) { toks.push({ type: 'str', value: m[0].slice(1, -1).replace(/""/g, '"') }); s = s.slice(m[0].length); continue; }
    if ((m = T.ERR.exec(s))) { toks.push({ type: 'err', value: errorFromText(m[0]) }); s = s.slice(m[0].length); continue; }
    if ((m = T.NUM.exec(s))) { toks.push({ type: 'num', value: parseFloat(m[0]) }); s = s.slice(m[0].length); continue; }

    // sheet qualifier?
    let sheet = null;
    if ((m = T.SHEETQ.exec(s))) { sheet = m[1].replace(/''/g, "'"); s = s.slice(m[0].length); }
    else if ((m = T.SHEETB.exec(s))) { sheet = m[1]; s = s.slice(m[0].length); }
    if (sheet !== null) {
      if ((m = T.CELL.exec(s))) { const text = m[0], after = s[text.length]; if (!(after && /[A-Za-z0-9_.(]/.test(after))) { toks.push({ type: 'ref', sheet, text }); s = s.slice(text.length); continue; } }
      if ((m = T.IDENT.exec(s))) { toks.push({ type: 'name', sheet, text: m[0] }); s = s.slice(m[0].length); continue; }
      toks.push({ type: 'name', sheet, text: '' }); continue;
    }

    // cell ref (not part of a longer ident / function)
    if ((m = T.CELL.exec(s))) { const text = m[0], after = s[text.length]; if (!(after && /[A-Za-z0-9_.(]/.test(after))) { toks.push({ type: 'ref', sheet: null, text }); s = s.slice(text.length); continue; } }

    if ((m = T.IDENT.exec(s))) {
      const word = m[0]; let k = word.length; while (/\s/.test(s[k])) k++;
      if (s[k] === '(') toks.push({ type: 'func', text: word });
      else if (/^(TRUE|FALSE)$/i.test(word)) toks.push({ type: 'bool', value: /^true$/i.test(word) });
      else toks.push({ type: 'name', sheet: null, text: word });
      s = s.slice(word.length); continue;
    }

    const ch = s[0];
    if (PUNCT[ch]) { toks.push({ type: PUNCT[ch] }); s = s.slice(1); continue; }
    if (ch === '%') { toks.push({ type: 'op', op: '%' }); s = s.slice(1); continue; }
    if ((m = T.OP.exec(s))) { toks.push({ type: 'op', op: m[0] }); s = s.slice(m[0].length); continue; }

    throw new Error('Unexpected character: "' + ch + '"');
  }
  toks.push({ type: 'eof' });
  return toks;
}
export default lex;
