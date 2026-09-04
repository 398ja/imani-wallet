import { checkCeiling, type PriorRedemption, type RedemptionCheck } from '@imani/redemption'

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

/**
 * Re-exported rather than redeclared.
 *
 * The shape now lives in `@imani/redemption`, so the till and the wallet API
 * cannot drift into two different answers about the same voucher.
 */
export type { RedemptionCheck } from '@imani/redemption'

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

  // Reads the rows, then hands the ARITHMETIC to the shared package. This
  // module keeps the part that is genuinely local — which rows count, and how
  // direction is derived — and owns no bound of its own, so a till and the
  // wallet API cannot enforce different ceilings on the same voucher.
  return checkCeiling({
    signedFaceValue,
    requested,
    priorRedemptions: await priorRedemptionsOf(voucherId, { excludeTransactionId }),
  })
}

/**
 * The rows for one voucher, in the shape the ceiling takes.
 *
 * Direction comes through `toTransaction` rather than off the row, because the
 * stored rows disagree with themselves about it — a merchant's own `issued`
 * row would otherwise read as incoming and consume the whole ceiling.
 */
async function priorRedemptionsOf(
  voucherId: string,
  { excludeTransactionId }: { excludeTransactionId?: string } = {},
): Promise<PriorRedemption[]> {
  if (!voucherId) return []

  const rows = await listTransactions()
  return rows
    .map(toTransaction)
    .filter((tx) => tx.voucherId === voucherId && tx.id !== excludeTransactionId)
    .map((tx) => ({ amount: tx.amount, direction: tx.direction === 'in' ? 'in' : 'out' }))
}
