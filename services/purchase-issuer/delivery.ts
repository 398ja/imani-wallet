/**
 * Getting an issued coupon to the person who paid for it.
 *
 * Two routes, chosen by whether the buyer has a wallet, and the choice is not
 * a preference. It is the difference between a coupon that arrives and one that
 * arrives looking like it came from a stranger.
 *
 * ## The envelope problem, and why a claim link sidesteps it
 *
 * `gateway-customer` overwrites `sender_pubkey` with the authenticated pubkey.
 * That is correct of it — a sender field a caller can set is one a caller can
 * forge — but it means a DM sent by this service is labelled with THIS
 * SERVICE'S key rather than the stall's.
 *
 * `imani-woo` ADR 0008 recorded the same defect as cosmetic, and there it is:
 * the shop's own customers already know the shop, the coupon itself names the
 * Stall, and it redeems normally.
 *
 * **Here it is worse.** A card purchase may be someone's first contact with
 * Imani. The delivery is the only thing they receive, and labelling it with an
 * unfamiliar key is how a legitimate coupon looks like a scam. So:
 *
 * - **A buyer with no wallet gets a claim link.** A URL has no sender field to
 *   get wrong, and the page names the stall. This is why the claim-page fix
 *   came first: the link had to stop burning itself on load before it could
 *   carry purchases.
 * - **A buyer with a wallet gets a DM**, and the envelope stays mislabelled
 *   until `gateway-customer` learns to accept a credentialled sender. That is
 *   upstream work, it is named in ADR 0008, and it is the real fix.
 */

import { DELIVER_PATH, IssuanceFailed, authorization, type StallCredential } from './issuer'

/**
 * The DM went out, but the gateway did not confirm it recorded the delivery against the payment
 * request (imani-wallet#287 E2, U3). Without that record gateway-core's fulfilment check finds
 * nothing and payment-adapter refuses the discharge for ever, so this is RETRYABLE: the outbox
 * re-sends (the wallet dedupes by voucher id, and gc's receipt is idempotent).
 *
 * The message says DELIVERED on purpose (imani-wallet#289, E4): an operator reading
 * `last_failure` must not conclude the buyer holds nothing.
 */
export class DeliveredUnconfirmed extends IssuanceFailed {
  readonly delivered = true as const
  readonly voucherId: string
  readonly paymentRequestId: string
  readonly eventId: string | undefined
  readonly at: Date

  constructor(voucherId: string, paymentRequestId: string, eventId: string | undefined, at: Date) {
    super(
      `voucher ${voucherId} DELIVERED by DM` +
        (eventId ? ` (event ${eventId})` : '') +
        ` at ${at.toISOString()} for payment request ${paymentRequestId}, ` +
        'but the discharge is not yet confirmed: the gateway did not record the delivery (fulfilment_recorded missing)',
      true,
      false,
    )
    this.name = 'DeliveredUnconfirmed'
    this.voucherId = voucherId
    this.paymentRequestId = paymentRequestId
    this.eventId = eventId
    this.at = at
  }
}

/** How the buyer told us to reach them. */
export type Recipient =
  /** A pubkey we can DM, because they already hold a wallet. */
  | { kind: 'pubkey'; pubkey: string }
  /** Nobody to DM. The coupon is parked and a link is handed over. */
  | { kind: 'claim' }

export interface Delivered {
  /** Set for a DM; the gateway's own id for the send. */
  eventId?: string
  /**
   * True when the gateway confirmed it recorded the delivery against the payment request
   * (`fulfilment_recorded`, imani-wallet#287). `deliver` never returns without it: an unconfirmed
   * 2xx is thrown as {@link DeliveredUnconfirmed}.
   */
  fulfilmentRecorded?: true
  /** Set for a claim; the reference the buyer's link carries. */
  claimRef?: string
}

