/**
 * The store under replay protection, tested as a pure structure.
 *
 * Time is an argument, not a clock, so expiry is tested at an instant rather
 * than by waiting.
 */
import { describe, expect, it } from 'vitest'

import { createExpiringMap } from '../expiringMap.js'
import { createBoundedSet } from '../../../src/lib/boundedSet.js'

const T = 1_000_000

describe('why not the app’s bounded set', () => {
  /**
   * The measurement that decided this file exists.
   *
   * `src/lib/boundedSet.ts` evicts by COUNT. That is right for "did I already
   * toast this payment?" and wrong for replay protection: an attacker floods
   * cheap entries, the victim's id falls out while its signature is still
   * inside the freshness window, and the captured request replays.
   *
   * Pinned as a test rather than left in a commit message, because the day
   * someone "simplifies" this back to the shared utility, this fails and says
   * why.
   */
  it('count-only eviction forgets a still-fresh signature under flood', () => {
    const set = createBoundedSet(100)
    set.add('victim')
    for (let i = 0; i < 100; i++) set.add(`flood-${i}`)

    expect(set.has('victim')).toBe(false) // <- the replay window, reopened
  })

  it('expiry-based eviction refuses to forget a live entry', () => {
    const map = createExpiringMap<true>(120_000, 100)
    expect(map.set('victim', true, T)).toBe('new')

    // The same flood. The store fills and REFUSES rather than evicting.
    const outcomes = new Set<string>()
    for (let i = 0; i < 200; i++) outcomes.add(map.set(`flood-${i}`, true, T))

    expect(outcomes.has('at-capacity')).toBe(true)
    // The victim is still remembered, so the replay is still refused.
    expect(map.get('victim', T)).toBe(true)
  })
})

describe('expiry', () => {
  it('holds an entry for its ttl', () => {
    const map = createExpiringMap<string>(1000, 10)
    map.set('k', 'v', T)
    expect(map.get('k', T + 999)).toBe('v')
  })

  it('forgets an entry once it expires', () => {
    const map = createExpiringMap<string>(1000, 10)
    map.set('k', 'v', T)
    expect(map.get('k', T + 1001)).toBeUndefined()
  })

  it('treats an expired key as new again, because its signature can no longer verify', () => {
    const map = createExpiringMap<true>(1000, 10)
    expect(map.set('k', true, T)).toBe('new')
    expect(map.set('k', true, T + 500)).toBe('duplicate')
    expect(map.set('k', true, T + 1001)).toBe('new')
  })


  it('makes room by expiring rather than refusing, once entries age out', () => {
    const map = createExpiringMap<true>(1000, 2)
    map.set('a', true, T)
    map.set('b', true, T)
    expect(map.set('c', true, T)).toBe('at-capacity')

    // Later, the first two have expired and there is room again.
    expect(map.set('c', true, T + 1001)).toBe('new')
  })
})

describe('boundedness', () => {
  it('never exceeds its capacity, whatever the traffic', () => {
    const map = createExpiringMap<true>(60_000, 50)
    for (let i = 0; i < 10_000; i++) map.set(`k-${i}`, true, T)
    expect(map.size(T)).toBeLessThanOrEqual(50)
  })

  /**
   * Purging stops at the first LIVE entry, which is only correct while
   * insertion order matches expiry order. Re-adding a key has to move it to the
   * end, or expired entries sit behind a live one and are never collected —
   * a slow leak that a capacity test alone would not show.
   */
  it('does not leak when a key is re-added after expiring', () => {
    const map = createExpiringMap<true>(1000, 100)
    map.set('recurring', true, T)

    for (let i = 1; i <= 50; i++) {
      const now = T + i * 2000
      map.set('recurring', true, now)
      map.set(`other-${i}`, true, now)
    }

    // Everything but the last round has expired.
    expect(map.size(T + 50 * 2000)).toBeLessThanOrEqual(2)
  })


  it('reports size without counting expired entries', () => {
    const map = createExpiringMap<true>(1000, 10)
    map.set('a', true, T)
    map.set('b', true, T)
    expect(map.size(T)).toBe(2)
    expect(map.size(T + 1001)).toBe(0)
  })
})

/**
 * The invariant the implementation leans on.
 *
 * Every entry shares one TTL, so insertion order IS expiry order, and purge can
 * stop at the first live entry knowing nothing expired sits behind it. That is
 * what lets `set` treat "present" as "live" without re-checking expiry.
 *
 * Two guards were written for cases this invariant rules out. A brute-force
 * search over 20,000 random operation sequences reached neither, so both were
 * deleted rather than left as untested code that looks load-bearing.
 *
 * Pinned here because the invariant is what makes that safe. Per-entry expiry
 * would break it and would need those guards back.
 */
describe('the shared-ttl invariant', () => {
  it('never holds an expired entry behind a live one', () => {
    const TTL = 100
    const map = createExpiringMap<true>(TTL, 1000)

    let now = 0
    for (let step = 0; step < 5000; step++) {
      now += Math.floor(Math.random() * 60)
      map.set(`k${Math.floor(Math.random() * 8)}`, true, now)

      // size() purges, then counts. If an expired entry could hide behind a
      // live one, this count would drift above the number genuinely live.
      const live = map.size(now)
      let expected = 0
      for (let k = 0; k < 8; k++) if (map.get(`k${k}`, now) !== undefined) expected++
      expect(live).toBe(expected)
    }
  })

  it('treats a present key as live, because purge has already run', () => {
    const map = createExpiringMap<true>(100, 10)
    map.set('k', true, 0)
    expect(map.set('k', true, 50)).toBe('duplicate')
    // Once expired, purge removes it and the key is new again.
    expect(map.set('k', true, 101)).toBe('new')
  })
})
