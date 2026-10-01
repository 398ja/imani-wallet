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
import { generateCashback, type IssuedCashback } from './cashback'
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
 * Sign the warrant, mint the code with it, then record the sale.
 *
 * The one warrant string goes to the portal AND onto the history row. Signing
 * twice would give two nonces for one sale, and reconciliation would then
 * disagree with the coupon about which sale it was.
 */
export async function issueCashback(request: CashbackRequest): Promise<IssuedCashback> {
  const { actor, amountMinor, unit, decimals, memo, expiryDays } = request
  const warrant = actor
    ? await buildIssuanceWarrant(actor, amountMinor, decimals, unit)
    : undefined

  const issued = await generateCashback({
    amountMinor,
    unit,
    memo: memo || undefined,
    expiryDays,
    issuanceWarrant: warrant,
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
