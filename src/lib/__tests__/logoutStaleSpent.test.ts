import { describe, it, expect, vi, beforeEach } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * Staging report (Android, v0.75.x): logout refused for good. The same account is open in a
 * browser, which spent coupons the Android copy still held as `active`. Each one's record on the
 * relay is a tombstone, so `confirmBackups` could never read it back, and logout said
 * "N vouchers are not confirmed as backed up" on every retry, with no way out.
 *
 * Now the check reconciles first (#667) and treats a held coupon its own signed tombstone names as
 * spent, never as unbacked value. A coupon with no record at all still refuses the logout.
 */

const sk = generateSecretKey()
const pk = getPublicKey(sk)

const world = vi.hoisted(() => ({
  relay: [] as Event[],
  store: new Map<string, VoucherRow>(),
  mintSpent: new Set<string>(),
  mintDown: true,
  published: 0,
  inFlight: new Set<string>(),
}))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: pk,
    hasKey: () => true,
    nip44Encrypt: (_: string, p: string) => p,
    nip44Decrypt: (_: string, c: string) => c,
    signEvent: async () => {
      throw new Error('no publish in this test')
    },
  }),
}))
vi.mock('../relay', () => ({
  allEvents: async () => world.relay,
  allEventsWithGateway: async () => world.relay,
  eventsByD: async () => [],
  publish: async () => {
    world.published += 1
  },
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({
    validateToken: async (token: string) => {
      if (world.mintDown) throw new Error('down')
      return { state: world.mintSpent.has(token) ? 'SPENT' : 'UNSPENT' }
    },
  }),
}))
vi.mock('../wallet', () => ({
  addRestoredVoucher: async (row: VoucherRow) => {
    world.store.set(row.token_id!, row)
    return row
  },
  getWallet: () => ({ getAllVouchers: async () => [...world.store.values()] }),
  openWallet: async () => ({ getAllVouchers: async () => [...world.store.values()] }),
  notifyWalletChanged: () => undefined,
  addRestoredTransaction: async () => undefined,
}))
vi.mock('../pay', () => ({
  withoutInFlight: (rows: VoucherRow[]) => rows.filter((r) => !world.inFlight.has(r.token_id!)),
}))
vi.mock('../nip98', () => ({ signedFetch: async () => ({ ok: false }) }))

import { confirmBackups } from '../voucherRecords'

const coupon = (id: string, amount = 500): VoucherRow =>
  ({
    token_id: id,
    token: `cashuB${id}`,
    amount,
    face_value: amount,
    face_unit: 'gbp',
    face_decimals: 2,
    status: 'active',
    issuer_id: 'cc'.repeat(32),
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  }) as VoucherRow

/** The coupons' last local write, in seconds: tombstones are placed either side of it. */
const WRITE = Date.parse('2026-11-01T00:00:00Z') / 1000
const BEFORE = WRITE - 86_400
const AFTER = WRITE + 3_600

const record = (id: string, at: number, body: object, spent = false): Event =>
  finalizeEvent(
    { kind: 7375, created_at: at, tags: [['d', id], ['spent', spent ? 'true' : 'false']], content: JSON.stringify(body) },
    sk,
  )

const fast = { rounds: 0, deadlineMs: 5_000, settleMs: 0 }
const noReconcile = { ...fast, reconcile: async () => undefined }

beforeEach(() => {
  world.store = new Map([['c1', coupon('c1')], ['c2', coupon('c2')]])
  world.mintSpent = new Set()
  world.mintDown = true
  world.published = 0
  world.inFlight = new Set()
  // c1 was spent in the browser: its live record, then its tombstone. c2 is backed up and live.
  world.relay = [record('c1', BEFORE, { voucher: coupon('c1') }), record('c1', AFTER, { spent: true }, true), record('c2', BEFORE, { voucher: coupon('c2') })]
})

describe('logout on a device holding coupons spent on another device', () => {
  it('a held coupon its own tombstone names does not refuse the logout, and is marked spent', async () => {
    const check = await confirmBackups(pk, noReconcile)
    expect(check.ok).toBe(true)
    expect(world.store.get('c1')?.status).toBe('spent')
    expect(world.store.get('c2')?.status).toBe('active')
    expect(world.published).toBe(0) // a spent coupon is never re-published as live
  })

  it('a coupon with no record at all still refuses, counted alone', async () => {
    world.store.set('c3', coupon('c3', 1250))
    const check = await confirmBackups(pk, noReconcile)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('unconfirmed')
    expect(check.unconfirmed.map((c) => c.token_id)).toEqual(['c3'])
  })

  it('a forged tombstone (another key) does not excuse a held coupon', async () => {
    const other = generateSecretKey()
    world.relay = [
      finalizeEvent({ kind: 7375, created_at: AFTER, tags: [['d', 'c3'], ['spent', 'true']], content: '{"spent":true}' }, other),
      ...world.relay,
    ]
    world.store.set('c3', coupon('c3'))
    const check = await confirmBackups(pk, noReconcile)
    expect(check.ok).toBe(false)
    expect(world.store.get('c3')?.status).toBe('active')
  })

  it('the default reconcile runs first: a coupon the mint says is spent (tombstone lost) stops counting', async () => {
    world.relay = [record('c2', BEFORE, { voucher: coupon('c2') })] // c1's records never arrived
    world.mintDown = false
    world.mintSpent.add('cashuBc1')
    const check = await confirmBackups(pk, fast)
    expect(check.ok).toBe(true)
    expect(world.store.get('c1')?.status).toBe('spent')
  })

  it('mint unreachable and no tombstone: the coupon is real until shown otherwise, logout refused', async () => {
    world.relay = [record('c2', BEFORE, { voucher: coupon('c2') })]
    const check = await confirmBackups(pk, fast)
    expect(check.ok).toBe(false)
    expect(world.store.get('c1')?.status).toBe('active')
  })

  // Review of #669: the exemption must not bypass #667's stale-tombstone guard.
  it('an OLD tombstone plus a re-acquired coupon with no live backup: logout refused, coupon kept', async () => {
    // c1 was spent long ago (tombstone), then came back to this device (a Cashlink taken back, a
    // returned send): the row was written after the tombstone, and no live record backs it yet.
    world.relay = [
      record('c1', BEFORE - 100, { voucher: coupon('c1') }),
      record('c1', BEFORE, { spent: true }, true),
      record('c2', BEFORE, { voucher: coupon('c2') }),
    ]
    const check = await confirmBackups(pk, noReconcile)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('unconfirmed')
    expect(check.unconfirmed.map((c) => c.token_id)).toEqual(['c1'])
    expect(world.store.get('c1')?.status).toBe('active')
  })

  it('a newer tombstone for a coupon an in-flight ledger holds does not excuse it', async () => {
    world.inFlight.add('c1')
    const check = await confirmBackups(pk, noReconcile)
    expect(check.ok).toBe(false)
    expect(world.store.get('c1')?.status).toBe('active')
  })

  it('a newer tombstone does not excuse a row that is not plain held money (markable)', async () => {
    world.store.set('c1', { ...coupon('c1'), status: 'pending_send' } as VoucherRow)
    const check = await confirmBackups(pk, noReconcile)
    expect(world.store.get('c1')?.status).toBe('pending_send')
    expect(check.ok).toBe(false)
  })
})
