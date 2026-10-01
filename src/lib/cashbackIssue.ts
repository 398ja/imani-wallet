/**
 * Issuing one cashback: sign, mint, record. In that order (#144).
 *
 * The warrant is part of the voucher's signed NUT-10 secret, like a NUT-11
 * condition. The gateway signs that secret when it mints, so a warrant signed
 * afterwards can never get into the coupon. A cashback minted without one is
 * refused at the issuing stall's own till as unwarranted. Sell does the same
 * thing in `issue.ts` `createVouchers`.
 *
 * Kept out of the page so the order can be tested without rendering it.
 */
import { issuingStall, type Actor } from './actor'
import { CashbackGenerateError, generateCashback, type IssuedCashback } from './cashback'
import { getSigner } from './nap'
import { buildCashbackTransaction } from './transactions'
import { getWallet, notifyWalletChanged } from './wallet'
import { buildIssuanceWarrant } from './warrantSigner'

const MS_PER_SECOND = 1000

export interface CashbackRequest {
  /**
   * WHO is issuing. Null only when the session names no stall, in which case
   * no warrant can be signed and none is sent.
   *
   * A terminal gets a signed `none` from the signer's own guard, because its
   * key is not the stall's. The portal accepts that and the till still refuses
   * the coupon. Fixing that needs the `delegated` form and is separate.
   */
  actor: Actor | null
  amountMinor: number
  unit: string
  decimals: number
  memo?: string
  expiryDays: number
}

/**
 * What must stay the same across every retry of one issue: the idempotency
 * key and the warrant string. The portal keys on the first and hashes the
 * second, so re-signing on a retry (a fresh nonce) is refused with 409.
 */
export interface CashbackAttempt {
  idempotencyKey: string
  warrant: string | undefined
}

/** Sign the warrant and pick the key for one issue. Call once per issue. */
export async function prepareCashbackAttempt(request: CashbackRequest): Promise<CashbackAttempt> {
  const { actor, amountMinor, decimals, unit } = request
  return {
    idempotencyKey: crypto.randomUUID(),
    warrant: actor ? await buildIssuanceWarrant(actor, amountMinor, decimals, unit) : undefined,
  }
}

/**
 * Sign the warrant, mint the code with it, then record the sale.
 *
 * The one warrant string goes to the portal AND onto the history row. Signing
 * twice would give two nonces for one sale, and reconciliation would then
 * disagree with the coupon about which sale it was.
 *
 * Pass the `attempt` from a failed call to retry the same issue. Omit it for a
 * new one.
 */
export async function issueCashback(
  request: CashbackRequest,
  attempt?: CashbackAttempt,
): Promise<IssuedCashback> {
  const { actor, amountMinor, unit, decimals, memo, expiryDays } = request
  const { idempotencyKey, warrant } = attempt ?? (await prepareCashbackAttempt(request))

  const issued = await generateCashback({
    amountMinor,
    unit,
    memo: memo || undefined,
    expiryDays,
    issuanceWarrant: warrant,
    idempotencyKey,
  })

  await record(issued, {
    decimals,
    memo: memo ?? '',
    warrant,
    stallPubkey: actor ? issuingStall(actor) : undefined,
  })
  return issued
}

/**
 * One issue screen's submissions, made safe to press twice.
 *
 * Two guards, for two different double presses:
 *  - In flight: a second press before the first answers does nothing and
 *    resolves null. React state is not synchronous, so a `busy` flag set by
 *    the first tap can still read false on a second tap in the same frame.
 *  - After a failure: the attempt (key and warrant) is kept, so pressing again
 *    retries the SAME issue. If the first request did land, the portal
 *    answers with that code instead of minting a second one.
 *
 * The attempt is dropped once a code is issued, and when the amount, unit,
 * note or expiry changes, because then it is a different sale. Also when the
 * stall or the signing key changes: an account switch is a different issuer.
 *
 * Two cases are never kept for a retry:
 *  - An attempt with NO warrant while there is an actor. That means the wallet
 *    was locked, and reusing it after unlocking would mint the coupon
 *    unwarranted, which the till refuses (the #144 symptom). The next press
 *    signs afresh.
 *  - An attempt the portal definitely refused (a 4xx envelope other than 409).
 *    Nothing was minted under that key, so there is nothing to protect.
 */
export function createCashbackIssuer() {
  let inFlight = false
  let pending: { inputs: string; attempt: CashbackAttempt } | null = null

  return {
    async submit(request: CashbackRequest): Promise<IssuedCashback | null> {
      if (inFlight) return null
      inFlight = true
      try {
        const inputs = JSON.stringify([
          request.amountMinor,
          request.unit,
          request.memo || undefined,
          request.expiryDays,
          request.actor ? issuingStall(request.actor) : null,
          signerPubkey(),
        ])
        if (pending?.inputs !== inputs) {
          pending = { inputs, attempt: await prepareCashbackAttempt(request) }
        }
        const attempt = pending.attempt
        if (request.actor && attempt.warrant === undefined) pending = null
        try {
          const issued = await issueCashback(request, attempt)
          pending = null
          return issued
        } catch (error) {
          if (error instanceof CashbackGenerateError && error.definiteRefusal) pending = null
          throw error
        }
      } finally {
        inFlight = false
      }
    },
  }
}

/** The unlocked key, or null while locked. Part of the attempt's identity. */
function signerPubkey(): string | null {
  try {
    return getSigner().pubkey
  } catch {
    return null
  }
}

/**
 * The merchant's own record of the code. Nothing else on this device holds it.
 *
 * Non-fatal but never silent, matching `issueAndDeliver`: the code is already
 * minted and about to go on screen, so throwing here would report a live
 * cashback as a failed one.
 */
async function record(
  issued: IssuedCashback,
  extra: { decimals: number; memo: string; warrant?: string; stallPubkey?: string },
): Promise<void> {
  try {
    const expiresAt = Date.parse(issued.expiresAt)
    await getWallet().addTransaction(
      buildCashbackTransaction({
        cashbackId: issued.cashbackId,
        claimCode: issued.claimCode,
        voucherId: issued.voucherId,
        amount: issued.amountMinor,
        unit: issued.unit,
        decimals: extra.decimals,
        memo: extra.memo || undefined,
        // Epoch SECONDS, as the builder documents.
        expiresAt: Number.isNaN(expiresAt) ? undefined : Math.floor(expiresAt / MS_PER_SECOND),
        at: Date.now(),
        issuanceWarrant: extra.warrant,
        merchantId: extra.stallPubkey,
      }),
    )
    // A write made by this tab is not echoed back to it, so the history screen
    // behind this one needs telling. Same as issue.ts.
    notifyWalletChanged()
  } catch (error) {
    console.error('[cashback] issuance not recorded in history', error)
  }
}
