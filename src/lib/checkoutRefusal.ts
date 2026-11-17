/** What the customer reads when no checkout code was made (#402). */
export function checkoutRefusalMessage(out: { kind: string; why?: string }): string {
  // The stall's plan no longer takes new checkout codes: a fact about the shop, not the vouchers.
  if (out.kind === 'refused' && out.why === 'not_in_plan') {
    return 'This shop is not taking new checkout codes right now. Nothing has changed: your vouchers are still in your wallet and still work at the stall.'
  }
  return out.kind === 'refused'
    ? 'These vouchers cannot be used online right now. Nothing has changed.'
    : 'No code could be made. Your vouchers come back on their own when the expiry passes.'
}
