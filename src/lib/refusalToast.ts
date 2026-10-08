import { toast } from 'sonner'

import type { RefusalReason } from '@imani/dm-poll'

/**
 * Telling a stall why a coupon it was offered was NOT taken.
 *
 * `DmPollService` has emitted `redemption:refused` since the ceiling check
 * shipped, and until this module nothing in the wallet subscribed to it. The
 * consequence was the worst shape a refusal can have: the coupon simply never
 * arrived. No balance change, no history row, no message — indistinguishable
 * from a payment lost in the network, in front of a customer who believes they
 * have paid.
 *
 * ## Why this is a toast and not a notification
 *
 * Unlike `arrivalToast`, this writes NO inbox row. A refusal is a fact about a
 * transaction that never happened, and the bell is a record of things that did.
 * Filing one would leave a permanent line about somebody else's coupon, which a
 * stall can neither act on later nor clear up — and on the `another-stall` path
 * it would accumulate one row per customer who walked to the wrong counter.
 *
 * The moment is what matters: the person is standing there, and the stall needs
 * a sentence it can say back to them right now.
 *
 * ## Never throws
 *
 * Called from an event handler on the redemption path. A toast that failed to
 * render must not become an unhandled rejection, and the same rule the arrival
 * toast follows applies for the same reason.
 *
 * ## Nothing has moved
 *
 * Both refusals fire BEFORE the mint swap, so the coupon is still the sender's
 * and their send reclaims at their next login. Every message here can say so
 * without qualification — which is what makes the refusal safe to explain
 * plainly rather than hedge.
 */

/**
 * What the stall is told, per reason. Keyed so a new reason must be handled.
 * Exported so the line left on the payment (`refusedCoupons.ts`) says the
 * same thing the toast did.
 */
export const REFUSAL_MESSAGES: Record<RefusalReason, { title: string; detail: string }> = {
  /**
   * The likely case, and an innocent one: a customer at the wrong counter.
   *
   * Worded for the person holding the coupon rather than for the operator. A
   * stall reading this has to turn round and explain it, so it says what the
   * customer should do next instead of naming a policy.
   */
  'another-stall': {
    title: 'That coupon is for another stall',
    detail:
      'Only the stall that issued a coupon can take it back. Nothing was taken — it is still theirs to spend where it came from.',
  },
  /**
   * The coupon is genuine and finished. Distinct from "for another stall" in
   * the only way that matters: this one IS the stall's own, and there is
   * nothing left on it.
   */
  unwarranted: {
    title: 'Coupon not authorised',
    detail:
      'Nothing outside the issuing service vouches for this coupon, so there is no ' +
      'evidence the stall it names actually issued it. Ask the customer where it came ' +
      'from before accepting it.',
  },
  'over-redeemed': {
    title: 'That coupon is already spent',
    detail: 'It has paid out everything it was issued for. Nothing was taken.',
  },
  'wrong-unit': {
    title: 'Coupon in a form this wallet cannot take',
    detail: 'Its value is in a unit this wallet does not handle. Nothing was taken.',
  },
  undecodable: {
    title: 'Coupon could not be read',
    detail: 'The coupon arrived damaged or in a form this wallet does not understand. Nothing was taken.',
  },
}

/**
 * Who is holding the device the coupon was refused on. A stall turns round and explains the
 * refusal to a customer at its counter; a customer refused a coupon a stall just sold them must
 * be told what to do about their own payment (#160 spec 4.6.6, 5b-5).
 */
export type RefusalAudience = 'stall' | 'customer'

/**
 * The customer's wording, where it differs from the stall's. Only `unwarranted` does: the other
 * reasons already speak to whoever holds the coupon.
 */
export const CUSTOMER_REFUSAL_MESSAGES: Partial<Record<RefusalReason, { title: string; detail: string }>> = {
  /**
   * A coupon the stall it names never signed for, most often one sold on a till the owner has not
   * set up again since terminals began carrying the stall's signature. Nothing moved: the coupon
   * was refused before it was taken, so the seller still holds it.
   */
  unwarranted: {
    title: 'Coupon not accepted',
    detail:
      'The stall it names did not sign for this coupon, so your wallet did not take it. ' +
      'Nothing was taken from you by this wallet. If you paid for it, ask the stall to issue ' +
      'it again from the owner’s phone or from a till they have set up again.',
  },
}

/** The words for one refusal, for this audience. */
export function refusalMessage(
  reason: RefusalReason,
  audience: RefusalAudience = 'stall',
): { title: string; detail: string } | undefined {
  return (audience === 'customer' ? CUSTOMER_REFUSAL_MESSAGES[reason] : undefined) ?? REFUSAL_MESSAGES[reason]
}

/**
 * Announce a refusal.
 *
 * `reason` is the typed discriminator off the event, never a parse of the
 * message: the two cases read completely differently to a customer, and telling
 * them the wrong one sends them away believing something untrue about their own
 * money.
 *
 * Unrecognised reasons are IGNORED rather than shown with a fallback string. A
 * future refusal this build does not understand would otherwise be announced
 * with wording chosen for a different situation, and a confidently wrong
 * explanation is worse here than silence — the same judgement `checkCoupon`
 * makes when it refuses to turn an unknown into an accusation.
 */
export function announceRefusal(
  event: { reason?: RefusalReason } | undefined,
  audience: RefusalAudience = 'stall',
): void {
  try {
    const reason = event?.reason
    if (!reason) return

    const message = refusalMessage(reason, audience)
    if (!message) return

    toast.error(message.title, {
      description: message.detail,
      // Longer than the arrival toast's 6s. This one has to be read and then
      // said out loud to somebody, and it is the only place the information
      // exists — there is no inbox row to come back to.
      duration: 10_000,
    })
  } catch (e) {
    console.warn('[refusal] could not announce a refused coupon:', e)
  }
}
