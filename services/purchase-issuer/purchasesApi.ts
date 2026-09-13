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
  /**
   * The stall's NOSTR pubkey, which is what a credential is keyed by.
   *
   * Null when the recording service could not identify the stall. Treated as
   * "issue by hand" rather than guessed at: minting for the wrong stall is
   * worse than not minting.
   */
  stallPubkey: string | null
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


/** A 32-byte NOSTR public key, lowercase or uppercase hex. */
const HEX64 = /^[0-9a-fA-F]{64}$/

/** An ISO-4217 alphabetic currency code. */
const ISO4217 = /^[A-Za-z]{3}$/

/**
 * A hard ceiling on a single coupon's face value, in minor units.
 *
 * No legitimate card purchase in this product reaches it, and an unbounded face value is an
 * unbounded liability for a stall that is not awake to notice. A row above the ceiling is far
 * more likely to be an attack or a unit-confusion bug than a real sale, and either way the safe
 * answer is to refuse and let a human look.
 */
export const MAX_FACE_VALUE_MINOR = 100_000_00

/**
 * One debt, or null when the row cannot be trusted.
 *
 * Hand-written rather than a schema library to match the parsers in `wallet-api`
 * (`redeem.ts`, `requests.ts`) and to avoid adding a dependency to the one service that holds
 * issuing keys. Every field is checked, because every field reaches either the face value, the
 * recipient, or the signature.
 */
export function parseOwedPurchase(row: unknown): OwedPurchase | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
  const r = row as Record<string, unknown>

  const eventId = typeof r.eventId === 'string' ? r.eventId.trim() : ''
  if (!eventId || eventId.length > 200) return null

  const paymentRequestId = typeof r.paymentRequestId === 'string' ? r.paymentRequestId.trim() : ''
  if (!paymentRequestId || paymentRequestId.length > 200) return null

  // Null is meaningful on both keys: "issue by hand" and "buyer takes a claim link". A missing
  // key and a malformed one are different things, and only the second is a refusal.
  const stallPubkey = r.stallPubkey === null || r.stallPubkey === undefined ? null : r.stallPubkey
  if (stallPubkey !== null && (typeof stallPubkey !== 'string' || !HEX64.test(stallPubkey))) return null

  const recipientPubkey =
    r.recipientPubkey === null || r.recipientPubkey === undefined ? null : r.recipientPubkey
  if (recipientPubkey !== null && (typeof recipientPubkey !== 'string' || !HEX64.test(recipientPubkey))) {
    return null
  }

  // The face value. Integer, positive, bounded — a float here would mint a coupon whose value
  // cannot be represented in minor units, and a negative one is nonsense that nothing downstream
  // checks for.
  const amountMinor = r.amountMinor
  if (
    typeof amountMinor !== 'number' ||
    !Number.isInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor > MAX_FACE_VALUE_MINOR
  ) {
    return null
  }

  // Checked before getDecimals() sees it: that lookup drives faceDecimals, and a
  // faceValue/faceDecimals disagreement is the 5000-XAF-becomes-50 class of bug.
  const currency = typeof r.currency === 'string' ? r.currency.trim() : ''
  if (!ISO4217.test(currency)) return null

  // Strictly boolean. `livemode: "false"` is truthy, and real value must never be minted from a
  // test payment because a string looked like one.
  if (typeof r.livemode !== 'boolean') return null

  const attempts = r.attempts
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0 || attempts > 1000) {
    return null
  }

  return {
    eventId,
    paymentRequestId,
    stallPubkey: stallPubkey as string | null,
    recipientPubkey: recipientPubkey as string | null,
    amountMinor,
    currency,
    livemode: r.livemode,
    attempts,
  }
}

export class PurchasesApi {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  /**
   * Called for each debt row that fails validation (IW-07).
   *
   * A dropped row must be loud. Silently skipping one turns "we refused to mint from a
   * malformed row" into "that purchase never arrived", which looks like a queue problem and
   * hides an attack.
   */
  private readonly onInvalidRow?: (row: unknown) => void

  constructor(
    baseUrl: string,
    token: string,
    fetchImpl: typeof fetch = fetch,
    onInvalidRow?: (row: unknown) => void,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
    this.fetchImpl = fetchImpl
    this.onInvalidRow = onInvalidRow
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
      if (!Array.isArray(body)) return []

      // IW-07: validate every row before it can decide how much value is minted.
      //
      // This used to be `body as OwedPurchase[]` — a cast, which is a promise to the type
      // checker and no check at all at runtime. Every field was then used as authoritative:
      // amountMinor became the coupon's face value with no range, type, integrality or sign
      // check, and recipientPubkey decided who received it. This worker mints real value
      // unsupervised with livemode: true, and its only input is an HTTP response, so anyone
      // able to influence that response controlled the mint — and PURCHASE_API_URL is a
      // plaintext intra-cluster hop reachable by any pod on the network.
      //
      // A malformed row is DROPPED and reported, never guessed at. Dropping one debt is
      // recoverable: the queue still holds it and a human can look. Minting an attacker-chosen
      // face value signed by a stall's own credential is not.
      const valid: OwedPurchase[] = []
      for (const row of body) {
        const parsed = parseOwedPurchase(row)
        if (parsed === null) {
          this.onInvalidRow?.(row)
          continue
        }
        valid.push(parsed)
      }
      return valid
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
  async reportFailure(
    eventId: string,
    reason: string,
    permanent: boolean,
    /**
     * The coupon that WAS minted, when one was.
     *
     * Its presence takes the debt out of the mintable queue. Omitting it after
     * a successful mint leaves the row looking unminted, and the next pass
     * mints again — one payment, a coupon per wake.
     */
    voucherId?: string,
  ): Promise<void> {
    try {
      await this.fetchImpl(
        `${this.baseUrl}/api/v1/purchases/${encodeURIComponent(eventId)}/failure`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ reason, permanent, voucherId: voucherId ?? null }),
        },
      )
    } catch {
      // Nothing to do. The debt is unchanged, which is the important part.
    }
  }
}
