/**
 * Talking to the service that knows what is owed.
 *
 * `payment-adapter` holds the debts; this reads them and reports back. The
 * split matters: that service records a payment fact transactionally with a
 * webhook, and this one mints coupons, and neither should be able to do the
 * other's job.
 *
 * ## The three answers to a discharge, and why they are not two
 *
 * Reporting a discharge is not "tell it we are done". The endpoint verifies
 * the claim against the gateway before accepting it, so there are three
 * outcomes and collapsing any two loses something:
 *
 * - **200** confirmed and closed.
 * - **409** the gateway sees no such send. The claim was wrong; retrying it
 *   unchanged will never succeed.
 * - **503** the gateway could not be asked. Nothing changed; come back.
 *
 * A caller that treats 409 as retryable hammers a claim that can never
 * succeed. One that treats 503 as failure abandons a debt over an outage.
 */

/** One debt, as the purchases API describes it. */
export interface OwedPurchase {
  /** The handle for reporting back. */
  eventId: string
  /**
   * Stamped onto the send, so the discharge can be verified.
   *
   * Minted by the service that recorded the debt, before any work happened,
   * which is what stops a discharge from being self-certifying.
   */
  paymentRequestId: string
  /** The stall that owes it. */
  connectedAccountId: string
  /** Who to deliver to, or null when the buyer takes a claim link. */
  recipientPubkey: string | null
  amountMinor: number
  currency: string
  /** False for test-mode. Real value must never be minted from a test payment. */
  livemode: boolean
  attempts: number
}

export type DischargeOutcome =
  | 'accepted'
  /** The gateway sees no such send. Do not retry this claim unchanged. */
  | 'refused'
  /** The gateway could not be asked. Nothing changed; try later. */
  | 'unverifiable'
  | 'unknown-purchase'

export class PurchasesApi {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
    this.fetchImpl = fetchImpl
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }
  }

  /**
   * What is still owed, oldest first.
   *
   * Returns empty on any failure rather than throwing. A worker that cannot
   * reach the queue should idle and try again, not crash: the debts are safe
   * where they are, and a crash loop is a worse way to wait.
   */
  async owed(): Promise<OwedPurchase[]> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/v1/purchases/owed`, {
        headers: this.headers(),
      })
      if (!response.ok) return []
      const body = (await response.json()) as unknown
      return Array.isArray(body) ? (body as OwedPurchase[]) : []
    } catch {
      return []
    }
  }

  /**
   * Report a coupon issued, and find out whether that was believed.
   *
   * The voucher id is required by the endpoint, because a discharge naming no
   * coupon is one nobody could trace afterwards.
   */
  async discharge(eventId: string, voucherId: string, issuerId: string): Promise<DischargeOutcome> {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/purchases/${encodeURIComponent(eventId)}/discharge`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ voucherId, issuerId }),
        },
      )
    } catch {
      // Unreachable is not refused. The coupon may well have been issued, and
      // treating this as a rejection would invite a second mint.
      return 'unverifiable'
    }

    if (response.ok) return 'accepted'
    if (response.status === 409) return 'refused'
    if (response.status === 404) return 'unknown-purchase'
    // Everything else, 503 included, means try again later.
    return 'unverifiable'
  }

  /**
   * Report that an attempt failed, closing nothing.
   *
   * Best-effort by design: this is a note for whoever reads the row later, and
   * failing to write it must not stop the worker moving to the next debt.
   */
  async reportFailure(eventId: string, reason: string, permanent: boolean): Promise<void> {
    try {
      await this.fetchImpl(
        `${this.baseUrl}/api/v1/purchases/${encodeURIComponent(eventId)}/failure`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ reason, permanent }),
        },
      )
    } catch {
      // Nothing to do. The debt is unchanged, which is the important part.
    }
  }
}
