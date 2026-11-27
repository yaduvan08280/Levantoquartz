// ============================================================
//  Mono — Hinglish/English query normalizer (P21)
//  Deterministic pre-pass shared by the browser (intents,
//  localBrain, copilot) and Node (server tiers, tests).
//
//  Pipeline: unicode cleanup → Devanagari word map (high
//  precision) → Devanagari char transliteration (fallback) →
//  romanized-Hinglish canonicalization (word-boundary, case-
//  insensitive, longest-phrase-first).
//
//  Design rules:
//  - NEVER touch cell refs, numbers, or single letters (a-z
//    could be a column). Every mapping is a whole word ≥2 chars.
//  - Structural Hinglish the brain already parses (se, tak, me,
//    mein, par, pe, ka/ki/ke) is left alone.
//  - Operation words map to the canonical English tokens that
//    intents.js and localBrain.js understand — so those modules
//    stay simple and each layer is testable alone.
// ============================================================

/* ---------- 1. Devanagari word map (precision layer) ----------
   Whole Hindi words → canonical English (or structural roman).
   Checked before char transliteration so schwa-deletion typing
   ("गिनती" → "ginti", not "ginati") can't cause a miss. */
const DEVA_WORDS = {
  'जोड़': 'sum', 'जोड़ो': 'sum', 'जोड़िए': 'sum', 'जोड़ दो': 'sum', 'योग': 'sum', 'जमा': 'sum',
  'कुल': 'total', 'घटाओ': 'subtract', 'घटा': 'subtract', 'गुणा': 'multiply', 'भाग': 'divide',
  'औसत': 'average', 'माध्यिका': 'median',
  'गिनती': 'count', 'गिनो': 'count', 'गिन': 'count',
  'कितने': 'how many', 'कितना': 'how many', 'कितनी': 'how many',
  'सबसे बड़ा': 'max', 'सबसे ज़्यादा': 'max', 'सबसे ज्यादा': 'max', 'सबसे अधिक': 'max',
  'सबसे छोटा': 'min', 'सबसे कम': 'min',
  'खोजो': 'find', 'खोजें': 'find', 'ढूंढो': 'find', 'ढूँढो': 'find', 'ढूंढ': 'find',
  'निकालो': 'get', 'निकाल': 'get', 'लाओ': 'get',
  'हटाओ': 'remove', 'हटा दो': 'remove', 'मिटाओ': 'remove',
  'बदलो': 'change', 'बदल दो': 'change',
  'बनाओ': 'make', 'बना दो': 'make', 'बनाऊं': 'make', 'बनाऊँ': 'make',
  'दिखाओ': 'show', 'दिखा दो': 'show', 'बताओ': 'tell', 'बता दो': 'tell',
  'लिखो': 'write', 'लिख दो': 'write', 'लगाओ': 'apply', 'लगा दो': 'apply',
  'डालो': 'put', 'डाल दो': 'put',
  'साफ़': 'clean', 'साफ': 'clean', 'ठीक करो': 'fix', 'ठीक': 'fix',
  'समझाओ': 'explain', 'समझा दो': 'explain', 'मतलब': 'meaning',
  'खाली': 'blank', 'भरा': 'filled', 'भरे': 'filled',
  'अगर': 'if', 'वरना': 'else', 'तो': 'then',
  'प्रतिशत': 'percent', 'आज': 'today', 'अभी': 'now',
  'पहला': 'first', 'पहली': 'first', 'आखिरी': 'last', 'अंतिम': 'last',
  'अलग अलग': 'unique', 'अलग-अलग': 'unique',
  'कॉलम': 'column', 'स्तंभ': 'column', 'पंक्ति': 'row', 'सेल': 'cell', 'शीट': 'sheet',
  'से': 'se', 'तक': 'tak', 'में': 'me', 'पर': 'par',
  'का': 'ka', 'की': 'ki', 'के': 'ke', 'को': 'ko',
  'और': 'aur', 'या': 'or', 'है': '', 'हैं': '', 'करो': '', 'कर दो': '', 'कीजिए': '',
  'मुझे': '', 'चाहिए': '', 'कृपया': 'please', 'क्या': 'kya', 'कैसे': 'kaise',
  'जहां': 'jaha', 'जहाँ': 'jaha', 'जिसका': 'jiska', 'जिनका': 'jinka',
  'ज़्यादा': 'zyada', 'ज्यादा': 'zyada', 'ऊपर': 'upar', 'नीचे': 'neeche', 'कम': 'kam',
  'बराबर': 'barabar',
};

