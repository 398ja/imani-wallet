/**
 * Why a sooner-expiring voucher is not the one this payment spends (#157).
 *
 * The wallet spends the soonest-expiring voucher first, within what the payee
 * accepts. When a sooner one is left for a legitimate reason, saying nothing
 * made it look as if the wallet had ignored its own rule. One line, the reason
 * only: the voucher is already visible on its stall's card, and no voucher id
 * reaches the screen (the `[pay]` log carries those).
 *
 * "Voucher", not CONTEXT.md's "coupon", like the rest of the send copy (see
 * bundleWording.ts). "Stall", never "merchant": CONTEXT.md keeps "merchant" off
 * every customer-facing line.
 */
import type { PassedOver } from '@imani/wallet-core'

/** Each reason as a clause; `one` for a single voucher, `many` for several. */
const BECAUSE: Record<PassedOver['reason'], { one: string; many: string }> = {
  issuer: {
    one: 'this stall only accepts its own vouchers',
    many: 'this stall only accepts its own vouchers',
  },
  unit: { one: 'it is in another currency', many: 'they are in another currency' },
  split: {
    one: 'it cannot be divided to this amount',
    many: 'they cannot be divided to this amount',
  },
  small: {
    one: 'it is worth less than this amount on its own',
    many: 'they are each worth less than this amount on their own',
  },
}

/** One sentence, or null when nothing sooner was passed over. */
export function passedOverNote(notes: PassedOver[]): string | null {
  if (notes.length === 0) return null
  const form = notes.length === 1 ? 'one' : 'many'
  const reasons = [...new Set(notes.map((n) => BECAUSE[n.reason][form]))]
  const subject =
    notes.length === 1
      ? 'A voucher that expires sooner is not used'
      : `${notes.length} vouchers that expire sooner are not used`
  return `${subject}: ${reasons.join(', or ')}.`
}
