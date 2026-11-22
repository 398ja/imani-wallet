import type { VoucherRow } from '@imani/wallet-storage'

import { cardReferenceOf } from './paymentReference'
import { parseVoucherToken } from './voucherToken'

/**
 * The card reference (Stripe `pi_`) a held voucher's SIGNED warrant carries, or undefined
 * (imani-wallet#277). Read from the token, not a stored field, because the warrant is inside the
 * issuer's signature and a split keeps it: every piece of a card voucher answers the same ref.
 */
export function cardReferenceOfRow(row: Pick<VoucherRow, 'token'>): string | undefined {
  if (!row.token) return undefined
  try {
    return cardReferenceOf(parseVoucherToken(row.token).voucher.issuanceWarrant)
  } catch {
    return undefined
  }
}
