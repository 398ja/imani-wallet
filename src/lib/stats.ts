import type { WalletTransaction } from './transactions'

/**
 * The merchant's numbers, computed from this wallet's own rows.
 *
 * NOT from `GET /api/v1/portal/dashboard/composite`, which is what
 * possa-merchant's dashboard reads. That endpoint exists here and answers 200,
 * but it answers with zeros: it is fed by `PortalDashboardService.allMerchantVouchers`,
 * which merges kind-30078 payment-request events and the `cashback_record`
 * table and deliberately does not consult customer-wallet (§15.9). Coupons from
 * the Sell flow are in neither, so a merchant who has issued three coupons gets
 * `vouchers_issued: 0` back. Rendering that would be a dashboard of lies.
 *
 * The issuance rows in this wallet are the only record of those coupons, so they
 * are the only honest source for these figures. The shapes match possa's
 * dashboard — five tiles, a status snapshot, a daily activity series — because
 * those are the right shapes; only the source differs.
 */

/** What a merchant's own records can say. */
export interface MerchantStats {
  issuedCount: number
  issuedValue: number
  /** Coupons THIS merchant issued that have come back as payment. */
  redeemedCount: number
  redeemedValue: number
  /**
   * redeemedValue / issuedValue, 0 when nothing has been issued.
   *
   * Value, not count: a coupon can come back part-spent, and a merchant asking
   * "how much of what I put out has been claimed" is asking about money. Ten
   * 5-euro coupons and one 500-euro coupon are not the same exposure, and a
   * count would rate them the same.
   *
   * Can exceed 1 at the edge of a window, when a coupon issued before `from`
   * comes back inside it — same reason `active` needs its floor.
   */
  redemptionRate: number
  /** Issued, not expired, not yet seen coming back. */
  active: number
  expired: number
  unit: string
  decimals: number
  /** Oldest first, one entry per day in range, zero-filled. */
  activity: Array<{ day: number; issued: number; redeemed: number }>
  /** Records left out because they are in another currency — never silently dropped. */
  otherCurrencyCount: number
}

const DAY_MS = 86_400_000

/** Midnight UTC for the day a timestamp falls in, so buckets line up. */
function dayOf(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS
}

/**
 * Is this incoming row one of THIS merchant's coupons coming home?
 *
 * The discriminator matters, because a merchant is also a customer: coupons they
 * received from some other merchant arrive as ordinary incoming rows too, and
 * counting those as redemptions would inflate the rate with money that has
 * nothing to do with their own issuance.
 *
 * `merchantId` is the issuer — `toTransaction` fills it from `issuer_id` — so an
 * incoming row issued by us is a coupon we put out and have now taken back.
 */
function isOwnRedemption(tx: WalletTransaction, pubkey: string): boolean {
  return tx.direction === 'in' && tx.merchantId?.toLowerCase() === pubkey.toLowerCase()
}

export function merchantStats(
  transactions: WalletTransaction[],
  {
    pubkey,
    unit,
    decimals,
    from,
    now,
  }: { pubkey: string; unit: string; decimals: number; from: number; now: number },
): MerchantStats {
  // One currency only. Adding XAF to EUR would be a confident lie, the same
  // reason `walletTotals` reports per-unit rather than summing; the count of
  // what was left out is carried out so the screen can say so.
  const inRange = transactions.filter((tx) => tx.at >= from && tx.at <= now)
  const relevant = inRange.filter(
    (tx) => tx.type === 'issued' || isOwnRedemption(tx, pubkey),
  )
  const matching = relevant.filter((tx) => tx.unit === unit)

  const issued = matching.filter((tx) => tx.type === 'issued')
  const redeemed = matching.filter((tx) => isOwnRedemption(tx, pubkey))

  const sum = (rows: WalletTransaction[]) => rows.reduce((total, tx) => total + tx.amount, 0)
  const issuedValue = sum(issued)
  const redeemedValue = sum(redeemed)

  // Status counts run over ALL issued coupons, not just the range: "how many of
  // mine are still out there" is not a question about a date window.
  const allIssued = transactions.filter((tx) => tx.type === 'issued' && tx.unit === unit)
  const expired = allIssued.filter(
    (tx) => tx.expiresAt !== undefined && tx.expiresAt <= now,
  ).length

  // Inclusive of BOTH ends. Counting `ceil((now - from) / DAY)` buckets forward
  // from the first day stops one short: today's rows then land past the last
  // bucket and vanish from the chart, which is how a busy afternoon can render
  // as an empty series. Callers pass `from = now - (days - 1) * DAY` to get
  // exactly `days` columns.
  const buckets = new Map<number, { day: number; issued: number; redeemed: number }>()
  for (let day = dayOf(from); day <= dayOf(now); day += DAY_MS) {
    buckets.set(day, { day, issued: 0, redeemed: 0 })
  }
  for (const tx of matching) {
    const bucket = buckets.get(dayOf(tx.at))
    // A row can fall outside the zero-filled span by a rounding edge; skip it
    // rather than growing the axis by one lopsided day.
    if (!bucket) continue
    if (tx.type === 'issued') bucket.issued += 1
    else bucket.redeemed += 1
  }

  return {
    issuedCount: issued.length,
    issuedValue,
    redeemedCount: redeemed.length,
    redeemedValue,
    redemptionRate: issuedValue === 0 ? 0 : redeemedValue / issuedValue,
    // Never negative: redemptions in range can outnumber issues in range when a
    // coupon issued before the window comes back inside it.
    active: Math.max(0, allIssued.length - expired),
    expired,
    unit,
    decimals,
    activity: [...buckets.values()].sort((a, b) => a.day - b.day),
    otherCurrencyCount: relevant.length - matching.length,
  }
}

/**
 * Issued coupons running out soon, soonest first.
 *
 * A merchant's actionable list: these are customers who still hold value that is
 * about to stop being worth anything, and the window matches the
 * `expires_within_days=7` filter possa-merchant's ExpiringPanel uses.
 *
 * Already-expired coupons are excluded. Nothing can be done about them, and
 * mixing them in would bury the ones that can still be spent.
 */
export function expiringSoon(
  transactions: WalletTransaction[],
  { now, withinDays = 7 }: { now: number; withinDays?: number },
): WalletTransaction[] {
  const deadline = now + withinDays * DAY_MS
  return transactions
    .filter(
      (tx) =>
        tx.type === 'issued' &&
        tx.expiresAt !== undefined &&
        tx.expiresAt > now &&
        tx.expiresAt <= deadline,
    )
    .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
}
