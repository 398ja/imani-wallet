/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  BUNDLE_BACKGROUND_POLL_MS,
  BUNDLE_WAIT_MS,
  DEFAULT_BUNDLE_MAX_PARTS,
  loadPendingBundles,
  reconcilePendingSends,
  sendVouchers,
  SendOutcomeUnknownError,
  withoutInFlight,
} from '../pay'
import { moneyInFlight } from '../inFlightMoney'

// #552: a plan of several parts goes to the gateway as ONE atomic bundle. Same stand-ins as
// pay.test.ts: the wallet store and imani-apps' API client.
const stubs = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
  api: {} as Record<string, unknown>,
  rows: [] as unknown[],
}))
vi.mock('../wallet', () => ({
  getWallet: () => stubs.wallet,
  listVouchers: async () => stubs.rows,
  notifyWalletChanged: () => {},
}))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => stubs.api }))
vi.mock('../merchant', () => ({ merchantStatus: async () => 'customer' }))
vi.mock('../transferSignature', () => ({ sendTransferSignature: async () => true }))

const PAYER = 'c'.repeat(64)
const FRIEND = 'd'.repeat(64)
const ISSUER = 'f'.repeat(64)
const merchant = { pubkey: ISSUER, name: 'Hill Farm', groups: [], voucherCount: 0 }

const row = (id: string, face: number) =>
  ({
    token_id: id.repeat(32),
    token: `cashuB${id.repeat(30)}`,
    voucher_id: `v-${id}`,
    face_value: face,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: face,
    amount: face,
    issuer_id: ISSUER,
    status: 'active',
  }) as unknown as VoucherRow

/** Three €4 coupons, none of which covers €10: a 3-part bundle of 400 + 400 + 200. */
const trio = () => [row('1', 400), row('2', 400), row('3', 400)]

/** A store that really holds rows, so a test can read the balance afterwards. */
function store(rows: VoucherRow[]) {
  const held = new Map(rows.map((r) => [r.token_id, { ...r }]))
  const transactions: Record<string, unknown>[] = []
  Object.assign(stubs.wallet, {
    getVoucher: async (id: string) => held.get(id) ?? null,
    removeVoucher: async (id: string) => held.delete(id),
    saveVoucher: async (r: VoucherRow) => void held.set(r.token_id, r),
    addTransaction: async (tx: Record<string, unknown>) => void transactions.push(tx),
    updateTransaction: async () => null,
  })
  const balance = () => [...held.values()].reduce((sum, r) => sum + Number(r.face_value ?? 0), 0)
  return { held, transactions, balance }
}

type Part = Record<string, unknown>
/** A gateway with the bundle endpoint. `answer` decides what each read returns. */
function gateway(answer: (reads: number, body: Record<string, unknown>) => Record<string, unknown>, config: Record<string, unknown> = {}) {
  const calls = { posts: [] as Record<string, unknown>[], reads: 0, perPart: 0, acks: [] as string[] }
  let body: Record<string, unknown> = {}
  Object.assign(stubs.api, {
    getConfig: async () => config,
    initiateAtomicSendBundle: async (b: Record<string, unknown>) => {
      calls.posts.push(b)
      body = b
      return answer(0, b)
    },
    getAtomicSendBundle: async () => {
      calls.reads += 1
      return answer(calls.reads, body)
    },
    initiateAtomicSend: async () => {
      calls.perPart += 1
      return { send_id: `as_p${calls.perPart}`, status: 'COMPLETED' }
    },
    getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
    ackKeepToken: async (id: string) => void calls.acks.push(id),
  })
  return calls
}

const parts = (b: Record<string, unknown>) => b.parts as Part[]
const delivered = (b: Record<string, unknown>) => ({
  bundle_id: b.bundle_id,
  state: 'DELIVERED',
  parts: parts(b).map((p, i) => ({
    part_index: i,
    send_id: `as_${i}`,
    status: 'COMPLETED',
    ...(Number(p.amount) < 400
      ? { keep_token: `cashuBkeep${'k'.repeat(30)}`, keep_face_value: 400 - Number(p.amount), is_full_send: false }
      : { is_full_send: true }),
  })),
})
const aborted = (b: Record<string, unknown>) => ({
  bundle_id: b.bundle_id,
  state: 'ABORTED',
  error_code: 'PREPARE_DEADLINE',
  parts: parts(b).map((p, i) =>
    i === 2
      ? { part_index: i, send_id: `as_${i}`, status: 'CANCELLED' } // never split: source untouched
      : Number(p.amount) < 400
        ? { part_index: i, send_id: `as_${i}`, status: 'RECLAIMED', keep_token: `cashuBkeep${'k'.repeat(30)}`, keep_face_value: 0, reclaimed_token: `cashuBback${i}${'r'.repeat(30)}` }
        : { part_index: i, send_id: `as_${i}`, status: 'RECLAIMED', is_full_send: true, reclaimed_token: `cashuBback${i}${'r'.repeat(30)}` },
  ),
})

