/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearPendingClaim,
  stashPendingClaim,
  takePendingClaim,
} from '../pendingClaim'

/**
 * Parking a claim across the walk to a wallet.
 *
 * The journey under test is the one that used to lose vouchers outright: a
 * customer with no wallet opens a bearer claim link, leaves to install the app,
 * and comes back. The claim must survive that and must not survive much else.
 */
describe('pendingClaim', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useRealTimers()
  })

  it('carries a claim across a round trip', () => {
    stashPendingClaim('abc12345', 'k'.repeat(43))

    const got = takePendingClaim()
    expect(got?.ref).toBe('abc12345')
    expect(got?.key).toBe('k'.repeat(43))
  })

  it('survives the tab closing, which sessionStorage would not', () => {
    // Installing an app means leaving and coming back in a NEW tab. This is the
    // whole reason this module uses localStorage while `onboardingHandoff` uses
    // sessionStorage for an nsec.
    stashPendingClaim('abc12345', 'k'.repeat(43))
    sessionStorage.clear()

    expect(takePendingClaim()?.ref).toBe('abc12345')
  })

  it('is consumed on read, so it cannot be replayed onto a second account', () => {
    stashPendingClaim('abc12345', 'k'.repeat(43))

    expect(takePendingClaim()).not.toBeNull()
    expect(takePendingClaim()).toBeNull()
  })

  it('refuses a claim older than a day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    stashPendingClaim('abc12345', 'k'.repeat(43))

    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'))
    expect(takePendingClaim()).toBeNull()
  })

  it('keeps a claim parked for a plausible install', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    stashPendingClaim('abc12345', 'k'.repeat(43))

    // Long enough to find the app store, install, and come back.
    vi.setSystemTime(new Date('2026-01-01T00:30:00Z'))
    expect(takePendingClaim()?.ref).toBe('abc12345')
  })

  it('returns null rather than throwing on a corrupted entry', () => {
    localStorage.setItem('imani-wallet:pending-claim', 'not json')
    expect(takePendingClaim()).toBeNull()

    localStorage.setItem('imani-wallet:pending-claim', JSON.stringify({ ref: 'x' }))
    expect(takePendingClaim()).toBeNull()

    localStorage.setItem('imani-wallet:pending-claim', JSON.stringify([1, 2, 3]))
    expect(takePendingClaim()).toBeNull()
  })

  it('removes a corrupted entry rather than leaving it to fail forever', () => {
    localStorage.setItem('imani-wallet:pending-claim', 'not json')
    takePendingClaim()
    expect(localStorage.getItem('imani-wallet:pending-claim')).toBeNull()
  })

  it('can be dropped without being acted on', () => {
    stashPendingClaim('abc12345', 'k'.repeat(43))
    clearPendingClaim()
    expect(takePendingClaim()).toBeNull()
  })

  it('does not throw when storage is unavailable', () => {
    // Private browsing, a full quota, or a locked-down embedded webview. The
    // customer loses the resumption, never the voucher they still hold in the
    // URL.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => stashPendingClaim('abc12345', 'k'.repeat(43))).not.toThrow()
    setItem.mockRestore()

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(takePendingClaim()).toBeNull()
    getItem.mockRestore()
  })
})
