/**
 * The grace window.
 *
 * Written to fail against an implementation that has no window at all, and
 * against three specific ways of building one wrong: granting a device that
 * never verified, softening a signed refusal, and letting the window run from
 * anything other than the last successful verification.
 *
 * Every clock here is a number. The window is stepped over by moving it, one
 * second either side of each boundary, because a test that waits twenty-four
 * hours is a test nobody runs.
 */
import { describe, expect, it } from 'vitest'

import {
  GRACE_REASONS,
  GRACE_WINDOW_SECONDS,
  decideWithGrace,
  type LastVerification,
} from '../grace'
import { DENIAL_REASONS, type LicenceGrant } from '../types'

const VERIFIED_AT = 1_800_000_000
/** Well past the window, so expiry never accidentally ends a grace test. */
const EXPIRES_AT = VERIFIED_AT + 365 * 86_400

const grant = (over: Partial<LicenceGrant> = {}): LicenceGrant => ({
  features: ['multi-terminal'],
  subscriptionId: 'sub-1',
  expiresAt: EXPIRES_AT,
  pilot: false,
  ...over,
})

const verifiedOnce = (over: Partial<LastVerification> = {}): LastVerification => ({
  at: VERIFIED_AT,
  grant: grant(),
  ...over,
})

/** Nothing could be checked: no voucher reachable, no storage, no network. */
const IMPOSSIBLE = { status: 'impossible', detail: 'storage unavailable' } as const

describe('when nothing can be checked', () => {
  it('keeps the features a previous verification earned', () => {
    const decision = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: verifiedOnce(),
      now: VERIFIED_AT + 3600,
    })

    expect(decision.granted).toBe(true)
    if (!decision.granted) return
    expect(decision.source).toBe('grace')
    expect(decision.grant.features).toEqual(['multi-terminal'])
    expect(decision.graceExpiresAt).toBe(VERIFIED_AT + GRACE_WINDOW_SECONDS)
  })

  it('still grants one second before the window ends, and refuses at it', () => {
    const inside = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: verifiedOnce(),
      now: VERIFIED_AT + GRACE_WINDOW_SECONDS - 1,
    })
    const boundary = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: verifiedOnce(),
      now: VERIFIED_AT + GRACE_WINDOW_SECONDS,
    })
    const past = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: verifiedOnce(),
      now: VERIFIED_AT + GRACE_WINDOW_SECONDS + 1,
    })

    expect(inside.granted).toBe(true)
    // The boundary instant belongs to the past, matching the verifier's `<=`.
    expect(boundary.granted).toBe(false)
    expect(past.granted).toBe(false)
    if (past.granted) return
    expect(past.reason).toBe(GRACE_REASONS.GRACE_ELAPSED)
  })

  it('measures from the last verification, not from the first', () => {
    // Same device, same clock reading. The only difference is when it last
    // managed to verify — which is the entire definition of the window, and the
    // thing an implementation measuring from install would get wrong.
    const now = VERIFIED_AT + GRACE_WINDOW_SECONDS + 3600

    const stale = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: verifiedOnce({ at: VERIFIED_AT }),
      now,
    })
    const refreshed = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: verifiedOnce({ at: now - 60 }),
      now,
    })

    expect(stale.granted).toBe(false)
    expect(refreshed.granted).toBe(true)
  })

  it('gives a device that has never verified no window at all', () => {
    const decision = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: null,
      now: VERIFIED_AT,
    })

    expect(decision.granted).toBe(false)
    if (decision.granted) return
    // Named as its own state. A caller reporting this as `expired` would be
    // telling a customer who never bought anything that their subscription
    // ended.
    expect(decision.reason).toBe(GRACE_REASONS.NEVER_VERIFIED)
  })

  it('does not resurrect a licence whose signed expiry has since passed', () => {
    // Verified an hour ago, expired ten minutes ago, and today's check cannot
    // run. An expiry is a signed answer we already have, so it locks now rather
    // than riding out the remaining twenty-three hours of window.
    const expiresAt = VERIFIED_AT + 3000
    const decision = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: verifiedOnce({ grant: grant({ expiresAt }) }),
      now: expiresAt + 600,
    })

    expect(decision.granted).toBe(false)
    if (decision.granted) return
    expect(decision.reason).toBe(DENIAL_REASONS.EXPIRED)
  })
})

describe('when the check answered', () => {
  it('locks an expired voucher at once, with no window', () => {
    // The heart of the ticket: an expiry is a signed answer, not an outage. The
    // device verified sixty seconds ago and would have twenty-three hours of
    // window left if this were treated as a failure to check.
    const decision = decideWithGrace({
      check: {
        status: 'answered',
        verdict: {
          granted: false,
          reason: DENIAL_REASONS.EXPIRED,
          detail: 'this licence expired at 1799999999',
        },
      },
      lastVerification: verifiedOnce({ at: VERIFIED_AT + 60 }),
      now: VERIFIED_AT + 120,
    })

    expect(decision.granted).toBe(false)
    if (decision.granted) return
    expect(decision.reason).toBe(DENIAL_REASONS.EXPIRED)
  })

  it('obeys every other signed refusal too, not just expiry', () => {
    // A forged or misdirected voucher presented once and then made unreachable
    // must not buy a day of access.
    for (const reason of [
      DENIAL_REASONS.BAD_SIGNATURE,
      DENIAL_REASONS.WRONG_ISSUER,
      DENIAL_REASONS.WRONG_KEY,
      DENIAL_REASONS.ABSENT,
    ]) {
      const decision = decideWithGrace({
        check: { status: 'answered', verdict: { granted: false, reason, detail: 'no' } },
        lastVerification: verifiedOnce(),
        now: VERIFIED_AT + 60,
      })

      expect(decision.granted).toBe(false)
      if (decision.granted) return
      expect(decision.reason).toBe(reason)
    }
  })

  it('reports a fresh grant as verified rather than as grace', () => {
    const decision = decideWithGrace({
      check: { status: 'answered', verdict: { granted: true, grant: grant() } },
      lastVerification: null,
      now: VERIFIED_AT,
    })

    expect(decision.granted).toBe(true)
    if (!decision.granted) return
    // A caller that cannot tell these apart cannot warn a customer that their
    // licence has not been confirmed for a day.
    expect(decision.source).toBe('verified')
    expect(decision.graceExpiresAt).toBeUndefined()
  })
})

describe('the window itself', () => {
  it('is twenty-four hours', () => {
    expect(GRACE_WINDOW_SECONDS).toBe(86_400)
  })

  it('hands out a grant a caller cannot mutate back into the stored one', () => {
    const stored = verifiedOnce()
    const decision = decideWithGrace({
      check: IMPOSSIBLE,
      lastVerification: stored,
      now: VERIFIED_AT + 60,
    })

    if (!decision.granted) throw new Error('expected a grace grant')
    ;(decision.grant.features as string[]).push('everything')

    expect(stored.grant.features).toEqual(['multi-terminal'])
  })
})
