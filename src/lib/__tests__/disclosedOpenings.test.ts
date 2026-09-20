import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'

import { commitTo, verifyDisclosedOpenings, verifyDisclosedTotal } from '../audit'

/**
 * The sound disclosure check, and the attack that motivates it.
 *
 * Finding 3: a Pedersen commitment to `n - x` is a well-formed point that
 * behaves as `-x` under addition, so a publisher running modified software can
 * drag a homomorphic sum down and make an understated total reconcile.
 *
 * The first test below is the one that shaped the design. The obvious cheap
 * fix — range-check the disclosed amounts, then do ONE aggregate check — looks
 * sound and is not, because the aggregate never ties an individual commitment
 * to an individual amount. It is asserted here rather than described, so nobody
 * re-proposes it.
 */

const N = schnorr.Point.Fn.ORDER
const G = schnorr.Point.BASE
const H = schnorr.Point.fromHex(commitTo(0, 1n))

/** What a modified publisher can emit and `commitTo` will not. */
const rawCommit = (amount: bigint, blind: bigint) =>
  G.multiply(amount).add(H.multiply(blind)).toHex(true)

const n = (i: number) => String(i).padStart(64, '0')

describe('the attack the aggregate check cannot see', () => {
  it('LIMIT: in-range amounts plus one negative commitment fool /verify-total', () => {
    // Three honest 5000s and one commitment behaving as -6000. The attacker
    // discloses four amounts that are each perfectly in range and sum to 9000.
    //
    // Every amount passes a range test. The aggregate reconciles. The lie goes
    // through. This is why `verifyDisclosedOpenings` exists and why the cheap
    // version was rejected.
    const blinds = [111n, 222n, 333n, 444n]
    const commitments = [
      commitTo(5000, blinds[0]),
      commitTo(5000, blinds[1]),
      commitTo(5000, blinds[2]),
      rawCommit((N - 6000n) % N, blinds[3]),
    ]
    const claimed = [3000, 3000, 3000, 0]
    const blindSum = (blinds.reduce((a, b) => a + b, 0n) % N).toString(16)

    expect(claimed.every((a) => Number.isInteger(a) && a >= 0 && a < 2 ** 32)).toBe(true)
    expect(verifyDisclosedTotal(commitments, 9000, blindSum)).toBe(true)
  })

  it('opening each commitment catches exactly that set', () => {
    // The same disclosure, checked the sound way. No in-range amount opens the
    // negative commitment, so the lie cannot be told.
    const blinds = [111n, 222n, 333n, 444n]
    const published = new Map([
      [n(1), commitTo(5000, blinds[0])],
      [n(2), commitTo(5000, blinds[1])],
      [n(3), commitTo(5000, blinds[2])],
      [n(4), rawCommit((N - 6000n) % N, blinds[3])],
    ])

    const result = verifyDisclosedOpenings(published, [
      { nullifier: n(1), amount: 3000, blind: blinds[0].toString(16) },
      { nullifier: n(2), amount: 3000, blind: blinds[1].toString(16) },
      { nullifier: n(3), amount: 3000, blind: blinds[2].toString(16) },
      { nullifier: n(4), amount: 0, blind: blinds[3].toString(16) },
    ])

    expect(result.verified).toBe(false)
    // Every one is named, not just the first: an auditor chasing this needs to
    // know the whole extent of what did not reconcile.
    expect(result.mismatched).toEqual([n(1), n(2), n(3), n(4)])
  })
})

describe('an honest disclosure', () => {
  const blinds = [111n, 222n, 333n]
  const published = new Map([
    [n(1), commitTo(5000, blinds[0])],
    [n(2), commitTo(4000, blinds[1])],
    [n(3), commitTo(6000, blinds[2])],
  ])
  const honest = [
    { nullifier: n(1), amount: 5000, blind: blinds[0].toString(16) },
    { nullifier: n(2), amount: 4000, blind: blinds[1].toString(16) },
    { nullifier: n(3), amount: 6000, blind: blinds[2].toString(16) },
  ]

  it('verifies, and reports the total it computed rather than one it was told', () => {
    const result = verifyDisclosedOpenings(published, honest)

    expect(result.verified).toBe(true)
    // DERIVED, not supplied. There is no `claimedTotal` parameter, so a
    // merchant cannot state a total at all — the openings determine it. That
    // removes the whole class of "claimed vs actual" disagreement.
    expect(result.total).toBe(15000)
  })

  it('refuses when one amount is altered', () => {
    const result = verifyDisclosedOpenings(published, [
      ...honest.slice(0, 2),
      { ...honest[2], amount: 6001 },
    ])

    expect(result.verified).toBe(false)
    expect(result.mismatched).toEqual([n(3)])
  })

  it('accepts a blind that is arithmetically equal but not reduced', () => {
    // `blindSumFor` reduces mod n, and a scalar assembled by another tool may
    // not. Refusing an equal-but-unreduced value would report an honest
    // disclosure as fraudulent.
    const result = verifyDisclosedOpenings(
      new Map([[n(1), commitTo(5000, 111n)]]),
      [{ nullifier: n(1), amount: 5000, blind: (111n + N).toString(16) }],
    )

    expect(result.verified).toBe(true)
  })
})

describe('what it refuses outright', () => {
  const published = new Map([[n(1), commitTo(5000, 111n)]])

  it('refuses an amount above the permitted bound', () => {
    // The bound is what makes an opening meaningful. `n - 6000` is a perfectly
    // good scalar, so "is an integer" says nothing on its own.
    const result = verifyDisclosedOpenings(published, [
      { nullifier: n(1), amount: 2 ** 32, blind: '6f' },
    ])

    expect(result.verified).toBe(false)
    expect(result.outOfRange).toEqual([n(1)])
  })

  it('refuses a negative amount without throwing', () => {
    // `commitTo` throws on a negative, and a throw here would surface as a
    // server error rather than as the finding it is. Hence the range check
    // runs FIRST.
    const result = verifyDisclosedOpenings(published, [
      { nullifier: n(1), amount: -5000, blind: '6f' },
    ])

    expect(result.verified).toBe(false)
    expect(result.outOfRange).toEqual([n(1)])
  })

  it('refuses a non-integer amount', () => {
    const result = verifyDisclosedOpenings(published, [
      { nullifier: n(1), amount: 50.5, blind: '6f' },
    ])

    expect(result.outOfRange).toEqual([n(1)])
  })

  it('refuses an empty disclosure rather than vacuously verifying it', () => {
    // `every` over an empty list is true, so a naive implementation reports a
    // disclosure of nothing as verified — a merchant could "prove" a period
    // by disclosing none of it.
    expect(verifyDisclosedOpenings(published, []).verified).toBe(false)
  })

  it('refuses an opening for a nullifier that was never published', () => {
    const result = verifyDisclosedOpenings(published, [
      { nullifier: n(9), amount: 5000, blind: '6f' },
    ])

    expect(result.verified).toBe(false)
    expect(result.mismatched).toEqual([n(9)])
  })

  it('refuses a malformed blind without throwing', () => {
    const result = verifyDisclosedOpenings(published, [
      { nullifier: n(1), amount: 5000, blind: 'not-hex' },
    ])

    expect(result.verified).toBe(false)
    expect(result.mismatched).toEqual([n(1)])
  })
})
