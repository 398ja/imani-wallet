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

import { discharge, type Obligation, type Outcome, type Ports } from './discharge'
import { countAttempt, countGiftSweepError, setOwedUnenrolled } from './metrics'
import type { DeliveryOutbox } from './outbox'
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
  /**
   * The durable delivery outbox (imani-wallet#274). Absent, a failed delivery parks the row ISSUED
   * with nothing to re-send it (the pre-U8 behaviour, kept for tests and tools only).
   */
  outbox?: DeliveryOutbox
  /** G15 §4.3: claimed/expired notices for delivered gifts, swept once per pass. Absent, nothing is swept. */
  giftTracker?: { sweep(): Promise<unknown> }
  /** Follow-up to #655: forward customer receipts queued for delegate keys to their stalls. Never throws. */
  receiptForwarder?: () => Promise<unknown>
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
  let owedUnenrolled = 0

  for (const purchase of owed) {
    if (purchase.stallPubkey === null) {
      // We know a debt is owed and cannot tell which stall owes it, so there is
      // no credential to look up. Left for a human rather than guessed at.
      result.skipped += 1
      countAttempt('skipped')
      continue
    }

    if (purchase.livemode !== deps.livemode) {
      // Not ours. Left owed rather than failed: the other worker will take it,
      // and marking it would hide a misconfiguration behind a stream of
      // failures.
      result.skipped += 1
      countAttempt('skipped')
      continue
    }

    // A stall with no enrolled issuer is issued by hand. Checked BEFORE the
    // claim, so that ordinary case never holds a lease on a row it will not
    // work, and never writes a note on every pass.
    //
    // Counted and logged DISTINCTLY (imani-wallet#290/#298). Every row here is a card purchase
    // somebody has PAID for, so "no credential" is money taken that nothing will issue. It used to
    // read as an ordinary `skipped`, which is how three paid purchases sat OWED unseen. One log
    // line per stall per hour (a pass runs every 15 s), with a stall prefix only: no amount, no id.
    if ((await deps.ports.credentialFor(purchase.stallPubkey)) === null) {
      result.skipped += 1
      owedUnenrolled += 1
      countAttempt('no_credential')
      const stall = purchase.stallPubkey.slice(0, 16)
      const now = Date.now()
      if ((warnedAt.get(stall) ?? 0) + UNENROLLED_WARN_EVERY_MS <= now) {
        warnedAt.set(stall, now)
        console.warn(
          JSON.stringify({
            event: 'purchase_owed_stall_not_enrolled',
            stall,
            detail: 'a paid card purchase for a stall with no enrolled issuer; the stall must turn on card sales',
          }),
        )
      }
      continue
    }

    // Claim before mint (imani-wallet#96). The purchases API moves the row
    // OWED -> ISSUING in one conditional update, so of any number of workers
    // (replicas, or this one restarted mid-pass) exactly one mints. Anything
    // but 'claimed', an unreachable API included, means do not mint.
    const claim = await deps.api.claim(purchase.eventId, worker)
    if (claim !== 'claimed') {
      if (claim === 'unreachable') {
        result.deferred += 1
        countAttempt('claim_unreachable')
      } else {
        result.skipped += 1
        countAttempt('claim_lost')
      }
      continue
    }

    const outcome = await discharge(deps.gatewayUrl, toObligation(purchase), deps.ports)

    // A coupon exists. Whatever it still owes goes into the durable outbox BEFORE the purchases
    // API hears anything, so a crash from here on cannot lose a delivery (imani-wallet#274).
    if ((outcome.kind === 'undelivered' || outcome.kind === 'discharged') && deps.outbox) {
      const owesDelivery = outcome.kind === 'undelivered'
      if (owesDelivery || outcome.pendingSale !== null) {
        const queued = await enqueue(deps.outbox, purchase, outcome)
        if (!queued && owesDelivery) {
          // Not durable, so NOT reported ISSUED: that would park the coupon with nothing to
          // re-send it. The claim is left to lapse instead; the re-claim re-mints under the same
          // pi_ nonce, gc replays the original voucher (#232), and delivery is tried again.
          result.deferred += 1
          countAttempt('outbox_write_failed')
          await deps.api.reportFailure(
            purchase.eventId,
            `issued voucher ${outcome.voucherId}, delivery failed and the outbox write failed`,
            false,
            undefined,
            { worker, keepClaim: true },
          )
          continue
        }
      }
    }

    switch (outcome.kind) {
      case 'unrecorded': {
        // Never retried (gc#232): the first run may have minted. Parked for a person.
        result.blocked += 1
        countAttempt('unrecorded')
        const parked = await deps.api.attention(purchase.eventId, 'gateway_unrecorded', {
          detail: outcome.reason.slice(0, 500),
          worker,
        })
        if (parked === 'unsupported') {
          // A payment-adapter without #280: the old permanent failure, which also stops retries.
          console.warn(JSON.stringify({ event: 'purchase_attention_unsupported', event_id: purchase.eventId }))
          await deps.api.reportFailure(purchase.eventId, `gateway_unrecorded: ${outcome.reason}`, true, undefined, {
            worker,
          })
        } else if (parked !== 'parked') {
          // Could not park it now. Left to lapse, NOT released: the next claim asks gc again and
          // gets the same 409, and tries to park it again.
          await deps.api.reportFailure(purchase.eventId, `gateway_unrecorded: ${outcome.reason}`, false, undefined, {
            worker,
            keepClaim: true,
          })
        }
        break
      }

      case 'discharged': {
        const accepted = await deps.api.discharge(
          purchase.eventId,
          outcome.voucherId,
          outcome.issuerId,
        )
        if (accepted === 'accepted') {
          result.discharged += 1
          countAttempt('discharged')
        } else {
          // We issued, and the debt did not close. Never retried as a fresh
          // issuance: the coupon exists, and a second pass would mint another
          // for the same payment. Recorded with the voucher id so a person can
          // find the coupon that was already made.
          result.deferred += 1
          countAttempt('discharge_rejected')
          await deps.api.reportFailure(
            purchase.eventId,
            // E4 (imani-wallet#289): this branch is only reached after a recorded delivery.
            `issued and DELIVERED voucher ${outcome.voucherId}` +
              (outcome.eventId ? ` (DM event ${outcome.eventId})` : '') +
              ` for payment request ${purchase.paymentRequestId}, but the discharge was ${accepted}`,
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
        // E4 (imani-wallet#289): a DM that went out but was not recorded is DELIVERED, and says
        // so in the text and the metric, so nobody concludes the buyer holds nothing.
        countAttempt(outcome.delivered ? 'delivered_unconfirmed' : 'undelivered')
        await deps.api.reportFailure(
          purchase.eventId,
          outcome.delivered
            ? `issued voucher ${outcome.voucherId}: ${outcome.reason}`
            : `issued voucher ${outcome.voucherId} but delivery failed: ${outcome.reason}`,
          false,
          outcome.voucherId,
        )
        break

      case 'attention': {
        // #312: nothing minted, and the stall's term cannot be honoured (never expires, or longer
        // than its delegation) or its record stayed unreadable. Parked for a person, who refunds
        // or issues by hand; a silent BLOCKED would leave a paid buyer with nobody looking.
        result.blocked += 1
        countAttempt('blocked')
        const parked = await deps.api.attention(purchase.eventId, 'issue_blocked', {
          detail: outcome.reason.slice(0, 500),
          worker,
        })
        if (parked !== 'parked') {
          // A payment-adapter that cannot park it: the old permanent failure, which a person
          // still sees in the BLOCKED queue. Nothing was minted, so closing it cannot strand value.
          await deps.api.reportFailure(purchase.eventId, outcome.reason, true, undefined, { worker })
        }
        break
      }

      case 'gift_undelivered': {
        // #410 G14: a locked gift exists and did not reach its recipient or buyer this pass.
        result.deferred += 1
        countAttempt(outcome.park ? 'blocked' : 'undelivered')
        if (outcome.park) {
          const parked = await deps.api.attention(purchase.eventId, 'delivery_exhausted', {
            voucherId: outcome.voucherId,
            detail: `locked gift ${outcome.voucherId}: ${outcome.reason}`.slice(0, 500),
            worker,
          })
          if (parked !== 'parked') {
            await deps.api.reportFailure(purchase.eventId, `locked gift: ${outcome.reason}`, true, outcome.voucherId, { worker })
          }
        } else {
          // Left to lapse, NOT named: the re-claim re-mints under the same idempotency key and
          // warrant nonce (gc replays this voucher), and every delivery step is idempotent.
          await deps.api.reportFailure(
            purchase.eventId,
            `issued locked gift ${outcome.voucherId}, delivery pending: ${outcome.reason}`,
            false,
            undefined,
            { worker, keepClaim: true },
          )
        }
        break
      }

      case 'blocked':
        result.blocked += 1
        countAttempt('blocked')
        await deps.api.reportFailure(purchase.eventId, outcome.reason, true, undefined, { worker })
        break

      case 'owed':
        result.deferred += 1
        countAttempt('owed')
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
        countAttempt('manual')
        await deps.api.reportFailure(purchase.eventId, 'no issuing credential at mint time', false, undefined, {
          worker,
        })
        break
    }
  }

  setOwedUnenrolled(owedUnenrolled)
  if (deps.giftTracker) {
    // Never fails the pass: a notice is late, never lost (the row stays until claimBy + 7 d).
    try {
      await deps.giftTracker.sweep()
    } catch (error) {
      countGiftSweepError()
      console.warn(JSON.stringify({ event: 'gift_sweep_failed', reason: error instanceof Error ? error.name : 'error' }))
    }
  }
  if (deps.receiptForwarder) {
    try {
      await deps.receiptForwarder()
    } catch {
      // forwardAllReceipts never throws; a receipt left queued is retried next pass.
    }
  }
  return result
}

/** How often one stall's "paid but not enrolled" line is repeated. */
const UNENROLLED_WARN_EVERY_MS = 60 * 60_000
const warnedAt = new Map<string, number>()

/** Queue what a minted coupon still owes. False when it could not be made durable. */
async function enqueue(
  outbox: DeliveryOutbox,
  purchase: OwedPurchase,
  outcome: Extract<Outcome, { kind: 'discharged' | 'undelivered' }>,
): Promise<boolean> {
  try {
    await outbox.put({
      eventId: purchase.eventId,
      voucherId: outcome.voucherId,
      issuerId: outcome.issuerId,
      stallPubkey: purchase.stallPubkey as string,
      recipientPubkey: purchase.recipientPubkey ?? '',
      paymentRequestId: purchase.paymentRequestId,
      deliver: outcome.kind === 'undelivered',
      // The inline attempt counts.
      attempts: outcome.kind === 'undelivered' ? 1 : 0,
      // core refused the receipt for good (#287, core#163): the next delivery pass parks it, unsent.
      ...(outcome.kind === 'undelivered' && outcome.refused
        ? { exhausted: true, lastError: outcome.reason }
        : {}),
      sale: outcome.pendingSale,
      saleAttempts: outcome.pendingSale ? 1 : 0,
    })
    return true
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'purchase_outbox_write_failed',
        event_id: purchase.eventId,
        detail: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
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
    gift: purchase.delivery ? { kind: purchase.delivery.kind, delivery: purchase.delivery, draftId: purchase.draftId ?? null } : null,
  }
}
