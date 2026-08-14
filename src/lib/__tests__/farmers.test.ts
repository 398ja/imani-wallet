import { describe, it, expect } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'
import { toFarmers, toVoucher, totalFaceValue, couponsFor, walletTotals, findFarmer } from '../farmers'
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

describe('toFarmers', () => {
  it('groups coupons from three farmers into three rows with correct totals', () => {
    const farmers = toFarmers([
      row({ issuer_id: PUBKEY_A, face_value: 500 }),
      row({ issuer_id: PUBKEY_A, face_value: 250 }),
      row({ issuer_id: PUBKEY_B, face_value: 100 }),
      row({ issuer_id: PUBKEY_C, face_value: 900 }),
    ])

    expect(farmers).toHaveLength(3)
    expect(farmers.map((f) => f.pubkey)).toEqual([PUBKEY_C, PUBKEY_A, PUBKEY_B])
    expect(totalFaceValue(farmers[0])).toBe(900)
    expect(totalFaceValue(farmers[1])).toBe(750)
    expect(farmers[1].voucherCount).toBe(2)
  })

  it('keeps one row per farmer even when unit or issuance ratio differs', () => {
    // VoucherGrouper keys on merchantId-unit-issuanceRatio, so these are three
    // separate MerchantGroups. They are still one farmer.
    const farmers = toFarmers([
      row({ issuer_id: PUBKEY_A, face_unit: 'EUR', issuance_ratio: 1 } as Partial<VoucherRow>),
      row({ issuer_id: PUBKEY_A, face_unit: 'USD', issuance_ratio: 1 } as Partial<VoucherRow>),
      row({ issuer_id: PUBKEY_A, face_unit: 'EUR', issuance_ratio: 2 } as Partial<VoucherRow>),
    ])

    expect(farmers).toHaveLength(1)
    expect(farmers[0].pubkey).toBe(PUBKEY_A)
    expect(farmers[0].voucherCount).toBe(3)
    expect(farmers[0].groups.length).toBeGreaterThan(1)
  })

  it('does not treat a live coupon as expired', () => {
    // Regression guard for the epoch-seconds vs ISO-string mismatch between
    // VoucherRow and Voucher. Get this wrong and every coupon dates to 1970,
    // VoucherGrouper filters them all out, and the farmer list renders empty.
    const oneYearOut = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60

    expect(new Date(toVoucher(row({ expires_at: oneYearOut })).expires_at!).getFullYear())
      .toBeGreaterThan(2000)

    expect(toFarmers([row({ expires_at: oneYearOut })])).toHaveLength(1)
  })

  it('reads an expiry stored as an ISO string, not just epoch seconds', () => {
    // VoucherRow types expires_at as epoch seconds, but the writer —
    // tokenRedemption's _persistRedeemed — stores the ISO string /inspect
    // returned. `expires_at * 1000` on that is NaN: NaN > Date.now() is false,
    // so a live coupon read as expired and its farmer left the list, and
    // `new Date(NaN).toISOString()` in toVoucher THREW.
    const oneYearOut = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    const coupon = row({ expires_at: oneYearOut as unknown as number })

    expect(toVoucher(coupon).expires_at).toBe(oneYearOut)
    expect(toFarmers([coupon])).toHaveLength(1)

    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    expect(toFarmers([row({ expires_at: lastYear as unknown as number })])).toHaveLength(0)
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
    // filters the coupon as expired, and the farmer vanishes from the list.
    const coupon = row({ expires_at: value as unknown as number })

    expect(toVoucher(coupon).expires_at).toBeUndefined()
    expect(toFarmers([coupon])).toHaveLength(1)
  })

  it('still excludes a genuinely expired coupon', () => {
    const lastYear = Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60
    expect(toFarmers([row({ expires_at: lastYear })])).toHaveLength(0)
  })

  it('returns nothing for an empty wallet', () => {
    expect(toFarmers([])).toEqual([])
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

  it('keeps coupons of different ratios in separate groups', () => {
    // The ratio is part of VoucherGrouper's group key. Dropping it merged
    // everything at ratio 1, and the screens format a farmer's total from
    // groups[0] — so the wrong unit/decimals would win.
    const farmers = toFarmers([
      xaf({ issuer_id: PUBKEY_A }),
      xaf({ issuer_id: PUBKEY_A, face_value: 5000, token_amount: 500 }), // ratio 10
    ])

    expect(farmers).toHaveLength(1)
    expect(farmers[0].groups).toHaveLength(2)
    expect(farmers[0].groups.map((g) => g.issuanceRatio).sort((a, b) => a - b)).toEqual([10, 25])
  })
})

describe('couponsFor', () => {
  it('returns only that farmer, newest first, as rows carrying token_id', () => {
    const rows = [
      row({ issuer_id: PUBKEY_A, created_at: '2026-08-01T00:00:00.000Z' }),
      row({ issuer_id: PUBKEY_B }),
      row({ issuer_id: PUBKEY_A, created_at: '2026-08-03T00:00:00.000Z' }),
    ]

    const coupons = couponsFor(rows, PUBKEY_A)

    expect(coupons).toHaveLength(2)
    expect(coupons[0].created_at).toBe('2026-08-03T00:00:00.000Z')
    // token_id is why this returns rows rather than farmer.groups[].vouchers:
    // it is the store's primary key and what addresses a coupon detail route.
    expect(coupons.every((c) => Boolean(c.token_id))).toBe(true)
  })

  it('matches the pubkey case-insensitively, as findFarmer does', () => {
    expect(couponsFor([row({ issuer_id: PUBKEY_A })], PUBKEY_A.toUpperCase())).toHaveLength(1)
  })

  it('agrees with the count shown on the farmer card', () => {
    // The card's number comes from VoucherGrouper via toFarmers; this list has
    // its own expiry filter. If the two ever disagree the screen contradicts
    // itself — "5 coupons" above a list of four.
    const rows = [
      row({ issuer_id: PUBKEY_A }),
      row({ issuer_id: PUBKEY_A, expires_at: 0 }),
      row({ issuer_id: PUBKEY_A, expires_at: Math.floor(Date.now() / 1000) + 86_400 }),
      row({ issuer_id: PUBKEY_A, expires_at: Math.floor(Date.now() / 1000) - 86_400 }),
      row({ issuer_id: PUBKEY_B }),
    ]

    expect(couponsFor(rows, PUBKEY_A)).toHaveLength(findFarmer(rows, PUBKEY_A)!.voucherCount)
  })

  it('excludes an expired coupon but keeps one with no expiry', () => {
    const rows = [
      row({ issuer_id: PUBKEY_A, expires_at: Math.floor(Date.now() / 1000) - 60 }),
      row({ issuer_id: PUBKEY_A, expires_at: undefined }),
    ]
    expect(couponsFor(rows, PUBKEY_A)).toHaveLength(1)
  })

  it('reaches the coupons of a row that has no issuer', () => {
    // VoucherGrouper maps a missing issuer to the farmer `unknown`, so one
    // appears on the farmer list holding real money. couponsFor used to match on
    // `row.issuer_id?.toLowerCase()`, which is undefined for exactly these rows,
    // so that farmer's own page reported 0 coupons over an empty list.
    const rows = [row({ issuer_id: undefined }), row({ issuer_id: PUBKEY_A })]
    const unknown = findFarmer(rows, 'unknown')

    expect(unknown).toBeDefined()
    expect(couponsFor(rows, 'unknown')).toHaveLength(unknown!.voucherCount)
    expect(couponsFor(rows, 'unknown')).toHaveLength(1)
  })

  it('keeps every farmer the list shows reachable', () => {
    // The parity that matters, stated once over the whole set rather than per
    // fixture: whatever `toFarmers` puts on screen, `couponsFor` must be able to
    // open. A farmer with a count nobody can drill into is money the holder
    // cannot see.
    const rows = [
      row({ issuer_id: PUBKEY_A }),
      row({ issuer_id: PUBKEY_A.toUpperCase() }),
      row({ issuer_id: PUBKEY_B }),
      row({ issuer_id: undefined }),
      row({ issuer_id: '' }),
    ]

    for (const farmer of toFarmers(rows)) {
      expect(couponsFor(rows, farmer.pubkey)).toHaveLength(farmer.voucherCount)
    }
  })
})

describe('walletTotals', () => {
  it('sums across farmers within a unit', () => {
    const farmers = toFarmers([
      row({ issuer_id: PUBKEY_A, face_value: 500 }),
      row({ issuer_id: PUBKEY_B, face_value: 250 }),
    ])

    expect(walletTotals(farmers)).toEqual([{ unit: 'EUR', decimals: 2, minor: 750 }])
  })

  it('keeps different currencies apart instead of adding them', () => {
    // 500 EUR-cents + 1000 sats is not 1500 of anything. Reporting one number
    // here would be a confident lie on the home screen.
    const farmers = toFarmers([
      row({ issuer_id: PUBKEY_A, face_value: 500, face_unit: 'EUR', face_decimals: 2 }),
      row({ issuer_id: PUBKEY_C, face_value: 1000, face_unit: 'SAT', face_decimals: 0 }),
    ])

    const totals = walletTotals(farmers)

    expect(totals).toHaveLength(2)
    expect(totals.map((t) => t.unit).sort()).toEqual(['EUR', 'SAT'])
    // Largest first, so the home screen leads with the dominant currency.
    expect(totals[0].minor).toBeGreaterThanOrEqual(totals[1].minor)
  })

  it('is empty for an empty wallet', () => {
    expect(walletTotals([])).toEqual([])
  })
})
