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
/**
 * The stall takes cards but its vouchers cannot be issued yet (imani-wallet#298): the purchase
 * issuer is not enrolled, its credential expired, or its delegation lapsed. Paying now would take
 * money for a voucher nothing would mint, so Buy waits.
 */
export const CARD_SALES_NOT_READY = "Card sales aren't ready for this merchant yet"
export const CARD_SALES_CHECKING = 'Checking card sales…'
/**
 * The stall's vouchers never expire, and a card voucher must (#312): its issuing delegation is
 * finite, so one without an expiry would stop working at the till. Buy waits until the stall
 * chooses a validity.
 */
export const CARD_SALES_NEEDS_EXPIRY = 'This shop sells by card only with an expiry date.'

/**
 * Whether the purchase issuer can issue for this stall now (#298). `checking` and `not-ready`
 * both keep Buy disabled: an unknown answer never sells.
 */
export type CardSalesReadiness = 'checking' | 'ready' | 'not-ready' | 'no-expiry'

/** The line under a disabled Buy for a readiness that is not `ready`. */
export function cardSalesReason(readiness: Exclude<CardSalesReadiness, 'ready'>): string {
  if (readiness === 'checking') return CARD_SALES_CHECKING
  return readiness === 'no-expiry' ? CARD_SALES_NEEDS_EXPIRY : CARD_SALES_NOT_READY
}

export interface ActionState {
  enabled: boolean
  /** Shown under a disabled button, and wired to it for screen readers. */
  reason?: string
}

export interface MerchantActionInput {
  /** The stall's published flag. Anything but `true` fails closed. */
  acceptsCards: boolean
  /** The purchase issuer's answer for this stall. Absent is `checking`: fail safe. */
  cardSales?: CardSalesReadiness
  /** Coupons from this stall that can still be spent: unspent and unexpired. */
  validVouchers: number
  loggedIn: boolean
}

export function merchantActions({
  acceptsCards,
  cardSales = 'checking',
  validVouchers,
  loggedIn,
}: MerchantActionInput): {
  buy: ActionState
  pay: ActionState
} {
  // Logged out does not disable Buy: the button leads through login and back
  // (guest card purchase is not supported, so that detour IS the purchase).
  // No cards at all says so first: it is the reason a shopper can act on (try another stall).
  const buy: ActionState = !acceptsCards
    ? { enabled: false, reason: NO_CARDS }
    : cardSales === 'ready'
      ? { enabled: true }
      : { enabled: false, reason: cardSalesReason(cardSales) }
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
