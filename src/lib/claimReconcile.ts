import type { TransactionRow, VoucherRow } from '@imani/wallet-storage'

import { checkIssuer } from './issuerAllowlist'
import { checkMintAndUnit } from './trustedMint'
import { boundedClaim, type MerchantClaim } from './merchantClaim'
import { redeemLockName } from './redemptionLedger'
import { isVoucherIssuance, toTransaction, type WalletTransaction } from './transactions'
import { publishTx } from './txRecords'
import { creditableFaceValue, exactFaceValue, parseVoucherToken, verifyVoucher } from './voucherToken'
import { getWallet, listTransactions, listVouchers, notifyWalletChanged } from './wallet'
import { withWebLock } from './webLock'

/**
 * Re-file redemptions that were written without their claim (#95).
 *
 * Since #90 a coupon coming home to the stall that issued it has its row
 * stamped with the ISSUED voucher's id (`merchantClaim.ts`), so the claimed
 * figure (`issuedVoucher`) and the redemption ceiling (`redemptionLedger`) can
 * see it. Rows written before that fix, or by a path that never went through
 * `legacyBridge.stampCorrelation`, still carry the gateway's random id. For
 * those vouchers outstanding shows the full face and the ceiling cannot see
 * the earlier redemptions.
 *
 * ## Where the voucher id comes from
 *
 * The COUPON the redemption wrote, not the row. A redemption row is keyed
 * `received:<tokenId>` on the token AFTER the mint swap, and the coupon row
 * under that `token_id` holds that token. A swap preserves the signed voucher
 * byte for byte (the same property `attestation.ts` relies on for the
 * nullifier), so parsing it gives the voucher id, issuer, unit and face the
 * issuer signed. A burnt coupon keeps its token on the row (`burn.ts` only
 * flips the status), so a stall's own returned coupons are still readable.
 *
 * The kind-7377 attestations the issue suggested joining against cannot give
 * the id: they carry no voucher id by design (they would name the stall's
 * takings per voucher if they did), and their nullifier hashes the RECEIVED
 * token, which the swap destroyed. A row whose coupon row is gone (spent on,
 * or never restored) is therefore left alone, and says so in the count.
 *
 * ## The gates, the same as a live claim
 *
 *  - The stored voucher's issuer signature verifies, and its key is not
 *    refused by a configured issuer allowlist (`checkIssuer`).
 *  - Its proofs are at a mint this build trusts, in sat (`checkMintAndUnit`).
 *    The signature covers no mint, so without this a genuine signed coupon
 *    backed by some other mint's proofs credits exactly like the real one.
 *  - It names THIS stall as issuer: a claim is a coupon coming home.
 *  - `boundedClaim`: only against a local `issued` row of the same id and
 *    unit, and never for more than that issuance has left. This is the gate
 *    that does the security work, exactly as in `merchantClaim.ts`.
 *
 * Amount: the figure the attestation committed (`attestedValue`) when the row
 * carries one in the voucher's unit, since that is what the stall honoured at
 * the time; otherwise the token's creditable value. Either way `boundedClaim`
 * caps it, so claimed can never exceed issued.
 *
 * ## Concurrency
 *
 * Each voucher's rows are re-read and re-filed under `redeemLockName`, the same
 * Web Lock the till holds from check to write, so a sweep and a live
 * redemption in another tab cannot both file against the same remainder.
 *
 * Idempotent: a re-filed row carries the issued voucher's id, so it is no
 * longer a candidate. The builder's original id is kept as
 * `reconciledFromVoucherId` so the change can be traced.
 */

export interface ReconcileResult {
  /** Rows re-filed against their issuance. */
  filed: number
  /** Candidate rows whose coupon row (and so its token) is not on this device. */
  unreadable: number
}

/**
 * Run the sweep. Never throws; a failure leaves every row as it was.
 *
 * `stallPubkey` is this wallet's own key. A wallet with no `issued` row is a
 * customer, and returns at once without reading a single coupon.
 */
export async function reconcileClaims(stallPubkey: string): Promise<ReconcileResult> {
  const result: ReconcileResult = { filed: 0, unreadable: 0 }
  if (!stallPubkey) return result
  try {
    const raw = await listTransactions()
    // `toTransaction` does not carry the attested figures, so they are read
    // off the stored row by id.
    const rawById = new Map(raw.map((r) => [String((r as { id?: unknown }).id ?? ''), r as unknown as Record<string, unknown>]))
    const rows = raw.map(toTransaction)
    const issuedIds = new Set(rows.filter((tx) => isVoucherIssuance(tx) && tx.voucherId).map((tx) => tx.voucherId))
    if (issuedIds.size === 0) return result

    const candidates = rows
      .filter((tx) => isUnfiled(tx, issuedIds))
      .sort((a, b) => a.at - b.at)
    if (candidates.length === 0) return result

    const coupons = new Map<string, VoucherRow>()
    for (const row of await listVouchers()) if (row.token_id) coupons.set(row.token_id, row)

    // Grouped by the voucher each row turns out to belong to, so each group is
    // filed under that voucher's lock in the order the redemptions happened.
    const byVoucher = new Map<string, { tx: WalletTransaction; claim: MerchantClaim }[]>()
    for (const tx of candidates) {
      const coupon = tx.tokenId ? coupons.get(tx.tokenId) : undefined
      if (!coupon?.token) {
        result.unreadable += 1
        continue
      }
      const stored = rawById.get(tx.id) ?? {}
      const claim = candidateClaim(
        {
          amount: tx.amount,
          attestedValue: typeof stored.attestedValue === 'number' ? stored.attestedValue : undefined,
          attestedUnit: typeof stored.attestedUnit === 'string' ? stored.attestedUnit : undefined,
        },
        coupon.token,
        stallPubkey,
      )
      if (!claim || !issuedIds.has(claim.voucherId)) continue
      const group = byVoucher.get(claim.voucherId) ?? []
      group.push({ tx, claim })
      byVoucher.set(claim.voucherId, group)
    }

    for (const [voucherId, group] of byVoucher) {
      result.filed += await withWebLock(redeemLockName(voucherId), () => fileGroup(group))
    }
    if (result.filed > 0) notifyWalletChanged()
  } catch (error) {
    console.error('[claimReconcile] sweep failed; rows left as they were', error)
  }
  return result
}

