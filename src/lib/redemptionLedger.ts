import {
  checkCeiling,
  checkPart as checkPartCeiling,
  type PriorRedemption,
  type RedemptionCheck,
} from '@imani/redemption'

import { listTransactions, listVouchers } from './wallet'
import { toTransaction, type WalletTransaction } from './transactions'
import { parseVoucherToken } from './voucherToken'

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
 * The Web Lock every read-check-write against one voucher's rows is taken
 * under, across every tab of this origin (#97).
 *
 * The ceiling is a read of local rows followed, later, by the write of a new
 * one, so two tabs that both check before either writes each see the same
 * priors and can take the same remaining value twice. `dmPoll`'s redemption
 * adapter holds this lock from the check through the mint swap to the row
 * write, and `claimReconcile` holds it while it re-files a row, so the two
 * cannot interleave on one voucher either.
 *
 * One definition, because two spellings of a lock name are two locks, and two
 * locks serialise nothing.
 *
 * Per DEVICE only. It says nothing about a second till on another device; see
 * ADR 0015 for why that is accepted and where the bound comes from instead.
 */
export function redeemLockName(voucherId: string): string {
  return `imani-redeem:${voucherId}`
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
 * What to book for one part worth `exact` (unrounded), and whether it fits.
 *
 * `checkPart` in `@imani/redemption` over this voucher's local rows, the same
 * rule wallet-api applies to caller-supplied rows.
 */
export async function checkPart(input: {
  voucherId: string
  exact: number
  signedFaceValue: number
}): Promise<{ credit: number; check: RedemptionCheck }> {
  return checkPartCeiling({
    signedFaceValue: input.signedFaceValue,
    exact: input.exact,
    priorRedemptions: await priorRedemptionsOf(input.voucherId),
  })
}

/**
 * The rows for one voucher, in the shape the ceiling takes.
 *
 * Direction comes through `toTransaction` rather than off the row, because the
 * stored rows disagree with themselves about it — a merchant's own `issued`
 * row would otherwise read as incoming and consume the whole ceiling.
 *
 * **Repairs what a race wrote (#145).** Before the bridge keyed its stamps per
 * redeem, two coupons redeemed at once could swap stamps: one coupon's row was
 * filed under the other's voucher with the other's claim, and the other's own
 * row was re-filed from its token later. That voucher then carried two rows
 * for one redemption, and its next honest part was refused. Those rows are
 * still on tills, so the ceiling reads past them:
 *
 *  - an incoming row whose own coupon (the swapped token, which keeps the
 *    signed voucher) names a DIFFERENT voucher is not a redemption of this
 *    one, and is dropped;
 *  - rows sharing a nullifier or a transfer id are one redemption (both hash
 *    the received token), and count once, at the larger amount.
 *
 * Neither can loosen the bound an attacker faces. Two genuine redemptions have
 * two received tokens, so two nullifiers and two transfer ids, and each row's
 * coupon names its own voucher. A row whose coupon is not on this device, or
 * does not parse, is kept as it stands: unknown is counted, never waved through.
 */
async function priorRedemptionsOf(
  voucherId: string,
  { excludeTransactionId }: { excludeTransactionId?: string } = {},
): Promise<PriorRedemption[]> {
  if (!voucherId) return []

  const rows = (await listTransactions())
    .map(toTransaction)
    .filter((tx) => tx.voucherId === voucherId && tx.id !== excludeTransactionId)
  const couponVoucher = await couponVouchersOf(rows)
  const genuine = rows.filter((tx) => {
    if (tx.direction !== 'in' || !tx.tokenId) return true
    const named = couponVoucher.get(tx.tokenId)
    return named === undefined || named === voucherId
  })

  return onePerRedemption(genuine).map((tx) => ({
    amount: tx.amount,
    direction: tx.direction === 'in' ? 'in' : 'out',
    ...(tx.exactValue === undefined ? {} : { exact: tx.exactValue }),
  }))
}

/**
 * The voucher each row's own coupon was signed for, by token id. Rows whose
 * coupon is missing or unreadable are absent from the map.
 */
async function couponVouchersOf(rows: readonly WalletTransaction[]): Promise<Map<string, string>> {
  const wanted = new Set(rows.map((tx) => tx.tokenId).filter((id): id is string => !!id))
  const named = new Map<string, string>()
  if (wanted.size === 0) return named
  let coupons: Awaited<ReturnType<typeof listVouchers>>
  try {
    coupons = await listVouchers()
  } catch {
    // No coupons to read means nothing is dropped, which is the strict side.
    return named
  }
  for (const coupon of coupons) {
    if (!coupon.token_id || !wanted.has(coupon.token_id) || !coupon.token) continue
    try {
      const id = parseVoucherToken(coupon.token).voucher.voucherId
      if (id) named.set(coupon.token_id, id)
    } catch {
      // Not a voucher token: keep the row as it stands.
    }
  }
  return named
}

/**
 * One row per redemption. Incoming rows carrying the same nullifier or transfer
 * id are the same received token, so only the largest is kept. Everything else
 * passes through.
 */
function onePerRedemption(rows: readonly WalletTransaction[]): WalletTransaction[] {
  const kept: WalletTransaction[] = []
  const byKey = new Map<string, number>()
  for (const tx of rows) {
    const keys = tx.direction === 'in' ? redemptionKeys(tx) : []
    const seen = keys.map((k) => byKey.get(k)).find((i) => i !== undefined)
    if (seen === undefined) {
      keys.forEach((k) => byKey.set(k, kept.length))
      kept.push(tx)
      continue
    }
    if (tx.amount > kept[seen].amount) kept[seen] = tx
    keys.forEach((k) => byKey.set(k, seen))
  }
  return kept
}

function redemptionKeys(tx: WalletTransaction): string[] {
  return [
    tx.attestationNullifier ? `n:${tx.attestationNullifier}` : undefined,
    tx.transferId ? `t:${tx.transferId}` : undefined,
  ].filter((k): k is string => k !== undefined)
}
