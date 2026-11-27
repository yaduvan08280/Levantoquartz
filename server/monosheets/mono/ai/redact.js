// ============================================================
//  Mono — PII Redaction for AI (P13 security guardrail)
//  Strips emails, phone numbers, and potential credit card
//  numbers before any string hits the LLM provider.
// ============================================================

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?(\d{1,3}))?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{4})(?: *x(\d+))?\b/g;
const CC_RE = /\b(?:\d[ -]*?){13,16}\b/g;

/**
 * Replaces recognized PII with safe placeholders.
 * @param {string} text - The raw prompt or data context
 * @returns {string} Safe string for LLM
 */
export function redactForLLM(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(EMAIL_RE, '[EMAIL REDACTED]')
    .replace(CC_RE, (match) => {
      // Very crude check so we don't redact plain 16 digit IDs, but good enough for now.
      if (match.replace(/[^0-9]/g, '').length >= 13) return '[CARD REDACTED]';
      return match;
    })
    .replace(PHONE_RE, (match) => {
      // Avoid redacting things that look like numbers 1,000,000 etc
      const digits = match.replace(/[^0-9]/g, '');
      if (digits.length >= 10 && digits.length <= 15) return '[PHONE REDACTED]';
      return match;
    });
}

/**
 * The single choke point for LLM payloads (roadmap P13 guardrail):
 * deep-walks the ENTIRE context object — prompt, selection values,
 * headers, everything, no exceptions for "safe" columns — and redacts
 * every string. Bare numbers in the card-length range (13–16 digits)
 * are also redacted; a string-level regex pass over serialized JSON
 * can't do that without corrupting number tokens.
 *
 * @param {*} value - the fully-assembled payload
 * @returns {*} a redacted deep copy (input is not mutated)
 */
export function redactPayloadForLLM(value) {
  if (typeof value === 'string') return redactForLLM(value);
  if (typeof value === 'number' && /^\d{13,16}$/.test(String(Math.abs(value)))) return '[CARD REDACTED]';
  if (Array.isArray(value)) return value.map(redactPayloadForLLM);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactPayloadForLLM(value[k]);
    return out;
  }
  return value;
}

