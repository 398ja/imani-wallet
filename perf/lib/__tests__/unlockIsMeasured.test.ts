/**
 * Unlock must stay INSIDE the measured window on populated rungs.
 *
 * This is a source-level assertion rather than a behavioural one because the
 * thing worth protecting is a decision, and the decision is invisible in any
 * single number: a populated rung with unlock excluded still produces a
 * plausible-looking millisecond count. It just silently stops measuring the
 * majority of what a returning customer waits for.
 *
 * Measured 2026-09-11 on a developer machine: empty wallet 129ms, 5-coupon
 * wallet 518ms. Restore-and-unlock is ~390ms, roughly three quarters of the
 * total. Excluding it would collapse every populated rung to near the empty
 * one and quietly void the cold-boot-5/cold-boot-20 comparison, whose entire
 * purpose is to reveal whether stored coupons cost anything to open.
 *
 * The pressure to remove it is real and will recur: unlock is why the perf job
 * cannot run on a CI runner, since it posts to /api/v1/auth/* and a runner has
 * no gateway to answer. The supported answer is to stand a gateway up, or to
 * run populated rungs only where the stack exists. Not to shrink the window.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(__dirname, '../../scenarios/coldBoot.ts'), 'utf8')

describe('the measured window on a populated rung', () => {
  it('restamps the duration AFTER unlocking, not before', () => {
    // The order is the whole point: `started` is taken before the load, and
    // the reported duration has to be recomputed once the wallet is open.
    const unlockAt = source.indexOf('await unlock(page, passphrase)')
    const restampAt = source.indexOf('unlockedMs = Date.now() - started')

    expect(unlockAt, 'cold boot no longer unlocks a restored fixture').toBeGreaterThan(-1)
    expect(restampAt, 'cold boot no longer restamps after unlocking').toBeGreaterThan(-1)
    expect(
      restampAt,
      'the duration is stamped before the unlock, so the populated rungs no ' +
        'longer measure what a returning customer waits for (~3/4 of the cost)',
    ).toBeGreaterThan(unlockAt)
  })

  it('reports the post-unlock duration rather than the raw load time', () => {
    expect(
      /ms:\s*unlockedMs/.test(source),
      'the rung reports something other than unlockedMs, so the unlock is ' +
        'measured and then discarded',
    ).toBe(true)
  })

  it('refuses to report a rung whose wallet never opened', () => {
    // A locked wallet would otherwise be the fastest boot ever recorded.
    expect(source).toMatch(/did not unlock with the fixture passphrase/)
  })
})
