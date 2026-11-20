/** What the customer reads when no checkout code was made (#402). */
export function checkoutRefusalMessage(out: { kind: string; why?: string; detail?: string }): string {
  // The stall's plan no longer takes new checkout codes: a fact about the shop, not the vouchers.
  if (out.kind === 'refused' && out.why === 'not_in_plan') {
    return 'This shop is not taking new checkout codes right now. Nothing has changed: your vouchers are still in your wallet and still work at the stall.'
  }
  const base =
    out.kind === 'refused'
      ? 'These vouchers cannot be used online right now. Nothing has changed.'
      : 'No code could be made. Your vouchers come back on their own when the expiry passes.'
  return withReason(base, out.detail)
}

/**
 * #644: a refusal on the way to a code that needed a split. Whether the split ran or not, nothing was
 * spent and the value is in the wallet; the number of coupons it is in now is not the customer's
 * concern, so it is never counted.
 */
export function splitCheckoutRefusalMessage(out: { why?: string; detail?: string }): string {
  if (out.why === 'not_in_plan') return checkoutRefusalMessage({ kind: 'refused', why: 'not_in_plan' })
  return withReason('No code could be made. Nothing was spent and your voucher is still in your wallet.', out.detail)
}

/** #644: the gateway's own refusal name, when it gave one, so the customer (and support) can see why. */
function withReason(text: string, detail: string | undefined): string {
  return detail ? `${text} Reason given: ${detail}.` : text
}
