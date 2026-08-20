import { describe, it, expect } from 'vitest'

import { merchantStats, expiringSoon } from '../stats'
import type { WalletTransaction } from '../transactions'

const ME = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const DAY = 86_400_000
const NOW = 1_786_000_000_000

const tx = (over: Partial<WalletTransaction> & { id: string }): WalletTransaction => ({
  type: 'issued',
  direction: 'out',
  at: NOW,
  amount: 500,
  unit: 'EUR',
  decimals: 2,
  ...over,
})

const issued = (over: Partial<WalletTransaction> & { id: string }) =>
  tx({ type: 'issued', direction: 'out', ...over })

/** An incoming row issued by us — one of our coupons coming home. */
const returned = (over: Partial<WalletTransaction> & { id: string }) =>
  tx({ type: 'received', direction: 'in', merchantId: ME, ...over })

const opts = { pubkey: ME, unit: 'EUR', decimals: 2, from: NOW - 30 * DAY, now: NOW }

describe('merchantStats', () => {
  it('counts and totals what was issued', () => {
    const stats = merchantStats([issued({ id: '1' }), issued({ id: '2', amount: 250 })], opts)
    expect(stats.issuedCount).toBe(2)
    expect(stats.issuedValue).toBe(750)
  })

  it('counts only OUR vouchers coming back as redemptions', () => {
    // A merchant is also a customer. Coupons received from another merchant are
    // incoming rows too, and counting them would inflate the rate with money
    // that has nothing to do with this merchant's own issuance.
    const stats = merchantStats(
      [
        issued({ id: '1' }),
        returned({ id: '2' }),
        tx({ id: '3', type: 'received', direction: 'in', merchantId: OTHER }),
      ],
      opts,
    )
    expect(stats.redeemedCount).toBe(1)
    expect(stats.redeemedValue).toBe(500)
  })

  it('matches the issuer case-insensitively', () => {
    const stats = merchantStats([returned({ id: '1', merchantId: ME.toUpperCase() })], opts)
    expect(stats.redeemedCount).toBe(1)
  })

  it('reports a redemption rate, and 0 rather than NaN when nothing was issued', () => {
    expect(merchantStats([issued({ id: '1' }), returned({ id: '2' })], opts).redemptionRate).toBe(1)
    expect(merchantStats([], opts).redemptionRate).toBe(0)
  })

  it('excludes other currencies from the totals and says how many', () => {
    // Adding XAF to EUR would be a confident lie; dropping it silently would be
    // a quieter one.
    const stats = merchantStats(
      [issued({ id: '1' }), issued({ id: '2', unit: 'XAF', decimals: 0, amount: 2500 })],
      opts,
    )
    expect(stats.issuedCount).toBe(1)
    expect(stats.issuedValue).toBe(500)
    expect(stats.otherCurrencyCount).toBe(1)
  })

  it('ignores rows outside the range', () => {
    const stats = merchantStats([issued({ id: 'old', at: NOW - 60 * DAY }), issued({ id: 'new' })], opts)
    expect(stats.issuedCount).toBe(1)
  })

  it('splits still-valid from expired over ALL issued vouchers, not just the range', () => {
    // "How many of mine are still out there" is not a question about a window.
    const stats = merchantStats(
      [
        issued({ id: 'live', at: NOW - 60 * DAY, expiresAt: NOW + DAY }),
        issued({ id: 'dead', at: NOW - 60 * DAY, expiresAt: NOW - DAY }),
      ],
      opts,
    )
    expect(stats.active).toBe(1)
    expect(stats.expired).toBe(1)
  })

  it('never reports a negative count of live vouchers', () => {
    const stats = merchantStats([returned({ id: '1' })], opts)
    expect(stats.active).toBe(0)
  })

  it('zero-fills the activity series so the axis is a timeline, not a list', () => {
    // from = now - (days - 1) * DAY, the convention the page uses.
    const stats = merchantStats([issued({ id: '1' })], { ...opts, from: NOW - 6 * DAY })
    expect(stats.activity).toHaveLength(7)
    expect(stats.activity.every((d, i) => i === 0 || d.day > stats.activity[i - 1].day)).toBe(true)
    expect(stats.activity.reduce((n, d) => n + d.issued, 0)).toBe(1)
  })

  it('buckets issued and returned separately on the same day', () => {
    const stats = merchantStats([issued({ id: '1' }), returned({ id: '2' })], opts)
    const busy = stats.activity.filter((d) => d.issued > 0 || d.redeemed > 0)
    expect(busy).toHaveLength(1)
    expect(busy[0]).toMatchObject({ issued: 1, redeemed: 1 })
  })
})

describe('expiringSoon', () => {
  it('returns vouchers inside the window, soonest first', () => {
    const rows = [
      issued({ id: 'later', expiresAt: NOW + 5 * DAY }),
      issued({ id: 'sooner', expiresAt: NOW + DAY }),
    ]
    expect(expiringSoon(rows, { now: NOW }).map((t) => t.id)).toEqual(['sooner', 'later'])
  })

  it('excludes what has already expired — nothing can be done about it', () => {
    expect(expiringSoon([issued({ id: '1', expiresAt: NOW - DAY })], { now: NOW })).toHaveLength(0)
  })

  it('excludes what is beyond the window, and honours a custom one', () => {
    const rows = [issued({ id: '1', expiresAt: NOW + 20 * DAY })]
    expect(expiringSoon(rows, { now: NOW })).toHaveLength(0)
    expect(expiringSoon(rows, { now: NOW, withinDays: 30 })).toHaveLength(1)
  })

  it('ignores vouchers with no expiry and rows that are not issuances', () => {
    const rows = [issued({ id: '1' }), returned({ id: '2', expiresAt: NOW + DAY })]
    expect(expiringSoon(rows, { now: NOW })).toHaveLength(0)
  })
})