/**
 * An incoming redemption row not yet filed against any issuance. Only
 * `received`: `toTransaction` reads a `payment` row as outgoing, so it could
 * never be a claim.
 */
function isUnfiled(tx: WalletTransaction, issuedIds: Set<string | undefined>): boolean {
  if (tx.type !== 'received' || tx.direction !== 'in' || !tx.tokenId) return false
  return !tx.voucherId || !issuedIds.has(tx.voucherId)
}

/**
 * The claim the stored token supports, before the issuance bound. Undefined
 * when the token is not a verified voucher of this stall's.
 *
 * Exported for its test.
 */
export function candidateClaim(
  tx: Pick<WalletTransaction, 'amount'> & { attestedValue?: number; attestedUnit?: string },
  token: string,
  stallPubkey: string,
): MerchantClaim | undefined {
  let parsed: ReturnType<typeof parseVoucherToken>
  try {
    parsed = parseVoucherToken(token)
  } catch {
    return undefined
  }
  const v = parsed.voucher
  if (!verifyVoucher(v).signatureValid) return undefined
  if (checkIssuer(parsed) === 'unknown-issuer') return undefined
  // The issuer signature covers the voucher's terms and no mint at all, so a
  // copy backed by another mint's proofs verifies just as well as the real
  // coupon. Only a positively trusted mint is claimed. Every other verdict,
  // `not-ready` and `no-trusted-mint` included (#133 review), is skipped. Safe
  // because this is a SWEEP: a row skipped now is a candidate again on the next
  // pass, so the only cost is a later reconciliation rather than a lost claim.
  if (checkMintAndUnit(parsed) !== 'trusted') return undefined
  if (!v.issuerId || v.issuerId.toLowerCase() !== stallPubkey.toLowerCase()) return undefined
  if (!v.voucherId || !v.unit) return undefined

  const unit = v.unit.trim().toUpperCase()
  const attested =
    typeof tx.attestedValue === 'number' &&
    Number.isFinite(tx.attestedValue) &&
    tx.attestedValue >= 0 &&
    (tx.attestedUnit ?? '').trim().toUpperCase() === unit
      ? tx.attestedValue
      : undefined
  const amount = attested ?? creditableFaceValue(parsed).faceValue
  const exact = exactFaceValue(parsed)
  if (!Number.isFinite(amount) || amount < 0) return undefined
  if (amount === 0 && !(exact > 0)) return undefined

  return {
    voucherId: v.voucherId,
    amount,
    unit,
    ...(exact > 0 ? { exact } : {}),
  }
}

/**
 * File one voucher's rows in order, each bounded by what the issuance has left
 * after the ones before it. Re-reads under the lock, so a redemption the till
 * wrote since the sweep started is counted.
 */
async function fileGroup(group: { tx: WalletTransaction; claim: MerchantClaim }[]): Promise<number> {
  let filed = 0
  for (const { tx, claim } of group) {
    const rows = (await listTransactions()).map(toTransaction)
    const current = rows.find((r) => r.id === tx.id)
    // Already filed by something else (another tab's sweep) since we looked.
    if (!current || current.voucherId === claim.voucherId) continue
    const bounded = boundedClaim(claim, rows)
    if (!bounded) continue

    const patch: Record<string, unknown> = {
      voucherId: bounded.voucherId,
      amount: bounded.amount,
      unit: bounded.unit,
      ...(bounded.decimals === undefined ? {} : { decimals: bounded.decimals }),
      ...(bounded.exact === undefined ? {} : { exactValue: bounded.exact }),
      reconciledFromVoucherId: current.voucherId ?? null,
    }
    const merged = await getWallet().updateTransaction(tx.id, patch as Partial<TransactionRow>)
    // `updateTransaction` bypasses the backup hook, and `backfillTx` only
    // publishes ids the relay has never seen, so the corrected row is pushed
    // here or a restore would bring the random id back.
    if (merged) {
      void publishTx(merged)
      filed += 1
    }
  }
  return filed
}
