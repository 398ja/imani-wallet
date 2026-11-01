import { describe, expect, it } from 'vitest'

import {
  CALLS_PER_BURN,
  CALLS_PER_RECEIVE,
  CALLS_PER_WINDOW,
  createReceivePacer,
  MAX_BURN_CALLS_PER_PART,
  MAX_RECEIVE_CALLS_PER_TOKEN,
  PacerResetError,
  WINDOW_MS,
  worstCaseBundleMs,
} from '../receivePacer'
import { readFileSync } from 'node:fs'

// Acks are exempt from the gateway limit since imani-gateway-customer#120 and
// are not paced, so a redemption spends one call: its receive.
const CALLS_PER_REDEEM = CALLS_PER_RECEIVE

/**
 * #110: one bundle must not blow the gateway's 10/min per-pubkey budget on
 * `/wallet/receive*`. Paced on CALLS (receive, ack, burn), driven by a fake
 * clock, so what is pinned is WHEN each call may start.
 */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

/** Largest number of calls started in any rolling window. */
function peak(starts: number[]): number {
  return Math.max(...starts.map((s) => starts.filter((x) => x >= s && x < s + WINDOW_MS).length))
}

describe('receivePacer', () => {
  it('lets a single coupon straight through', async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    await pacer.acquire(CALLS_PER_REDEEM)
    expect(clock.now()).toBe(0)
  })

  it("keeps staging's 8-part SELF-ISSUED bundle (16 receive calls) under the gateway's 10/min", async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    const starts: number[] = []
    const book = async (n: number) => {
      await pacer.acquire(n)
      for (let i = 0; i < n; i++) starts.push(clock.now())
    }
    // Sequential: the pacer is FIFO, and a shared fake clock would otherwise be
    // advanced by the next waiter before this one records its start.
    for (let i = 0; i < 8; i++) {
      await book(CALLS_PER_REDEEM)
      await book(CALLS_PER_BURN)
    }
    expect(starts).toHaveLength(16)
    expect(peak(starts)).toBeLessThanOrEqual(CALLS_PER_WINDOW)
    expect(CALLS_PER_WINDOW).toBeLessThan(10)
  })

  /**
   * #110 second review C: the bound must count EVERY call through the gate,
   * at its cap: 5 receives per token (all retry layers), a burn with its
   * retry, and a full window on arrival. Acks are exempt (#120), not paced.
   */
  it('an 8-part bundle at every per-part cap finishes inside worstCaseBundleMs', async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    await pacer.acquire(CALLS_PER_WINDOW) // someone else spent the window
    for (let i = 0; i < 8; i++) {
      for (let c = 0; c < MAX_RECEIVE_CALLS_PER_TOKEN; c++) await pacer.acquire(CALLS_PER_RECEIVE)
      for (let c = 0; c < MAX_BURN_CALLS_PER_PART; c++) await pacer.acquire(CALLS_PER_BURN)
    }
    expect(clock.now()).toBeLessThan(worstCaseBundleMs(8))
  })

  it("the bound's per-token receive cap is the one tokenRedemption enforces", () => {
    const source = readFileSync('shared/tokenRedemption.js', 'utf8')
    const m = /const RECEIVE_CALLS_PER_TOKEN = (\d+);/.exec(source)
    expect(Number(m?.[1])).toBe(MAX_RECEIVE_CALLS_PER_TOKEN)
  })

  /** #111 delta review: the cap only bounds the window if its span covers it. */
  it("the per-token cap's span covers the bundle wait window", async () => {
    const source = readFileSync('shared/tokenRedemption.js', 'utf8')
    const m = /const RECEIVE_CALLS_SPAN_MS = (\d+) \* 60 \* 1000;/.exec(source)
    const { BUNDLE_WAIT_WINDOW_MS } = await import('../bundleArrival')
    expect(Number(m?.[1]) * 60_000).toBeGreaterThanOrEqual(BUNDLE_WAIT_WINDOW_MS)
  })

  it('a reset waiter is a quiet deferral in dm-poll (RECEIVE_DEFERRED), not a user-facing failure', () => {
    expect(new PacerResetError().code).toBe('RECEIVE_DEFERRED')
  })

  /** #110 second review F: a waiter asleep across a reset must not fire. */
  it('reset settles waiters that are already asleep, instead of letting them fire', async () => {
    let wake: () => void = () => {}
    const pacer = createReceivePacer({
      now: () => 0,
      sleep: () => new Promise<void>((r) => (wake = r)),
    })
    await pacer.acquire(CALLS_PER_WINDOW)
    const waiting = pacer.acquire(1)
    let fired = false
    const settled = waiting.then(
      () => (fired = true),
      (e: unknown) => e,
    )
    await Promise.resolve()
    pacer.reset()
    const outcome = await settled
    expect(fired).toBe(false)
    expect(outcome).toBeInstanceOf(PacerResetError)
    wake() // the old sleep ending later changes nothing
  })

  it('starts afresh after reset (account switch)', async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    await pacer.acquire(CALLS_PER_WINDOW)
    pacer.reset()
    await pacer.acquire(1)
    expect(clock.now()).toBe(0)
  })

  it('an aborted waiter books no slot, and the next waiter gets it at once (#301)', async () => {
    let t = 0
    const pacer = createReceivePacer({ now: () => t, sleep: () => new Promise<void>(() => {}) })
    await pacer.acquire(CALLS_PER_WINDOW)
    const abort = new AbortController()
    const ghost = pacer.acquire(1, abort.signal).then(
      () => 'booked',
      () => 'abandoned',
    )
    await new Promise((r) => setTimeout(r, 0))
    abort.abort(new Error('step timeout'))
    expect(await ghost).toBe('abandoned')
    // The window frees. The next caller books at once: the abandoned wait
    // neither took the slot nor left a sleeper ahead of it in the queue.
    t = WINDOW_MS
    let booked = false
    void pacer.acquire(1).then(() => (booked = true))
    await new Promise((r) => setTimeout(r, 0))
    expect(booked).toBe(true)
  })
})
