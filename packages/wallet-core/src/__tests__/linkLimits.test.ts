import { describe, expect, it } from 'vitest'

import {
  ABSOLUTE_MAX_OUTSTANDING,
  INDIVIDUAL_LIMITS,
  LinkLimitsConfigError,
  limitsFor,
  limitsForSender,
  linkAllowance,
  parseBusinessSenders,
  restoreGapFor,
  restoreScanEnd,
} from '../linkLimits'

const EMPLOYER = 'ab'.repeat(32)
const PERSON = 'cd'.repeat(32)

describe('limits per account type', () => {
  it('individuals keep Q5: 10 outstanding, 10 expired-unreturned, restore gap 20', () => {
    expect(INDIVIDUAL_LIMITS).toEqual({ accountType: 'individual', maxOutstanding: 10, maxExpiredUnreturned: 10, restoreGap: 20 })
  })

  it('a business gets the configured limit, a proportionate expired cap and a wider restore gap', () => {
    expect(limitsFor('business', 300)).toEqual({ accountType: 'business', maxOutstanding: 300, maxExpiredUnreturned: 300, restoreGap: 600 })
  })

  it('the restore gap is never below 20 and always at least twice the limit', () => {
    expect(restoreGapFor(1)).toBe(20)
    expect(restoreGapFor(10)).toBe(20)
    expect(restoreGapFor(11)).toBe(22)
    expect(restoreGapFor(500)).toBe(1000)
  })

  it('only a listed sender is a business; matching is case-insensitive', () => {
    const business = parseBusinessSenders(JSON.stringify({ maxOutstanding: 250, pubkeys: [EMPLOYER.toUpperCase()] }))
    expect(limitsForSender(EMPLOYER, business).maxOutstanding).toBe(250)
    expect(limitsForSender(PERSON, business)).toBe(INDIVIDUAL_LIMITS)
  })

  it('no list means nobody is a business', () => {
    for (const raw of [undefined, null, '', '  ']) expect(limitsForSender(EMPLOYER, parseBusinessSenders(raw))).toBe(INDIVIDUAL_LIMITS)
  })

  it('a malformed list refuses rather than guessing', () => {
    const bad = ['{', '[]', '{"pubkeys":"x"}', '{"pubkeys":["nope"]}', '{"pubkeys":[],"maxOutstanding":5}', `{"pubkeys":[],"maxOutstanding":${ABSOLUTE_MAX_OUTSTANDING + 1}}`, '{"pubkeys":[],"maxOutstanding":10.5}', '{"pubkeys":[],"extra":1}']
    for (const raw of bad) expect(() => parseBusinessSenders(raw), raw).toThrow(LinkLimitsConfigError)
  })
})

describe('linkAllowance', () => {
  const business = limitsFor('business', 50)
  it('allows up to the limit and says what remains', () => {
    expect(linkAllowance({ outstanding: 0, expiredUnreturned: 0 }, INDIVIDUAL_LIMITS)).toEqual({ ok: true, remaining: 9 })
    expect(linkAllowance({ outstanding: 9, expiredUnreturned: 0 }, INDIVIDUAL_LIMITS)).toEqual({ ok: true, remaining: 0 })
    expect(linkAllowance({ outstanding: 10, expiredUnreturned: 0 }, INDIVIDUAL_LIMITS)).toEqual({ ok: false, reason: 'too_many_outstanding', limit: 10 })
  })
  it('a batch is checked as a whole', () => {
    expect(linkAllowance({ outstanding: 45, expiredUnreturned: 0 }, business, 5)).toEqual({ ok: true, remaining: 0 })
    expect(linkAllowance({ outstanding: 45, expiredUnreturned: 0 }, business, 6)).toMatchObject({ ok: false, reason: 'too_many_outstanding' })
  })
  it('too many expired-unreturned blocks before the outstanding count is looked at', () => {
    expect(linkAllowance({ outstanding: 0, expiredUnreturned: 10 }, INDIVIDUAL_LIMITS)).toEqual({ ok: false, reason: 'too_many_expired', limit: 10 })
    expect(linkAllowance({ outstanding: 0, expiredUnreturned: 49 }, business)).toMatchObject({ ok: true })
  })
})

describe('restoreScanEnd', () => {
  it('scans past the higher of the local last index and the recorded high-water mark', () => {
    expect(restoreScanEnd(-1, -1, INDIVIDUAL_LIMITS)).toBe(19)
    expect(restoreScanEnd(5, -1, INDIVIDUAL_LIMITS)).toBe(25)
    const business = limitsFor('business', 100)
    // A device that lost its counter (lastKnown -1) still scans past the recorded high-water mark.
    expect(restoreScanEnd(-1, 340, business)).toBe(540)
  })
})
