// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({ restore: 0, prune: 0, resume: undefined as undefined | (() => void) }))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, fn: () => void) => {
      if (name === 'resume') calls.resume = fn
      return { remove: async () => { calls.resume = undefined } }
    },
  },
}))
vi.mock('../voucherRecords', () => ({
  restoreVouchers: async () => { calls.restore++; return 0 },
  pruneMintSpent: async () => { calls.prune++; return 0 },
}))

import { MIN_INTERVAL_MS, reconcileOnResume, reconcileWallet, resetReconcileForTests } from '../walletReconcile'

beforeEach(() => {
  calls.restore = 0
  calls.prune = 0
  resetReconcileForTests()
})

describe('walletReconcile', () => {
  it('re-reads the relay and then asks the mint', async () => {
    await reconcileWallet('pk', 1_000_000)
    expect([calls.restore, calls.prune]).toEqual([1, 1])
  })

  it('is throttled so a flurry of resumes is one pass', async () => {
    await reconcileWallet('pk', 1_000_000)
    await reconcileWallet('pk', 1_000_000 + MIN_INTERVAL_MS - 1)
    expect(calls.restore).toBe(1)
    await reconcileWallet('pk', 1_000_000 + MIN_INTERVAL_MS)
    expect(calls.restore).toBe(2)
  })

  it('runs on Capacitor resume and on visibilitychange, and stops cleanly', async () => {
    const stop = reconcileOnResume('pk')
    await Promise.resolve()
    calls.resume?.()
    await vi.waitFor(() => expect(calls.restore).toBe(1))
    resetReconcileForTests()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(calls.restore).toBe(2))
    stop()
    resetReconcileForTests()
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(calls.restore).toBe(2)
  })
})
