import { VoucherGrouper } from '@imani/voucher-send'
import type { Voucher, MerchantGroup } from '@imani/voucher-send'
import type { VoucherRow } from '@imani/wallet-storage'

import { toEpochMs } from './format'
import { isLicence } from './licences'
import type { WalletTransaction } from './transactions'

/**
 * A merchant, as the wallet's home screen thinks of one: an issuer pubkey plus
 * everything we hold from them.
 *
 * This is NOT the same shape as VoucherGrouper's MerchantGroup. That groups on
 * `merchantId-unit-issuanceRatio`, so a single merchant selling in two currencies
 * — or who changed their issuance ratio between market days — produces several
 * groups. Correct for send-side selection (you can't merge coupons across units
 * or ratios), wrong for a merchant list, which wants one row per person.
 */
export interface Merchant {
  /** Issuer pubkey, normalised. The merchant's identity. */
  pubkey: string
  /** Display name from voucher metadata; callers may override via profile lookup. */
  name: string
  /** One entry per (unit, ratio) combination held from this merchant. */
  groups: MerchantGroup[]
  /** Total coupons held, across all groups. */
  voucherCount: number
}

/**
 * Bridge wallet-storage's VoucherRow to voucher-send's Voucher.
 *
 * The two shapes agree on nearly everything, but `expires_at` does not:
 * VoucherRow is TYPED as Unix epoch seconds, Voucher expects an ISO-8601
 * string, and VoucherGrouper's expiry filter calls `new Date(expires_at)`.
 * Passing the raw epoch number through would make `new Date(1788…)` — a date in
 * 1970 — so every live coupon would read as expired and the merchant list would
 * render empty.
 *
 * The stored value is not reliably a number either: `_persistRedeemed` writes
 * the ISO string `/inspect` returned. `toEpochMs` reads both, which is why the
 * conversion goes through it rather than a bare `* 1000` — that multiplication
 * on an ISO string is NaN, and `new Date(NaN).toISOString()` THROWS.
 *
 * "No expiry" must cover null and 0, not just undefined. The gateway populates
 * expires_at ASYNCHRONOUSLY: for roughly 5–10 seconds after a voucher already
 * reports status=ISSUED / payment_state=CONFIRMED, the field is still JSON
 * null. A freshly received coupon therefore lands in the wallet with a null
 * expiry, and `null === undefined` is false — so a guard that only checks
 * undefined falls through to new Date(0), the coupon reads as expired, and the
 * merchant silently disappears from the list until the next sync. Verified
 * against the live gateway.
 */
export function toVoucher(row: VoucherRow): Voucher {
  const expiresMs = toEpochMs(row.expires_at)
  return {
    voucher_id: row.voucher_id ?? row.token_id,
    token: row.token,
    face_value: row.face_value ?? row.amount,
    face_unit: row.face_unit ?? 'SAT',
    face_decimals: row.face_decimals ?? 0,
    token_amount: row.token_amount ?? row.amount,
    backing_strategy: row.backing_strategy,
    // Part of VoucherGrouper's group key (`merchantId-unit-issuanceRatio`), and
    // it reads `voucher.issuance_ratio || 1`. Omitting it collapsed every
    // coupon onto ratio 1, so coupons backed at genuinely different ratios
    // merged into one group — and the screens format a merchant's total with
    // `groups[0]`. Derived when the row predates issuance_ratio being stored.
    issuance_ratio: issuanceRatioOf(row),
    issuer_id: row.issuer_id,
    status: row.status,
    expires_at: expiresMs === undefined ? undefined : new Date(expiresMs).toISOString(),
    created_at: row.created_at,
  } as Voucher
}

/**
 * A coupon's issuance ratio: face MINOR UNITS PER SAT.
 *
 * Stored value first, else computed — same arithmetic as imani-apps'
 * `calculateIssuanceRatio` (face_value / token_amount) and as the vanilla app's
 * group builder, which back-computes `totalFaceValue / totalTokenAmount`.
 *
 * The fallback is not just for old rows: the ratio is a property of the coupon
 * itself, so anything displaying or grouping by it should get the same answer
 * whether or not the field happened to be persisted. Rows written before this
 * was stored read back as an explicit `null` (WalletStorage normalises absent
 * optionals), which `??` catches.
 */
