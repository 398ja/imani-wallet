/**
 * Working off the debts a purchase creates.
 *
 * `payment-adapter` records that a card purchase was paid and is undischarged.
 * This reads those records, mints, delivers, and marks them done — and every
 * decision here is about what to do when one of those steps does not work.
 *
 * ## The rule everything follows
 *
 * **An Obligation is discharged by confirmed issuance, never by an attempt.**
 * `imani-woo` ADR 0009 learned this the expensive way: a merchant ticking a box
 * before sending left a customer who had paid for nothing, and no part of the
 * system could tell. The same shape applies to a machine — marking a debt done
 * because a call was made, rather than because it succeeded, is the same bug
 * with a faster actor.
 *
 * So the only path to `discharged` runs through a coupon that exists and a
 * delivery that returned. Everything else leaves the debt standing, which is
 * recoverable, and is the whole reason payment is recorded before issuance
 * (ADR 0010).
 */

import {
  IssuanceFailed,
  issueAsStall,
  purchaseIdempotencyKey,
  DEFAULT_EXPIRES_IN_DAYS,
  type IssuedCoupon,
  type StallCredential,
} from './issuer'
import { checkDelegation, delegatedWarrant } from './delegatedWarrant'
import { DeliveredUnconfirmed, DeliveryRefused, deliver, type Recipient } from './delivery'
import type { CardSale } from './saleRecord'

/** One coupon a stall owes because a card payment cleared. */
export interface Obligation {
  /** Stable across retries; Stripe's event id upstream. */
  id: string
  /**
   * Stamped onto the send so the discharge can be verified.
   *
   * Comes from the service that recorded the debt, never invented here: an id
   * this service chose at delivery time would verify only that this service
   * did something, which is what it already claims.
   */
  paymentRequestId: string
  stallPubkey: string
  faceValue: number
  faceUnit: string
  faceDecimals: number
  memo: string
  recipient: Recipient
  /** How many times issuance has already been tried. */
  attempts: number
  /**
   * The processor's record of the payment. Carried inside the coupon's signed
   * warrant as `ref` so the stall can reconcile it; not evidence.
   */
  processorReference?: string | null
}

/**
 * What a minted coupon still owes after this pass, for the delivery outbox (imani-wallet#274):
 * the sale record, when it did not land inline.
 */
export interface Minted {
  issuerId: string
  /** The sale record, or null when it was filed inline (or there is no `fileSale` port). */
  pendingSale: CardSale | null
}

export type Outcome =
  | ({ kind: 'discharged'; voucherId: string; eventId?: string } & Minted)
  /** Issued but not delivered: value exists and has not reached anyone. */
  | ({
      kind: 'undelivered'
      voucherId: string
      reason: string
      /**
       * The DM DID go out, but the gateway did not confirm it recorded the delivery
       * (imani-wallet#287/#289). Still owed to the outbox: the discharge is not confirmed.
       */
      delivered?: true
      /** gateway-core refused the receipt for good (core#163): park, never retry. */
      refused?: true
    } & Minted)
  /**
   * gc refused 409 UNRECORDED (gc#232): this payment's warrant nonce was spent by a run that never
   * recorded its voucher. Unknown whether a coupon exists, so never retried: parked for a person.
   */
  | { kind: 'unrecorded'; reason: string }
  /**
   * Nothing minted as far as we know. The debt stands and can be tried again.
   *
   * `ambiguous` when the request may have reached the gateway and minted
   * anyway (network error, timeout, 5xx). The claim is then left to lapse
   * rather than released, so the retry comes after anything in flight has
   * settled and the idempotency key can answer it (imani-wallet#96).
   */
  | { kind: 'owed'; reason: string; ambiguous: boolean }
  /** Nothing minted and retrying cannot help. Needs a person. */
  | { kind: 'blocked'; reason: string }
  /** No credential for this stall. Ordinary, not an error. */
  | { kind: 'manual' }

