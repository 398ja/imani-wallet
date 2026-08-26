import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

// The relay, the mint and the store, stubbed. `nip44` is a passthrough here —
// what these tests are about is which rows survive the restore, not the sealing.
const stubs = vi.hoisted(() => ({
  events: [] as { tags: string[][]; content: string; created_at: number }[],
  restored: [] as VoucherRow[],
  state: 'SPENT',
}))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: 'bb'.repeat(32),
    nip44Encrypt: (_to: string, plain: string) => plain,
    nip44Decrypt: (_from: string, cipher: string) => cipher,
  }),
}))
vi.mock('../relay', () => ({ allEvents: async () => stubs.events, publish: async () => undefined }))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({ validateToken: async () => ({ state: stubs.state }) }),
}))
vi.mock('../wallet', () => ({
  addRestoredVoucher: async (row: VoucherRow) => {
    stubs.restored.push(row)
  },
  getWallet: () => ({ getAllVouchers: async () => [] }),
  notifyWalletChanged: () => undefined,
}))

import { pickLive, restoreVouchers, type TokenRecord } from '../voucherRecords'

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
  it('restores a voucher that was never spent', () => {
    expect(pickLive([record('a', 100, { voucher: coupon('a') })]).map((v) => v.token_id)).toEqual([
      'a',
    ])
  })

  it('drops a voucher that has a tombstone, whatever order the relay replays in', () => {
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

  it('keeps a tombstone final even against a later record for the same voucher', () => {
    // token_id is sha256(token), so an id that has been spent can never become
    // unspent — a later record for it is a stale republish, not a new coupon.
    expect(pickLive([record('a', 100, { spent: true }), record('a', 900, { voucher: coupon('a') })]))
      .toEqual([])
  })

  it('takes the newest record when a voucher was republished', () => {
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

  it('keeps other vouchers when one of them is spent', () => {
    expect(
      pickLive([
        record('a', 100, { voucher: coupon('a') }),
        record('b', 100, { voucher: coupon('b') }),
        record('a', 200, { spent: true }),
      ]).map((v) => v.token_id),
    ).toEqual(['b'])
  })
})

describe('restoreVouchers', () => {
  const event = (row: VoucherRow) => ({
    tags: [
      ['d', row.token_id],
      ['spent', 'false'],
    ],
    content: JSON.stringify({ voucher: row } satisfies TokenRecord),
    created_at: 100,
  })

  beforeEach(() => {
    stubs.restored = []
    stubs.state = 'SPENT'
  })

  it('keeps a redeemed coupon the mint calls SPENT, and drops a live one', async () => {
    // Being SPENT is what redeeming does (burn.ts) — the row is a receipt, not
    // money, and asking the mint would throw the merchant's record away. An
    // 'active' row with the same verdict is a genuinely burnt coupon: it goes.
    const receipt = { ...coupon('a'), status: 'redeemed' } as VoucherRow
    stubs.events = [event(receipt), event(coupon('b'))]

    expect(await restoreVouchers('bb'.repeat(32))).toBe(1)
    expect(stubs.restored.map((r) => r.token_id)).toEqual(['a'])
  })

  it('restores both once the mint says they are live', async () => {
    stubs.state = 'UNSPENT'
    stubs.events = [event({ ...coupon('a'), status: 'redeemed' } as VoucherRow), event(coupon('b'))]

    expect(await restoreVouchers('bb'.repeat(32))).toBe(2)
  })
})
