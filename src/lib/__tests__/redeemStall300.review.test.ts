import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReceivePacer } from '../receivePacer'

/**
 * #301 adversarial review. Pins the money-adjacent edges of the #300 step
 * timeouts against the real classic script: a late pacer release never sends a
 * second receive, the retry carries the same idempotency key, fail-closed
 * sources stay closed, and an abandoned pacer waiter does not book a slot.
 */

const REDEMPTION_SOURCE = readFileSync('shared/tokenRedemption.js', 'utf8')
const TOKEN = 'cashuAeyJ0b2tlbiI6W119'
const FP = createHash('sha256').update(TOKEN).digest('hex')
const never = () => new Promise<never>(() => {})
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(api: Record<string, unknown>): any {
  const r = new Function(
    'api', 'walletStorageIntegration', 'localStorage', 'resolveDecimals', 'TokenSecurity',
    'generateReceiveIdempotencyKey',
    `${REDEMPTION_SOURCE}; return TokenRedemption;`,
  )(
    { acknowledgeReceive: async () => {}, _nostrPublicKey: 'c'.repeat(64), ...api },
    { atomicallyWrite: async () => {} },
    memoryStorage(),
    () => 2,
    { getFingerprint: async () => FP },
    (fp: string) => `rcv_${fp}`,
  )
  r._stepTimeoutMs = 50
  r._receiveGateTimeoutMs = 50
  return r
}

const ok = (id: string) => ({ receive_id: id, amount: 650, token: 'cashuAfresh', imported_count: 1, unit: 'sat' })
const settle = <T,>(p: Promise<T>, ms = 1000) =>
  Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r('HUNG'), ms))])
const META = { face_unit: 'GBP', expires_at: 1 }

afterEach(() => vi.restoreAllMocks())

describe('#301 review: no double receive', () => {
  it('a pacer that frees its slot AFTER the timeout never sends the abandoned call; the retry sends one, same key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const receive = vi.fn(async (...args: [string, { idempotencyKey?: string }]) => (void args, ok('r-1')))
    const r = load({ getTokenMetadata: async () => META, receive })
    let release!: () => void
    r._receiveGate = () => new Promise<void>((res) => (release = res))

    const first = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect((first as { e?: { code?: string } }).e?.code).toBe('RECEIVE_DEFERRED')
    // dmPoll keys its early catch-up on this tag (#301 second check: pin the contract).
    expect((first as { e?: { deferredBy?: string } }).e?.deferredBy).toBe('receive-gate-timeout')

    // The original step completes late. Nothing may follow it.
    release()
    await sleep(30)
    expect(receive).not.toHaveBeenCalled()

    r._receiveGate = async () => {}
    const second = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect((second as { v?: unknown }).v).toBeTruthy()
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0][1]).toEqual({ idempotencyKey: `rcv_${FP}` })
  })

  it('every attempt at one token uses the same key (the gateway dedupes on it)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const keys: Array<string | undefined> = []
    const err = Object.assign(new Error('HTTP 503 upstream'), { status: 503 })
    const receive = vi.fn(async (_t: string, o: { idempotencyKey?: string }) => {
      keys.push(o.idempotencyKey)
      if (keys.length === 1) throw err
      return ok('r-1')
    })
    const r = load({ getTokenMetadata: async () => META, receive })
    await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect(keys.length).toBeGreaterThanOrEqual(2)
    expect(new Set(keys)).toEqual(new Set([`rcv_${FP}`]))
  })

  it('a gate timeout returns the per-token call it booked (budget not burnt by calls never made)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = load({ getTokenMetadata: async () => META, receive: vi.fn(async () => ok('r-1')) })
    r._receiveGate = never
    for (let i = 0; i < 3; i++) await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect(r._receiveCalls.get(FP) ?? []).toHaveLength(0)
  })
})

describe('#301 review: fail-closed sources stay closed on a timeout', () => {
  for (const source of ['scan', 'manual']) {
    it(`${source}: a hung inspectVoucher refuses before any receive`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const receive = vi.fn(async () => ok('r-1'))
      const r = load({ getTokenMetadata: async () => META, inspectVoucher: never, receive })
      const out = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source }))
      expect((out as { e?: { name?: string } }).e?.name).toBe('ProvenanceVerificationError')
      expect(receive).not.toHaveBeenCalled()
    })
  }

  it('opportunistic: metadata AND inspect both hung still reach one receive (same as the error fallback)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const receive = vi.fn(async () => ok('r-1'))
    const r = load({ getTokenMetadata: never, inspectVoucher: never, receive })
    const out = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect(out).not.toBe('HUNG')
    expect(receive).toHaveBeenCalledTimes(1)
  })
})

describe('#301 review: an abandoned pacer waiter', () => {
  it('does not book a slot once its redemption gave up on it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let t = 0
    const pacer = createReceivePacer({ limit: 1, windowMs: 100, now: () => t, sleep: () => sleep(5) })
    await pacer.acquire(1) // window full until t=100
    const r = load({ getTokenMetadata: async () => META, receive: vi.fn(async () => ok('r-1')) })
    r._receiveGate = (signal?: AbortSignal) => pacer.acquire(1, signal)

    const first = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect((first as { e?: { code?: string } }).e?.code).toBe('RECEIVE_DEFERRED')

    // The window frees. The abandoned waiter must not take the slot for a call
    // that will never go out, or the next real call waits a window for nothing.
    t = 100
    await sleep(30)
    let next = false
    void pacer.acquire(1).then(() => (next = true))
    await sleep(30)
    expect(next).toBe(true)
  })
})

describe('#301 review: api.receive itself (the await the PR does not bound)', () => {
  it('a receive that never answers is reported, not aborted (no second call)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const receive = vi.fn(never)
    const r = load({ getTokenMetadata: async () => META, receive })
    r._receiveSlowWarnMs = 30
    const out = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }), 200)
    expect(out).toBe('HUNG')
    expect(receive).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('#300 api.receive still pending'))).toBe(true)
  })
})