/* ---------- 2. Devanagari char transliteration (fallback) ---------- */
// Canonical form is DECOMPOSED: precomposed nukta letters (U+0958–U+095F)
// are rewritten to base+nukta before any matching, for both input text and
// word-map keys — so it never matters how an editor or IME encoded them.
const NUKTA = '़', VIRAMA = '्';
const PRECOMPOSED = { 'क़': 'क', 'ख़': 'ख', 'ग़': 'ग', 'ज़': 'ज', 'ड़': 'ड', 'ढ़': 'ढ', 'फ़': 'फ', 'य़': 'य' };
const decomposeNukta = (s) => String(s).replace(/[क़-य़]/g, (ch) => PRECOMPOSED[ch] + NUKTA);
// base consonant + nukta → sound
const NUKTA_SOUNDS = { 'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'd', 'ढ': 'rh', 'फ': 'f', 'य': 'y' };
const DEVA_CONSONANTS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l',
  'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
};
const DEVA_VOWELS = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e' };
const DEVA_MATRAS = { 'ा': 'aa', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' };
const DEVA_SIGNS = { 'ं': 'n', 'ँ': 'n', 'ः': 'h' };
const DEVA_DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
const isDeva = (ch) => ch >= 'ऀ' && ch <= 'ॿ';

/**
 * Char-level Devanagari → roman. Inherent 'a' is emitted only when
 * another Devanagari consonant follows (word-final schwa deletion:
 * "जोड" → "jod", not "joda"). Non-Devanagari text passes through.
 */
export function transliterateDevanagari(text) {
  const s = decomposeNukta(text || '');
  if (!/[ऀ-ॿ]/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!isDeva(ch)) { out += ch; continue; }
    if (DEVA_DIGITS[ch] !== undefined) { out += DEVA_DIGITS[ch]; continue; }
    if (DEVA_VOWELS[ch]) { out += DEVA_VOWELS[ch]; continue; }
    if (DEVA_SIGNS[ch]) { out += DEVA_SIGNS[ch]; continue; }
    if (ch === '।' || ch === '॥') { out += '. '; continue; }
    if (ch === VIRAMA || ch === NUKTA) continue;
    let cons = DEVA_CONSONANTS[ch];
    if (cons) {
      let j = i;
      if (s[j + 1] === NUKTA && NUKTA_SOUNDS[ch]) { cons = NUKTA_SOUNDS[ch]; j++; }
      out += cons;
      const next = s[j + 1];
      if (next && DEVA_MATRAS[next]) { out += DEVA_MATRAS[next]; j++; }
      else if (next === VIRAMA) { j++; }
      else if (next && (DEVA_CONSONANTS[next] || PRECOMPOSED[next])) { out += 'a'; } // medial schwa
      i = j;
      continue;
    }
    // anything else in the block (rare) — drop silently
  }
  return out;
}

/* ---------- 3. Romanized-Hinglish canonicalization ----------
   phrase → replacement. Multi-word phrases are applied first.
   '' means "filler — drop". Single letters are never keys. */
