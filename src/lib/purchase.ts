/**
 * Starting a card purchase.
 *
 * One call, to a service that decides whether the purchase is possible before
 * the customer sees a card form. Everything refusable — no connected account,
 * charges not enabled, no currency — is answered here rather than at Stripe,
 * because a payment page that fails after somebody has typed their card number
 * is the worst place to learn a stall is misconfigured.
 */
import type { CardProcessor } from './cardProcessor'

/** Where the purchase endpoint lives, same-origin through the proxy. One per processor (ADR 0002). */
const PURCHASE_PATH = '/api/v1/checkout/purchase'
const PAYPAL_PURCHASE_PATH = '/api/v1/checkout/paypal/purchase'

/** Long enough for a session to be created, short enough not to feel hung. */
const TIMEOUT_MS = 15000

export type PurchaseStart =
  | { kind: 'ok'; checkoutUrl: string; reference: string }
  | { kind: 'error'; reason: string }

export async function startPurchase(params: {
  stallPubkey: string
  amountMinor: number
  /** Null for a buyer with no wallet, who takes delivery by claim link. */
  buyerPubkey: string | null
  /**
   * The processor the stall's record names. Both endpoints take the same body and answer the same
   * shape; each refuses a stall it cannot charge for, so a stale record costs one failed tap.
   */
  processor?: CardProcessor
}): Promise<PurchaseStart> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(params.processor === 'paypal' ? PAYPAL_PURCHASE_PATH : PURCHASE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stallPubkey: params.stallPubkey,
        amountMinor: params.amountMinor,
        buyerPubkey: params.buyerPubkey,
      }),
      signal: controller.signal,
    })

    const body = (await response.json().catch(() => null)) as
      | { checkoutUrl?: string; reference?: string; error?: string }
      | null

    if (!response.ok || !body?.checkoutUrl) {
      // The service's own words when it has them: "this stall cannot accept
      // card payments yet" is worth showing verbatim, and beats a generic
      // failure that leaves a customer guessing whose fault it is.
      return {
        kind: 'error',
        reason: body?.error ?? 'This purchase could not be started. Please try again.',
      }
    }

    return { kind: 'ok', checkoutUrl: body.checkoutUrl, reference: body.reference ?? '' }
  } catch (error) {
    // Nothing was charged, so the honest message is "try again" rather than
    // anything suggesting the customer may have paid.
    return {
      kind: 'error',
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'The payment page took too long to load. Nothing was charged.'
          : 'Could not reach the payment service. Nothing was charged.',
    }
  } finally {
    clearTimeout(timer)
  }
}
