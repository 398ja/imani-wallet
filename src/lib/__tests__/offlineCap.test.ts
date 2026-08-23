import { describe, expect, it, beforeEach, vi } from 'vitest'

// The suite runs in node, so there is no localStorage. Same approach as
// backup.test.ts, but a working store rather than a spy — these tests are about
// what survives a round trip.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

import {
  MAX_OFFLINE_CAP,
  checkOfflineRedemption,
  clearProvisional,
  getOfflineCap,
  listProvisional,
  offlineOutstanding,
  recordProvisional,
  setOfflineCap,
  validOfflineCap,
} from '../offlineCap'

const PUBKEY = 'a'.repeat(64)

beforeEach(() => {
  store.clear()
})

describe('validOfflineCap', () => {
  it('accepts whole minor-unit amounts in range', () => {
    expect(validOfflineCap(0)).toBe(0)
    expect(validOfflineCap(2000)).toBe(2000)
    expect(validOfflineCap('2000')).toBe(2000)
    expect(validOfflineCap(MAX_OFFLINE_CAP)).toBe(MAX_OFFLINE_CAP)
  })

  it('rejects anything that is not a whole amount in range', () => {
    expect(validOfflineCap(-1)).toBeNull()
    expect(validOfflineCap(12.5)).toBeNull()
    expect(validOfflineCap('abc')).toBeNull()
    expect(validOfflineCap(MAX_OFFLINE_CAP + 1)).toBeNull()
  })

  it('reads a half-typed field as null, distinct from an absent cap', () => {
    // The form holds null mid-typing; getOfflineCap reads absent as 0. Conflating
    // them would let an unfinished entry save as "accept nothing" silently.
    expect(validOfflineCap('')).toBeNull()
    expect(validOfflineCap(undefined)).toBeNull()
  })
})

describe('getOfflineCap', () => {
  it('is zero when never set — the whole point of the default', () => {
    expect(getOfflineCap(PUBKEY)).toBe(0)
  })

  it('round-trips a stored cap', () => {
    setOfflineCap(PUBKEY, 2000)
    expect(getOfflineCap(PUBKEY)).toBe(2000)
  })

  it('is per merchant, so two accounts on one device do not share a ceiling', () => {
    setOfflineCap(PUBKEY, 2000)
    expect(getOfflineCap('b'.repeat(64))).toBe(0)
  })

  it('reads corrupted storage as zero rather than trusting it', () => {
    localStorage.setItem(`imani-wallet:offline-cap:${PUBKEY}`, 'not-a-number')
    expect(getOfflineCap(PUBKEY)).toBe(0)
  })

  it('clears back to refusing', () => {
    setOfflineCap(PUBKEY, 2000)
    setOfflineCap(PUBKEY, null)
    expect(getOfflineCap(PUBKEY)).toBe(0)
  })
})

describe('checkOfflineRedemption', () => {
  it('refuses everything when no cap is set', () => {
    expect(checkOfflineRedemption(PUBKEY, 1)).toMatchObject({
      allowed: false,
      cap: 0,
      remaining: 0,
    })
  })

  it('allows a redemption inside the cap', () => {
    setOfflineCap(PUBKEY, 2000)
    expect(checkOfflineRedemption(PUBKEY, 500)).toMatchObject({
      allowed: true,
      remaining: 2000,
    })
  })

  it('bounds the TOTAL outstanding, not each redemption', () => {
    // The reason a per-redemption cap is not enough: three coupons each under
    // the ceiling would otherwise all be accepted.
    setOfflineCap(PUBKEY, 2000)
    recordProvisional(PUBKEY, { voucherId: 'v1', amount: 900, at: 1 })
    recordProvisional(PUBKEY, { voucherId: 'v2', amount: 900, at: 2 })

    expect(offlineOutstanding(PUBKEY)).toBe(1800)
    expect(checkOfflineRedemption(PUBKEY, 900)).toMatchObject({
      allowed: false,
      outstanding: 1800,
      remaining: 200,
    })
    expect(checkOfflineRedemption(PUBKEY, 200).allowed).toBe(true)
  })

  it('allows exactly the remaining allowance', () => {
    setOfflineCap(PUBKEY, 1000)
    recordProvisional(PUBKEY, { voucherId: 'v1', amount: 600, at: 1 })
    expect(checkOfflineRedemption(PUBKEY, 400).allowed).toBe(true)
    expect(checkOfflineRedemption(PUBKEY, 401).allowed).toBe(false)
  })
})

describe('the settle queue', () => {
  it('frees allowance as entries reconcile', () => {
    setOfflineCap(PUBKEY, 2000)
    const first = { voucherId: 'v1', amount: 1500, at: 1 }
    recordProvisional(PUBKEY, first)
    expect(checkOfflineRedemption(PUBKEY, 600).allowed).toBe(false)

    clearProvisional(PUBKEY, first)
    expect(checkOfflineRedemption(PUBKEY, 600).allowed).toBe(true)
  })

  it('clears one redemption of a voucher without freeing the others', () => {
    // One voucher can legitimately be redeemed more than once, so clearing by
    // voucherId alone would release allowance still genuinely at risk.
    setOfflineCap(PUBKEY, 5000)
    const a = { voucherId: 'v1', amount: 400, at: 10 }
    const b = { voucherId: 'v1', amount: 700, at: 20 }
    recordProvisional(PUBKEY, a)
    recordProvisional(PUBKEY, b)

    clearProvisional(PUBKEY, a)

    expect(listProvisional(PUBKEY)).toEqual([b])
    expect(offlineOutstanding(PUBKEY)).toBe(700)
  })

  it('treats an unreadable queue as empty rather than throwing at the till', () => {
    localStorage.setItem(`imani-wallet:offline-queue:${PUBKEY}`, '{not json')
    expect(() => offlineOutstanding(PUBKEY)).not.toThrow()
    expect(offlineOutstanding(PUBKEY)).toBe(0)
  })

  it('discards malformed entries instead of counting them as NaN', () => {
    // One bad row must not poison the sum — NaN would make every comparison
    // false and silently refuse every redemption.
    localStorage.setItem(
      `imani-wallet:offline-queue:${PUBKEY}`,
      JSON.stringify([{ voucherId: 'v1', amount: 500, at: 1 }, { nonsense: true }]),
    )
    expect(offlineOutstanding(PUBKEY)).toBe(500)
  })
})