export function issuanceRatioOf(row: VoucherRow): number | undefined {
  const stored = row.issuance_ratio
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored

  const face = row.face_value
  const sats = row.token_amount
  if (typeof face !== 'number' || typeof sats !== 'number' || sats <= 0) return undefined
  return face / sats
}

/**
 * Group stored coupons into merchants, one entry per issuer pubkey.
 *
 * Sorted by total face value descending — the merchant you hold the most with
 * leads the list.
 */
export function toMerchants(rows: VoucherRow[]): Merchant[] {
  const grouper = new VoucherGrouper()
  const groups = grouper.groupToArray(spendable(rows).map(toVoucher))

  const byPubkey = new Map<string, Merchant>()
  for (const group of groups) {
    const existing = byPubkey.get(group.merchantId)
    if (existing) {
      existing.groups.push(group)
      existing.voucherCount += group.voucherCount
      // Keep the first non-placeholder name we see.
      if (existing.name === existing.pubkey && group.merchantName) {
        existing.name = group.merchantName
      }
    } else {
      byPubkey.set(group.merchantId, {
        pubkey: group.merchantId,
        name: group.merchantName || group.merchantId,
        groups: [group],
        voucherCount: group.voucherCount,
      })
    }
  }

  return [...byPubkey.values()].sort(
    (a, b) => totalFaceValue(b) - totalFaceValue(a),
  )
}

/**
 * Sum of face value across a merchant's groups.
 *
 * ponytail: naive sum across units — a merchant selling in both EUR and SAT gets
 * a meaningless total. Fine while the pilot is single-currency per merchant; if
 * that stops being true, render per-unit subtotals instead of one number.
 */
export function totalFaceValue(merchant: Merchant): number {
  return merchant.groups.reduce((sum, g) => sum + g.totalFaceValue, 0)
}

/**
 * The merchant list, plus everyone you have a history with but hold nothing from.
 *
 * Every customer screen is rooted in `listVouchers()` — the home list, and
 * therefore the only route to `/merchants/:pubkey` and to the transactions on it.
 * So a merchant whose coupons are all spent disappeared completely, taking the
 * record of what was spent with them; and a device restored from the relay
 * before coupon backup existed showed "No coupons yet" over a full history.
 * Past merchants come back with an empty `groups`, which every consumer already
 * tolerates — `toMerchantPass` reads `groups[0]?.unit`, and `totalFaceValue`
 * sums to 0.
 */
export function withPastMerchants(merchants: Merchant[], transactions: WalletTransaction[]): Merchant[] {
  const held = new Set(merchants.map((f) => f.pubkey))
  const past = new Map<string, Merchant>()

  for (const tx of transactions) {
    // `counterparty` on a 'sent' row is the PERSON the voucher went to, not its
    // issuer — falling back to it would put a friend on the home deck as a
    // merchant, with a merchant page and a coupon list belonging to nobody.
    // `buildSentTransaction` always writes `merchantId`; this guard is what
    // makes a row that somehow lacks one drop out instead of inventing one.
    const key = issuerKey(tx.type === 'sent' ? tx.merchantId : tx.merchantId ?? tx.counterparty)
    // 'unknown' is the grouper's bucket for a coupon with no issuer. A merchant
    // page for it would be a page about several different people.
    if (key === 'unknown' || held.has(key)) continue

    const existing = past.get(key)
    if (!existing) {
      past.set(key, { pubkey: key, name: tx.merchantName || key, groups: [], voucherCount: 0 })
    } else if (existing.name === key && tx.merchantName) {
      // Rows are not ordered, and only some carry a name. Take the first real one.
      existing.name = tx.merchantName
    }
  }

  return [...merchants, ...past.values()]
}

