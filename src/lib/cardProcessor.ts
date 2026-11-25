/**
 * Which card processor a stall takes cards through: Stripe or PayPal (payment-adapter ADR 0002).
 *
 * A stall uses ONE at a time. It chooses before connecting, and the connected one is the one its
 * public record names (`cardProcessor`), so a buyer is sent to that processor's checkout. Absent
 * means Stripe, which is what every record published before PayPal existed says.
 *
 * Card references tell the processors apart by shape, exactly as payment-adapter's
 * `ProcessorReference` does: a Stripe PaymentIntent is `pi_…`, a PayPal capture id is 17
 * uppercase letters and digits. A voucher's warrant carries only the reference, so its shape is
 * what decides where a stall's "is this genuine?" question goes.
 */

export type CardProcessor = 'stripe' | 'paypal'

const STRIPE_REF = /^pi_[A-Za-z0-9_]{1,250}$/
const PAYPAL_REF = /^[A-Z0-9]{17}$/

/** The processor that issued a card reference, or undefined when it is neither's. */
export function processorOfReference(ref: string | undefined | null): CardProcessor | undefined {
  if (typeof ref !== 'string') return undefined
  if (STRIPE_REF.test(ref)) return 'stripe'
  if (PAYPAL_REF.test(ref)) return 'paypal'
  return undefined
}

/** A reference either processor could have issued. */
export function isCardReference(ref: string | undefined | null): ref is string {
  return processorOfReference(ref) !== undefined
}

/** The name a person reads. */
export function processorName(processor: CardProcessor): 'Stripe' | 'PayPal' {
  return processor === 'paypal' ? 'PayPal' : 'Stripe'
}

/** A stall record's processor: only a literal `paypal` is PayPal, anything else is Stripe. */
export function processorOf(record: { cardProcessor?: unknown } | null | undefined): CardProcessor {
  return record?.cardProcessor === 'paypal' ? 'paypal' : 'stripe'
}

/**
 * Whether this build offers PayPal at all (`VITE_PAYPAL=on`). Off by default, so the choice ships
 * dark until payment-adapter has PayPal configured. Off changes nothing for a Stripe stall, and a
 * stall already published as PayPal is still sold to: the buyer side follows the record, not this.
 */
export function paypalEnabled(raw: unknown = import.meta.env?.VITE_PAYPAL): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'on'
}
