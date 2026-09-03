/**
 * Verifying a licence.
 *
 * Written adversarially, because a licence check that passes the happy path and
 * nothing else is a licence check that grants everything to everyone. The cases
 * that matter are: signed by the wrong person, presented by the wrong key, past
 * its expiry by one second, and carrying no lock at all.
 *
 * The clock is a number and the signature check is a function, both supplied by
 * the caller. So every boundary here is reachable without waiting, without a
 * key, and without forging anything — which is the argument for this being a
 * package rather than a module reached through the app.
 */
import { describe, expect, it } from 'vitest'

import { verifyLicence } from '../verify'
import { DENIAL_REASONS, type LicenceVoucher } from '../types'

const US = 'a'.repeat(64)
const THEM = 'b'.repeat(64)
const CUSTOMER = 'c'.repeat(64)
const SOMEONE_ELSE = 'd'.repeat(64)

const NOW = 1_800_000_000
const LATER = NOW + 86_400

const licence = (over: Partial<LicenceVoucher> = {}): LicenceVoucher => ({
  subscriptionId: 'sub-1',
  issuerPublicKey: US,
  issuerSignature: 'sig',
  lockKey: CUSTOMER,
  expiresAt: LATER,
  features: ['multi-terminal'],
  ...over,
})

/** Options with a signature check that passes, so a test can vary one thing. */
const opts = (over: Partial<Parameters<typeof verifyLicence>[1]> = {}) => ({
  issuerPublicKey: US,
  now: NOW,
  presenter: CUSTOMER,
  verifySignature: () => true,
  ...over,
})

describe('a licence that verifies', () => {
  it('grants its features', () => {
    const verdict = verifyLicence(licence(), opts())

    expect(verdict.granted).toBe(true)
    if (!verdict.granted) return
    expect(verdict.grant.features).toEqual(['multi-terminal'])
    expect(verdict.grant.expiresAt).toBe(LATER)
    expect(verdict.grant.subscriptionId).toBe('sub-1')
  })

  it('reports a pilot as one', () => {
    const paying = verifyLicence(licence(), opts())
    const pilot = verifyLicence(licence({ pilot: true }), opts())

    // Support and revenue should not have to guess which is which.
    expect(paying.granted && paying.grant.pilot).toBe(false)
    expect(pilot.granted && pilot.grant.pilot).toBe(true)
  })

  it('does not hand back a list the caller can mutate', () => {
    const voucher = licence({ features: ['multi-terminal'] })
    const verdict = verifyLicence(voucher, opts())
    if (!verdict.granted) throw new Error('expected a grant')

    // The caller holds the voucher, so aliasing its array would let a decision
    // already made be edited through the input.
    ;(voucher.features as string[]).push('everything-else')

    expect(verdict.grant.features).toEqual(['multi-terminal'])
  })
})

describe('a licence we did not issue', () => {
  it('grants nothing, however well-formed it is', () => {
    // THE check. Without it a customer mints their own subscription, signs it
    // properly, gives themselves every feature, and it verifies.
    const theirs = licence({
      issuerPublicKey: THEM,
      features: ['multi-terminal', 'everything'],
      expiresAt: NOW + 100 * 365 * 86_400,
    })

    const verdict = verifyLicence(theirs, opts({ verifySignature: () => true }))

    expect(verdict.granted).toBe(false)
    expect(verdict).toMatchObject({ reason: DENIAL_REASONS.WRONG_ISSUER })
  })

  it('is refused before its signature is even checked', () => {
    let asked = false
    verifyLicence(
      licence({ issuerPublicKey: THEM }),
      opts({
        verifySignature: () => {
          asked = true
          return true
        },
      }),
    )

    // Not merely an optimisation: a voucher from an unknown issuer is one whose
    // every field an attacker chose, and the canonical-bytes encoder should not
    // be fed it at all.
    expect(asked).toBe(false)
  })

  it('grants nothing when the signature does not hold', () => {
    // Claims to be ours; the signature says otherwise. Corruption or forgery,
    // and either way the fields below it cannot be trusted.
    const verdict = verifyLicence(licence(), opts({ verifySignature: () => false }))

    expect(verdict).toMatchObject({ granted: false, reason: DENIAL_REASONS.BAD_SIGNATURE })
  })
})

