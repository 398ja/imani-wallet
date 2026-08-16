import { describe, it, expect } from 'vitest'

import { pickLive, type TokenRecord } from '../voucherRecords'
import type { VoucherRow } from '@imani/wallet-storage'

const coupon = (tokenId: string): VoucherRow =>
  ({
    token_id: tokenId,
    token: `cashuB${tokenId}`,
    amount: 21,
    face_value: 1200,
    face_unit: 'GBP',
    face_decimals: 2,
    issuer_id: 'bb'.repeat(32),
    created_at: '2026-08-16T10:00:00.000Z',
    updated_at: '2026-08-16T10:00:00.000Z',
  }) as VoucherRow

const record = (id: string, at: number, r: TokenRecord) => ({ id, at, record: r })

describe('pickLive', () => {
  it('restores a coupon that was never spent', () => {
    expect(pickLive([record('a', 100, { voucher: coupon('a') })]).map((v) => v.token_id)).toEqual([
      'a',
    ])
  })

  it('drops a coupon that has a tombstone, whatever order the relay replays in', () => {
    // The rule that keeps burnt proofs out of a restored wallet. `created_at` is
    // seconds, so a coupon received and spent inside the same second gives both
    // events the SAME timestamp — newest-wins would then depend on which one the
    // relay happened to send first, which is not a coin flip anyone should take
    // with money.
    const live = record('a', 100, { voucher: coupon('a') })
    const dead = record('a', 100, { spent: true })

    expect(pickLive([live, dead])).toEqual([])
    expect(pickLive([dead, live])).toEqual([])
  })

  it('keeps a tombstone final even against a later record for the same coupon', () => {
    // token_id is sha256(token), so an id that has been spent can never become
    // unspent — a later record for it is a stale republish, not a new coupon.
    expect(pickLive([record('a', 100, { spent: true }), record('a', 900, { voucher: coupon('a') })]))
      .toEqual([])
  })

  it('takes the newest record when a coupon was republished', () => {
    const older = { ...coupon('a'), status: 'active' }
    const newer = { ...coupon('a'), status: 'partially_spent' }

    expect(
      pickLive([record('a', 100, { voucher: older }), record('a', 200, { voucher: newer })])[0]
        .status,
    ).toBe('partially_spent')
  })

  it('ignores a record with no token — there is nothing to restore', () => {
    expect(pickLive([record('a', 100, { voucher: { token_id: 'a' } as VoucherRow })])).toEqual([])
  })

  it('keeps other coupons when one of them is spent', () => {
    expect(
      pickLive([
        record('a', 100, { voucher: coupon('a') }),
        record('b', 100, { voucher: coupon('b') }),
        record('a', 200, { spent: true }),
      ]).map((v) => v.token_id),
    ).toEqual(['b'])
  })
})