const send = (amount = 1000, onProgress?: (p: unknown) => void) =>
  sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount, onProgress })

beforeEach(() => {
  for (const k of ['pending-sends', 'pending-bundles', 'settled-sends', 'send-intents']) {
    localStorage.removeItem(`imani-wallet:${k}:${PAYER}`)
  }
  for (const k of Object.keys(stubs.api)) delete stubs.api[k]
  const quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})]
  onTestFinished(() => quiet.forEach((q) => q.mockRestore()))
})

describe('atomic bundle send (#552)', () => {
  it('sends the whole plan in one request and settles every part on DELIVERED', async () => {
    stubs.rows = trio()
    const { held, transactions } = store(trio())
    // PUBLISHING on the POST answer, DELIVERED on the first read (one real 1 s poll).
    const calls = gateway((reads, b) => (reads < 1 ? { bundle_id: b.bundle_id, state: 'PUBLISHING', parts: [] } : delivered(b)))
    const result = await send()
    // #635: `sent` sums what each part's settle confirmed; EUR parts go exactly.
    expect(result).toMatchObject({ requested: 1000, delivered: 1000, sent: 1000, parts: 3 })
    expect(result.shortfall).toBeUndefined()
    expect(calls.posts).toHaveLength(1)
    expect(calls.perPart).toBe(0)
    const body = calls.posts[0]
    expect(body.bundle_id).toMatch(/^[0-9a-f]{32}$/)
    expect(body.total).toBe(1000)
    expect(body.recipient_pubkey).toBe(FRIEND)
    expect(parts(body).map((p) => p.amount)).toEqual([400, 400, 200])
    // Two coupons gone in full, the third replaced by its change.
    expect(held.has('1'.repeat(32))).toBe(false)
    expect(held.has('2'.repeat(32))).toBe(false)
    expect(held.has('3'.repeat(32))).toBe(false)
    expect([...held.values()].map((r) => r.face_value)).toEqual([200])
    expect(transactions).toHaveLength(3)
    expect(new Set(transactions.map((t) => t.bundleId))).toEqual(new Set([body.bundle_id]))
    expect(calls.acks.sort()).toEqual(['as_0', 'as_1', 'as_2'])
    expect(loadPendingBundles(PAYER)).toEqual([])
  })

  it('restores every source coupon on ABORTED, and the balance is unchanged', async () => {
    stubs.rows = trio()
    const { balance } = store(trio())
    const before = balance()
    gateway((reads, b) => (reads === 0 ? { bundle_id: b.bundle_id, state: 'PREPARING', parts: [] } : aborted(b)))
    vi.useFakeTimers()
    try {
      const sending = send().catch((e: unknown) => e)
      await vi.runAllTimersAsync()
      const error = (await sending) as Error
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SendOutcomeUnknownError)
      expect(error.message).toMatch(/Not sent: nothing left your wallet/)
    } finally {
      vi.useRealTimers()
    }
    expect(balance()).toBe(before)
    expect(loadPendingBundles(PAYER)).toEqual([])
  })

  it('says not sent the moment the bundle is ABORTING, and stays open until ABORTED (#651)', async () => {
    stubs.rows = trio()
    const { balance } = store(trio())
    const seen: Record<string, unknown>[] = []
    // Staging 2f757a36: PREPARING, then 85 s of ABORTING while the split retries ran out, then ABORTED.
    gateway((reads, b) =>
      reads < 2 ? { bundle_id: b.bundle_id, state: 'PREPARING', parts: [] } : reads < 80 ? { bundle_id: b.bundle_id, state: 'ABORTING', parts: [] } : aborted(b),
    )
    vi.useFakeTimers()
    try {
      let outcome: unknown = 'pending'
      const sending = send(1000, (p) => void seen.push(p as Record<string, unknown>)).then((r) => r, (e: unknown) => e).then((v) => (outcome = v))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(seen.at(-1)).toMatchObject({ aborting: true })
      expect(outcome).toBe('pending') // not final yet: nothing reclaimed until ABORTED
      expect(balance()).toBe(1200)
      await vi.runAllTimersAsync()
      await sending
      expect(outcome).toBeInstanceOf(Error)
      expect(outcome).not.toBeInstanceOf(SendOutcomeUnknownError)
      expect((outcome as Error).message).toMatch(/Not sent: nothing left your wallet/)
    } finally {
      vi.useRealTimers()
    }
    expect(seen.filter((p) => p.aborting)).toHaveLength(1)
    expect(loadPendingBundles(PAYER)).toEqual([])
  })

  it('keeps checking after the live wait and hands the screen the final answer (#651)', async () => {
    stubs.rows = trio()
    const { balance } = store(trio())
    let finished = false
    gateway((_reads, b) => (finished ? aborted(b) : { bundle_id: b.bundle_id, state: 'ABORTING', parts: [] }))
    vi.useFakeTimers()
    try {
      const sending = send().catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(BUNDLE_WAIT_MS + 5_000)
      const error = (await sending) as SendOutcomeUnknownError
      expect(error).toBeInstanceOf(SendOutcomeUnknownError)
      // Said as not sent, not as "still sending", and not silent: a promise follows the bundle.
      expect(error.message).toMatch(/Not sent: nothing reached the recipient/)
      expect(error.settled).toBeInstanceOf(Promise)
      finished = true
      await vi.advanceTimersByTimeAsync(BUNDLE_BACKGROUND_POLL_MS * 2)
      const out = await error.settled
      expect(out).toBeInstanceOf(Error)
      expect((out as Error).message).toMatch(/back with you/)
    } finally {
      vi.useRealTimers()
    }
    expect(balance()).toBe(1200)
    expect(loadPendingBundles(PAYER)).toEqual([])
  })

  it('keeps the record when the outcome is unknown, holds the coupons, and finishes at login', async () => {
    stubs.rows = trio()
    const { balance } = store(trio())
    let finished = false
    gateway((_reads, b) => (finished ? delivered(b) : { bundle_id: b.bundle_id, state: 'PUBLISHING', parts: [] }))
    vi.useFakeTimers()
    try {
      const sending = send().catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(BUNDLE_WAIT_MS + 5_000)
      const error = await sending
      expect(error).toBeInstanceOf(SendOutcomeUnknownError)
      expect((error as Error).message).toMatch(/still sending/)
    } finally {
      vi.useRealTimers()
    }
    // Nothing applied, nothing forgotten, and the coupons are not offered again.
    expect(balance()).toBe(1200)
    expect(loadPendingBundles(PAYER)).toHaveLength(1)
    expect(withoutInFlight(trio(), PAYER)).toEqual([])
    expect(moneyInFlight(PAYER).sends).toBeGreaterThan(0)
    // A second send to the same person is refused while it is unknown.
    await expect(send()).rejects.toBeInstanceOf(SendOutcomeUnknownError)

    // Unreadable at login: still kept.
    stubs.api.getAtomicSendBundle = async () => {
      throw Object.assign(new TypeError('Failed to fetch'))
    }
    await reconcilePendingSends(PAYER)
    expect(loadPendingBundles(PAYER)).toHaveLength(1)

    // The gateway delivered it: the next login settles every part and drops the record.
    gateway((_r, b) => delivered({ ...b, bundle_id: loadPendingBundles(PAYER)[0].bundleId, parts: [{ amount: 400 }, { amount: 400 }, { amount: 200 }] }))
    finished = true
    expect(await reconcilePendingSends(PAYER)).toBe(1)
    expect(loadPendingBundles(PAYER)).toEqual([])
    expect(balance()).toBe(200)
  })

  it('refuses a plan above the gateway cap before anything is spent', async () => {
    const many = Array.from({ length: 4 }, (_, i) => row(String(i + 1), 100))
    stubs.rows = many
    const { balance } = store(many)
    const calls = gateway((_r, b) => delivered(b), { atomic_send_bundle_max_parts: 3 })
    await expect(send(400)).rejects.toThrow(/needs 4 vouchers, and one payment can use at most 3\. Nothing was sent/)
    expect(calls.posts).toEqual([])
    expect(calls.perPart).toBe(0)
    expect(balance()).toBe(400)
    expect(loadPendingBundles(PAYER)).toEqual([])
  })

  it('plans fewer, larger parts when the expiry-first plan is over the cap', async () => {
    // Four €1 coupons expire first, a €5 coupon later. Expiry-first needs 5 parts; largest-first 1+... fits.
    const soon = Math.floor(Date.now() / 1000) + 86_400
    const small = Array.from({ length: 4 }, (_, i) => ({ ...row(String(i + 1), 100), expires_at: soon }) as unknown as VoucherRow)
    const rows = [...small, row('9', 500)]
    stubs.rows = rows
    store(rows)
    const calls = gateway((_r, b) => delivered(b), { atomic_send_bundle_max_parts: 2 })
    await send(600)
    expect(parts(calls.posts[0]).map((p) => p.amount)).toEqual([500, 100])
  })

  it('uses the default cap of 10 when the gateway does not advertise one', () => {
    expect(DEFAULT_BUNDLE_MAX_PARTS).toBe(10)
  })

  it('says TOO_MANY_PARTS from the gateway as a refusal, nothing spent', async () => {
    stubs.rows = trio()
    const { balance } = store(trio())
    gateway(() => ({}))
    stubs.api.initiateAtomicSendBundle = async () => {
      throw Object.assign(new Error('too many'), { status: 422, code: 'TOO_MANY_PARTS', data: { max_parts: 2 } })
    }
    await expect(send()).rejects.toThrow(/at most 2\. Nothing was sent/)
    expect(balance()).toBe(1200)
    expect(loadPendingBundles(PAYER)).toEqual([])
  })

  // gateway-core#221: a refunded or disputed card voucher refuses the whole bundle up front.
  it.each([
    ['refunded:0', /Not sent: nothing left your wallet\. A voucher in it can’t be spent: its card payment was refunded\./],
    ['disputed:0', /Not sent: nothing left your wallet\. .*card payment is disputed/],
    ['partly_refunded:700', /Not sent: nothing left your wallet\. Part of a voucher’s card payment was refunded/],
  ])('says VOUCHER_PAYMENT_REFUNDED (%s) as not sent, nothing spent', async (details, wording) => {
    stubs.rows = trio()
    const { balance } = store(trio())
    const calls = gateway(() => ({}))
    stubs.api.initiateAtomicSendBundle = async () => {
      // shared/api.js copies the code onto the error and leaves details in the body.
      throw Object.assign(new Error('refused'), {
        status: 422,
        code: 'VOUCHER_PAYMENT_REFUNDED',
        data: { error: { code: 'VOUCHER_PAYMENT_REFUNDED', details } },
      })
    }
    await expect(send()).rejects.toThrow(wording)
    expect(balance()).toBe(1200)
    expect(loadPendingBundles(PAYER)).toEqual([])
    expect(calls.perPart).toBe(0)
  })

  it('says PAYMENT_STATE_UNAVAILABLE as not sent, nothing spent, not as still sending', async () => {
    stubs.rows = trio()
    const { balance } = store(trio())
    gateway(() => ({}))
    stubs.api.initiateAtomicSendBundle = async () => {
      throw Object.assign(new Error('down'), { status: 503, code: 'PAYMENT_STATE_UNAVAILABLE' })
    }
    const error = await send().catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(SendOutcomeUnknownError)
    expect(String((error as Error).message)).toMatch(/Not sent: nothing left your wallet\. .*card payment/)
    expect(balance()).toBe(1200)
    expect(loadPendingBundles(PAYER)).toEqual([])
  })

  it('falls back to the per-part loop on a gateway without the bundle endpoint', async () => {
    stubs.rows = trio()
    store(trio())
    const calls = gateway(() => ({}))
    stubs.api.initiateAtomicSendBundle = async () => {
      throw Object.assign(new Error('Not Found'), { status: 404, code: 'UNKNOWN_ERROR' })
    }
    const result = await send()
    expect(result).toMatchObject({ requested: 1000, delivered: 1000, parts: 3 })
    expect(calls.perPart).toBe(3)
    expect(loadPendingBundles(PAYER)).toEqual([])
  })

  it('keeps a single-coupon send on the per-part path', async () => {
    stubs.rows = [row('1', 1000)]
    store([row('1', 1000)])
    const calls = gateway((_r, b) => delivered(b))
    await send(500)
    expect(calls.posts).toEqual([])
    expect(calls.perPart).toBe(1)
  })
})
