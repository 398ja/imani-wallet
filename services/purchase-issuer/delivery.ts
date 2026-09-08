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

/** How the buyer told us to reach them. */
export type Recipient =
  /** A pubkey we can DM, because they already hold a wallet. */
  | { kind: 'pubkey'; pubkey: string }
  /** Nobody to DM. The coupon is parked and a link is handed over. */
  | { kind: 'claim' }

export interface Delivered {
  /** Set for a DM; the gateway's own id for the send. */
  eventId?: string
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
  fetchImpl: typeof fetch = fetch,
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
  const body = JSON.stringify({ recipient_pubkey: recipient.pubkey, token })

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
      `delivery refused with status ${response.status}: ${raw.trim().slice(0, 200)}`,
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
  return { eventId: typeof record.event_id === 'string' ? record.event_id : undefined }
}
