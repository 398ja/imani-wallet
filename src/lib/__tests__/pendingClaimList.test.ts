/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_ENTRIES,
  carryPendingClaimsAcrossLogout,
  forgetPendingClaim,
  hasExpiredPendingClaim,
  listPendingClaims,
  markPendingClaimOffered,
  peekPendingClaim,
  peekPendingClaimFor,
  pendingClaimToResume,
  resetPendingClaimOffers,
  stashPendingClaim,
  takePendingClaim,
} from '../pendingClaim'
import { sweepAppStorage } from '../appStorage'

/**
 * Claim links phase 3 (docs/spec-claim-links.md 2.5, 8; review of #239, F4-1): parked claims are a
 * short LIST keyed by ref, each with its own 24 h age, and they survive logout.
 */
const A = 'aaaa1111bbbb2222'
const B = 'bbbb2222cccc3333'
const KA = 'A'.repeat(43)
const KB = 'B'.repeat(43)
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  localStorage.clear()
  resetPendingClaimOffers()
  vi.useRealTimers()
})

describe('parked claims are keyed by ref (F4-1)', () => {
  it('O4: a second link opened logged out does not overwrite the first', () => {
    stashPendingClaim(A, KA)
    stashPendingClaim(B, KB)
    expect(peekPendingClaimFor(A)?.key).toBe(KA)
    expect(peekPendingClaimFor(B)?.key).toBe(KB)
    expect(peekPendingClaim()?.ref).toBe(B)
  })

  it('forgetting one ref leaves the others', () => {
    stashPendingClaim(A, KA)
    stashPendingClaim(B, KB)
    forgetPendingClaim(B)
    expect(listPendingClaims().map((c) => c.ref)).toEqual([A])
  })

  it('parking the same ref again keeps one entry and makes it the newest', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    stashPendingClaim(A, KA)
    vi.setSystemTime(2_000)
    stashPendingClaim(B, KB)
    vi.setSystemTime(3_000)
    stashPendingClaim(A, KA)
    expect(listPendingClaims().map((c) => c.ref)).toEqual([B, A])
  })

  it('each entry ages on its own', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    stashPendingClaim(A, KA)
    vi.setSystemTime(DAY / 2)
    stashPendingClaim(B, KB)
    vi.setSystemTime(DAY + 1)
    expect(listPendingClaims().map((c) => c.ref)).toEqual([B])
    vi.setSystemTime(DAY + DAY / 2 + 1)
    expect(listPendingClaims()).toEqual([])
    expect(hasExpiredPendingClaim()).toBe(true)
  })

  it(`holds at most ${MAX_ENTRIES}, dropping the oldest`, () => {
    vi.useFakeTimers()
    for (let i = 0; i < MAX_ENTRIES + 2; i++) {
      vi.setSystemTime(1_000 + i)
      stashPendingClaim(`ref${i}xxxxxxxx`, KA)
    }
    const refs = listPendingClaims().map((c) => c.ref)
    expect(refs).toHaveLength(MAX_ENTRIES)
    expect(refs[0]).toBe('ref2xxxxxxxx')
  })

  it('reads a single-slot value from an older build as a list of one', () => {
    localStorage.setItem('imani-wallet:pending-claim', JSON.stringify({ ref: A, key: KA, at: Date.now() }))
    expect(peekPendingClaim()).toMatchObject({ kind: 'cashback', ref: A, key: KA })
    stashPendingClaim(B, KB)
    expect(listPendingClaims().map((c) => c.ref)).toEqual([A, B])
  })

  it('keeps kind and x, and nothing it was not given', () => {
    stashPendingClaim(A, KA, { kind: 'gift', x: 1_900_000_000 })
    const stored = JSON.parse(localStorage.getItem('imani-wallet:pending-claim')!) as unknown[]
    expect(Object.keys(stored[0] as object).sort()).toEqual(['at', 'key', 'kind', 'ref', 'x'])
    expect(peekPendingClaim()).toMatchObject({ kind: 'gift', x: 1_900_000_000 })
  })

  it('take consumes only the newest', () => {
    stashPendingClaim(A, KA)
    stashPendingClaim(B, KB)
    expect(takePendingClaim()?.ref).toBe(B)
    expect(listPendingClaims().map((c) => c.ref)).toEqual([A])
  })

  it('resumes the newest claim not yet offered to this account, then the next one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    stashPendingClaim(A, KA)
    vi.setSystemTime(2_000)
    stashPendingClaim(B, KB)
    const me = 'c'.repeat(64)
    expect(pendingClaimToResume(me)?.ref).toBe(B)
    markPendingClaimOffered(B, me)
    expect(pendingClaimToResume(me)?.ref).toBe(A)
    markPendingClaimOffered(A, me)
    expect(pendingClaimToResume(me)).toBeNull()
    // Another account on the same page session is still offered both.
    expect(pendingClaimToResume('d'.repeat(64))?.ref).toBe(B)
  })
})

describe('parked claims survive logout (spec 2.5)', () => {
  it('the sweep removes every other app key but keeps live parked claims, ages unchanged', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    stashPendingClaim(A, KA)
    stashPendingClaim(B, KB)
    localStorage.setItem('imani-wallet:profile:x', '{}')
    vi.setSystemTime(9_000)
    carryPendingClaimsAcrossLogout(sweepAppStorage)
    expect(localStorage.getItem('imani-wallet:profile:x')).toBeNull()
    expect(listPendingClaims().map((c) => [c.ref, c.key, c.at])).toEqual([[A, KA, 5_000], [B, KB, 5_000]])
  })

  it('an expired claim does not survive it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    stashPendingClaim(A, KA)
    vi.setSystemTime(DAY + 1)
    carryPendingClaimsAcrossLogout(sweepAppStorage)
    expect(localStorage.getItem('imani-wallet:pending-claim')).toBeNull()
  })
})
