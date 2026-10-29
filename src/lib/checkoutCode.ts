/**
 * The checkout code itself (#402, contract §1): the twelve symbols a customer types at a stall's
 * online shop, with nothing else in this module.
 *
 * ## The shape
 *
 * Crockford base32 with no I, L, O or U. Eleven random data symbols and one Luhn mod 32 check
 * symbol, shown as `IMANI-XXXX-XXXX-XXXX` and kept in its compact canonical form `IMANIXXXXXXXXXXXX`
 * (17 characters, which also fits a Shopify gift card). The code store generates every code. The
 * wallet only ever reads, checks and shows one, so there is no generator here.
 *
 * ## Why normalising is strict about its order
 *
 * A person types what they see, in any case, with or without hyphens, and confuses O with 0 and I
 * or L with 1. The contract fixes the steps so the wallet, the store and every platform plugin turn
 * the same keystrokes into the same canonical code. The prefix is matched BEFORE the look-alikes are
 * mapped, because `IMANI` itself contains an `I`.
 *
 * Two different failures are told apart. Input that is not shaped like an Imani code at all is
 * `not_a_code`, and a platform leaves it alone so ordinary coupons keep working. Input that is
 * shaped right but fails the check symbol is `check`: a typo, caught locally before any network
 * call, and worth telling the person about.
 *
 * Every rule here is pinned by `docs/checkout-codes/vectors.json`, which the other implementations
 * test against too.
 */

/** Crockford base32. The index of a symbol is its value. */
export const CHECKOUT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** The prefix every checkout code carries, in display and canonical form alike. */
export const CHECKOUT_PREFIX = 'IMANI'

/** Data symbols plus the check symbol. */
const BODY_LENGTH = 12

export type CheckoutCodeProblem = 'not_a_code' | 'check'

export type NormalisedCode = { ok: true; canonical: string } | { ok: false; problem: CheckoutCodeProblem }

const value = (symbol: string): number => CHECKOUT_ALPHABET.indexOf(symbol)

/**
 * The Luhn mod 32 sum over `symbols`, right to left, starting with `firstFactor` on the last
 * symbol. Shared by {@link checkSymbol} (factor 2, the check is not there yet) and
 * {@link isValidBody} (factor 1, the check is the last symbol).
 */
function luhnSum(symbols: string, firstFactor: 1 | 2): number {
  let factor = firstFactor
  let sum = 0
  for (let i = symbols.length - 1; i >= 0; i--) {
    const a = factor * value(symbols[i])
    sum += Math.floor(a / 32) + (a % 32)
    factor = factor === 2 ? 1 : 2
  }
  return sum
}

const onlyAlphabet = (text: string) => [...text].every((c) => value(c) >= 0)

/** The check symbol for eleven data symbols. Throws on anything else: a caller bug, not input. */
export function checkSymbol(data: string): string {
  if (data.length !== BODY_LENGTH - 1 || !onlyAlphabet(data)) throw new Error('checkSymbol takes 11 alphabet symbols')
  return CHECKOUT_ALPHABET[(32 - (luhnSum(data, 2) % 32)) % 32]
}

/** Whether twelve symbols (data then check) are in the alphabet and pass the check. */
export function isValidBody(body: string): boolean {
  return body.length === BODY_LENGTH && onlyAlphabet(body) && luhnSum(body, 1) % 32 === 0
}

/**
 * What a person typed, as the canonical code, or why it is not one. Contract §1, in its order:
 * uppercase (ASCII only), drop separators, strip the prefix, map the look-alikes, then the length
 * and the check.
 */
export function normalise(typed: string): NormalisedCode {
  const upper = String(typed ?? '').replace(/[a-z]/g, (c) => c.toUpperCase())
  const squeezed = upper.replace(/[ \t\-_.]/g, '')
  if (!squeezed.startsWith(CHECKOUT_PREFIX)) return { ok: false, problem: 'not_a_code' }
  const body = squeezed
    .slice(CHECKOUT_PREFIX.length)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (body.length !== BODY_LENGTH || !onlyAlphabet(body)) return { ok: false, problem: 'not_a_code' }
  if (!isValidBody(body)) return { ok: false, problem: 'check' }
  return { ok: true, canonical: CHECKOUT_PREFIX + body }
}

/** The body of a canonical code, or a thrown error: callers hand this only what normalise made. */
function bodyOf(canonical: string): string {
  const body = canonical.startsWith(CHECKOUT_PREFIX) ? canonical.slice(CHECKOUT_PREFIX.length) : ''
  if (!isValidBody(body)) throw new Error('not a canonical checkout code')
  return body
}

/** `IMANI-XXXX-XXXX-XXXX`, the form a person reads and types. */
export function display(canonical: string): string {
  const body = bodyOf(canonical)
  return `${CHECKOUT_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`
}

/** `IMANIXXXXXXXXXXXX`, for fields that allow no hyphens. The same as the canonical form. */
export function compact(canonical: string): string {
  return CHECKOUT_PREFIX + bodyOf(canonical)
}
