import { describe, it, expect } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'
import {
  toMerchants,
  toVoucher,
  totalFaceValue,
  couponsFor,
  redeemedFor,
  walletTotals,
  findMerchant,
  withPastMerchants,
  findMerchantWithHistory,
} from '../merchants'
import type { WalletTransaction } from '../transactions'
import { formatSats } from '../format'

const PUBKEY_A = 'a'.repeat(64)
const PUBKEY_B = 'b'.repeat(64)
const PUBKEY_C = 'c'.repeat(64)

let seq = 0
function row(over: Partial<VoucherRow> = {}): VoucherRow {
  seq += 1
  return {
    token_id: `token-${seq}`,
    token: `cashuB${seq}`,
    amount: 100,
    face_value: 100,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 100,
    issuer_id: PUBKEY_A,
    status: 'active',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

describe('toMerchants', () => {
  it('groups vouchers from three shops into three rows with correct totals', () => {
    const merchants = toMerchants([
      row({ issuer_id: PUBKEY_A, face_value: 500 }),
      row({ issuer_id: PUBKEY_A, face_value: 250 }),
      row({ issuer_id: PUBKEY_B, face_value: 100 }),
      row({ issuer_id: PUBKEY_C, face_value: 900 }),
    ])

    expect(merchants).toHaveLength(3)
    expect(merchants.map((f) => f.pubkey)).toEqual([PUBKEY_C, PUBKEY_A, PUBKEY_B])
    expect(totalFaceValue(merchants[0])).toBe(900)
    expect(totalFaceValue(merchants[1])).toBe(750)
    expect(merchants[1].voucherCount).toBe(2)
  })

  it('keeps one row per shop even when unit or issuance ratio differs', () => {
    // VoucherGrouper keys on merchantId-unit-issuanceRatio, so these are three
    // separate MerchantGroups. They are still one merchant.
    const merchants = toMerchants([
      row({ issuer_id: PUBKEY_A, face_unit: 'EUR', issuance_ratio: 1 } as Partial<VoucherRow>),
      row({ issuer_id: PUBKEY_A, face_unit: 'USD', issuance_ratio: 1 } as Partial<VoucherRow>),
      row({ issuer_id: PUBKEY_A, face_unit: 'EUR', issuance_ratio: 2 } as Partial<VoucherRow>),
    ])

    expect(merchants).toHaveLength(1)
    expect(merchants[0].pubkey).toBe(PUBKEY_A)
    expect(merchants[0].voucherCount).toBe(3)
    expect(merchants[0].groups.length).toBeGreaterThan(1)
  })

  it('does not treat a live voucher as expired', () => {
    // Regression guard for the epoch-seconds vs ISO-string mismatch between
    // VoucherRow and Voucher. Get this wrong and every coupon dates to 1970,
    // VoucherGrouper filters them all out, and the merchant list renders empty.
    const oneYearOut = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60

    expect(new Date(toVoucher(row({ expires_at: oneYearOut })).expires_at!).getFullYear())
      .toBeGreaterThan(2000)

    expect(toMerchants([row({ expires_at: oneYearOut })])).toHaveLength(1)
  })

  it('reads an expiry stored as an ISO string, not just epoch seconds', () => {
    // VoucherRow types expires_at as epoch seconds, but the writer —
    // tokenRedemption's _persistRedeemed — stores the ISO string /inspect
    // returned. `expires_at * 1000` on that is NaN: NaN > Date.now() is false,
    // so a live coupon read as expired and its merchant left the list, and
    // `new Date(NaN).toISOString()` in toVoucher THREW.
    const oneYearOut = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    const coupon = row({ expires_at: oneYearOut as unknown as number })

    expect(toVoucher(coupon).expires_at).toBe(oneYearOut)
    expect(toMerchants([coupon])).toHaveLength(1)

    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    expect(toMerchants([row({ expires_at: lastYear as unknown as number })])).toHaveLength(0)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['empty-string', ''],
    ['unparseable', 'not a date'],
  ])('treats a %s expiry as "no expiry", not as 1970', (_label, value) => {
    // The gateway populates expires_at asynchronously: for ~5-10s after a
    // voucher already reports ISSUED/CONFIRMED it is still JSON null. Coupons
    // legitimately arrive in that state. Since `null === undefined` is false,
    // an undefined-only guard falls through to new Date(0), VoucherGrouper
    // filters the coupon as expired, and the merchant vanishes from the list.
    const coupon = row({ expires_at: value as unknown as number })

    expect(toVoucher(coupon).expires_at).toBeUndefined()
    expect(toMerchants([coupon])).toHaveLength(1)
  })

  it('still excludes a genuinely expired voucher', () => {
    const lastYear = Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60
    expect(toMerchants([row({ expires_at: lastYear })])).toHaveLength(0)
  })

  it('returns nothing for an empty wallet', () => {
    expect(toMerchants([])).toEqual([])
  })
})

describe('issuance ratio', () => {
  /**
   * A coupon where face value and sats are genuinely different numbers.
   *
   * The live stack issues EUR coupons at ratio 1.0 — face_value 500, token_amount
   * 500 — so face and backing are numerically identical and any confusion
   * between them renders correctly by accident. 5000 XAF backed by 200 sats
   * (ratio 25) is the case that tells the two apart.
   */
  const xaf = (over: Partial<VoucherRow> = {}) =>
    row({
      face_value: 5000,
      face_unit: 'XAF',
      face_decimals: 0,
      token_amount: 200,
      amount: 200,
      backing_strategy: 'PROPORTIONAL',
      ...over,
    })

  it('is the sats backing that gets displayed, not the face value', () => {
    const coupon = xaf()
    expect(coupon.token_amount).toBe(200)
    expect(coupon.face_value).toBe(5000)
    // What the Backing row renders. If it ever showed face_value it would read
    // 5,000 — which on the EUR test data would be indistinguishable from right.
    expect(formatSats(coupon.token_amount)).toBe('200')
  })

  it('carries a stored ratio through to the voucher', () => {
    expect(toVoucher(xaf({ issuance_ratio: 25 })).issuance_ratio).toBe(25)
  })

  it('derives face/sats when the row predates the field', () => {
    // 5000 XAF over 200 sats = 25 minor units per sat.
    expect(toVoucher(xaf()).issuance_ratio).toBe(25)

    // WalletStorage stores an absent optional as an explicit null, not as a
    // missing key — verified against the real store, where every row written
    // before this change reads `issuance_ratio: null`. A `||` or an
    // undefined-only guard would fall through differently, so pin the shape
    // that actually occurs.
    expect(toVoucher(xaf({ issuance_ratio: null as unknown as number })).issuance_ratio).toBe(25)
  })

  it('leaves the ratio undefined rather than guessing 1 with no backing', () => {
    expect(toVoucher(xaf({ token_amount: undefined })).issuance_ratio).toBeUndefined()
    expect(toVoucher(xaf({ token_amount: 0 })).issuance_ratio).toBeUndefined()
  })

  it('keeps vouchers of different ratios in separate groups', () => {
    // The ratio is part of VoucherGrouper's group key. Dropping it merged
    // everything at ratio 1, and the screens format a merchant's total from
    // groups[0] — so the wrong unit/decimals would win.
    const merchants = toMerchants([
      xaf({ issuer_id: PUBKEY_A }),
      xaf({ issuer_id: PUBKEY_A, face_value: 5000, token_amount: 500 }), // ratio 10
    ])

    expect(merchants).toHaveLength(1)
    expect(merchants[0].groups).toHaveLength(2)
    expect(merchants[0].groups.map((g) => g.issuanceRatio).sort((a, b) => a - b)).toEqual([10, 25])
  })
})

describe('couponsFor', () => {
  it('returns only that shop, newest first, as rows carrying token_id', () => {
    const rows = [
      row({ issuer_id: PUBKEY_A, created_at: '2026-08-01T00:00:00.000Z' }),
      row({ issuer_id: PUBKEY_B }),
      row({ issuer_id: PUBKEY_A, created_at: '2026-08-03T00:00:00.000Z' }),
    ]

    const coupons = couponsFor(rows, PUBKEY_A)

    expect(coupons).toHaveLength(2)
    expect(coupons[0].created_at).toBe('2026-08-03T00:00:00.000Z')
    // token_id is why this returns rows rather than merchant.groups[].vouchers:
    // it is the store's primary key and what addresses a coupon detail route.
    expect(coupons.every((c) => Boolean(c.token_id))).toBe(true)
  })

  it('matches the pubkey case-insensitively, as findMerchant does', () => {
    expect(couponsFor([row({ issuer_id: PUBKEY_A })], PUBKEY_A.toUpperCase())).toHaveLength(1)
  })

  it('agrees with the count shown on the shop card', () => {
    // The card's number comes from VoucherGrouper via toMerchants; this list has
    // its own expiry filter. If the two ever disagree the screen contradicts
    // itself — "5 coupons" above a list of four.
    const rows = [
      row({ issuer_id: PUBKEY_A }),
      row({ issuer_id: PUBKEY_A, expires_at: 0 }),
      row({ issuer_id: PUBKEY_A, expires_at: Math.floor(Date.now() / 1000) + 86_400 }),
      row({ issuer_id: PUBKEY_A, expires_at: Math.floor(Date.now() / 1000) - 86_400 }),
      row({ issuer_id: PUBKEY_B }),
    ]

    expect(couponsFor(rows, PUBKEY_A)).toHaveLength(findMerchant(rows, PUBKEY_A)!.voucherCount)
  })

  it('excludes an expired voucher but keeps one with no expiry', () => {
    const rows = [
      row({ issuer_id: PUBKEY_A, expires_at: Math.floor(Date.now() / 1000) - 60 }),
      row({ issuer_id: PUBKEY_A, expires_at: undefined }),
    ]
    expect(couponsFor(rows, PUBKEY_A)).toHaveLength(1)
  })

  it('reaches the vouchers of a row that has no issuer', () => {
    // VoucherGrouper maps a missing issuer to the merchant `unknown`, so one
    // appears on the merchant list holding real money. couponsFor used to match on
    // `row.issuer_id?.toLowerCase()`, which is undefined for exactly these rows,
    // so that merchant's own page reported 0 coupons over an empty list.
    const rows = [row({ issuer_id: undefined }), row({ issuer_id: PUBKEY_A })]
    const unknown = findMerchant(rows, 'unknown')

    expect(unknown).toBeDefined()
    expect(couponsFor(rows, 'unknown')).toHaveLength(unknown!.voucherCount)
    expect(couponsFor(rows, 'unknown')).toHaveLength(1)
  })

  it('keeps every shop the list shows reachable', () => {
    // The parity that matters, stated once over the whole set rather than per
    // fixture: whatever `toMerchants` puts on screen, `couponsFor` must be able to
    // open. A merchant with a count nobody can drill into is money the holder
    // cannot see.
    const rows = [
      row({ issuer_id: PUBKEY_A }),
      row({ issuer_id: PUBKEY_A.toUpperCase() }),
      row({ issuer_id: PUBKEY_B }),
      row({ issuer_id: undefined }),
      row({ issuer_id: '' }),
    ]

    for (const merchant of toMerchants(rows)) {
      expect(couponsFor(rows, merchant.pubkey)).toHaveLength(merchant.voucherCount)
    }
  })
})

describe('redeemed coupons', () => {
  // A redeemed coupon's proofs are burnt at the mint (burn.ts). It is a receipt,
  // not money: it must leave the balance and the live list, and surface only
  // through `redeemedFor`.
  const rows = [
    row({ issuer_id: PUBKEY_A, face_value: 500 }),
    row({ issuer_id: PUBKEY_A, face_value: 300, status: 'redeemed' }),
  ]

  it('are not money: out of the balance and the shop card count', () => {
    expect(walletTotals(toMerchants(rows))).toEqual([{ unit: 'EUR', decimals: 2, minor: 500 }])
    expect(findMerchant(rows, PUBKEY_A)!.voucherCount).toBe(1)
  })

  it('leave the live list, keeping it in step with the card', () => {
    expect(couponsFor(rows, PUBKEY_A)).toHaveLength(1)
    expect(couponsFor(rows, PUBKEY_A)[0].face_value).toBe(500)
  })

  it('come back through redeemedFor, expired or not', () => {
    const redeemed = redeemedFor(
      [...rows, row({ issuer_id: PUBKEY_A, status: 'redeemed', expires_at: 0 })],
      PUBKEY_A,
    )
    // No expiry filter here: a sale that happened does not stop having happened.
    expect(redeemed).toHaveLength(2)
    expect(redeemedFor(rows, PUBKEY_B)).toEqual([])
  })
})

describe('walletTotals', () => {
  it('sums across shops within a unit', () => {
    const merchants = toMerchants([
      row({ issuer_id: PUBKEY_A, face_value: 500 }),
      row({ issuer_id: PUBKEY_B, face_value: 250 }),
    ])

    expect(walletTotals(merchants)).toEqual([{ unit: 'EUR', decimals: 2, minor: 750 }])
  })

  it('keeps different currencies apart instead of adding them', () => {
    // 500 EUR-cents + 1000 sats is not 1500 of anything. Reporting one number
    // here would be a confident lie on the home screen.
    const merchants = toMerchants([
      row({ issuer_id: PUBKEY_A, face_value: 500, face_unit: 'EUR', face_decimals: 2 }),
      row({ issuer_id: PUBKEY_C, face_value: 1000, face_unit: 'SAT', face_decimals: 0 }),
    ])

    const totals = walletTotals(merchants)

    expect(totals).toHaveLength(2)
    expect(totals.map((t) => t.unit).sort()).toEqual(['EUR', 'SAT'])
    // Largest first, so the home screen leads with the dominant currency.
    expect(totals[0].minor).toBeGreaterThanOrEqual(totals[1].minor)
  })

  it('is empty for an empty wallet', () => {
    expect(walletTotals([])).toEqual([])
  })
})

const tx = (over: Partial<WalletTransaction> = {}): WalletTransaction => ({
  id: `payment:${(seq += 1)}`,
  type: 'payment',
  direction: 'out',
  at: 1_755_000_000_000,
  amount: 100,
  unit: 'EUR',
  decimals: 2,
  merchantId: PUBKEY_A,
  ...over,
})

describe('withPastMerchants', () => {
  it('adds a shop known only from history', () => {
    // The whole point of the customer restore: spend the last coupon and the
    // merchant must stay on the home screen, because their card is the only route
    // to the record of what was spent.
    const merchants = withPastMerchants([], [tx({ merchantId: PUBKEY_B, merchantName: 'Bea' })])

    expect(merchants.map((f) => f.pubkey)).toEqual([PUBKEY_B])
    expect(merchants[0].name).toBe('Bea')
    expect(merchants[0].voucherCount).toBe(0)
    expect(totalFaceValue(merchants[0])).toBe(0)
  })

  it('does not duplicate a shop whose vouchers are still held', () => {
    const held = toMerchants([row({ issuer_id: PUBKEY_A })])

    expect(withPastMerchants(held, [tx({ merchantId: PUBKEY_A })]).map((f) => f.pubkey)).toEqual([
      PUBKEY_A,
    ])
  })

  it('takes the first real name, whatever order the rows arrive in', () => {
    // Only some rows carry merchantName, and history is not sorted by it.
    const merchants = withPastMerchants(
      [],
      [tx({ merchantId: PUBKEY_C }), tx({ merchantId: PUBKEY_C, merchantName: 'Cara' })],
    )

    expect(merchants).toHaveLength(1)
    expect(merchants[0].name).toBe('Cara')
  })

  it('skips a row with no counterparty', () => {
    // 'unknown' is the grouper's bucket for several different people at once.
    expect(withPastMerchants([], [tx({ merchantId: undefined })])).toEqual([])
  })

  it('falls back to counterparty when there is no merchantId', () => {
    expect(
      withPastMerchants([], [tx({ merchantId: undefined, counterparty: PUBKEY_B })]).map(
        (f) => f.pubkey,
      ),
    ).toEqual([PUBKEY_B])
  })

  it('never turns the person a voucher was sent to into a merchant', () => {
    // A 'sent' row's counterparty is a FRIEND. The fallback above would put them
    // on the home deck as a merchant, with a merchant page and a coupon list
    // belonging to nobody. The issuer is what the row is filed under.
    const merchants = withPastMerchants(
      [],
      [tx({ type: 'sent', merchantId: PUBKEY_A, counterparty: PUBKEY_B })],
    )

    expect(merchants.map((f) => f.pubkey)).toEqual([PUBKEY_A])
  })

  it('drops a sent row that somehow has no issuer, rather than inventing one', () => {
    expect(
      withPastMerchants([], [tx({ type: 'sent', merchantId: undefined, counterparty: PUBKEY_B })]),
    ).toEqual([])
  })
})

describe('findMerchantWithHistory', () => {
  it('resolves a shop holding no vouchers — the screen would say "No vouchers from this shop"', () => {
    expect(findMerchantWithHistory([], [tx({ merchantId: PUBKEY_B })], PUBKEY_B)?.pubkey).toBe(
      PUBKEY_B,
    )
    expect(findMerchant([], PUBKEY_B)).toBeUndefined()
  })

  it('is undefined for a shop in neither', () => {
    expect(findMerchantWithHistory([], [], PUBKEY_B)).toBeUndefined()
  })
})
