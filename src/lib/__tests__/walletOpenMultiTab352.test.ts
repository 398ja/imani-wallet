/**
 * @vitest-environment jsdom
 */
/**
 * #352: logging in while other wallet tabs are open.
 *
 * Staging 0.33.0, reproduced in a real browser with two other tabs logged in
 * (Playwright, see #352): logout's `deleteDatabase` reported `blocked` (the other tabs
 * got `versionchange` and ignored it), `wipeWallet` resolved anyway, and the
 * next login's `open` of the same store queued behind that delete with NO event
 * at all. The screen read "Opening wallet…" for as long as the other tabs
 * lived; closing them opened it at once.
 *
 * Driven through the real `openWallet` / `wipeWallet` and the real
 * WalletStorage on fake-indexeddb, which implements the same versionchange,
 * blocked and queueing rules. "Another tab" is a second connection to the
 * same store: a raw one that ignores versionchange is a tab still on 0.33.0.
 */
import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalletStorage } from '@imani/wallet-storage'

import {
  PENDING_DELETE_GRACE_MS,
  onWalletOpenStatus,
  openWallet,
  resetReleaseForTests,
  retryOpenWallet,
  setBeforeWalletRelease,
  walletOpenStatus,
  wipeWallet,
  type WalletOpenStatus,
} from '../wallet'
import { releaseWalletForOtherTab } from '../walletHandover'
import { beginReceive, beginSpend, gatesSealed, openReceives, openSpends } from '../receiveGate'

vi.mock('../voucherRecords', () => ({
  publishVoucher: vi.fn().mockResolvedValue(undefined),
  tombstoneVoucher: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../txRecords', () => ({ publishTx: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../burn', () => ({ burnIfSelfIssued: vi.fn().mockResolvedValue(false) }))

const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timed out'> =>
  Promise.race([p, new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), ms))])

/** A tab on 0.33.0: holds the store and never answers versionchange. */
function oldTab(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`imani-wallet-${userId}`, 2)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('wallet_vouchers', { keyPath: 'token_id' })
      req.result.createObjectStore('wallet_transactions', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const deleteFromOtherTab = (userId: string) =>
  new Promise<'deleted'>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`imani-wallet-${userId}`)
    req.onsuccess = () => resolve('deleted')
    req.onerror = () => reject(req.error)
  })

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
  setBeforeWalletRelease(undefined)
  resetReleaseForTests()
  openReceives()
  openSpends()
  localStorage.clear()
})

function track(): WalletOpenStatus[] {
  const seen: WalletOpenStatus[] = []
  cleanup.push(onWalletOpenStatus((s) => seen.push(s)))
  return seen
}

