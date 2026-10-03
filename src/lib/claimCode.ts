/**
 * Cashback claim codes as typed: the one reader the wallet and wallet-api share.
 *
 * Pure on purpose (no React, no config, no fetch), so `services/wallet-api`
 * can import it and refuse a non-code before spending a portal request on it.
 * Every wallet-api caller reaches the portal from one IP, and the portal
 * throttles malformed codes per IP, so one caller's typo would cost everyone.
 *
 * Two shapes, each with its own alphabet (#141):
 *
 * - **Current**, since gateway-portal 0.4.0 (GP-02): ten random characters from
 *   `CashbackService.CODE_ALPHABET`, `23456789ABCDEFGHJKMNPQRSTVWXYZ`. No 0, 1,
 *   O, I, L or U, because people mis-transcribe them.
 * - **Legacy**: six hex characters derived from the cashback id, `CB-XXXX-YY`.
 *   These DO contain 0 and 1, and receipts carrying them still redeem.
 *
 * Confusables are refused, never mapped. Reading O as something else is a
 * guess the portal has not agreed to, and a wrong guess spends a lookup.
 */

/** The portal's `CashbackService.CODE_ALPHABET`, verbatim. */
export const CURRENT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

/** The characters current codes leave out, in the order a person would list them. */
export const EXCLUDED_CODE_CHARACTERS = ['0', '1', 'O', 'I', 'L', 'U'] as const

export const CURRENT_VARIABLE_RE = /^[2-9A-HJKMNP-TV-Z]{10}$/
export const LEGACY_VARIABLE_RE = /^[0-9A-F]{6}$/
/** What the gateway matches on, narrowed to the characters each shape can hold. */
export const CANONICAL_RE = /^CB-(?:[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}|[0-9A-F]{4}-[0-9A-F]{2})$/

const CB_PREFIX = 'CB'
const CURRENT_LENGTH = 10
const LEGACY_LENGTH = 6

function alphanumOf(raw: string): string {
  return raw.toUpperCase().match(/[A-Z0-9]/g)?.join('') ?? ''
}

function isVariablePart(candidate: string): boolean {
  return CURRENT_VARIABLE_RE.test(candidate) || LEGACY_VARIABLE_RE.test(candidate)
}

/**
 * Whatever the customer typed, reduced to the characters that matter.
 *
 * Forgiving about case, spaces, missing dashes and a missing `CB` prefix.
 * Returns null when what is left is not a current or legacy code.
 */
export function normaliseTypedClaimCode(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const alphanum = alphanumOf(raw)
  // `CB` is stripped only when it leaves a whole code, so a bare code that
  // itself starts with C and B keeps them.
  const stripped = alphanum.startsWith(CB_PREFIX) ? alphanum.slice(CB_PREFIX.length) : null
  if (stripped !== null && isVariablePart(stripped)) return stripped
  return isVariablePart(alphanum) ? alphanum : null
}

/** The variable characters, punctuated the way the gateway stores them. */
export function toCanonicalClaimCode(variable: string): string {
  if (CURRENT_VARIABLE_RE.test(variable)) {
    return `CB-${variable.slice(0, 5)}-${variable.slice(5)}`
  }
  if (LEGACY_VARIABLE_RE.test(variable)) {
    return `CB-${variable.slice(0, 4)}-${variable.slice(4)}`
  }
  throw new Error('toCanonicalClaimCode: expected ten characters of the code alphabet or six hex characters')
}

/** Typed input straight to `CB-XXXXX-XXXXX` or `CB-XXXX-YY`, or null if it was never a code. */
export function canonicaliseTypedClaimCode(raw: string): string | null {
  const variable = normaliseTypedClaimCode(raw)
  return variable === null ? null : toCanonicalClaimCode(variable)
}

/**
 * Why a complete-looking entry was not accepted, in words that say what to do.
 *
 * Null while the entry is still short, or once it reads as a code: a hint that
 * fires mid-typing is nagging, not help. Only speaks when the length matches a
 * shape but a character cannot be in it.
 */
export function typedClaimCodeProblem(raw: string): string | null {
  if (typeof raw !== 'string' || canonicaliseTypedClaimCode(raw) !== null) return null
  const alphanum = alphanumOf(raw)
  const variable =
    alphanum.startsWith(CB_PREFIX) && [CURRENT_LENGTH, LEGACY_LENGTH].includes(alphanum.length - CB_PREFIX.length)
      ? alphanum.slice(CB_PREFIX.length)
      : alphanum

  if (variable.length === CURRENT_LENGTH) {
    const found = EXCLUDED_CODE_CHARACTERS.filter((c) => variable.includes(c))
    if (found.length > 0) {
      return (
        `Cashback codes never contain ${found.join(', ')}, so a character may have been misread. ` +
        'Check the receipt and try again.'
      )
    }
  }
  if (variable.length === LEGACY_LENGTH) {
    return 'A six-character code only uses the digits 0 to 9 and the letters A to F. Check the receipt again.'
  }
  return null
}
