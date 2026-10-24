/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Claim links phase 3 (spec 2.5, CL-SWITCH): the real `logout` keeps the parked claim links and
 * still erases every other `imani-wallet:*` key.
 */
vi.mock('../nap', () => ({
  getSession: () => ({ logout: vi.fn().mockResolvedValue(undefined) }),
  keyStore: { clear: vi.fn().mockResolvedValue(undefined) },
  resetSession: vi.fn(),
}))
vi.mock('../dmPoll', () => ({ stopDmPoll: vi.fn(), startDmPoll: vi.fn(), drainDmPoll: vi.fn(async () => true) }))
vi.mock('../terminalRosterSyncNet', () => ({ stopRosterSync: vi.fn(), startRosterSync: vi.fn() }))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn(), startIncomingNotifications: vi.fn() }))
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => undefined) }))
// Every held voucher confirmed: these pin the teardown. The BLOCK is pinned in
// logoutUnbackedCoupons.test.ts and end to end in restoreAfterLogout.test.ts.
vi.mock('../voucherRecords', () => ({
  confirmBackups: vi.fn(async () => ({ ok: true, confirmed: 0, fingerprint: '' })),
  heldFingerprint: () => '',
}))
vi.mock('../resume', () => ({ forgetResume: vi.fn() }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => undefined),
  openWallet: async () => ({ getAllVouchers: async () => [], getAllTransactions: async () => [] }),
  voucherWriteCount: () => 0,
}))

const { logout } = await import('../logout')
const { listPendingClaims, stashPendingClaim } = await import('../pendingClaim')

const REF = 'abcd1234efgh5678'
const KEY = 'K'.repeat(43)

beforeEach(() => localStorage.clear())

describe('logout and the parked claim', () => {
  it('keeps the parked claim and erases the account data', async () => {
    stashPendingClaim(REF, KEY)
    localStorage.setItem('imani-wallet:profile:' + 'a'.repeat(64), '{"name":"X"}')
    localStorage.setItem('imani:cashback:pending', '["cashuBxyz"]')

    // The stash is backed up and confirmed first (#331); this pins the teardown after that.
    const checkStash = async () => ({ ok: true as const, fingerprint: 'cashuBxyz', count: 1 })
    await expect(logout('a'.repeat(64), () => true, () => {}, { checkStash, stashNow: () => 'cashuBxyz' })).resolves.toBe(true)

    expect(listPendingClaims().map((c) => [c.ref, c.key])).toEqual([[REF, KEY]])
    expect(localStorage.getItem('imani-wallet:profile:' + 'a'.repeat(64))).toBeNull()
    // The cashback token stash is outside the swept prefix and must stay (spec 2.5).
    expect(localStorage.getItem('imani:cashback:pending')).toBe('["cashuBxyz"]')
  })

  it('cancelling keeps everything', async () => {
    stashPendingClaim(REF, KEY)
    await expect(logout('a'.repeat(64), () => false, () => {})).resolves.toBe(false)
    expect(listPendingClaims()).toHaveLength(1)
  })
})
