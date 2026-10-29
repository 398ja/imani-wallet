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
  /**
   * The processor's own record of the payment (a Stripe payment intent),
   * copied verbatim into the coupon's `processor` issuance warrant so the
   * stall can reconcile it on its own dashboard (imani-wallet#96). Null when
   * payment-adapter recorded none.
   */
  processorReference: string | null
  /**
   * A gifting-site purchase's PINNED delivery (#410), or null for a wallet purchase. Pinned in the
   * Purchase Draft at review: nothing here may change who receives the voucher.
   */
  delivery?: GiftDelivery | null
  /** The gifting draft this debt answers, or null for a wallet purchase (the claim email's idempotency key). */
  draftId?: string | null
}

/**
 * How a gift is delivered (#410 §4). `sealed` is the link secret sealed to this issuer (G4), opened
 * only to arm and email, then scrubbed. Never logged: see `describeGift`.
 */
export interface GiftDelivery {
  kind: 'self' | 'handle' | 'email'
  refundPubkey: string | null
  recipientEmail: string | null
  sealed: string | null
  message: string | null
  from: string | null
  buyerEmail: string | null
  claimWindowDays: number
  /** The recipient's handle as the buyer typed it (`bob@example.com` NIP-05 or `@bob`), for notices. Optional. */
  recipientHandle?: string | null
  /** The signed-in buyer's wallet key, or null for a guest. Optional (absent reads as guest). */
  buyerPubkey?: string | null
  /** When the draft was created, unix ms (the guest's return-link mail date, approximately). Optional. */
  draftCreatedAt?: number | null
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

/** A processor record id, e.g. Stripe's `pi_...`: short, printable, no spaces. */
const PROCESSOR_REF = /^[A-Za-z0-9_-]{1,100}$/

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

  // Optional and opaque, but bounded and printable: it is written into signed
  // coupon bytes, where a control character or a kilobyte of junk is a
  // smuggling surface rather than a reference.
  const rawRef = r.processorReference
  let processorReference: string | null = null
  if (rawRef !== null && rawRef !== undefined) {
    if (typeof rawRef !== 'string' || !PROCESSOR_REF.test(rawRef)) return null
    processorReference = rawRef
  }

  let delivery: GiftDelivery | null = null
  if (r.delivery !== null && r.delivery !== undefined) {
    delivery = parseGiftDelivery(r.delivery)
    if (delivery === null) return null
    // A handle or self gift has a pinned key; an email gift never does (the link key is made at arm).
    if (delivery.kind === 'email' ? recipientPubkey !== null : recipientPubkey === null) return null
  }

  const draftId = r.draftId === null || r.draftId === undefined ? null : r.draftId
  if (draftId !== null && (typeof draftId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(draftId))) return null

  return {
    delivery,
    draftId,
    eventId,
    paymentRequestId,
    stallPubkey: stallPubkey as string | null,
    recipientPubkey: recipientPubkey as string | null,
    amountMinor,
    currency,
    livemode: r.livemode,
    attempts,
    processorReference,
  }
}

const optStr = (v: unknown, max: number): string | null | undefined =>
  v === null || v === undefined ? null : typeof v === 'string' && v.length <= max ? v : undefined