describe('opening the wallet with other tabs open (#352)', () => {
  it('says "blocked" when a logout delete is held up by an old tab, then opens by itself once it closes', async () => {
    const userId = crypto.randomUUID()
    const old = await oldTab(userId)
    // This tab logs out: the delete is blocked by the old tab and wipeWallet resolves anyway.
    await wipeWallet(userId)

    const seen = track()
    const open = openWallet(userId)
    // The staging symptom: queued, no event, not open.
    expect(await within(open, PENDING_DELETE_GRACE_MS + 300)).toBe('timed out')
    // Now honest about why.
    expect(walletOpenStatus()).toBe('blocked')

    old.close() // the user closes the other tab
    const ws = await within(open, 1000)
    expect(ws).toBeInstanceOf(WalletStorage)
    expect(walletOpenStatus()).toBe('opening')
    expect(seen).toEqual(['opening', 'blocked', 'opening'])
    // Opened once, cleanly: the next login does not wait on a stale marker.
    expect(localStorage.getItem('imani-wallet:delete-pending')).toBeNull()
    cleanup.push(() => wipeWallet(userId))
  })

  it('this tab lets go when another tab logs out: writers stopped first, then "released"', async () => {
    const userId = crypto.randomUUID()
    const order: string[] = []
    setBeforeWalletRelease(() =>
      releaseWalletForOtherTab({
        stop: () => order.push('writers stopped'),
        drain: async () => {
          order.push('in-flight receive landed')
          return true
        },
      }),
    )
    await openWallet(userId)
    const seen = track()

    // Before #352 this never resolved: this tab's connection held the delete.
    expect(await within(deleteFromOtherTab(userId), 1000)).toBe('deleted')
    expect(order).toEqual(['writers stopped', 'in-flight receive landed'])
    expect(seen).toEqual(['released'])
    expect(walletOpenStatus()).toBe('released')
  })

  it('a login behind a blocked delete opens at once when the other tab is on the fixed wallet', async () => {
    const userId = crypto.randomUUID()
    // Another tab running this version: it answers versionchange.
    const other = new WalletStorage({ userId, channelName: `t-${userId}` })
    await other.init()
    cleanup.push(() => other.close())

    await wipeWallet(userId)
    const t0 = performance.now()
    const ws = await within(openWallet(userId), 1000)
    expect(ws).toBeInstanceOf(WalletStorage)
    expect(performance.now() - t0).toBeLessThan(500)
    cleanup.push(() => wipeWallet(userId))
  })

  it('Try again starts a fresh open; the abandoned one closes instead of installing a second handle', async () => {
    const userId = crypto.randomUUID()
    const old = await oldTab(userId)
    await wipeWallet(userId)
    const first = openWallet(userId)
    expect(await within(first, 100)).toBe('timed out')

    const second = retryOpenWallet(userId)
    old.close()
    const [a, b] = await Promise.all([first, second])
    // Both callers end up on the ONE handle that was installed.
    expect(b).toBeInstanceOf(WalletStorage)
    expect(a).toBe(b)
    expect(await b.getAllVouchers()).toEqual([])
    cleanup.push(() => wipeWallet(userId))
  })

  // ── Review of #353 ────────────────────────────────────────────────────────

  it('never lets go while a receive is still running, however long it takes: no coupon to a closed store', async () => {
    const userId = crypto.randomUUID()
    let landed = false
    let drains = 0
    setBeforeWalletRelease(() =>
      releaseWalletForOtherTab(
        {
          stop: () => {},
          // The first wait runs out with the redemption still past the mint swap.
          drain: async () => {
            drains += 1
            if (drains === 1) return false
            landed = true
            return true
          },
        },
        5,
        5,
      ),
    )
    await openWallet(userId)
    expect(await within(deleteFromOtherTab(userId), 1000)).toBe('deleted')
    expect(drains).toBe(2)
    expect(landed).toBe(true)
  })

  it('once released, the gates stay shut for good and the store is never opened again', async () => {
    const userId = crypto.randomUUID()
    setBeforeWalletRelease(() => releaseWalletForOtherTab({ stop: () => {}, drain: async () => true }))
    await openWallet(userId)
    expect(await within(deleteFromOtherTab(userId), 1000)).toBe('deleted')
    expect(walletOpenStatus()).toBe('released')

    // A resume from a refused logout in another tab cannot reopen them.
    openReceives()
    openSpends()
    expect(gatesSealed()).toBe(true)
    expect(() => beginReceive()).toThrow()
    expect(() => beginSpend()).toThrow()
    // Nor can anything open the store again behind the other tab's delete.
    await expect(openWallet(userId)).rejects.toThrow(/another tab/)
    await expect(retryOpenWallet(userId)).rejects.toThrow(/another tab/)
  })

  it("an open of one account does not forget another account's held-up delete", async () => {
    const a = crypto.randomUUID()
    const b = crypto.randomUUID()
    const old = await oldTab(a)
    await wipeWallet(a)
    expect(localStorage.getItem('imani-wallet:delete-pending')).toBe(a)
    await openWallet(b)
    expect(localStorage.getItem('imani-wallet:delete-pending')).toBe(a)
    old.close()
    cleanup.push(() => wipeWallet(b))
  })
})
