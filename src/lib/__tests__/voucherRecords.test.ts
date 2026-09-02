import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

// The relay, the mint and the store, stubbed. `nip44` is a passthrough here —
// what these tests are about is which rows survive the restore, not the sealing.
const stubs = vi.hoisted(() => ({
  events: [] as { tags: string[][]; content: string; created_at: number }[],
  restored: [] as VoucherRow[],
  state: 'SPENT',
  /** How many records the restore actually opened. */
  decrypts: 0,
  /** What the device already holds, for the skip-the-mint path. */
  stored: [] as VoucherRow[],
  /** How many times the mint was asked about a coupon. */
  validations: 0,
}))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: 'bb'.repeat(32),
    nip44Encrypt: (_to: string, plain: string) => plain,
    nip44Decrypt: (_from: string, cipher: string) => {
      // Counted, because "did not decrypt this" is a claim a test should be
      // able to make. getSigner returns a fresh object per call, so the count
      // lives on the shared stub rather than on the signer.
      stubs.decrypts++
      return cipher
    },
  }),
}))
vi.mock('../relay', () => ({ allEvents: async () => stubs.events, publish: async () => undefined }))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({
    validateToken: async () => {
      stubs.validations++
      return { state: stubs.state }
    },
  }),
}))
vi.mock('../wallet', () => ({
  addRestoredVoucher: async (row: VoucherRow) => {
    stubs.restored.push(row)
  },
  getWallet: () => ({ getAllVouchers: async () => stubs.stored }),
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

  /** A tombstone: the tag says spent, and the payload agrees. */
  const tombstone = (row: VoucherRow) => ({
    tags: [
      ['d', row.token_id],
      ['spent', 'true'],
    ],
    content: JSON.stringify({ spent: true } satisfies TokenRecord),
    created_at: 200,
  })

  beforeEach(() => {
    stubs.restored = []
    stubs.state = 'SPENT'
    stubs.decrypts = 0
    stubs.stored = []
    stubs.validations = 0
  })

  it('does not ask the mint about a coupon the device already holds', async () => {
    /*
     * A returning customer's wallet already has its coupons. Asking the mint
     * about each one buys nothing — it is already theirs, and it is checked at
     * spend time like any other — while costing one sequential NIP-98 request
     * per coupon. Measured at 120 coupons: 120 calls, 12.8s (#44).
     */
    stubs.state = 'UNSPENT'
    stubs.stored = [coupon('a'), coupon('b')]
    stubs.events = [event(coupon('a')), event(coupon('b'))]

    await restoreVouchers('aa'.repeat(32))

    expect(stubs.validations).toBe(0)
    // Still written through: the relay copy may be newer than this device's.
    expect(stubs.restored.map((r) => r.token_id)).toEqual(['a', 'b'])
  })

  it('does ask about a coupon the device does not have', async () => {
    // The other half. Without this, the test above would pass against a
    // restore that never validates anything.
    stubs.state = 'UNSPENT'
    stubs.stored = [coupon('a')]
    stubs.events = [event(coupon('a')), event(coupon('b'))]

    await restoreVouchers('aa'.repeat(32))

    expect(stubs.validations).toBe(1)
    expect(stubs.restored.map((r) => r.token_id)).toEqual(['a', 'b'])
  })

  it('still drops a coupon the mint calls SPENT when the device lacks it', async () => {
    // The rule the restore stands on. Skipping the check for HELD coupons must
    // not weaken it for the ones actually being recovered.
    stubs.state = 'SPENT'
    stubs.stored = []
    stubs.events = [event(coupon('b'))]

    await restoreVouchers('aa'.repeat(32))

    expect(stubs.restored).toEqual([])
  })

  it('counts only what it recovered, not what it re-wrote', async () => {
    // The return value drives a log line that says how many coupons came back
    // from the relay. Counting re-writes would report a recovery that did not
    // happen on every single login.
    stubs.state = 'UNSPENT'
    stubs.stored = [coupon('a')]
    stubs.events = [event(coupon('a')), event(coupon('b'))]

    expect(await restoreVouchers('aa'.repeat(32))).toBe(1)
  })

  it('does not decrypt a tombstone it can recognise by its tag', async () => {
    /*
     * `buildRecord` writes `spent` as a TAG as well as into the payload, so a
     * reader can skip tombstones without opening them. The reader decrypted
     * everything anyway, and a wallet accumulates one tombstone per coupon it
     * has ever spent — measured at 240 relay events on a 120-coupon fixture,
     * every one decrypted and every one then discarded.
     */
    stubs.events = [tombstone(coupon('a')), tombstone(coupon('b'))]
    await restoreVouchers('aa'.repeat(32))

    expect(stubs.decrypts).toBe(0)
  })

  it('does decrypt a record that is not a tombstone', async () => {
    // The other half: the skip must be specific to tombstones, or the first
    // test would pass just as well against a reader that never decrypts.
    stubs.state = 'UNSPENT'
    stubs.events = [event(coupon('a'))]

    await restoreVouchers('aa'.repeat(32))

    expect(stubs.decrypts).toBe(1)
  })

  it('still lets a tombstone win, whichever way it was read', async () => {
    // The rule the whole restore stands on: a coupon whose proofs are burnt
    // must not come back. Skipping the decrypt must not weaken it.
    stubs.state = 'UNSPENT'
    stubs.events = [event(coupon('a')), tombstone(coupon('a'))]

    await restoreVouchers('aa'.repeat(32))

    expect(stubs.restored).toEqual([])
  })

  it('does not trust a tag that says spent when the payload disagrees', async () => {
    // The tag is a hint and can only make the reader do LESS work. It is
    // written by this wallet, but an event on a public relay is not something
    // to take on trust — and treating a `false` tag as authoritative would let
    // a forged tag resurrect a burnt coupon.
    stubs.state = 'UNSPENT'
    stubs.events = [
      {
        tags: [
          ['d', 'a'],
          ['spent', 'false'],
        ],
        // Tag says live, payload says spent. The payload is the record.
        content: JSON.stringify({ spent: true } satisfies TokenRecord),
        created_at: 100,
      },
    ]

    await restoreVouchers('aa'.repeat(32))

    expect(stubs.restored).toEqual([])
  })

  it('reads a record with no spent tag at all', async () => {
    // Written before the tag existed. Must still restore.
    stubs.state = 'UNSPENT'
    stubs.events = [
      {
        tags: [['d', 'a']],
        content: JSON.stringify({ voucher: coupon('a') } satisfies TokenRecord),
        created_at: 100,
      },
    ]

    await restoreVouchers('aa'.repeat(32))

    expect(stubs.restored.map((r) => r.token_id)).toEqual(['a'])
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