/** `findMerchant`, but a merchant known only from history still resolves. */
export function findMerchantWithHistory(
  rows: VoucherRow[],
  transactions: WalletTransaction[],
  pubkey: string,
): Merchant | undefined {
  const target = issuerKey(pubkey)
  return withPastMerchants(toMerchants(rows), transactions).find((f) => f.pubkey === target)
}

/**
 * The single merchant matching a pubkey, or undefined.
 *
 * Through `issuerKey`, not a bare `toLowerCase()`: `Merchant.pubkey` comes from
 * the grouper, so the lookup has to normalise the same way — an `npub1…` route
 * param or the `unknown` bucket would otherwise never match.
 */
export function findMerchant(rows: VoucherRow[], pubkey: string): Merchant | undefined {
  const target = issuerKey(pubkey)
  return toMerchants(rows).find((f) => f.pubkey === target)
}

/**
 * Is this coupon still live?
 *
 * Mirrors VoucherGrouper's expiry filter, which is why `toMerchants` and
 * `couponsFor` agree on what a merchant holds. Absent, null and 0 all mean "no
 * expiry" — see toVoucher's note on the gateway populating expires_at
 * asynchronously.
 */
function isLive(row: VoucherRow): boolean {
  const ms = toEpochMs(row.expires_at)
  return ms === undefined || ms > Date.now()
}

/**
 * Has this coupon been redeemed and burnt? Reads the row's own status, the
 * same value `pass.ts`'s `isVoided` keys on.
 */
export function isRedeemed(row: Pick<VoucherRow, 'status'>): boolean {
  return (row.status ?? '').toLowerCase() === 'redeemed'
}

/**
 * Has this coupon been spent, under either word for it?
 *
 * `'redeemed'` is what a merchant's burn writes; `'spent'` is
 * `@imani/voucher-send`'s own vocabulary for the same fact, and
 * `wallet-core`'s `isSpendable` has treated the two as equivalent since the
 * money logic was extracted. This file did not: `spendable` checked
 * `isRedeemed` alone, so a row marked `'spent'` was money here and not money
 * to the shared planner.
 *
 * That mattered on the send path rather than in a count. `couponsFor` feeds
 * `spendableFrom`, so a spent row was offered to the gateway, which refuses it
 * with SOURCE_PROOFS_NOT_UNSPENT — and on this stack a send that fails after
 * the split cannot be reclaimed, so the coupon is stuck rather than merely
 * rejected. A row acquires that status when another device spends it and the
 * relay's own record is read back, which is exactly the two-device case.
 *
 * `planParity.test.ts` exists to catch this class of drift and did not, because
 * every fixture in it used `'redeemed'`. Both words are now exercised there.
 */
export function isSpent(row: Pick<VoucherRow, 'status'>): boolean {
  const status = (row.status ?? '').toLowerCase()
  return status === 'redeemed' || status === 'spent'
}

/**
 * The rows that are still MONEY.
 *
 * A redeemed coupon's proofs are burnt (burn.ts), so counting one would put
 * value on the home screen that exists nowhere any more, and offering it to pay
 * with would produce a spend the mint refuses. Both `toMerchants` and
 * `couponsFor` drop them, which is what keeps a shop card's count and its
 * coupon list agreeing; the receipts come back separately through
 * `redeemedFor`.
 *
 * A LICENCE is dropped for a different reason and by the same filter. It is a
 * voucher with a real face value (ADR 0007 makes the price paid the face value
 * so the credential is its own receipt), so nothing about it fails `isSpent` —
 * it would be offered for spending and summed into a takings figure, telling a
 * merchant something false about their business. This is the only place worth
 * putting that: `toMerchants` and `couponsFor` are the two roots every balance,
 * count and send-side selection grows from, so excluding it here excludes it
 * everywhere at once rather than in each screen that remembered.
 */
export function spendable(rows: VoucherRow[]): VoucherRow[] {
  return rows.filter((row) => !isSpent(row) && !isLicence(row))
}

