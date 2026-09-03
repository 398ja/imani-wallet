/**
 * What a holding is worth.
 *
 * The app answers this in `src/lib/merchants.ts`, over stored rows. The wallet
 * API has to answer it over coupons that arrived in a request body, and the two
 * must not disagree — a customer looking at the app and a program reading the
 * API are looking at the same money.
 *
 * ## Why the breakdown is the answer, and a total is not
 *
 * A coupon is a claim on exactly one stall, honoured by that stall alone. Five
 * from one stall and five from another is not ten of anything: there is no
 * transaction either number could pay for. The same holds within a stall across
 * currencies. So this returns groups, and deliberately offers no grand total —
 * `walletTotals` in the app takes the same position, and its comment records
 * that a summed home screen produced "a confident, meaningless figure".
 *
 * ## Why unusable coupons are reported rather than dropped
 *
 * The app filters spent and expired coupons away, which is right for a screen
 * offering things to spend. It is wrong for a caller reconciling books: a
 * program that sends 100 coupons and is told about 98 has to diff the sets to
 * discover the other two, and the likeliest reading of a smaller number is that
 * the request was mangled.
 *
 * So every coupon in, every coupon accounted for: it is spendable and inside a
 * group, or it is unusable and named with a reason. The counts add up, which is
 * the property a reconciler actually needs.
 */

import type { Voucher } from '@imani/voucher-send'

import { toEpochMs } from './spend'

/**
 * Why a coupon cannot be spent.
 *
 * `spent` and `redeemed` are distinct in the wallet's vocabulary — spent went
 * to another party, redeemed came home to the issuing stall and was burnt — but
 * both mean the proofs are gone, so they are one reason here. A caller that
 * cares which can look at the coupon it sent.
 */
export type UnusableReason =
  | 'spent'
  | 'expired'
  | 'no-value'
  | 'no-token'

/** One coupon that carries no spendable value, and why. */
export interface UnusableCoupon {
  /** The coupon's own id, as it arrived. */
  couponId: string | undefined
  reason: UnusableReason
}

/**
 * What one stall's coupons are worth in one currency.
 *
 * Minor units, because that is what a coupon's `face_value` is and converting
 * to a decimal here would invent a rounding decision that belongs to whoever
 * displays it.
 */
export interface HoldingGroup {
  /** The stall that issued these, normalised. */
  stallId: string
  /** Currency code, upper case. */
  currency: string
  /** Decimal places, for a caller that wants to render this. */
  decimals: number
  /** Total face value, in minor units. */
  faceValue: number
  /** Total backing, in the mint's units. */
  tokenAmount: number
  /** How many coupons are in this group. */
  couponCount: number
}

export interface HoldingValue {
  /** Spendable value, grouped. Largest face value first. */
  groups: HoldingGroup[]
  /** Coupons carrying no spendable value, each with a reason. */
  unusable: UnusableCoupon[]
  /** Every coupon supplied, spendable or not. `groups` + `unusable` sum to it. */
  couponCount: number
}

/**
 * The stall id, normalised the way the app normalises it.
 *
 * Mirrors `issuerKey` in `src/lib/merchants.ts`, and the reasoning there is
 * worth repeating: a raw comparison against a normalised id made real coupons
 * invisible, because the two differed only in case. The `'unknown'` fallback
 * matters for the same reason — a coupon that arrived without an issuer still
 * belongs to a group a caller can see, rather than vanishing.
 */
export function stallKey(issuerId: string | undefined | null): string {
  const id = issuerId || 'unknown'
  // An npub stays as it is: it looks decodable and is not.
  if (id.startsWith('npub1')) return id
  return /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : id
}

/**
 * Why this coupon cannot be spent, or `undefined` if it can.
 *
 * The order is not arbitrary. A coupon with no token is unusable whatever its
 * status says, and a spent coupon that later expired is still best described as
 * spent — the reason a caller can act on is the one that came first.
 *
 * `now` is injected rather than read, so expiry is testable without waiting and
 * without a fake clock.
 */
function unusableReason(coupon: Voucher, now: number): UnusableReason | undefined {
  // No token means no proofs: nothing to present to a mint, whatever else the
  // coupon claims about itself.
  if (!coupon.token) return 'no-token'

  const status = (coupon.status ?? '').toLowerCase()
  if (status === 'spent' || status === 'redeemed') return 'spent'

  // Through `toEpochMs`, NOT `Date.parse`. `expires_at` is typed as a string
  // and is written as a number — seconds or milliseconds — by the redemption
  // path, so a parser that trusted the type would read every numeric expiry as
  // invalid and call a long-lapsed coupon live. `spend.ts` carries the same
  // note over the same field.
  const expiry = toEpochMs(coupon.expires_at as number | string | undefined)
  if (expiry !== undefined && expiry <= now) return 'expired'

  // A zero-value coupon is not money. Reported rather than dropped, because a
  // caller holding one wants to know it is there.
  if ((coupon.face_value ?? 0) <= 0) return 'no-value'

  return undefined
}

/**
 * Value a holding, grouped by stall and currency.
 *
 * Pure: a function of the coupons handed in and the clock passed to it. No
 * storage, no network, no DOM — which is what lets the API call it per request
 * and hold nothing afterwards.
 */
export function valueHolding(coupons: Voucher[], now: number = Date.now()): HoldingValue {
  const groups = new Map<string, HoldingGroup>()
  const unusable: UnusableCoupon[] = []

  for (const coupon of coupons) {
    const reason = unusableReason(coupon, now)
    if (reason) {
      unusable.push({ couponId: coupon.voucher_id, reason })
      continue
    }

    const stallId = stallKey(coupon.issuer_id)

    // The UNKNOWN sentinel, never a default of SAT. A coupon whose unit is
    // missing is not silently declared satoshis: that would merge it into a
    // real group and misstate a balance. Same rule the balance package follows.
    const rawUnit = typeof coupon.face_unit === 'string' ? coupon.face_unit.trim() : ''
    const currency = rawUnit.length === 0 ? 'UNKNOWN' : rawUnit.toUpperCase()

    // Keyed on both, because that is exactly the pair that may be summed. A key
    // of one or the other is the bug this endpoint exists to avoid.
    const key = `${stallId}\u0000${currency}`

    const existing = groups.get(key)
    if (existing) {
      existing.faceValue += coupon.face_value ?? 0
      existing.tokenAmount += coupon.token_amount ?? 0
      existing.couponCount++
      // Widest wins. Coupons in one currency should agree, and if they do not,
      // narrowing would misplace the decimal point on money that is really there.
      if ((coupon.face_decimals ?? 0) > existing.decimals) {
        existing.decimals = coupon.face_decimals ?? 0
      }
    } else {
      groups.set(key, {
        stallId,
        currency,
        decimals: coupon.face_decimals ?? 0,
        faceValue: coupon.face_value ?? 0,
        tokenAmount: coupon.token_amount ?? 0,
        couponCount: 1,
      })
    }
  }

  return {
    // Largest first, so the most significant group leads. Ties broken by stall
    // then currency so the order is total: an unstable order would make two
    // identical holdings serialise differently, and a caller diffing responses
    // would see changes that are not there.
    groups: [...groups.values()].sort(
      (a, b) =>
        b.faceValue - a.faceValue ||
        a.stallId.localeCompare(b.stallId) ||
        a.currency.localeCompare(b.currency),
    ),
    unusable,
    couponCount: coupons.length,
  }
}
