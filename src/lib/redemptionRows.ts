import { currencyDecimals } from './format'
import { isVoucherIssuance, type WalletTransaction } from './transactions'
import { creditableFaceValue, exactFaceValue, parseVoucherToken } from './voucherToken'

/**
 * A stall's incoming rows as the redemptions they really were (#145).
 *
 * The one reader both money figures go through: the redemption ceiling
 * (`redemptionLedger`) and the claimed figure (`merchantClaim.boundedClaim`,
 * `issuedVoucher`). Two readers that repaired differently would let a till
 * honour a part its own claimed figure says was never taken.
 *
 * **What it repairs.** Before the bridge stamped each redeem by name, two
 * coupons redeemed at once could swap stamps: coupon B's row was filed under
 * voucher A with A's claim, amount, exact value and nullifier. A then carried
 * two rows for one redemption and refused its honest last part, while B
 * carried none and would have taken its full face a second time.
 *
 * So a row is filed under the voucher its OWN coupon names. The coupon row is
 * the swapped token, and a swap keeps the signed voucher byte for byte, so
 * this is the issuer's word and not a stamp. When that disagrees with the
 * stamp, nothing the stamp carried is trusted: the row is valued from the
 * coupon, and its nullifier and transfer id (which belonged to the other
 * redeem) are dropped so they cannot merge it with a row it has nothing to do
 * with.
 *
 * **Only a stall's own issuances are touched.** A row is re-filed only when
 * its coupon or its stamp names a voucher this device issued, which is the
 * only case the stamp was ever a claim. A customer's rows carry the gateway's
 * random id and are left alone: re-filing them would make a customer who
 * received a coupon, passed it on and got it back refuse it, since the ceiling
 * counts incoming rows only.
 *
 * **One redemption, one row.** Rows of one voucher that carry the same token
 * are one received token. A token cannot be redeemed twice: the mint refuses a
 * second swap of the same proofs and dm-poll drops a token whose fingerprint it
 * has marked received. So a second row is a bookkeeping copy and counts once,
 * as the larger of the two, the strict side. A shared nullifier or transfer id
 * also folds a copy whose coupon is not on this device into the row it copies,
 * but never merges two rows whose own coupons are different tokens: a stamp
 * can be another redeem's, and the coupon is the issuer's word.
 *
 * **Why the ceiling stays a ceiling.** Every row whose coupon is readable
 * counts in full against the voucher that coupon was signed for, whatever it
 * was stamped. Two genuine redemptions are two different received tokens, so
 * nothing merges them. A row whose coupon is missing or unreadable keeps its
 * stamp and counts there, never nowhere. So splitting genuine proofs is still
 * capped at their genuine total, voucher by voucher.
 */
export function repairRedemptionRows(
  rows: readonly WalletTransaction[],
  couponTokens: ReadonlyMap<string, string>,
): WalletTransaction[] {
  const issued = new Set(rows.filter((tx) => isVoucherIssuance(tx) && tx.voucherId).map((tx) => tx.voucherId))
  const refiled = rows.map((tx) => refile(tx, couponTokens.get(tx.tokenId ?? ''), issued))
  return onePerRedemption(refiled)
}

/** One incoming row, filed under the voucher its coupon names. */
function refile(
  tx: WalletTransaction,
  token: string | undefined,
  issued: ReadonlySet<string | undefined>,
): WalletTransaction & { tokenKey?: string } {
  if (tx.direction !== 'in' || !token) return tx
  let parsed: ReturnType<typeof parseVoucherToken>
  try {
    parsed = parseVoucherToken(token)
  } catch {
    return tx
  }
  const named = parsed.voucher.voucherId
  const tokenKey = `k:${token}`
  if (!named || named === tx.voucherId) return { ...tx, tokenKey }
  if (!issued.has(named) && !issued.has(tx.voucherId)) return tx

  const unit = parsed.voucher.unit.trim().toUpperCase()
  return {
    ...tx,
    voucherId: named,
    amount: creditableFaceValue(parsed).faceValue,
    exactValue: exactFaceValue(parsed),
    unit,
    decimals: currencyDecimals(unit),
    attestationNullifier: undefined,
    transferId: undefined,
    tokenKey,
  }
}

/** The larger of two copies of one redemption: the side that leaves less to take. */
function stricter(a: WalletTransaction, b: WalletTransaction): WalletTransaction {
  return (b.exactValue ?? b.amount) > (a.exactValue ?? a.amount) ? b : a
}

function onePerRedemption(rows: ReadonlyArray<WalletTransaction & { tokenKey?: string }>): WalletTransaction[] {
  const kept: { tx: WalletTransaction; tokenKey?: string }[] = []
  const byKey = new Map<string, number>()
  for (const { tokenKey, ...tx } of rows) {
    const keys = tx.direction === 'in' ? redemptionKeys(tx, tokenKey) : []
    const seen = keys.map((k) => byKey.get(k)).find((i) => i !== undefined)
    // Two rows whose own coupons are different tokens are two redemptions,
    // whatever their stamps share: a stamp may be another redeem's.
    const distinctCoupons = seen !== undefined && !!tokenKey && !!kept[seen].tokenKey && kept[seen].tokenKey !== tokenKey
    if (seen === undefined || distinctCoupons) {
      keys.forEach((k) => {
        if (!byKey.has(k)) byKey.set(k, kept.length)
      })
      kept.push({ tx, tokenKey })
      continue
    }
    kept[seen] = { tx: stricter(kept[seen].tx, tx), tokenKey: kept[seen].tokenKey ?? tokenKey }
    keys.forEach((k) => byKey.set(k, seen))
  }
  return kept.map((k) => k.tx)
}

/** Keys that mean "the same received token", scoped to one voucher. */
function redemptionKeys(tx: WalletTransaction, tokenKey: string | undefined): string[] {
  const scope = tx.voucherId ?? ''
  return [
    tx.attestationNullifier ? `n:${tx.attestationNullifier}` : undefined,
    tx.transferId ? `t:${tx.transferId}` : undefined,
    tokenKey,
  ]
    .filter((k): k is string => k !== undefined)
    .map((k) => `${scope}|${k}`)
}
