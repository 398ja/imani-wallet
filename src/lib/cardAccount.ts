import type { CardProcessor } from './cardProcessor'
import type { StripeResult } from './stripeAccount'

/**
 * Which card account the Card payments screen is about, given what Stripe and PayPal each said.
 *
 * A stall takes cards through one processor at a time. The one it is CONNECTED to is the one the
 * screen shows and the offer names. With neither connected, the screen shows the processor the
 * stall's record already names (Stripe for every record from before PayPal), and the merchant can
 * pick the other one before connecting.
 *
 * "Could not ask" is never read as "not connected": with no connected account found and a read
 * that failed, the failed read is what goes on, so the reconcile changes nothing (an offer is
 * never withdrawn because one of two services blipped).
 */
export function chooseCardAccount(
  reads: { stripe?: StripeResult; paypal?: StripeResult },
  recorded: CardProcessor,
): { processor: CardProcessor; result: StripeResult } {
  const connected = (p: CardProcessor) => {
    const r = reads[p]
    return r?.kind === 'ok' && r.status.status !== 'not_connected'
  }
  const pick = (processor: CardProcessor) => ({ processor, result: reads[processor]! })

  const stripeOn = connected('stripe')
  const paypalOn = connected('paypal')
  if (stripeOn && paypalOn) {
    // Both connected (one was set up on another device). The record decides, then whichever can
    // charge, then Stripe.
    const other: CardProcessor = recorded === 'stripe' ? 'paypal' : 'stripe'
    const recordedCharges = (reads[recorded] as { kind: 'ok'; status: { chargesEnabled: boolean } }).status.chargesEnabled
    const otherCharges = (reads[other] as { kind: 'ok'; status: { chargesEnabled: boolean } }).status.chargesEnabled
    return pick(recordedCharges || !otherCharges ? recorded : other)
  }
  if (stripeOn) return pick('stripe')
  if (paypalOn) return pick('paypal')

  const failed = (p: CardProcessor) => reads[p] !== undefined && reads[p]!.kind !== 'ok'
  if (failed(recorded)) return pick(recorded)
  const other: CardProcessor = recorded === 'stripe' ? 'paypal' : 'stripe'
  if (failed(other)) return pick(other)
  return reads[recorded] ? pick(recorded) : pick(other)
}
