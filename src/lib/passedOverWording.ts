/**
 * Why a sooner-expiring voucher is not the one this payment spends (#157).
 *
 * The wallet spends the soonest-expiring voucher first, within what the payee
 * accepts. When a sooner one is left for a legitimate reason, saying nothing
 * made it look as if the wallet had ignored its own rule. One line, the reason
 * only: the voucher is already visible on its merchant's card.
 *
 * "Voucher", not CONTEXT.md's "coupon", like the rest of the send copy (see
 * bundleWording.ts).
 */
import type { PassedOver } from '@imani/wallet-core'

const BECAUSE: Record<PassedOver['reason'], string> = {
  issuer: 'this merchant only accepts vouchers they issued',
  unit: 'wrong currency for this request',
  split: 'cannot be divided to this amount',
}

/** One sentence, or null when nothing sooner was passed over. */
export function passedOverNote(notes: PassedOver[]): string | null {
  if (notes.length === 0) return null
  const reasons = [...new Set(notes.map((n) => BECAUSE[n.reason]))]
  const subject =
    notes.length === 1
      ? 'A voucher that expires sooner is not used'
      : `${notes.length} vouchers that expire sooner are not used`
  return `${subject}: ${reasons.join(', or ')}.`
}
