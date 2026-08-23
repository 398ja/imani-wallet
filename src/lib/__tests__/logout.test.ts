import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Logout has to end the DOCUMENT, not just the session.
 *
 * Everything else logout does erases what was stored. But this is a SPA, and the
 * page-lifetime module caches of the logged-out user survive a route change —
 * legacyBridge's memoised binding to the WalletStorage that `wipeWallet` has
 * just deleted worst of all, because the next login's coupons were then swapped
 * at the mint and written into the dead store, burnt and unrecoverable. Hence
 * the reload, and hence this test: it is a one-line call that is easy to drop in
 * a refactor and whose absence is silent until someone loses money.
 */

const order: string[] = []

vi.mock('../nap', () => ({
  getSession: () => ({ logout: vi.fn().mockResolvedValue(undefined) }),
  keyStore: { clear: vi.fn().mockResolvedValue(undefined) },
  resetSession: vi.fn(),
}))
vi.mock('../dmPoll', () => ({ stopDmPoll: vi.fn() }))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn() }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => {
    order.push('wipe')
  }),
}))

const { logout } = await import('../logout')
const { wipeWallet } = await import('../wallet')

const yes = () => true
const no = () => false
const reload = vi.fn(() => {
  order.push('reload')
})

beforeEach(() => {
  order.length = 0
  reload.mockClear()
  vi.mocked(wipeWallet).mockClear()
  // The module clears every `imani-wallet:*` key; the test env has no DOM.
  globalThis.localStorage = { 'imani-wallet:x': '1' } as unknown as Storage
  globalThis.localStorage.removeItem = () => {}
})

describe('logout', () => {
  it('reloads the page, after the data is gone', async () => {
    await expect(logout('ab'.repeat(32), yes, reload)).resolves.toBe(true)

    expect(reload).toHaveBeenCalledOnce()
    // Order is the point: reloading first would abandon the teardown midway and
    // leave the wallet on disk.
    expect(order).toEqual(['wipe', 'reload'])
  })

  it('leaves the page alone when the user cancels', async () => {
    await expect(logout('ab'.repeat(32), no, reload)).resolves.toBe(false)

    expect(reload).not.toHaveBeenCalled()
    expect(wipeWallet).not.toHaveBeenCalled()
  })
})
