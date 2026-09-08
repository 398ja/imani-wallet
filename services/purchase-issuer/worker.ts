/**
 * The loop that works off debts.
 *
 * Reads what is owed, discharges what it can, reports what it cannot, and
 * comes back. Every decision here is about not making a bad situation worse:
 * the customer has already paid, so the failure modes are "late" and "twice",
 * and only one of those is recoverable.
 */

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
}

export interface PassResult {
  discharged: number
  deferred: number
  blocked: number
  skipped: number
}

/**
 * One pass over the queue.
 *
 * Sequential, deliberately. Minting is cheap to parallelise and expensive to
 * get wrong: two workers racing the same debt is exactly how one payment
 * becomes two coupons, and the queue is short enough that the ordering costs
 * nothing worth having.
 */
export async function runPass(deps: WorkerDeps): Promise<PassResult> {
  const result: PassResult = { discharged: 0, deferred: 0, blocked: 0, skipped: 0 }
  const owed = await deps.api.owed()

  for (const purchase of owed) {
    if (purchase.livemode !== deps.livemode) {
      // Not ours. Left owed rather than failed: the other worker will take it,
      // and marking it would hide a misconfiguration behind a stream of
      // failures.
      result.skipped += 1
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
        )
        break

      case 'blocked':
        result.blocked += 1
        await deps.api.reportFailure(purchase.eventId, outcome.reason, true)
        break

      case 'owed':
        result.deferred += 1
        await deps.api.reportFailure(purchase.eventId, outcome.reason, false)
        break

      case 'manual':
        // A stall with no credential. Ordinary, not a failure, and not
        // reported: writing a note on every pass would fill the row with
        // repetitions of a fact that is not going to change by itself.
        result.skipped += 1
        break
    }
  }

  return result
}

function toObligation(purchase: OwedPurchase): Obligation {
  return {
    id: purchase.eventId,
    paymentRequestId: purchase.paymentRequestId,
    stallPubkey: purchase.connectedAccountId,
    faceValue: purchase.amountMinor,
    faceUnit: purchase.currency.toUpperCase(),
    // Stripe's minor units and the coupon's must agree, and they do: both are
    // the currency's own minor unit. Zero-decimal currencies are the case to
    // watch if this ever supports one.
    faceDecimals: 2,
    memo: '',
    recipient:
      purchase.recipientPubkey === null
        ? { kind: 'claim' }
        : { kind: 'pubkey', pubkey: purchase.recipientPubkey },
    attempts: purchase.attempts,
  }
}
