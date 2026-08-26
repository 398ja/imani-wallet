import { listTransactions } from './wallet'
import { toTransaction } from './transactions'

/**
 * How much has already been taken in against one voucher, and whether the next
 * redemption would breach what was issued.
 *
 * This is the only check that sees ACROSS redemptions. A signature says the
 * voucher is genuine and the faceValue cap bounds any single presentation, but
 * neither notices the same £10 voucher being redeemed four times for £10. A
 * partially-spent voucher legitimately comes back more than once — the schema
 * says as much, "cashu tokens can legitimately share the same voucher_id" — so
 * the bound is on the sum, not the count.
 *
 * Deliberately no new store. Every transaction row already carries `voucher_id`
 * and an amount, and there is a `by-voucher-id` index on the table, so the total
 * is a query rather than a second source of truth that could disagree with the
 * first.
 *
 * Local rows are authoritative here, by design: a merchant who accepted a
 * redemption with no signal must be able to enforce their own ceiling without
 * asking anyone. Relay reconciliation corrects the wiped-device case afterwards
 * (`backfillTx` already makes that sweep) rather than gating the till on a round
 * trip at the slowest possible moment.
 */

export interface RedemptionCheck {
  /** False when crediting `requested` would take the voucher past what was issued. */
  allowed: boolean
  /** Sum of prior redemptions against this voucher on this device. */
  alreadyRedeemed: number
  requested: number
  /** The issuer-signed ceiling. */
  signedFaceValue: number
  /** What remains creditable. Never negative. */
  remaining: number
}

/**
 * Sums prior redemptions of one voucher, in face minor units.
 *
 * Counts incoming rows only. A merchant issuing the voucher writes an `issued`
 * row and a customer spending it writes `payment`/`sent` — all outgoing, none of
 * them a redemption *to* this device. `toTransaction` is the one place that
 * derives direction (the stored rows disagree with themselves about it), so the
 * sum goes through it rather than reading `direction` off the row.
 */
export async function redeemedTotal(
  voucherId: string,
  { excludeTransactionId }: { excludeTransactionId?: string } = {},
): Promise<number> {
  if (!voucherId) return 0

  const rows = await listTransactions()
  return rows
    .map(toTransaction)
    .filter(
      (tx) =>
        tx.voucherId === voucherId &&
        tx.direction === 'in' &&
        tx.id !== excludeTransactionId,
    )
    .reduce((sum, tx) => sum + (Number.isFinite(tx.amount) ? tx.amount : 0), 0)
}

/**
 * Whether one more redemption fits inside what the issuer signed.
 *
 * Call BEFORE writing the row for this redemption, or pass its id as
 * `excludeTransactionId` — otherwise the redemption being checked is counted
 * against itself and every second presentation of a voucher is refused.
 *
 * `signedFaceValue` must come from the verified voucher, never the DM envelope.
 * A ceiling the sender chose is not a ceiling.
 */
export async function checkRedemption(input: {
  voucherId: string
  requested: number
  signedFaceValue: number
  excludeTransactionId?: string
}): Promise<RedemptionCheck> {
  const { voucherId, requested, signedFaceValue, excludeTransactionId } = input

  const alreadyRedeemed = await redeemedTotal(voucherId, { excludeTransactionId })
  const remaining = Math.max(0, signedFaceValue - alreadyRedeemed)

  return {
    // A voucher with no signed face value (faceValue 0 — legacy derive-only
    // tokens store nothing) has no ceiling to enforce, so this cannot refuse it.
    // Saying so plainly beats inventing a bound and refusing honest coupons.
    allowed: signedFaceValue <= 0 || alreadyRedeemed + requested <= signedFaceValue,
    alreadyRedeemed,
    requested,
    signedFaceValue,
    remaining,
  }
}