describe('the binding to a key', () => {
  it('refuses a licence presented by a key it is not locked to', () => {
    // Possession is not enough, which is the property the whole design rests on.
    const verdict = verifyLicence(licence(), opts({ presenter: SOMEONE_ELSE }))

    expect(verdict).toMatchObject({ granted: false, reason: DENIAL_REASONS.WRONG_KEY })
  })

  it('refuses a licence carrying no lock at all', () => {
    // Reachable today rather than theoretical: the wallet's parser reads a plain
    // VOUCHER secret, which has no lock key, so this is what an unmigrated
    // voucher looks like. Refused rather than treated as bearer.
    const verdict = verifyLicence(licence({ lockKey: undefined }), opts())

    expect(verdict).toMatchObject({ granted: false, reason: DENIAL_REASONS.UNLOCKED })
  })

  it('matches a key regardless of case', () => {
    const verdict = verifyLicence(
      licence({ lockKey: CUSTOMER.toUpperCase() }),
      opts({ presenter: CUSTOMER }),
    )

    expect(verdict.granted).toBe(true)
  })
})

describe('expiry', () => {
  it('grants a licence with a second left', () => {
    expect(verifyLicence(licence({ expiresAt: NOW + 1 }), opts()).granted).toBe(true)
  })

  it('refuses one a second past', () => {
    const verdict = verifyLicence(licence({ expiresAt: NOW - 1 }), opts())
    expect(verdict).toMatchObject({ granted: false, reason: DENIAL_REASONS.EXPIRED })
  })

  it('treats the exact moment of expiry as expired', () => {
    // The boundary belongs to the past. Choosing the other one would make the
    // final second of a subscription behave unlike every second before it.
    const verdict = verifyLicence(licence({ expiresAt: NOW }), opts())
    expect(verdict).toMatchObject({ granted: false, reason: DENIAL_REASONS.EXPIRED })
  })

  it('refuses a licence with no expiry rather than granting it forever', () => {
    const verdict = verifyLicence(licence({ expiresAt: undefined }), opts())
    expect(verdict).toMatchObject({ granted: false, reason: DENIAL_REASONS.NO_EXPIRY })
  })

  it('reads the clock it is given, not the wall clock', () => {
    const expired = licence({ expiresAt: NOW - 1 })

    // The same voucher, asked about a moment before it expired.
    expect(verifyLicence(expired, opts({ now: NOW - 100 })).granted).toBe(true)
    expect(verifyLicence(expired, opts({ now: NOW })).granted).toBe(false)
  })
})

describe('refusals a caller can act on', () => {
  it('reports absence as its own reason, not as a failure', () => {
    // The ordinary state of a free stall. Logging it as an error would make
    // every line about it noise.
    const verdict = verifyLicence(undefined, opts())
    expect(verdict).toMatchObject({ granted: false, reason: DENIAL_REASONS.ABSENT })
  })

  it('reports a licence that confers nothing', () => {
    const verdict = verifyLicence(licence({ features: [] }), opts())
    expect(verdict).toMatchObject({ granted: false, reason: DENIAL_REASONS.NO_FEATURES })
  })

  it('names every refusal distinctly', () => {
    // "Your subscription ended" and "that licence is for another device" have
    // different remedies, and a caller that only sees false can say neither.
    const reasons = [
      verifyLicence(undefined, opts()),
      verifyLicence(licence({ issuerPublicKey: THEM }), opts()),
      verifyLicence(licence(), opts({ verifySignature: () => false })),
      verifyLicence(licence({ lockKey: undefined }), opts()),
      verifyLicence(licence(), opts({ presenter: SOMEONE_ELSE })),
      verifyLicence(licence({ expiresAt: undefined }), opts()),
      verifyLicence(licence({ expiresAt: NOW - 1 }), opts()),
      verifyLicence(licence({ features: [] }), opts()),
    ].map((v) => (v.granted ? 'granted' : v.reason))

    expect(new Set(reasons).size).toBe(reasons.length)
  })
})
