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

/** What the stall is told, per reason. Keyed so a new reason must be handled. */
const MESSAGES: Record<RefusalReason, { title: string; detail: string }> = {
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
  'over-redeemed': {
    title: 'That coupon is already spent',
    detail: 'It has paid out everything it was issued for. Nothing was taken.',
  },
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
export function announceRefusal(event: { reason?: RefusalReason } | undefined): void {
  try {
    const reason = event?.reason
    if (!reason) return

    const message = MESSAGES[reason]
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
