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
vi.mock('../dmPoll', () => ({ stopDmPoll: vi.fn(), startDmPoll: vi.fn(), drainDmPoll: vi.fn(async () => true) }))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn(), startIncomingNotifications: vi.fn() }))
vi.mock('../terminalRosterSyncNet', () => ({ stopRosterSync: vi.fn(), startRosterSync: vi.fn() }))
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => undefined) }))
import { disableNotifications } from '../notifications/manager'
const forgetResume = vi.fn(() => {
  order.push('forget-resume')
})
// Every held voucher confirmed: these pin the teardown. The BLOCK is pinned in
// logoutUnbackedCoupons.test.ts and end to end in restoreAfterLogout.test.ts.
vi.mock('../voucherRecords', () => ({
  confirmBackups: vi.fn(async () => ({ ok: true, confirmed: 0, fingerprint: '' })),
  heldFingerprint: () => '',
}))
vi.mock('../resume', () => ({ forgetResume: () => forgetResume() }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => {
    order.push('wipe')
  }),
  openWallet: async () => ({ getAllVouchers: async () => [], getAllTransactions: async () => [] }),
  voucherWriteCount: () => 0,
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
  forgetResume.mockClear()
  vi.mocked(wipeWallet).mockClear()
  vi.mocked(disableNotifications).mockClear()
  // The module clears every `imani-wallet:*` key; the test env has no DOM.
  globalThis.localStorage = { 'imani-wallet:x': '1' } as unknown as Storage
  globalThis.localStorage.removeItem = () => {}
  globalThis.localStorage.getItem = () => null
})

describe('logout', () => {
  it('reloads the page, after the data is gone', async () => {
    await expect(logout('ab'.repeat(32), yes, reload)).resolves.toBe(true)

    expect(reload).toHaveBeenCalledOnce()
    // Order is the point: reloading first would abandon the teardown midway and
    // leave the wallet on disk.
    expect(order).toEqual(['forget-resume', 'wipe', 'reload'])
  })

  /**
   * The reload cache holds a wrapped copy of the very key logout erases. Leaving
   * it would let the reload on the last line walk straight back into the session
   * the user just asked to leave — the same failure as skipping keyStore.clear(),
   * by a different door.
   */
  it('clears the reload cache, before the page comes back', async () => {
    await logout('ab'.repeat(32), yes, reload)

    expect(forgetResume).toHaveBeenCalledOnce()
    expect(order.indexOf('forget-resume')).toBeLessThan(order.indexOf('reload'))
  })

  /**
   * Logout promises "This erases your key AND all your data from this browser",
   * and it stops the DM poller and the drain loop for exactly that reason. A
   * push subscription is the one piece of this account's state that lives
   * somewhere localStorage cannot reach: in the browser's push service and in
   * the gateway's push_subscription table.
   *
   * Left behind, the server keeps pushing this account's coupon events to a
   * device that has just erased the key, so a shared or borrowed phone shows
   * the previous user's activity on the lock screen. That is the same failure
   * the wholesale localStorage wipe above exists to prevent, by a different
   * door.
   */
  it('cancels the push subscription, so the device stops receiving this account', async () => {
    await logout('ab'.repeat(32), yes, reload)

    expect(disableNotifications).toHaveBeenCalledWith('ab'.repeat(32))
  })

  it('logs out even when cancelling the push subscription fails', async () => {
    // An unreachable gateway must not strand the user in a session they asked
    // to leave, exactly as with session.logout() above.
    vi.mocked(disableNotifications).mockRejectedValueOnce(new Error('offline'))

    await expect(logout('ab'.repeat(32), yes, reload)).resolves.toBe(true)
    expect(wipeWallet).toHaveBeenCalled()
    expect(reload).toHaveBeenCalled()
  })

  it('leaves the push subscription alone when the user cancels', async () => {
    await logout('ab'.repeat(32), no, reload)

    expect(disableNotifications).not.toHaveBeenCalled()
  })

  it('leaves the page alone when the user cancels', async () => {
    await expect(logout('ab'.repeat(32), no, reload)).resolves.toBe(false)

    expect(reload).not.toHaveBeenCalled()
    expect(wipeWallet).not.toHaveBeenCalled()
    // And the cache stays, because the user is still logged in.
    expect(forgetResume).not.toHaveBeenCalled()
  })
})

describe('logout keeps the settled-but-unsaved record (#112)', () => {
  it('sweeps every imani-wallet key except unsaved-receipts', async () => {
    const pk = 'ab'.repeat(32)
    const store: Record<string, string> = {
      [`imani-wallet:unsaved-receipts:${pk}`]: '[]',
      [`imani-wallet:receive-ledger:${pk}`]: '[]',
      [`imani-wallet:notifications:${pk}`]: '[]',
      'other-app': '1',
    }
    const removed: string[] = []
    globalThis.localStorage = Object.assign(Object.create(null), store) as unknown as Storage
    Object.defineProperty(globalThis.localStorage, 'removeItem', {
      value: (k: string) => removed.push(k),
      enumerable: false,
    })

    await logout(pk, yes, reload)

    expect(removed.sort()).toEqual([`imani-wallet:notifications:${pk}`, `imani-wallet:receive-ledger:${pk}`])
  })
})
