/**
 * The guards, tested directly.
 *
 * The HTTP suite covers what a caller sees. This covers what only direct
 * construction can reach: the at-capacity path needs a store small enough to
 * fill, and filling the real 50,000-entry store over HTTP would take longer
 * than the whole suite.
 */
import { describe, expect, it } from 'vitest'

import { createGuards, RATE_LIMIT, REPLAY_TTL_MS } from '../guards.js'
import { createExpiringMap } from '../expiringMap.js'
import { FRESHNESS_WINDOW_SECONDS } from '../nip98.js'

const T = 1_000_000
const KEY = 'a'.repeat(64)

const check = (
  g: ReturnType<typeof createGuards>,
  over: Partial<{ eventId: string; pubkey: string; idempotencyKey: string; now: number }> = {},
) =>
  g.check({
    eventId: 'event-1',
    pubkey: KEY,
    idempotencyKey: undefined,
    now: T,
    ...over,
  })

describe('the replay window is derived, not chosen', () => {
  /**
   * A signature is dangerous for as long as it could still verify, which is the
   * freshness window in BOTH directions. Remembering for less would let a
   * still-valid signature replay; remembering for much more is memory spent on
   * requests already refused as stale.
   */
  it('outlives the window in which a signature could still verify', () => {
    expect(REPLAY_TTL_MS).toBeGreaterThan(FRESHNESS_WINDOW_SECONDS * 2 * 1000)
    // Bounded above too, or "not required to remember it any longer" is not met.
    expect(REPLAY_TTL_MS).toBeLessThan(FRESHNESS_WINDOW_SECONDS * 4 * 1000)
  })
})

describe('at capacity', () => {
  /**
   * The security-critical branch, and the reason this store exists rather than
   * the app's count-evicting bounded set.
   *
   * Under flood the choice is to evict a live entry (accepting a replay) or to
   * refuse (a denial of service). This service refuses. ADR 0001 already
   * accepts denial of service as this design's failure mode, and a caller
   * retrying in a minute beats a spend that happens twice.
   *
   * Tested on the store directly because the real capacity is 50,000.
   */
  it('refuses rather than evicting a live entry', () => {
    const store = createExpiringMap<true>(REPLAY_TTL_MS, 3)

    expect(store.set('victim', true, T)).toBe('new')
    expect(store.set('b', true, T)).toBe('new')
    expect(store.set('c', true, T)).toBe('new')

    // Full, and nothing has expired. The flood is refused...
    expect(store.set('flood', true, T)).toBe('at-capacity')
    // ...and the victim is still remembered, so its replay is still refused.
    expect(store.set('victim', true, T)).toBe('duplicate')
  })

  it('recovers once entries expire, so a flood is not permanent', () => {
    const store = createExpiringMap<true>(1000, 1)
    store.set('a', true, T)
    expect(store.set('b', true, T)).toBe('at-capacity')
    expect(store.set('b', true, T + 1001)).toBe('new')
  })
})

describe('throttling', () => {
  it('allows exactly the limit before refusing', () => {
    const guards = createGuards()
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect(check(guards, { eventId: `e-${i}` }).allowed).toBe(true)
    }
    const over = check(guards, { eventId: 'one-too-many' })
    expect(over).toMatchObject({ allowed: false, reason: 'rate-limited' })
  })

  it('reports a retry delay a caller can actually back off by', () => {
    const guards = createGuards()
    for (let i = 0; i < RATE_LIMIT; i++) check(guards, { eventId: `e-${i}` })

    const verdict = check(guards, { eventId: 'over', now: T + 15_000 })
    expect(verdict).toMatchObject({ allowed: false, reason: 'rate-limited' })
    if (verdict.allowed === false && verdict.reason === 'rate-limited') {
      // 60s window opened at T, so ~45s remain. Never zero, or a caller
      // "backing off" would hammer immediately.
      expect(verdict.retryAfterSeconds).toBeGreaterThan(0)
      expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(60)
    }
  })

  it('opens a new window once the old one lapses', () => {
    const guards = createGuards()
    for (let i = 0; i < RATE_LIMIT; i++) check(guards, { eventId: `e-${i}` })
    expect(check(guards, { eventId: 'blocked' }).allowed).toBe(false)

    expect(check(guards, { eventId: 'later', now: T + 61_000 }).allowed).toBe(true)
  })

  it('counts each caller separately', () => {
    const guards = createGuards()
    const other = 'b'.repeat(64)
    for (let i = 0; i < RATE_LIMIT; i++) check(guards, { eventId: `e-${i}` })

    expect(check(guards, { eventId: 'blocked' }).allowed).toBe(false)
    expect(check(guards, { eventId: 'fresh', pubkey: other }).allowed).toBe(true)
  })

  /**
   * Throttling runs FIRST, so a caller in a hot loop is shed before it can
   * consume replay-store capacity. A flood that is refused but still recorded
   * is still a flood that fills the store.
   */
  it('sheds a throttled caller without spending replay capacity', () => {
    const guards = createGuards()
    for (let i = 0; i < RATE_LIMIT; i++) check(guards, { eventId: `e-${i}` })
    const before = guards.sizes(T).replay

    for (let i = 0; i < 50; i++) check(guards, { eventId: `flood-${i}` })

    expect(guards.sizes(T).replay).toBe(before)
  })
})

