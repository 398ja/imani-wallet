/**
 * The loop that works off debts.
 *
 * Reads what is owed, discharges what it can, reports what it cannot, and
 * comes back. Every decision here is about not making a bad situation worse:
 * the customer has already paid, so the failure modes are "late" and "twice",
 * and only one of those is recoverable.
 */

import { hostname } from 'node:os'

import { getDecimals } from '@imani/money'

import { discharge, type Obligation, type Ports } from './discharge'
import type { PurchasesApi, OwedPurchase } from './purchasesApi'

export interface WorkerDeps {
  api: PurchasesApi
  ports: Ports
  /** Where the gateway lives, for minting and delivering. */
  gatewayUrl: string
  /**
   * Whether this deployment may mint real coupons.
   *
   * A test-mode payment must never produce real value, and the check lives
   * here rather than in the queue because only the deployment knows which it
   * is. A live worker skips test rows and a test worker skips live ones, so a
   * misconfigured pair leaves debts visibly unworked rather than quietly
   * minting the wrong thing.
   */
  livemode: boolean
  /**
   * Who is claiming, recorded on the row for an operator (imani-wallet#96).
   * Not an authority; the bearer token is.
   */
  workerId?: string
}

/** Host and process, which is what an operator needs to find the claimant. */
const DEFAULT_WORKER_ID = `${hostname()}:${process.pid}`

export interface PassResult {
  discharged: number
  deferred: number
  blocked: number
  skipped: number
}

/**
 * One pass over the queue.
 *
 * Sequential, deliberately: the queue is short and ordering costs nothing
 * worth having. It is no longer what stops two workers racing one debt; the
 * claim is (imani-wallet#96), so replicas are safe.
 *
 * Throws `ReportLostError` when an outcome could not be recorded after every
 * retry. The caller must stop rather than carry on (see `server.ts`).
 */
export async function runPass(deps: WorkerDeps): Promise<PassResult> {
  const result: PassResult = { discharged: 0, deferred: 0, blocked: 0, skipped: 0 }
  const worker = deps.workerId ?? DEFAULT_WORKER_ID
  const owed = await deps.api.owed()

  for (const purchase of owed) {
    if (purchase.stallPubkey === null) {
      // We know a debt is owed and cannot tell which stall owes it, so there is
      // no credential to look up. Left for a human rather than guessed at.
      result.skipped += 1
      continue
    }

    if (purchase.livemode !== deps.livemode) {
      // Not ours. Left owed rather than failed: the other worker will take it,
      // and marking it would hide a misconfiguration behind a stream of
      // failures.
      result.skipped += 1
      continue
    }

    // A stall with no enrolled issuer is issued by hand. Checked BEFORE the
    // claim, so that ordinary case never holds a lease on a row it will not
    // work, and never writes a note on every pass.
    if ((await deps.ports.credentialFor(purchase.stallPubkey)) === null) {
      result.skipped += 1
      continue
    }

    // Claim before mint (imani-wallet#96). The purchases API moves the row
    // OWED -> ISSUING in one conditional update, so of any number of workers
    // (replicas, or this one restarted mid-pass) exactly one mints. Anything
    // but 'claimed', an unreachable API included, means do not mint.
    const claim = await deps.api.claim(purchase.eventId, worker)
    if (claim !== 'claimed') {
      if (claim === 'unreachable') result.deferred += 1
      else result.skipped += 1
      continue
    }

    const outcome = await discharge(deps.gatewayUrl, toObligation(purchase), deps.ports)

    switch (outcome.kind) {
      case 'discharged': {
        const accepted = await deps.api.discharge(
          purchase.eventId,
          outcome.voucherId,
          outcome.issuerId,
        )
        if (accepted === 'accepted') {
          result.discharged += 1
        } else {
          // We issued, and the debt did not close. Never retried as a fresh
          // issuance: the coupon exists, and a second pass would mint another
          // for the same payment. Recorded with the voucher id so a person can
          // find the coupon that was already made.
          result.deferred += 1
          await deps.api.reportFailure(
            purchase.eventId,
            `issued voucher ${outcome.voucherId} but the discharge was ${accepted}`,
            false,
            // NAMED, so the debt stops being mintable. Without this the row
            // stays in the owed queue and the next pass mints a second coupon
            // for the same payment.
            outcome.voucherId,
          )
        }
        break
      }

      case 'undelivered':
        // Issued, not delivered. Same rule: the coupon exists, so this must
        // never look like an unminted debt.
        result.deferred += 1
        await deps.api.reportFailure(
          purchase.eventId,
          `issued voucher ${outcome.voucherId} but delivery failed: ${outcome.reason}`,
          false,
          outcome.voucherId,
        )
        break

      case 'blocked':
        result.blocked += 1
        await deps.api.reportFailure(purchase.eventId, outcome.reason, true, undefined, { worker })
        break

      case 'owed':
        result.deferred += 1
        await deps.api.reportFailure(purchase.eventId, outcome.reason, false, undefined, {
          worker,
          keepClaim: outcome.ambiguous,
        })
        break

      case 'manual':
        // The credential vanished between the check above and the mint (a
        // stall re-enrolling mid-pass). Nothing was minted, so the claim is
        // released back to OWED rather than left to lapse.
        result.skipped += 1
        await deps.api.reportFailure(purchase.eventId, 'no issuing credential at mint time', false, undefined, {
          worker,
        })
        break
    }
  }

  return result
}

function toObligation(purchase: OwedPurchase): Obligation {
  const currency = purchase.currency.toUpperCase()
  return {
    id: purchase.eventId,
    paymentRequestId: purchase.paymentRequestId,
    // The stall's pubkey, never its Stripe account id: a credential is keyed
    // by the first and the second addresses money.
    stallPubkey: purchase.stallPubkey as string,
    faceValue: purchase.amountMinor,
    faceUnit: currency,
    /*
     * Looked up, NOT assumed to be 2.
     *
     * This said `faceDecimals: 2` with a comment calling zero-decimal
     * currencies "the case to watch". They are not hypothetical: XAF, XOF,
     * UGX and TZS are all zero-decimal and XAF is a primary market. Stripe
     * sends 5000 for 5000 XAF, and a coupon minted with 2 decimals would read
     * that as 50.00 — a customer paying 5000 and receiving a hundredth of it.
     */
    faceDecimals: getDecimals(currency),
    memo: '',
    recipient:
      purchase.recipientPubkey === null
        ? { kind: 'claim' }
        : { kind: 'pubkey', pubkey: purchase.recipientPubkey },
    attempts: purchase.attempts,
    processorReference: purchase.processorReference,
  }
}
