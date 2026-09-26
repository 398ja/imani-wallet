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
  processorWarrant,
  type IssuedCoupon,
  type StallCredential,
} from './issuer'
import { deliver, type Recipient } from './delivery'

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
  /** The processor's record of the payment, for the coupon's warrant. */
  processorReference?: string | null
}

export type Outcome =
  | { kind: 'discharged'; voucherId: string; issuerId: string; eventId?: string }
  /** Issued but not delivered: value exists and has not reached anyone. */
  | { kind: 'undelivered'; voucherId: string; reason: string }
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

  let coupon: IssuedCoupon
  try {
    coupon = await issueAsStall(baseUrl, credential, {
      faceValue: obligation.faceValue,
      faceUnit: obligation.faceUnit,
      faceDecimals: obligation.faceDecimals,
      memo: obligation.memo,
      expiresInDays: 365,
      // The purchase's own id, so every attempt at this debt (including one
      // after a lapsed claim) mints under one key (imani-wallet#96).
      idempotencyKey: purchaseIdempotencyKey(obligation.id),
      // A card purchase is warranted by the processor that took the money,
      // so the stall can reconcile it against its own account.
      issuanceWarrant: processorWarrant({
        eventId: obligation.id,
        saleTotalMinor: obligation.faceValue,
        faceDecimals: obligation.faceDecimals,
        unit: obligation.faceUnit,
        reference: obligation.processorReference ?? null,
      }),
    })
  } catch (error) {
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
  let token = coupon.token
  if (token === '') {
    token = await waitForToken(credential, coupon.voucherId, ports)
  }

  if (token === '') {
    return {
      kind: 'undelivered',
      voucherId: coupon.voucherId,
      reason: 'the mint has not produced a token yet',
    }
  }

  try {
    const delivered = await deliver(
      baseUrl,
      credential,
      obligation.recipient,
      token,
      obligation.paymentRequestId,
    )
    return {
      kind: 'discharged',
      voucherId: coupon.voucherId,
      issuerId: coupon.issuerId,
      eventId: delivered.eventId,
    }
  } catch (error) {
    return {
      kind: 'undelivered',
      voucherId: coupon.voucherId,
      reason: error instanceof Error ? error.message : describe(error),
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
