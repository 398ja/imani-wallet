/**
 * Is a card coupon's payment reference a genuine payment to THIS stall's own
 * Stripe account?
 *
 * The reference on a card warrant is the purchase's PaymentIntent id (`pi_…`).
 * The warrant's signature proves the reference was not edited after issuance,
 * not that the payment exists. Only Stripe knows that, and only the server may
 * ask: merchant-service reads the stall from the session, and payment-adapter
 * reads the PaymentIntent with that stall's `Stripe-Account` and compares it
 * with the purchase record. The browser sends a reference and receives a verdict,
 * nothing more, and no key or account id.
 *
 * Three outcomes, and only an explicit server verdict reaches the first two:
 *
 * - `verified`: on your account, succeeded, matching the purchase.
 * - `failed`: the server looked and it is not (`not_found`, `mismatch`).
 * - `unknown`: anything else, including unreachable, not yet succeeded, not
 *   connected, or a verdict this build does not know. Never a warning, because
 *   a stall accused of a fake payment by a network blip is worse than no tick.
 */

export type ReferenceVerification =
  | { kind: 'verified' }
  | { kind: 'failed'; result: 'mismatch' | 'not_found'; detail?: string }
  | { kind: 'unknown'; reason: string }

const PATH = '/api/v1/merchant/stripe/payments'
const TIMEOUT_MS = 15000
const PI_SHAPE = /^pi_[A-Za-z0-9_]{1,250}$/

/**
 * Final verdicts, per reference. A succeeded PaymentIntent never changes its
 * amount or account, so a verdict holds for the page's life. In-flight requests
 * are shared so a list of rows asks once per reference.
 */
const cache = new Map<string, Promise<ReferenceVerification>>()

/** For tests. */
export function __resetReferenceVerificationCache() {
  cache.clear()
}

export function verifyCardReference(reference: string): Promise<ReferenceVerification> {
  if (!PI_SHAPE.test(reference)) {
    return Promise.resolve({ kind: 'unknown', reason: 'not a Stripe payment reference' })
  }
  const known = cache.get(reference)
  if (known) return known
  const pending = ask(reference).then((answer) => {
    if (answer.kind === 'unknown') cache.delete(reference)
    return answer
  })
  cache.set(reference, pending)
  return pending
}

async function ask(reference: string): Promise<ReferenceVerification> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${PATH}/${encodeURIComponent(reference)}/verification`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return { kind: 'unknown', reason: `service answered ${response.status}` }
    const body = (await response.json()) as { result?: unknown; detail?: unknown }
    const detail = typeof body.detail === 'string' ? body.detail : undefined
    switch (body.result) {
      case 'verified':
        return { kind: 'verified' }
      case 'mismatch':
      case 'not_found':
        return { kind: 'failed', result: body.result, ...(detail ? { detail } : {}) }
      default:
        return { kind: 'unknown', reason: typeof body.result === 'string' ? body.result : 'no verdict' }
    }
  } catch {
    return { kind: 'unknown', reason: 'could not reach the account service' }
  } finally {
    clearTimeout(timer)
  }
}