/**
 * The issuer id the way `VoucherGrouper` derives it, so this file agrees with
 * the grouping it builds `Merchant`s from.
 *
 * A mirror of the grouper's private `normalizeIssuerId` plus `getMerchantId`'s
 * `issuer_id || 'unknown'` — neither is exported from `@imani/voucher-send`, so
 * there is nothing to reuse. The parity test over `toMerchants` and `couponsFor`
 * is what catches this drifting.
 *
 * The `'unknown'` case is the whole reason it exists. `couponsFor` used to match
 * `row.issuer_id?.toLowerCase()`, which is `undefined` for a row with no issuer,
 * while the grouper maps that same row to a merchant called `unknown`. So a coupon
 * that arrived without an issuer — a legacy human-readable DM, which
 * `parseTextMessage` gives no issuerId — showed up on the merchant list with a
 * balance and a count, and then that merchant's own page reported 0 coupons and an
 * empty list. Real money, unreachable.
 */
export function issuerKey(issuerId: string | undefined | null): string {
  const id = issuerId || 'unknown'
  // npub stays as-is: the grouper says it would decode to hex but does not.
  if (id.startsWith('npub1')) return id
  return /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : id
}

/**
 * A merchant's coupons as STORED ROWS, newest first.
 *
 * Deliberately not `merchant.groups[].vouchers`. Those are voucher-send Vouchers
 * produced by `toVoucher`, which drops `token_id` and maps
 * `voucher_id: row.voucher_id ?? row.token_id`. `voucher_id` is a merchant
 * TEMPLATE id — two coupons issued from the same template share it — so it can
 * neither key a React list nor address a detail route. `token_id` is the store's
 * primary key and is content-derived, so it is unique per coupon.
 *
 * The count here must match `findMerchant(...).voucherCount`, which comes from
 * VoucherGrouper; `isLive` exists to keep those two in step, and a test pins it.
 */
export function couponsFor(rows: VoucherRow[], pubkey: string): VoucherRow[] {
  return byIssuer(spendable(rows).filter(isLive), pubkey)
}

/**
 * A merchant's REDEEMED coupons as stored rows, newest first.
 *
 * The receipts: burnt at the mint, worth nothing, kept so the merchant can see
 * which of their coupons came back. Separate from `couponsFor` rather than
 * mixed into it because the shop card's count is the money count — a list that
 * mixed the two would show more coupons than the card above it claims.
 *
 * No expiry filter. A coupon redeemed before it lapsed is still a sale that
 * happened, and dropping the record on its expiry date would erase it.
 */
export function redeemedFor(rows: VoucherRow[], pubkey: string): VoucherRow[] {
  return byIssuer(rows.filter(isRedeemed), pubkey)
}

function byIssuer(rows: VoucherRow[], pubkey: string): VoucherRow[] {
  const target = issuerKey(pubkey)
  return rows
    .filter((row) => issuerKey(row.issuer_id) === target)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
}

/** A balance in one currency, in that currency's minor units. */
export interface UnitTotal {
  unit: string
  decimals: number
  minor: number
}

/**
 * What the wallet holds in total, split by currency.
 *
 * Returns one entry per unit rather than a single number, because face values in
 * different currencies cannot be added — the same reason `totalFaceValue` carries
 * its ponytail note. Summing a merchant's EUR against another's SAT would produce a
 * confident, meaningless figure on the home screen. Largest first.
 */
export function walletTotals(merchants: Merchant[]): UnitTotal[] {
  const byUnit = new Map<string, UnitTotal>()

  for (const merchant of merchants) {
    for (const group of merchant.groups) {
      const unit = group.unit ?? 'UNKNOWN'
      const existing = byUnit.get(unit)
      if (existing) {
        existing.minor += group.totalFaceValue
      } else {
        byUnit.set(unit, {
          unit,
          decimals: group.decimals ?? 0,
          minor: group.totalFaceValue,
        })
      }
    }
  }

  return [...byUnit.values()].sort((a, b) => b.minor - a.minor)
}