/** Strict, like the rest of this parser: a malformed delivery drops the row, loudly. */
export function parseGiftDelivery(raw: unknown): GiftDelivery | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const d = raw as Record<string, unknown>
  if (d.kind !== 'self' && d.kind !== 'handle' && d.kind !== 'email') return null
  const refundPubkey = optStr(d.refundPubkey, 64)
  if (refundPubkey === undefined || (refundPubkey !== null && !HEX64.test(refundPubkey))) return null
  if (d.kind !== 'self' && refundPubkey === null) return null
  const recipientEmail = optStr(d.recipientEmail, 320)
  const sealed = optStr(d.sealed, 2048)
  const message = optStr(d.message, 280)
  const from = optStr(d.from, 80)
  const buyerEmail = optStr(d.buyerEmail, 320)
  const recipientHandle = optStr(d.recipientHandle, 320)
  const buyerPubkey = optStr(d.buyerPubkey, 64)
  if ([recipientEmail, sealed, message, from, buyerEmail, recipientHandle, buyerPubkey].includes(undefined)) return null
  if (buyerPubkey !== null && !HEX64.test(buyerPubkey as string)) return null
  const rawCreated = d.draftCreatedAt
  let draftCreatedAt: number | null = null
  if (rawCreated !== null && rawCreated !== undefined) {
    // Seconds or ms on the wire; anything else is dropped (it only dates a sentence in an email).
    const n = typeof rawCreated === 'number' ? rawCreated : typeof rawCreated === 'string' ? Date.parse(rawCreated) : NaN
    if (Number.isFinite(n) && n > 0) draftCreatedAt = n < 1e12 ? n * 1000 : n
  }
  const claimWindowDays = typeof d.claimWindowDays === 'number' && Number.isInteger(d.claimWindowDays) && d.claimWindowDays > 0 && d.claimWindowDays <= 365 ? d.claimWindowDays : null
  if (claimWindowDays === null) return null
  return {
    kind: d.kind,
    refundPubkey,
    recipientEmail: recipientEmail as string | null,
    sealed: sealed as string | null,
    message: message as string | null,
    from: from as string | null,
    buyerEmail: buyerEmail as string | null,
    claimWindowDays,
    recipientHandle: recipientHandle as string | null,
    buyerPubkey: buyerPubkey === null ? null : (buyerPubkey as string).toLowerCase(),
    draftCreatedAt,
  }
}