/**
 * Hand a coupon to its buyer.
 *
 * Separate from issuance on purpose, and `wallet-api`'s `issue.ts` says why in
 * terms worth repeating: a coupon can be issued and undelivered, and that state
 * is only recoverable if somebody is told. Folding delivery into issuance turns
 * a recoverable state into a silent loss of value.
 */
export async function deliver(
  baseUrl: string,
  credential: StallCredential,
  recipient: Recipient,
  token: string,
  paymentRequestId: string,
  voucherId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Delivered> {
  if (token === '') {
    // The mint has not finished. Not a failure: the coupon exists and the
    // caller should come back for it rather than treat this as a lost sale.
    throw new IssuanceFailed('the coupon has no token yet', true)
  }

  if (recipient.kind === 'claim') {
    throw new IssuanceFailed(
      'claim-link delivery is not wired yet; the coupon is issued and undelivered',
      true,
    )
  }

  const url = `${baseUrl.replace(/\/$/, '')}${DELIVER_PATH}`
  // No `sender_pubkey`. The gateway overwrites it with the authenticated key,
  // so sending one would be stating something we are not the authority on —
  // the same reason issuance sends no `issuer_id`.
  //
  // `paymentRequestId` IS ours to state, and it is what makes the discharge
  // checkable: gateway-core records it against the send, and the purchases API
  // later asks whether a COMPLETED send answered this exact id. Omitting it
  // would leave every discharge unverifiable, which the endpoint answers with
  // 503 forever — the coupon would be issued and the debt never closed.
  const body = JSON.stringify({
    recipient_pubkey: recipient.pubkey,
    token,
    // SNAKE case. `SendTokenDmRequest` binds this with
    // @JsonProperty("payment_request_id") and the DTO ignores unknown fields,
    // so a camelCase key is silently DROPPED — the send is recorded with a null
    // request id, no completed send ever answers the purchase, and every
    // discharge is refused forever. Sending the wrong case here is invisible at
    // every layer until a debt never closes.
    payment_request_id: paymentRequestId,
    // SNAKE case too, same trap. gc records the delivery as the issuer's own hand-over (and, with
    // imani-wallet#287 U2, reports it to gateway-core as an issuance receipt) only when the send
    // names the voucher it carries. Without it nothing reaches core and the discharge is refused.
    voucher_id: voucherId,
  })

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization('POST', url, body, credential.lockKeyHex),
      },
      body,
    })
  } catch (error) {
    throw new IssuanceFailed(
      error instanceof Error ? error.message : 'could not reach the gateway',
      true,
    )
  }

  const raw = await response.text()

  if (response.status !== 200 && response.status !== 201) {
    // Deliberately retryable even on a 400. The coupon EXISTS by this point:
    // `imani-woo` hit an unexplained 400 here and the right response was to
    // keep the debt open rather than to conclude the customer had been paid.
    throw new IssuanceFailed(
      // Redacted: gc's validation answer echoes the rejected value, which for an oversized send
      // is the token itself. This message reaches logs, payment-adapter's last_failure and the
      // outbox file (review of #279).
      `delivery refused with status ${response.status}: ${raw.trim().replace(/cashu[AB][A-Za-z0-9_\-+/=]*/g, 'cashu[redacted]').slice(0, 200)}`,
      true,
    )
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    // Delivery may well have happened. Saying otherwise would risk a second
    // coupon for one purchase, which is worse than a late one.
    throw new IssuanceFailed('delivery returned something that was not JSON', true)
  }

  const record = (decoded ?? {}) as Record<string, unknown>
  const eventId = typeof record.event_id === 'string' ? record.event_id : undefined
  // Strictly `true`. An older gc (no U2) answers 2xx without the field: the DM went out, but
  // nothing recorded it in gateway-core, so the discharge cannot be confirmed (imani-wallet#287).
  if (record.fulfilment_recorded !== true) {
    throw new DeliveredUnconfirmed(voucherId, paymentRequestId, eventId, new Date(now()))
  }
  return { eventId, fulfilmentRecorded: true }
}
