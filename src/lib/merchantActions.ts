import { couponsFor } from './merchants'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * The two things a customer can do at a stall, and whether they can do them now (#280).
 *
 * Pure, so the rules the owner set are tested in one place and both profile
 * screens cannot drift apart on them.
 */

export const NO_CARDS = "Card payments aren't set up for this merchant"
export const NO_VOUCHERS = 'You have no vouchers from this merchant yet'
export const LOG_IN_TO_PAY = 'Log in to pay with your vouchers'

export interface ActionState {
  enabled: boolean
  /** Shown under a disabled button, and wired to it for screen readers. */
  reason?: string
}

export interface MerchantActionInput {
  /** The stall's published flag. Anything but `true` fails closed. */
  acceptsCards: boolean
  /** Coupons from this stall that can still be spent: unspent and unexpired. */
  validVouchers: number
  loggedIn: boolean
}

export function merchantActions({ acceptsCards, validVouchers, loggedIn }: MerchantActionInput): {
  buy: ActionState
  pay: ActionState
} {
  // Logged out does not disable Buy: the button leads through login and back
  // (guest card purchase is not supported, so that detour IS the purchase).
  const buy: ActionState = acceptsCards ? { enabled: true } : { enabled: false, reason: NO_CARDS }
  // Logged out says why in its own words. "No vouchers" would be a guess about
  // a wallet we cannot see.
  const pay: ActionState = !loggedIn
    ? { enabled: false, reason: LOG_IN_TO_PAY }
    : validVouchers > 0
      ? { enabled: true }
      : { enabled: false, reason: NO_VOUCHERS }
  return { buy, pay }
}

/**
 * How many of this stall's coupons can pay for something.
 *
 * `couponsFor` already drops spent, redeemed, licence and terminal rows and
 * anything past its expiry, which is exactly the owner's "valid" (unspent, not
 * expired). Reused rather than restated so Pay and the coupon count on the
 * stall's card always agree.
 */
export function validVoucherCount(rows: VoucherRow[], merchantPubkey: string): number {
  return couponsFor(rows, merchantPubkey).length
}

/** Where Pay goes: the existing send flow, addressed to the stall and spending only its coupons. */
export function payPath(merchantPubkey: string): string {
  return `/send?from=${merchantPubkey}&to=${merchantPubkey}`
}
