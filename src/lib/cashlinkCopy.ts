/**
 * "Cashlink" (wallet#268, owner 2026-10-15): the one user-facing name for every voucher sent by
 * link, a stall's cashback and a customer's gift link alike. Copy only: routes, identifiers and
 * persisted values (`type: 'cashback'`, `gift_link`, `/c/`, `/g`) keep their names.
 *
 * Typed cashback codes are retired in the same decision. During the transition a scanned or
 * pasted `CB-` code is recognised only to say so; it is never looked up.
 */

/** What a customer holding a typed code is told, everywhere they could use one. */
export const CODES_RETIRED = 'Codes are no longer used. Ask the shop to show you the Cashlink QR again.'

/** `CB` then ten (current) or six (legacy) alphanumerics, with any spacing or dashes. */
const RETIRED_CODE_RE = /^CB(?:[A-Z0-9]{10}|[A-Z0-9]{6})$/

/**
 * Whether `text` is a typed cashback code (`CB-XXXXX-XXXXX`, or the legacy `CB-XXXX-YY`).
 *
 * Requires the `CB` prefix, unlike the old redeem field, so a scanned handle or word of the right
 * length is never mistaken for one.
 */
export function isRetiredCashbackCode(text: string): boolean {
  if (typeof text !== 'string') return false
  const squashed = text.toUpperCase().replace(/[\s-]/g, '')
  return RETIRED_CODE_RE.test(squashed)
}
