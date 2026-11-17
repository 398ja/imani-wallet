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
 * The stall is on the Free plan and has used its lifetime sales allowance (gc#317). The gateway
 * would refuse to mint the voucher, so a card payment now would be taken for nothing. Buy waits
 * until the stall upgrades. Worded for the shopper: the plan is the stall's to change, not theirs.
 */
export const CARD_SALES_LIMIT_REACHED = "This merchant can't sell more vouchers on their current plan right now."

/**
 * Whether the purchase issuer can issue for this stall now (#298). `checking` and `not-ready`
 * both keep Buy disabled: an unknown answer never sells.
 */
/** #434: the stall has switched Open for business off. Neither Buy nor Pay is offered. */
export const STALL_CLOSED = 'This merchant is closed right now. Your vouchers are safe.'
/** #434: the portal could not say. Fail closed. */
export const STALL_UNKNOWN = "Can't check whether this merchant is open. Try again in a moment."
export const STALL_CHECKING = 'Checking this merchant is open…'
/** #402: the stall's profile names no online shop, so a checkout code has nowhere to be used. */
export const NO_ONLINE_SHOP = "This merchant doesn't sell online"
export const LOG_IN_FOR_CODE = 'Log in to use your vouchers online'

export type StallOpen = 'open' | 'closed' | 'customer' | 'unknown' | 'loading'

export type CardSalesReadiness = 'checking' | 'ready' | 'not-ready' | 'no-expiry' | 'sales-limit'

/** The line under a disabled Buy for a readiness that is not `ready`. */
export function cardSalesReason(readiness: Exclude<CardSalesReadiness, 'ready'>): string {
  if (readiness === 'checking') return CARD_SALES_CHECKING
  if (readiness === 'sales-limit') return CARD_SALES_LIMIT_REACHED
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
  /**
   * #434: the stall's open-for-business status from the portal. Only `open` lets either button
   * through; closed, unknown and still-loading all disable both, with the reason. Absent keeps
   * the pre-#434 behaviour, for callers with no stall status to give.
   */
  stallOpen?: StallOpen
  /** #402: the stall's profile names an online shop. Absent is no shop. */
  sellsOnline?: boolean
}

function stallBlock(stallOpen: StallOpen | undefined): ActionState | null {
  if (stallOpen === undefined || stallOpen === 'open') return null
  if (stallOpen === 'closed') return { enabled: false, reason: STALL_CLOSED }
  if (stallOpen === 'loading') return { enabled: false, reason: STALL_CHECKING }
  return { enabled: false, reason: STALL_UNKNOWN }
}

export function merchantActions({
  acceptsCards,
  cardSales = 'checking',
  validVouchers,
  loggedIn,
  stallOpen,
  sellsOnline = false,
}: MerchantActionInput): {
  buy: ActionState
  pay: ActionState
  online: ActionState
} {
  // #402: a checkout code needs a shop to use it at, a wallet, and a coupon to put in it. The
  // shop is asked first: it is the one thing about this stall the shopper cannot change.
  const online: ActionState = !sellsOnline
    ? { enabled: false, reason: NO_ONLINE_SHOP }
    : !loggedIn
      ? { enabled: false, reason: LOG_IN_FOR_CODE }
      : validVouchers > 0
        ? { enabled: true }
        : { enabled: false, reason: NO_VOUCHERS }
  // A closed stall (or one nobody could confirm is open) takes neither card nor vouchers (#434).
  // Except while still asking: a reason the shopper can act on ("no cards here") is shown first.
  const blocked = stallBlock(stallOpen)
  // The code is spent at the shop later, not here, so a stall closed at its till does not block it.
  if (blocked && !(stallOpen === 'loading' && !acceptsCards)) return { buy: blocked, pay: blocked, online }
  if (blocked) return { buy: { enabled: false, reason: NO_CARDS }, pay: blocked, online }
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
  return { buy, pay, online }
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
