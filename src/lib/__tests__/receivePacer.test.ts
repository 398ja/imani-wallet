import { describe, expect, it } from 'vitest'

import {
  CALLS_PER_BURN,
  CALLS_PER_REDEEM,
  CALLS_PER_WINDOW,
  createReceivePacer,
  WINDOW_MS,
  worstCasePacingDelayMs,
} from '../receivePacer'

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

  it("keeps staging's 8-part SELF-ISSUED bundle (32 calls) under the gateway's 10/min", async () => {
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
    expect(starts).toHaveLength(32)
    expect(peak(starts)).toBeLessThanOrEqual(CALLS_PER_WINDOW)
    expect(CALLS_PER_WINDOW).toBeLessThan(10)
  })

  it('stays within its conservative bound even when the window starts full', async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    await pacer.acquire(CALLS_PER_WINDOW) // someone else spent the window
    for (let i = 0; i < 8; i++) {
      await pacer.acquire(CALLS_PER_REDEEM)
      await pacer.acquire(CALLS_PER_BURN)
      await pacer.acquire(1) // a background ack retry
    }
    await pacer.acquire(2) // a flush at its cap
    expect(clock.now()).toBeLessThanOrEqual(worstCasePacingDelayMs(8))
  })

  it('starts afresh after reset (account switch)', async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    await pacer.acquire(CALLS_PER_WINDOW)
    pacer.reset()
    await pacer.acquire(1)
    expect(clock.now()).toBe(0)
  })
})
