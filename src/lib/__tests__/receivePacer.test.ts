import { describe, expect, it } from 'vitest'

import {
  createReceivePacer,
  PACED_BUNDLE_PARTS,
  REDEMPTIONS_PER_WINDOW,
  WINDOW_MS,
  worstCasePacingDelayMs,
} from '../receivePacer'

/**
 * #110: one bundle must not blow the gateway's 10/min per-pubkey budget.
 * Driven by a fake clock, so what is pinned is WHEN each redemption may start.
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

describe('receivePacer', () => {
  it('lets a small bundle straight through', async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    const starts: number[] = []
    for (let i = 0; i < REDEMPTIONS_PER_WINDOW; i++) {
      await pacer.acquire()
      starts.push(clock.now())
    }
    expect(starts.every((s) => s === 0)).toBe(true)
  })

  it("keeps staging's 8-part bundle under the budget: never more than 4 starts a minute", async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    const starts: number[] = []
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await pacer.acquire()
        starts.push(clock.now())
      }),
    )
    starts.sort((a, b) => a - b)
    for (const s of starts) {
      // A redemption is a receive and an ack: 2 calls each.
      const inWindow = starts.filter((x) => x >= s && x < s + WINDOW_MS).length
      expect(inWindow * 2).toBeLessThanOrEqual(10)
    }
    expect(Math.max(...starts)).toBe(worstCasePacingDelayMs(8))
  })

  it('starts afresh after reset (account switch)', async () => {
    const clock = fakeClock()
    const pacer = createReceivePacer(clock)
    for (let i = 0; i < REDEMPTIONS_PER_WINDOW; i++) await pacer.acquire()
    pacer.reset()
    await pacer.acquire()
    expect(clock.now()).toBe(0)
  })

  it('names the bundle size it is sized for', () => {
    expect(worstCasePacingDelayMs(1)).toBe(0)
    expect(worstCasePacingDelayMs(PACED_BUNDLE_PARTS)).toBe(2 * WINDOW_MS)
  })
})
