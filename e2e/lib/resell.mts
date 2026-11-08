/** Same reading as `cents` in ui.mts, kept here so this module stays pure (ui.mts pulls in register.mts). */
function cents(text: string): number {
  const digits = text.replace(/[^\d.-]/g, '')
  return digits ? Math.round(Number.parseFloat(digits) * 100) : Number.NaN
}

/**
 * Whether a setup sale whose result screen never said "delivered" should be sold again (#566).
 *
 * The screen can lag the sale: on a slow run the voucher had landed, the screen had not caught
 * up, and the retry issued a second one. So the customer's balance decides. Retry only when it
 * did not rise by the sale's amount. An unreadable balance is not proof the sale failed, so it
 * does not retry either: a missing sale is caught by the setup check, a duplicate is not.
 */
export function shouldResell(before: string, after: string, amount: string): boolean {
  const rise = cents(after) - cents(before)
  if (Number.isNaN(rise)) return false
  return rise < cents(amount)
}