describe('idempotency', () => {
  it('is scoped to the caller, so one key cannot read another’s answer', () => {
    const guards = createGuards()
    const other = 'b'.repeat(64)
    guards.remember({
      pubkey: KEY,
      idempotencyKey: 'shared',
      response: { status: 200, body: { secret: 'mine' } },
      now: T,
    })

    expect(check(guards, { idempotencyKey: 'shared', eventId: 'x' })).toMatchObject({
      reason: 'idempotent-replay',
    })
    // The same key, a different caller: unrelated.
    expect(
      check(guards, { idempotencyKey: 'shared', pubkey: other, eventId: 'y' }).allowed,
    ).toBe(true)
  })

  /**
   * A caller-chosen key must not be able to reach into another caller's scope
   * by containing whatever separator the implementation uses.
   */
  it('cannot be escaped by a key containing a separator', () => {
    const guards = createGuards()
    const other = 'b'.repeat(64)
    guards.remember({
      pubkey: KEY,
      idempotencyKey: 'k',
      response: { status: 200, body: { secret: 'mine' } },
      now: T,
    })

    for (const crafted of [`${KEY}:k`, `${KEY}\u0000k`, `${KEY}k`]) {
      expect(
        check(guards, { idempotencyKey: crafted, pubkey: other, eventId: crafted }).allowed,
      ).toBe(true)
    }
  })
})

/**
 * The guards' own handling of a full store.
 *
 * Distinct from the store test above, which proves the STORE refuses. This
 * proves the guards turn that refusal into a refused request rather than
 * quietly carrying on — mutation testing showed the two were not the same
 * check, and that removing the guards' branch broke nothing.
 */
describe('the guards under flood', () => {
  it('refuses a request it cannot protect, rather than proceeding unprotected', () => {
    const guards = createGuards({ replay: 2 })

    expect(check(guards, { eventId: 'a' }).allowed).toBe(true)
    expect(check(guards, { eventId: 'b' }).allowed).toBe(true)

    const verdict = check(guards, { eventId: 'c' })
    expect(verdict).toMatchObject({ allowed: false, reason: 'at-capacity' })
    expect(guards.stats.atCapacity).toBe(1)
  })

  it('fails CLOSED, so a flood cannot smuggle a replay through', () => {
    const guards = createGuards({ replay: 2 })
    check(guards, { eventId: 'victim' })
    check(guards, { eventId: 'filler' })

    // The store is full. New requests are refused...
    expect(check(guards, { eventId: 'flood' }).allowed).toBe(false)
    // ...and crucially the victim is still remembered, so replaying it fails.
    expect(check(guards, { eventId: 'victim' })).toMatchObject({ reason: 'replay' })
  })

  it('recovers once the window passes, so a flood is not a permanent outage', () => {
    const guards = createGuards({ replay: 1 })
    check(guards, { eventId: 'a' })
    expect(check(guards, { eventId: 'b' }).allowed).toBe(false)

    // Past the replay TTL, the store has drained and service resumes.
    expect(check(guards, { eventId: 'b', now: T + REPLAY_TTL_MS + 1 }).allowed).toBe(true)
  })
})

/**
 * Ordering is a decision, and the mutation that swapped it went unnoticed.
 *
 * Throttling must run BEFORE the replay store is written, or a caller in a hot
 * loop fills the store with entries for requests that were refused anyway —
 * turning a rate limit into a way to exhaust replay capacity.
 */
describe('guard ordering', () => {
  it('throttles before spending replay capacity', () => {
    const guards = createGuards()
    for (let i = 0; i < RATE_LIMIT; i++) check(guards, { eventId: `e-${i}` })

    const spentBefore = guards.sizes(T).replay
    for (let i = 0; i < 100; i++) check(guards, { eventId: `flood-${i}` })

    expect(guards.sizes(T).replay).toBe(spentBefore)
    expect(guards.stats.throttled).toBe(100)
  })

  it('answers an idempotent retry rather than refusing it as a replay', () => {
    const guards = createGuards()
    guards.remember({
      pubkey: KEY,
      idempotencyKey: 'k',
      response: { status: 200, body: { ok: true } },
      now: T,
    })

    // The SAME event id as a stored answer: without idempotency running first
    // this would be refused as a replay, which is the wrong answer for a
    // caller entitled to retry.
    check(guards, { eventId: 'same', idempotencyKey: 'k' })
    const verdict = check(guards, { eventId: 'same', idempotencyKey: 'k' })
    expect(verdict).toMatchObject({ reason: 'idempotent-replay' })
  })
})

describe('the retry delay', () => {
  /**
   * Never zero, and never rounded down. A caller told to "retry in 0s" backs
   * off by nothing, which is the hammering the limit exists to stop.
   */
  it('is at least a second, even at the very end of the window', () => {
    const guards = createGuards()
    for (let i = 0; i < RATE_LIMIT; i++) check(guards, { eventId: `e-${i}` })

    // 1ms before the window closes: a floor() would report 0.
    const verdict = check(guards, { eventId: 'over', now: T + 59_999 })
    expect(verdict).toMatchObject({ reason: 'rate-limited' })
    if (verdict.allowed === false && verdict.reason === 'rate-limited') {
      expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    }
  })
})
