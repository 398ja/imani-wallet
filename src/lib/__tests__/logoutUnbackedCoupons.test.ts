import { describe, expect, it, vi } from 'vitest'

/**
 * Logout deletes the device copy of every coupon. For a coupon with no
 * confirmed backup that is the only copy, and the ordinary warning promises
 * it comes back. The user must be told the truth before they confirm.
 */

vi.mock('../nap', () => ({
  getSession: () => ({ logout: vi.fn().mockResolvedValue(undefined) }),
  keyStore: { clear: vi.fn().mockResolvedValue(undefined) },
  resetSession: vi.fn(),
}))
vi.mock('../dmPoll', () => ({ stopDmPoll: vi.fn() }))
vi.mock('../terminalRosterSyncNet', () => ({ stopRosterSync: vi.fn() }))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn() }))
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => undefined) }))
vi.mock('../resume', () => ({ forgetResume: vi.fn() }))
vi.mock('../wallet', () => ({ wipeWallet: vi.fn(async () => undefined) }))
vi.mock('../voucherRecords', () => ({ couponsWithoutBackup: vi.fn(async () => []) }))

globalThis.localStorage = { removeItem: () => {} } as unknown as Storage

const { logout, LOGOUT_WARNING } = await import('../logout')
const { wipeWallet } = await import('../wallet')

const PK = 'cd'.repeat(32)

describe('logout and coupons with no confirmed backup', () => {
  it('asks the ordinary question when every coupon is backed up', async () => {
    const asked: string[] = []
    await logout(PK, (m) => (asked.push(m), false), () => {}, async () => [])
    expect(asked).toEqual([LOGOUT_WARNING])
  })

  it('names the unbacked coupons and does NOT wipe when the user declines', async () => {
    vi.mocked(wipeWallet).mockClear()
    const asked: string[] = []
    const done = await logout(PK, (m) => (asked.push(m), false), () => {}, async () => [{}, {}])

    expect(done).toBe(false)
    expect(asked[0]).toMatch(/2 vouchers you hold are NOT backed up/)
    expect(asked[0]).toMatch(/cannot be restored/)
    expect(wipeWallet).not.toHaveBeenCalled()
  })

  it('treats a failed check as a question asked the ordinary way, not a crash', async () => {
    const done = await logout(PK, () => false, () => {}, async () => {
      throw new Error('offline')
    })
    expect(done).toBe(false)
  })

  it('the ordinary warning no longer promises a re-receive that cannot happen', () => {
    expect(LOGOUT_WARNING).not.toMatch(/as they are received again/)
  })
})