export interface Ports {
  credentialFor(stallPubkey: string): Promise<StallCredential | null>
  /** Fetch a token for a coupon whose mint had not finished. */
  tokenFor(credential: StallCredential, voucherId: string): Promise<string>
  now(): number
  sleep(ms: number): Promise<void>
  /**
   * File the card sale into the stall's own ledger (imani-wallet#275, `saleRecord.ts`). Optional:
   * absent, nothing is filed. Must never throw; its result never changes the outcome.
   */
  fileSale?(credential: StallCredential, sale: CardSale): Promise<boolean>
}

/**
 * How long to wait for a token before giving up on this pass.
 *
 * Minting is asynchronous: `imani-woo` measured a voucher id back in ~250ms and
 * the token about 1.5s later, against a real gateway. Three seconds is a
 * CEILING rather than a target — past it the coupon is not lost, it is simply
 * collected on the next pass.
 *
 * Unlike `imani-woo`, nobody is waiting on a checkout response here, so this
 * could be longer. It is not, because a long wait holds a worker on one debt
 * while others queue behind it, and lateness costs less than a stall's whole
 * backlog stalling on one slow mint.
 */
const TOKEN_WAIT_MS = 3000
const TOKEN_POLL_MS = 400

/**
 * Work one Obligation as far as it will go.
 *
 * Never throws. Every failure is a returned Outcome, because a thrown error in
 * a loop over debts is how one bad row stops the rest from being paid.
 */
