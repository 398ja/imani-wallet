import { toast } from 'sonner'

/**
 * The toast that says a coupon is queued, not lost.
 *
 * The gateway limits redemption to ten a minute per pubkey, so a payment made
 * of several coupons can have one part pause for a full minute while the
 * others land (#39, #40). The wallet retries and the coupon does arrive — but
 * until it does, a queued coupon and a failed one look exactly alike, which is
 * the one thing a person cannot be left guessing about when it is their money.
 *
 * Deliberately NOT a progress meter. The product sends coupons in bundles of
 * roughly two to five, because `planParts` stops as soon as the amount is
 * covered — so there is no long batch to report progress through, and a
 * counter would imply a scale the wallet does not produce. What is missing is
 * one fact: this is still coming.
 *
 * ## Why a loading toast rather than a warning
 *
 * Apple's four kinds of feedback are status, completion, warning and error.
 * This is STATUS: nothing has gone wrong, and nothing is asked of the user.
 * Dressing a queue as a warning would train people to read a normal pause as a
 * fault, and the wallet would be crying wolf about its own rate limiter.
 *
 * ## Why it stays until settled
 *
 * A status toast that vanishes on a timer leaves the same ambiguity it was
 * built to remove: the message disappears, the coupon has not arrived, and the
 * user is back to guessing. So it persists and is dismissed by the outcome —
 * `settleQueued` on success, or replaced by the failure. The arrival toast
 * takes over from it, which is also why they share a voucher-keyed id: the two
 * are one story, and sonner replaces a toast in place when the id matches.
 */

/**
 * Announce that a coupon is waiting to be redeemed.
 *
 * Safe to call repeatedly for the same coupon — each retry replaces the
 * previous toast in place rather than stacking, because it is one coupon and
 * one wait, however many attempts it takes.
 *
 * Never throws. It is called from inside the redemption path, and a toast that
 * failed to render must not turn a recoverable pause into a failed redemption.
 */
export function announceQueued(voucherId: string | undefined, delayMs: number): void {
  try {
    const seconds = Math.max(1, Math.round(delayMs / 1000))

    toast.loading('Still receiving', {
      // Keyed on the coupon, so retries replace rather than stack, and so
      // settleQueued can dismiss exactly this one.
      id: queuedId(voucherId),
      // One sentence, not two. The first draft read "Taking a moment — your
      // coupon is safe. Retrying in 20s." — three clauses for one fact, which
      // wrapped to two lines and made the reader work out which part mattered.
      //
      // Says nothing about a rate limiter, which would mean nothing to the
      // person reading it. What they need is that the money is not lost and
      // that something is still happening; the countdown carries the second
      // without needing a sentence of its own.
      description: `Your coupon is safe — retrying in ${seconds}s.`,
      // Held open on purpose: see the note above. Dismissed by the outcome.
      duration: Infinity,
    })
  } catch (e) {
    console.warn('[queued] could not announce a queued coupon:', e)
  }
}

/**
 * Clear the queued toast for a coupon.
 *
 * Called when the coupon settles either way. On success the arrival toast is
 * the completion half of the pair, and it fires with its own id — dismissing
 * here rather than letting it expire keeps the two from briefly overlapping,
 * which would read as two separate payments.
 */
export function settleQueued(voucherId: string | undefined): void {
  try {
    toast.dismiss(queuedId(voucherId))
  } catch (e) {
    console.warn('[queued] could not dismiss a queued coupon toast:', e)
  }
}

/**
 * Namespaced away from the `received-` and `pending-` ids for the same reason
 * those are namespaced from each other: they are different statements about
 * one payment, and colliding ids would make one silently replace another.
 *
 * A coupon with no id still gets a toast, under a shared key. Announcing is
 * better than silence, and the alternative — one undismissable toast per
 * unidentifiable coupon — is worse than one that a later coupon replaces.
 */
function queuedId(voucherId: string | undefined): string {
  return voucherId ? `queued-${voucherId}` : 'queued-unidentified'
}
