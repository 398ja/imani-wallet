import { describe, it, expect } from 'vitest'

import { checkCeiling, redeemedTotalOf } from '../ceiling.js'
import type { PriorRedemption } from '../types.js'

/**
 * The ceiling, at its boundaries.
 *
 * This is the only check in the system that sees ACROSS redemptions — the one
 * that notices the same £10 voucher presented four times for £10. A signature
 * cannot see it and a per-presentation cap cannot see it, so if this is wrong
 * the voucher is worth whatever a determined presenter has patience for.
 *
 * Tested here rather than only through the app because the interesting cases
 * are arithmetic edges, and reaching them through IndexedDB and a DM poller
 * would mean most of what these assert is incidental.
 */

const took = (amount: number): PriorRedemption => ({ amount, direction: 'in' })
const gave = (amount: number): PriorRedemption => ({ amount, direction: 'out' })

describe('what has already been taken', () => {
  it('is nothing, for a voucher never presented', () => {
    expect(redeemedTotalOf([])).toBe(0)
  })

  it('sums incoming movements', () => {
    expect(redeemedTotalOf([took(400), took(350)])).toBe(750)
  })

  it('ignores outgoing ones', () => {
    // The merchant's own `issued` row. Counting it would consume the entire
    // ceiling before a customer redeemed anything — the single easiest way to
    // get this wrong, and invisible until a real coupon is refused.
    expect(redeemedTotalOf([gave(1000), took(400)])).toBe(400)
  })

  it('treats a malformed amount as nothing rather than poisoning the sum', () => {
    // NaN would make every comparison in `checkCeiling` false, so `allowed`
    // would come back TRUE and one bad row would silently disable the ceiling.
    expect(redeemedTotalOf([took(Number.NaN), took(400)])).toBe(400)
    expect(redeemedTotalOf([took(Number.POSITIVE_INFINITY), took(400)])).toBe(400)
  })
})

describe('whether one more redemption fits', () => {
  const face = 1000

  it('allows a first redemption inside the face', () => {
    const c = checkCeiling({ signedFaceValue: face, requested: 400, priorRedemptions: [] })
    expect(c.allowed).toBe(true)
    expect(c.remaining).toBe(1000)
  })

  it('allows a second that still fits, because partial spends legitimately return', () => {
    const c = checkCeiling({ signedFaceValue: face, requested: 400, priorRedemptions: [took(400)] })
    expect(c.allowed).toBe(true)
    expect(c.alreadyRedeemed).toBe(400)
    expect(c.remaining).toBe(600)
  })

  it('allows exactly to the face', () => {
    // The boundary itself. `<=` not `<`: a voucher must be spendable down to
    // its last minor unit, and an off-by-one here quietly steals a penny from
    // every fully-redeemed coupon.
    const c = checkCeiling({
      signedFaceValue: face,
      requested: 200,
      priorRedemptions: [took(400), took(400)],
    })
    expect(c.allowed).toBe(true)
    expect(c.remaining).toBe(200)
  })

  it('REFUSES one minor unit past the face', () => {
    const c = checkCeiling({
      signedFaceValue: face,
      requested: 201,
      priorRedemptions: [took(400), took(400)],
    })
    expect(c.allowed).toBe(false)
  })

  it('REFUSES anything once the face is used up', () => {
    const c = checkCeiling({ signedFaceValue: face, requested: 1, priorRedemptions: [took(1000)] })
    expect(c.allowed).toBe(false)
    expect(c.remaining).toBe(0)
  })

  it('reports no remainder when history already exceeds the face', () => {
    // Reachable through relay reconciliation after a wiped device, so it is a
    // real state rather than a defensive flourish. Must not read as negative
    // money left to give.
    const c = checkCeiling({ signedFaceValue: face, requested: 1, priorRedemptions: [took(1200)] })
    expect(c.allowed).toBe(false)
    expect(c.remaining).toBe(0)
  })

  it('enforces nothing when no face value was signed', () => {
    // Legacy derive-only tokens store nothing there. Inventing a bound would
    // refuse honest coupons; saying there is none is the truth.
    const c = checkCeiling({ signedFaceValue: 0, requested: 5000, priorRedemptions: [] })
    expect(c.allowed).toBe(true)
  })

  it('echoes what it was asked, so a caller can show its working', () => {
    const c = checkCeiling({ signedFaceValue: face, requested: 250, priorRedemptions: [took(100)] })
    expect(c.requested).toBe(250)
    expect(c.signedFaceValue).toBe(face)
  })
})

describe('the ceiling cannot be talked around', () => {
  it('is not raised by an outgoing row, however large', () => {
    // A caller sending its own issuance as history must not thereby increase
    // what it may take.
    const honest = checkCeiling({ signedFaceValue: 1000, requested: 700, priorRedemptions: [took(400)] })
    const padded = checkCeiling({
      signedFaceValue: 1000,
      requested: 700,
      priorRedemptions: [took(400), gave(10_000)],
    })
    expect(honest.allowed).toBe(false)
    expect(padded.allowed).toBe(false)
    expect(padded.alreadyRedeemed).toBe(honest.alreadyRedeemed)
  })

  it('is the same answer however the rows are ordered', () => {
    const a = checkCeiling({
      signedFaceValue: 1000,
      requested: 300,
      priorRedemptions: [took(400), gave(50), took(200)],
    })
    const b = checkCeiling({
      signedFaceValue: 1000,
      requested: 300,
      priorRedemptions: [took(200), took(400), gave(50)],
    })
    expect(a).toEqual(b)
  })

  it('does not mutate what it was given', () => {
    // It is handed a caller's array straight off a request body.
    const rows = [took(400), gave(100)]
    const before = JSON.stringify(rows)
    checkCeiling({ signedFaceValue: 1000, requested: 100, priorRedemptions: rows })
    expect(JSON.stringify(rows)).toBe(before)
  })
})
