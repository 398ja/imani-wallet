/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #348: the key backup gate is pinned in logoutKeyBackup348.test.ts. Here the key is backed up.
vi.mock('../keyBackups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../keyBackups')>()),
  checkKeyBackup: async () => ({ ok: true, backups: [] }),
}))

/**
 * #558: the account-deletion hook inside the real attemptLogout.
 */

const calls: string[] = []
const fail = vi.hoisted(() => ({ roster: false }))
vi.mock('../nap', () => ({
  getSession: () => ({ logout: vi.fn(async () => void calls.push('session-logout')) }),
  keyStore: { clear: vi.fn(async () => void calls.push('key-clear')) },
  resetSession: vi.fn(),
}))
vi.mock('../dmPoll', () => ({
  stopDmPoll: vi.fn(() => void calls.push('stop-dm')),
  startDmPoll: vi.fn(() => void calls.push('start-dm')),
  drainDmPoll: vi.fn(async () => true),
}))
vi.mock('../terminalRosterSyncNet', () => ({
  stopRosterSync: vi.fn(() => {
    if (fail.roster) throw new Error('roster stop failed')
  }),
  startRosterSync: vi.fn(() => {
    throw new Error('roster start failed too')
  }),
}))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn(), startIncomingNotifications: vi.fn() }))
vi.mock('../resume', () => ({ forgetResume: vi.fn() }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => void calls.push('wipe')),
  openWallet: vi.fn(async () => ({ getAllVouchers: async () => [], getAllTransactions: async () => [] })),
  voucherWriteCount: () => 0,
}))
vi.mock('../voucherRecords', () => ({
  confirmBackups: vi.fn(async () => ({ ok: true, confirmed: 0, fingerprint: '' })),
  heldFingerprint: () => '',
}))

const gate = await import('../receiveGate')

const PK = 'cd'.repeat(32)
const okStash = async () => ({ ok: true as const, fingerprint: '', count: 0 })
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => void calls.push('push-unsubscribe')) }))
const { deleteAccount, forgetDeletedHandles } = await import('../accountDeletion')


beforeEach(() => {
  calls.length = 0
  forgetDeletedHandles()
  gate.openReceives()
  gate.openSpends()
})

const base = (stillPaused: () => Promise<boolean> = async () => true) => {
  // A code saved since step 1c, so the 4c re-check runs: the hook must come after it.
  let checked = 0
  return {
  checkStash: okStash,
  checkCodes: async () => {
    calls.push(checked === 0 ? 'codes-check' : 'codes-recheck-4c')
    return { ok: true as const, fingerprint: checked++ === 0 ? 'c0' : 'c1' }
  },
  codesNow: () => (checked === 0 ? 'c0' : 'c1'),
  inFlight: () => {
    calls.push('in-flight-check')
    return { sends: 0, swaps: 0 }
  },
  strandedLinks: async () => 0,
  receivesNow: () => 0,
  pauseTabs: async () => ({ ok: true as const, tabs: { stillPaused, resume: () => {}, done: () => {} } }),
  }
}

describe('the DELETE runs as late as possible in the real attemptLogout', () => {
  it('after every reversible check, before push unsubscribe and the wipe', async () => {
    const del = vi.fn(async () => {
      calls.push('DELETE')
      return 'deleted' as const
    })
    const out = await deleteAccount(PK, 'duran@imani.casa', { deleteHandle: del, logoutDeps: base(), reload: () => calls.push('reload') })
    expect(out).toEqual({ status: 'done' })
    const at = (s: string) => calls.indexOf(s)
    expect(at('stop-dm')).toBeLessThan(at('DELETE'))
    expect(at('codes-recheck-4c')).toBeGreaterThan(-1)
    expect(at('codes-recheck-4c')).toBeLessThan(at('DELETE'))
    expect(calls.lastIndexOf('in-flight-check')).toBeLessThan(at('DELETE'))
    expect(at('DELETE')).toBeLessThan(at('push-unsubscribe'))
    expect(at('push-unsubscribe')).toBeLessThan(at('wipe'))
  })

  it('a refusal after a successful DELETE is deleted-logout-pending; the retry never DELETEs again and Finish logs out', async () => {
    let checks = 0
    // Passes at the pre-hook check, fails at the re-check after disableNotifications.
    const flaky = async () => ++checks !== 2
    const del = vi.fn(async () => 'deleted' as const)
    const first = await deleteAccount(PK, 'duran@imani.casa', { deleteHandle: del, logoutDeps: base(flaky) })
    expect(first.status).toBe('deleted-logout-pending')
    expect(calls).not.toContain('wipe')
    expect(del).toHaveBeenCalledTimes(1)

    const again = await deleteAccount(PK, 'duran@imani.casa', { deleteHandle: del, logoutDeps: base(), reload: () => {} })
    expect(again).toEqual({ status: 'done' })
    expect(del).toHaveBeenCalledTimes(1)
    expect(calls).toContain('wipe')
  })

  it('a refusal of the DELETE (404) erases nothing and restarts the writers', async () => {
    const out = await deleteAccount(PK, 'duran@imani.casa', { deleteHandle: async () => 'unknown', logoutDeps: base() })
    expect(out).toEqual({ status: 'failed', reason: 'unknown' })
    expect(calls).not.toContain('wipe')
    expect(calls).not.toContain('push-unsubscribe')
    expect(calls).toContain('start-dm')
    expect(() => gate.beginReceive()()).not.toThrow()
  })
})