export async function discharge(
  baseUrl: string,
  obligation: Obligation,
  ports: Ports,
): Promise<Outcome> {
  const credential = await ports.credentialFor(obligation.stallPubkey)

  // A stall that never enrolled an issuer is the ORDINARY configuration, not a
  // failure. `imani-woo` is explicit that warning on every sale trains a
  // merchant to ignore the log. The debt stands and the stall issues by hand.
  if (credential === null) {
    return { kind: 'manual' }
  }

  // A guest (no buyer pubkey) would take delivery by Cashlink, which is not
  // wired (delivery.ts). Minting first strands a paid coupon, retried forever.
  // Checkout refuses guests now; this blocks any debt that predates that.
  if (obligation.recipient.kind === 'claim') {
    return {
      kind: 'blocked',
      reason: 'guest purchase: Cashlink delivery is not wired yet; nothing minted, refund or deliver by hand',
    }
  }

  // Every debt this service works is a CARD purchase, and its warrant is the
  // only place the stall can reconcile it against Stripe. A delegated warrant
  // with no `ref` would mint and then read as rail "unknown" (#267). Checkout
  // in payment mode always yields a payment_intent, so a missing one is an
  // upstream defect: refuse before minting and leave the debt for a person.
  // BLOCKED, not owed: retrying the same row cannot produce a reference.
  if (!obligation.processorReference) {
    return {
      kind: 'blocked',
      reason: 'card purchase has no processor reference (pi_…); refusing to mint an unreconcilable coupon',
    }
  }

  // The till refuses any coupon this service cannot warrant (#152), so a
  // credential without a live delegation from the stall must not mint at all.
  // BLOCKED rather than owed: retrying cannot help until the stall signs a new
  // delegation, which needs a person, and nothing was minted.
  const expiresInDays = DEFAULT_EXPIRES_IN_DAYS
  const delegation = checkDelegation(credential, ports.now() + expiresInDays * 86_400_000)
  if (!delegation.ok) {
    return { kind: 'blocked', reason: delegation.reason }
  }

  const issuanceWarrant = delegatedWarrant({
    // The nonce derives from the PAYMENT, not the event (imani-wallet#274): any re-drive of one
    // pi_ is the same warrant use at gc, which replays the recorded voucher (gc#232).
    paymentIntent: obligation.processorReference,
    issuerId: credential.stallPubkey.toLowerCase(),
    saleTotalMinor: obligation.faceValue,
    faceDecimals: obligation.faceDecimals,
    unit: obligation.faceUnit,
    reference: obligation.processorReference ?? null,
    lockKeyHex: credential.lockKeyHex,
    delegation: delegation.event,
  })

  let coupon: IssuedCoupon
  try {
    coupon = await issueAsStall(baseUrl, credential, {
      faceValue: obligation.faceValue,
      faceUnit: obligation.faceUnit,
      faceDecimals: obligation.faceDecimals,
      memo: obligation.memo,
      expiresInDays,
      // The payment intent, so every attempt at this PAYMENT (a lapsed claim,
      // a second event, a reconciler re-drive) mints under one key
      // (imani-wallet#96, #274).
      idempotencyKey: purchaseIdempotencyKey(obligation.processorReference),
      // Signed as the stall's delegate, with the stall's own delegation inside,
      // so the till verifies it offline (#152). The processor reference rides
      // along inside the signed bytes for reconciliation.
      issuanceWarrant,
    })
  } catch (error) {
    if (error instanceof IssuanceFailed && error.unrecorded) {
      return { kind: 'unrecorded', reason: error.message }
    }
    if (error instanceof IssuanceFailed) {
      // A burnt credential will never mint. Retrying it forever would bury the
      // one case that needs a human in a log of identical failures.
      return error.retryable
        ? { kind: 'owed', reason: error.message, ambiguous: error.ambiguous }
        : { kind: 'blocked', reason: error.message }
    }
    return { kind: 'owed', reason: describe(error), ambiguous: true }
  }

  // From here a coupon EXISTS. Nothing below may report the debt as unminted,
  // because a second pass would mint a second coupon for one payment.

  // The sale goes into the stall's ledger as soon as the coupon exists, delivered
  // or not: an undelivered card coupon is still the stall's sale (#275, gap D).
  // Tried once inline; one that does not land is returned as `pendingSale`, and the
  // delivery outbox owns its retries (imani-wallet#274, U8).
  let pendingSale: CardSale | null = null
  if (ports.fileSale) {
    const at = ports.now()
    const sale: CardSale = {
      voucherId: coupon.voucherId,
      faceValue: obligation.faceValue,
      faceUnit: obligation.faceUnit,
      faceDecimals: obligation.faceDecimals,
      memo: obligation.memo,
      recipientPubkey: obligation.recipient.kind === 'pubkey' ? obligation.recipient.pubkey : undefined,
      at,
      // The gateway counts `expires_in_days` from its own mint instant, so this is
      // the coupon's expiry to within the mint's latency. Without it the merchant
      // record reads "No expiry" for a coupon that expires (S1 showed the date).
      expiresAt: Math.floor(at / 1000) + expiresInDays * 86_400,
      issuanceWarrant,
    }
    // try/await, not `.catch`: a port that throws synchronously must not escape
    // either, because the coupon already exists (review of #278).
    let filed = false
    try {
      filed = await ports.fileSale(credential, sale)
    } catch {
      filed = false
    }
    if (!filed) pendingSale = sale
  }
  const minted: Minted = { issuerId: coupon.issuerId, pendingSale }

  let token = coupon.token
  if (token === '') {
    token = await waitForToken(credential, coupon.voucherId, ports)
  }

  if (token === '') {
    return {
      kind: 'undelivered',
      voucherId: coupon.voucherId,
      reason: 'the mint has not produced a token yet',
      ...minted,
    }
  }

  try {
    const delivered = await deliver(
      baseUrl,
      credential,
      obligation.recipient,
      token,
      obligation.paymentRequestId,
      coupon.voucherId,
      fetch,
      () => ports.now(),
    )
    return {
      kind: 'discharged',
      voucherId: coupon.voucherId,
      eventId: delivered.eventId,
      ...minted,
    }
  } catch (error) {
    return {
      kind: 'undelivered',
      voucherId: coupon.voucherId,
      reason: error instanceof Error ? error.message : describe(error),
      ...(error instanceof DeliveredUnconfirmed || error instanceof DeliveryRefused ? { delivered: true as const } : {}),
      ...(error instanceof DeliveryRefused ? { refused: true as const } : {}),
      ...minted,
    }
  }
}

/** Poll briefly for a token the mint had not finished producing. */
async function waitForToken(
  credential: StallCredential,
  voucherId: string,
  ports: Ports,
): Promise<string> {
  const deadline = ports.now() + TOKEN_WAIT_MS
  while (ports.now() < deadline) {
    await ports.sleep(TOKEN_POLL_MS)
    try {
      const token = await ports.tokenFor(credential, voucherId)
      if (token !== '') return token
    } catch {
      // A failed poll is not a failed mint. Keep trying until the ceiling.
    }
  }
  return ''
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
