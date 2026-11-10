/**
 * The PII scrubber and the TS port of imani-coupon-core's Redactor (#589 section 2b, rules 3 and 4).
 *
 * `scrub` replaces matches with a typed placeholder and is applied to every free-text string that
 * the inventory lets through (memos when opted in, error templates, unknown key names). `scanText`
 * is the fail-closed gate: the same patterns, used to find rather than replace, over the final
 * `data/` bytes. Order matters: the specific bearer forms go first so a cashu token is reported as
 * a token and not as a run of base64.
 */

export interface Pattern {
  kind: string
  re: RegExp
  /** Extra check on a match, for shapes a regex cannot decide (Luhn). */
  accept?: (match: string) => boolean
}

function luhnOk(digits: string): boolean {
  const d = digits.replace(/\D/g, '')
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  let dbl = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (dbl) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    dbl = !dbl
  }
  return sum % 10 === 0
}

const STREET_WORDS =
  'Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Way|Court|Ct|Place|Pl|Square|Sq|Terrace|Close|Crescent'
const DUTCH_STREET = '[A-Z][a-z]+(?:straat|weg|laan|plein|gracht|kade|dijk|singel|steeg|hof)'

export const PATTERNS: Pattern[] = [
  { kind: 'auth', re: /\bNostr\s+[A-Za-z0-9+/=]{16,}/g },
  { kind: 'token', re: /\bcashu[AB][A-Za-z0-9_\-+/=]{8,}/g },
  { kind: 'bech32', re: /\b(?:nsec|npub|nprofile|nevent|naddr|note|lnurl|lnbc|lntb|lnbcrt)1[02-9ac-hj-np-z]{6,}/gi },
  { kind: 'code', re: /\bimani[\s\-_.]*(?:[0-9a-z][\s\-_.]*){12}(?![0-9a-z])/gi },
  { kind: 'code', re: /\bSNAP[\s-]*(?:[0-9A-Z][\s-]*){9}(?![0-9A-Z])/gi },
  { kind: 'hex', re: /\b[0-9a-fA-F]{32,}\b/g },
  { kind: 'url', re: /\bhttps?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'ip', re: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g },
  { kind: 'ip', re: /\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b/g },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g, accept: (m) => m.replace(/\s/g, '').length >= 15 },
  { kind: 'card', re: /\b\d(?:[ -]?\d){12,18}\b/g, accept: luhnOk },
  { kind: 'phone', re: /(?:\+|\b00)\d[\d\s().-]{6,}\d\b/g },
  { kind: 'phone', re: /\b0\d{1,3}[\s-]?\d{6,8}\b/g },
  { kind: 'stripe', re: /\b(?:pi|ch|cus|pm|seti|cs|in|sub|acct|re|txn)_[A-Za-z0-9]{8,}\b/g },
  { kind: 'address', re: new RegExp(`\\b\\d{1,5}[A-Za-z]?\\s+(?:[A-Z][a-z]+\\s+){1,3}(?:${STREET_WORDS})\\b\\.?`, 'g') },
  { kind: 'address', re: new RegExp(`\\b${DUTCH_STREET}\\s+\\d{1,5}[a-zA-Z]?\\b`, 'g') },
  { kind: 'postcode', re: /\b\d{4}\s?[A-Z]{2}\b/g },
  { kind: 'postcode', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}\b/g },
]

/** Scrubber version recorded in the manifest. Bump when PATTERNS change meaning. */
export const PII_SCRUBBER_VERSION = 1 as const

/** Replace every pattern match and every known identifier with a typed placeholder. */
export function scrub(text: string, known: Iterable<string> = []): string {
  let out = text
  for (const id of known) {
    if (id.length < 4) continue
    const re = new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, '<id>')
  }
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => (p.accept && !p.accept(m) ? m : `<${p.kind}>`))
  }
  return out
}

/** The first pattern that matches `text`, or null. */
export function findPattern(text: string): string | null {
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    for (const m of text.matchAll(p.re)) {
      if (!p.accept || p.accept(m[0])) return p.kind
    }
  }
  return null
}
