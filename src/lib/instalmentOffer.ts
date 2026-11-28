/**
 * Keeping a stall's published `acceptsInstalments` true, beside `reconcileCardOffer`.
 *
 * Asymmetric on purpose: this only ever WITHDRAWS. Turning monthly payments on is the stall's
 * explicit opt-in, after the fee disclosure and the terms checkbox, so it never happens because a
 * status read came back eligible. Withdrawing happens on any read that says the offer is no longer
 * true: the account is not eligible, cards are not offered, or sales are closed.
 *
 * Null (could not ask) changes nothing, for the reason `reconcileCardOffer` gives.
 */
import type { MerchantProfile } from './merchant'

export interface InstalmentStatus {
  instalmentsEligible: boolean
}

export type InstalmentOfferChange =
  | { kind: 'republish'; merchant: MerchantProfile; reason: string }
  | { kind: 'unchanged' }

export function reconcileInstalmentOffer(
  merchant: MerchantProfile,
  status: InstalmentStatus | null,
): InstalmentOfferChange {
  if (status === null) return { kind: 'unchanged' }
  if (merchant.acceptsInstalments !== true) return { kind: 'unchanged' }

  const reason =
    merchant.salesClosed === true
      ? 'sales are closed'
      : merchant.acceptsCards !== true
        ? 'card payments are off'
        : !status.instalmentsEligible
          ? 'your Stripe account setup means monthly payments aren’t available'
          : null

  if (reason === null) return { kind: 'unchanged' }
  return { kind: 'republish', merchant: { ...merchant, acceptsInstalments: false }, reason }
}
