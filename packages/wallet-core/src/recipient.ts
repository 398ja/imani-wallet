/**
 * May these coupons be sent to this recipient?
 *
 * A coupon is a claim on exactly one stall, honoured by that stall alone. Sent
 * to a DIFFERENT stall it is something they cannot honour, cannot redeem and
 * cannot return, and the customer's money simply stops. Nothing downstream
 * catches it: the gateway's send takes a recipient pubkey and does not care who
 * issued what.
 *
 * A mirror of `refuseIfWrongMerchant` in the app's `pay.ts`, expressed as a
 * decision over a role rather than a function that performs a lookup. The
 * lookup belongs to whoever has a network; the RULE belongs here, so the app
 * and the API cannot come to different conclusions about where a coupon may go.
 *
 * ## The order is the design
 *
 * Redemption is decided FIRST and without asking anything. Sending a stall its
 * own coupons is the overwhelmingly common case and the one a market stall
 * depends on, so it must keep working when the network does not. Only a send to
 * someone else needs to know who they are.
 *
 * That ordering is also what makes fail-closed affordable. If redemption
 * required a lookup, an outage would stop the whole market; because it does
 * not, refusing on `unknown` costs only cross-stall sends, which are rare.
 */

import { stallKey } from './holding'

/**
 * What the network says about a recipient.
 *
 * `unknown` is NOT `customer`. One means "asked, and they are not a stall"; the
 * other means "could not ask". Collapsing them is exactly what lets a foreign
 * coupon through during an outage.
 */
export type RecipientRole = 'stall' | 'customer' | 'unknown'

export type SendRefusal =
  /** The recipient is a stall, but not the one that issued these coupons. */
  | 'wrong-stall'
  /** The recipient's role could not be determined. */
  | 'recipient-unknown'
  /** The caller is sending to itself. */
  | 'self-send'

export type SendVerdict =
  | { allowed: true; kind: 'redemption' | 'transfer' }
  | { allowed: false; reason: SendRefusal; detail: string }

export interface RecipientCheck {
  /** Who is sending. Used only to refuse a send to oneself. */
  senderPubkey: string
  /** Who is receiving. */
  recipientPubkey: string
  /** The stall that issued the coupons being sent. */
  issuerPubkey: string | undefined
  /**
   * What the recipient is. Only consulted when the send is not a redemption,
   * so a caller may pass `unknown` freely for the redemption case — and should,
   * rather than performing a lookup it does not need.
   */
  recipientRole: RecipientRole
}

/**
 * Decide whether a send may proceed.
 *
 * Pure: a function of the four facts handed in. The network call happens
 * outside, which is what lets the redemption case avoid one entirely.
 */
export function checkRecipient({
  senderPubkey,
  recipientPubkey,
  issuerPubkey,
  recipientRole,
}: RecipientCheck): SendVerdict {
  const sender = stallKey(senderPubkey)
  const recipient = stallKey(recipientPubkey)
  const issuer = stallKey(issuerPubkey)

  /**
   * Self-send first, and above even redemption.
   *
   * A stall redeeming to itself is still a round trip that burns a coupon and
   * mints an equal one, costing a mint fee to end up exactly where it started.
   * Checking this after redemption would let that through for the one identity
   * where it is most likely to be a loop bug.
   */
  if (sender === recipient) {
    return {
      allowed: false,
      reason: 'self-send',
      detail:
        'This would send the coupons to the key that is sending them, which burns them and ' +
        'returns an equal set at the cost of a fee. Nothing has moved.',
    }
  }

  // A redemption: these coupons going home to the stall that issued them. The
  // ordinary end of a coupon's life, and it asks the network nothing.
  if (recipient === issuer) {
    return { allowed: true, kind: 'redemption' }
  }

  if (recipientRole === 'customer') {
    // Not a stall, so they hold it as a bearer instrument like anyone else and
    // may redeem it at the issuing stall later.
    return { allowed: true, kind: 'transfer' }
  }

  if (recipientRole === 'unknown') {
    return {
      allowed: false,
      reason: 'recipient-unknown',
      detail:
        'Could not check whether the recipient is a stall, so this send was refused rather ' +
        'than risked. Nothing has moved. Retry when the network is reachable.',
    }
  }

  return {
    allowed: false,
    reason: 'wrong-stall',
    detail:
      `These coupons were issued by ${issuer}, and the recipient is a different stall ` +
      `(${recipient}). A stall can only honour the coupons it issued, so this send would ` +
      'leave the coupons unredeemable. Nothing has moved.',
  }
}

/**
 * Does this send need a network lookup at all?
 *
 * Exposed so a caller can avoid one for the common case rather than
 * rediscovering the rule. A redemption and a self-send are both decided from
 * the keys alone.
 */
export function needsRecipientLookup(
  senderPubkey: string,
  recipientPubkey: string,
  // Optional, because a plan may name no stall: `stallKey` already maps
  // undefined to 'unknown', so this signature was narrower than the behaviour
  // and forced its one caller to lie about the type.
  issuerPubkey: string | undefined,
): boolean {
  const sender = stallKey(senderPubkey)
  const recipient = stallKey(recipientPubkey)
  return sender !== recipient && recipient !== stallKey(issuerPubkey)
}