/** A gift for a log line: kind and refund key only. Never the email, message or seal (#410). */
export function describeGift(d: GiftDelivery | null | undefined): string {
  return d ? `${d.kind} gift, refund ${d.refundPubkey ? `${d.refundPubkey.slice(0, 8)}…` : 'none'}` : 'wallet purchase'
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
  /** Delays between failure-report retries. Injected so tests do not wait. */
  private readonly reportBackoffsMs: readonly number[]
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    baseUrl: string,
    token: string,
    fetchImpl: typeof fetch = fetch,
    onInvalidRow?: (row: unknown) => void,
    {
      reportBackoffsMs = [1_000, 4_000, 15_000],
      sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    }: { reportBackoffsMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
    this.fetchImpl = fetchImpl
    this.onInvalidRow = onInvalidRow
    this.reportBackoffsMs = reportBackoffsMs
    this.sleep = sleep
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
   * Claim one purchase before minting for it (imani-wallet#96).
   *
   * `payment-adapter` moves the row OWED -> ISSUING in one conditional update,
   * so of any number of workers asking, exactly one hears `'claimed'`. Only
   * that one may mint. Everything else, an unreachable API included, is "do
   * not mint": a purchase left unminted is late, one minted twice is lost
   * money.
   */
  async claim(eventId: string, worker: string): Promise<'claimed' | 'taken' | 'unknown-purchase' | 'unreachable'> {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/purchases/${encodeURIComponent(eventId)}/claim`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ worker }),
        },
      )
    } catch {
      return 'unreachable'
    }
    if (response.ok) return 'claimed'
    if (response.status === 409) return 'taken'
    if (response.status === 404) return 'unknown-purchase'
    return 'unreachable'
  }

  /**
   * Park a purchase for a person (payment-adapter#280, `POST /{eventId}/attention`, #273).
   *
   * `gateway_unrecorded`: gc refused the mint 409 UNRECORDED, so whether a coupon exists is
   * unknown and nothing automatic may retry it. `delivery_exhausted`: the outbox gave up, a coupon
   * exists (`voucherId`). `issue_blocked`: nothing minted and nothing automatic can (#312: the
   * stall's validity cannot be honoured, or its record stayed unreadable); the detail says why,
   * and the operator refunds or issues by hand. Uses the ISSUER token; `/resolve` is the operator's.
   *
   * `unsupported` is a 404 with no such row answer from a payment-adapter that predates #280: the
   * caller logs and falls back to `/failure`. Retried with the same backoff as failure reports.
   */
  async attention(
    eventId: string,
    reason: 'gateway_unrecorded' | 'delivery_exhausted' | 'issue_blocked',
    { voucherId, detail, worker }: { voucherId?: string; detail?: string; worker?: string } = {},
  ): Promise<'parked' | 'unsupported' | 'refused' | 'unreachable'> {
    for (let attempt = 0; attempt <= this.reportBackoffsMs.length; attempt++) {
      if (attempt > 0) await this.sleep(this.reportBackoffsMs[attempt - 1])
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/api/v1/purchases/${encodeURIComponent(eventId)}/attention`,
          {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ reason, detail: detail ?? null, worker: worker ?? null, voucherId: voucherId ?? null }),
          },
        )
        if (response.ok) return 'parked'
        // 404 covers both "no such route" (PA without #280) and "no such row". Either way
        // parking cannot happen here; the /failure fallback answers the second correctly too.
        if (response.status === 404) return 'unsupported'
        // 409: closed, or another worker holds the live claim. 400: a reason PA does not know.
        if (response.status === 409 || response.status === 400) return 'refused'
        // 503 (optimistic lock lost) and anything else: retry.
      } catch {
        // retry
      }
    }
    return 'unreachable'
  }

  /**
   * Report that an attempt failed, closing nothing.
   *
   * NOT best-effort any more (imani-wallet#96). When `voucherId` is set this
   * report is what takes the row out of the mintable queue, and a report that
   * silently fails leaves a coupon-bearing row looking unminted. So it is
   * retried with backoff, and if it still does not land it THROWS
   * `ReportLostError`: the worker must stop rather than carry on polling a
   * queue it can no longer keep honest.
   *
   * A report with no voucher id is retried the same way. Losing one of those
   * is harmless on its own (the row is re-claimed after its lease), but the
   * API being unreachable for every retry is the same signal either way.
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
    /**
     * `worker`: who is reporting, so a late report cannot release a claim
     * another worker now holds. `keepClaim`: the outcome is ambiguous (the
     * mint may still be in flight), so the claim is left to lapse rather than
     * handing the row straight back (imani-wallet#96).
     */
    { worker, keepClaim = false }: { worker?: string; keepClaim?: boolean } = {},
  ): Promise<void> {
    let lastError = ''
    for (let attempt = 0; attempt <= this.reportBackoffsMs.length; attempt++) {
      if (attempt > 0) await this.sleep(this.reportBackoffsMs[attempt - 1])
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/api/v1/purchases/${encodeURIComponent(eventId)}/failure`,
          {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
              reason,
              permanent,
              voucherId: voucherId ?? null,
              worker: worker ?? null,
              keepClaim,
            }),
          },
        )
        // 2xx is recorded. 404 means there is no such row to keep honest, so
        // there is nothing for a retry to fix.
        if (response.ok || response.status === 404) return
        lastError = `status ${response.status}`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    throw new ReportLostError(eventId, voucherId, lastError)
  }
}

/**
 * A failure report that could not be recorded after every retry
 * (imani-wallet#96).
 *
 * When it names a voucher, a coupon exists that the purchases API does not
 * know about, and its row may still look mintable once its claim lapses. The
 * worker halts on this rather than continue.
 */
export class ReportLostError extends Error {
  readonly eventId: string
  readonly voucherId?: string

  constructor(eventId: string, voucherId: string | undefined, cause: string) {
    super(
      `could not record the outcome of purchase ${eventId}` +
        (voucherId ? ` (voucher ${voucherId} was minted)` : '') +
        `: ${cause}`,
    )
    this.name = 'ReportLostError'
    this.eventId = eventId
    this.voucherId = voucherId
  }
}
