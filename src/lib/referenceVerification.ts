/**
 * Is a card coupon's payment reference a genuine payment to THIS stall's own
 * Stripe account, or its own PayPal seller account?
 *
 * The reference on a card warrant is the processor's record of the purchase: a
 * Stripe PaymentIntent id (`pi_…`) or a PayPal capture id (17 uppercase
 * letters and digits, payment-adapter ADR 0002). Its shape says which processor
 * to ask, and each is asked through merchant-service the same way:
 * `/api/v1/merchant/stripe/payments/{pi}/verification` or
 * `/api/v1/merchant/paypal/payments/{capture}/verification`, with the same
 * verdict vocabulary.
 *
 * The warrant's signature proves the reference was not edited after issuance,
 * not that the payment exists. Only the processor knows that, and only the server may
 * ask: merchant-service reads the stall from the session, and payment-adapter
 * reads the payment as that stall's own account (`Stripe-Account`, or PayPal's
 * `PayPal-Auth-Assertion`) and compares it
 * with the purchase record. The browser sends a reference and receives a verdict,
 * nothing more, and no key or account id.
 *
 * Four outcomes, and only an explicit server verdict reaches the first three:
 *
 * - `verified`: on your account, succeeded, matching the purchase.
 * - `reversed`: it was genuine, but has since been refunded or disputed on
 *   the processor (`refunded`, `disputed`). The voucher was still issued; nothing
 *   reverses it automatically yet.
 * - `failed`: the server looked and it is not (`not_found`, `mismatch`).
 * - `unknown`: anything else, including unreachable, not yet succeeded, not
 *   connected, or a verdict this build does not know. Never a warning, because
 *   a stall accused of a fake payment by a network blip is worse than no tick.
 */
import { processorOfReference } from './cardProcessor'

export type ReferenceVerification =
  | { kind: 'verified' }
  | { kind: 'reversed'; result: 'refunded' | 'disputed'; refundedMinor?: number }
  | { kind: 'failed'; result: 'mismatch' | 'not_found'; detail?: string }
  | { kind: 'unknown'; reason: string }

const PATHS = {
  stripe: '/api/v1/merchant/stripe/payments',
  paypal: '/api/v1/merchant/paypal/payments',
} as const
const TIMEOUT_MS = 15000

/** How long a final verdict is trusted. A refund or dispute can come later. */
export const VERDICT_TTL_MS = 5 * 60 * 1000

/** Requests in flight at once, across every row on the page. */
export const MAX_CONCURRENT_VERIFICATIONS = 4

/**
 * Verdicts per reference. Final verdicts are kept for {@link VERDICT_TTL_MS},
 * not the page's life: the wallet is a long-lived tab and a refund or dispute
 * recorded later must show. Unknown answers are dropped so they retry.
 * In-flight requests are shared so a list of rows asks once per reference.
 */
const cache = new Map<string, { answer: Promise<ReferenceVerification>; expiresAt: number }>()

let active = 0
const waiting: Array<() => void> = []

function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active++
      task()
        .then(resolve, reject)
        .finally(() => {
          active--
          waiting.shift()?.()
        })
    }
    if (active < MAX_CONCURRENT_VERIFICATIONS) run()
    else waiting.push(run)
  })
}

/** For tests. */
export function __resetReferenceVerificationCache() {
  cache.clear()
  waiting.length = 0
  active = 0
}

export function verifyCardReference(reference: string): Promise<ReferenceVerification> {
  const processor = processorOfReference(reference)
  if (!processor) {
    return Promise.resolve({ kind: 'unknown', reason: 'not a card payment reference' })
  }
  const known = cache.get(reference)
  if (known && Date.now() < known.expiresAt) return known.answer
  const entry = { answer: undefined as unknown as Promise<ReferenceVerification>, expiresAt: Infinity }
  entry.answer = limited(() => ask(PATHS[processor], reference)).then((answer) => {
    if (cache.get(reference) === entry) {
      if (answer.kind === 'unknown') cache.delete(reference)
      else entry.expiresAt = Date.now() + VERDICT_TTL_MS
    }
    return answer
  })
  cache.set(reference, entry)
  return entry.answer
}

async function ask(path: string, reference: string): Promise<ReferenceVerification> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${path}/${encodeURIComponent(reference)}/verification`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return { kind: 'unknown', reason: `service answered ${response.status}` }
    const body = (await response.json()) as { result?: unknown; detail?: unknown; refunded_minor?: unknown }
    const detail = typeof body.detail === 'string' ? body.detail : undefined
    switch (body.result) {
      case 'verified':
        return { kind: 'verified' }
      case 'refunded':
      case 'disputed': {
        const minor = body.refunded_minor
        return {
          kind: 'reversed',
          result: body.result,
          ...(typeof minor === 'number' && minor > 0 ? { refundedMinor: minor } : {}),
        }
      }
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