const CANON = {
  // -- aggregates / math verbs --
  'jod do': 'sum', 'jod dijiye': 'sum', 'joddo': 'sum', 'jama karo': 'sum', 'jama kar do': 'sum', 'jama kardo': 'sum',
  'kul jod': 'total', 'kul yog': 'total',
  jod: 'sum', jodo: 'sum', jodiye: 'sum', yog: 'sum', jama: 'sum', kul: 'total',
  'ghata do': 'subtract', ghatado: 'subtract', ghatao: 'subtract', ghata: 'subtract',
  'guna karo': 'multiply', guna: 'multiply', 'bhag do': 'divide', 'bhaag do': 'divide', bhag: 'divide', bhaag: 'divide',
  ausat: 'average', avsat: 'average', awsat: 'average', madhyika: 'median', madhya: 'median',
  ginti: 'count', ginati: 'count', gino: 'count', 'gin lo': 'count', ginlo: 'count', gin: 'count',
  kitna: 'how many', kitne: 'how many', kitni: 'how many', ktne: 'how many', kitte: 'how many',
  'sabse bada': 'max', 'sabse badi': 'max', 'sabse zyada': 'max', 'sabse jyada': 'max', 'sabse adhik': 'max',
  'sab se bada': 'max', 'sab se zyada': 'max',
  'sabse chota': 'min', 'sabse choti': 'min', 'sabse kam': 'min', 'sab se kam': 'min', 'sabse neeche': 'min', 'sabse niche': 'min',
  'square root': 'sqrt', 'varg mool': 'sqrt', vargmool: 'sqrt',
  'alag alag': 'unique', 'alag-alag': 'unique',
  pratishat: 'percent', prtishat: 'percent',
  // -- action verbs --
  khojo: 'find', khojiye: 'find', khoj: 'find', dhundho: 'find', dhundo: 'find', dhoondho: 'find', dhoondo: 'find', dhundh: 'find', dhund: 'find', dundho: 'find',
  'nikal do': 'get', nikalo: 'get', nikaalo: 'get', nikale: 'get', nikal: 'get', lao: 'get', 'le ao': 'get',
  'hata do': 'remove', hatado: 'remove', hatao: 'remove', 'mita do': 'remove', mitao: 'remove',
  'badal do': 'change', badaldo: 'change', badlo: 'change', badal: 'change',
  'bana do': 'make', banado: 'make', banao: 'make', banaiye: 'make', banau: 'make', banaun: 'make',
  'dikha do': 'show', dikhado: 'show', dikhao: 'show', dikhaiye: 'show',
  'bata do': 'tell', batado: 'tell', batao: 'tell', bataiye: 'tell', bataye: 'tell', batana: 'tell',
  'laga do': 'apply', lagado: 'apply', lagao: 'apply',
  'dal do': 'put', daldo: 'put', dalo: 'put', 'daal do': 'put', daalo: 'put',
  'likh do': 'write', likho: 'write',
  'saaf karo': 'clean', 'saf karo': 'clean', saaf: 'clean',
  'theek karo': 'fix', 'thik karo': 'fix', 'sahi karo': 'fix', chuno: 'select',
  'samjha do': 'explain', samjhao: 'explain', samjhaiye: 'explain', samjha: 'explain', matlab: 'meaning',
  ajeeb: 'weird', ajib: 'weird', gadbad: 'weird', garbar: 'weird', jancho: 'analyze', jaanch: 'analyze',
  // -- condition / logic words --
  agar: 'if', agr: 'if',
  'nahi to': 'else', 'nahi toh': 'else', 'nhi to': 'else', warna: 'else', varna: 'else', vrna: 'else',
  toh: 'then',
  // -- state words --
  khali: 'blank', khaali: 'blank', bhara: 'filled', bhare: 'filled', bhari: 'filled',
  aaj: 'today', abhi: 'now',
  pehla: 'first', pehli: 'first', pahla: 'first', pahli: 'first', aakhri: 'last', akhri: 'last', antim: 'last',
  pankti: 'row', stambh: 'column', kolam: 'column', colum: 'column', colomn: 'column',
  // -- question forms --
  'kya main': 'can i', 'kya mai': 'can i', 'kya hum': 'can i', 'kya me': 'can i',
  'ho sakta hai': 'is it possible', 'ho sakta h': 'is it possible', 'ho sakti hai': 'is it possible',
  'kar sakta hun': 'is it possible', 'kar sakta hu': 'is it possible', 'kar sakte hain': 'is it possible', 'kar sakti hun': 'is it possible',
  kaise: 'how do i', kya: '',
  // -- abbreviations & fillers (dropped or expanded) --
  pls: 'please', plz: 'please', plss: 'please', plzz: 'please', calc: 'calculate',
  'kar do': '', 'kar de': '', 'kar dijiye': '', 'de do': '', dedo: '', krdo: '', kardo: '', karde: '', kariye: '', kijiye: '',
  karna: '', krna: '', karein: '', karen: '', kare: '', karo: '', kar: '',
  mujhe: '', mujhko: '', mereko: '', muje: '', chahiye: '', chaiye: '', chahie: '',
  wala: '', wale: '', wali: '', vala: '', vale: '', vali: '',
  hai: '', hain: '', bhi: '', zara: '', bas: '', sirf: '',
};

// Longest phrases first so "sabse bada" wins before "bada"/"sabse".
const CANON_RULES = Object.keys(CANON)
  .sort((a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length)
  .map((k) => ({ re: new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), to: CANON[k] }));

// Keys are decomposed with the same function applied to input text, and
// wrapped in Devanagari "word boundary" lookarounds (\b is ASCII-only), so
// 'तो' can never match inside 'तोड़ो'.
const DEVA_WORDS_DECOMP = Object.fromEntries(
  Object.entries(DEVA_WORDS).map(([k, v]) => [decomposeNukta(k), v]));
const DEVA_RULES = Object.keys(DEVA_WORDS_DECOMP)
  .sort((a, b) => b.length - a.length)
  .map((k) => ({
    re: new RegExp(`(?<![ऀ-ॿ])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![ऀ-ॿ])`, 'g'),
    to: DEVA_WORDS_DECOMP[k] === '' ? ' ' : ` ${DEVA_WORDS_DECOMP[k]} `,
  }));

/** Romanized-Hinglish → canonical English tokens. Case of untouched text is preserved. */
export function canonicalize(text) {
  let t = String(text || '');
  for (const { re, to } of CANON_RULES) t = t.replace(re, to);
  return t;
}

/**
 * Full normalization pipeline. Idempotent; safe to call anywhere.
 * @returns {{ text: string, changed: boolean, hadDevanagari: boolean }}
 */
export function normalizeQuery(text) {
  const original = String(text || '');
  let t = original
    .replace(/[​-‍﻿]/g, '')      // zero-width chars
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"'); // curly quotes
  const hadDevanagari = /[ऀ-ॿ]/.test(t);
  if (hadDevanagari) {
    t = decomposeNukta(t);                                         // canonical form
    for (const { re, to } of DEVA_RULES) t = t.replace(re, to);   // word map first
    t = transliterateDevanagari(t);                                // char fallback
  }
  t = canonicalize(t)
    .replace(/\s+/g, ' ')
    .trim();
  return { text: t, changed: t !== original.trim(), hadDevanagari };
}

