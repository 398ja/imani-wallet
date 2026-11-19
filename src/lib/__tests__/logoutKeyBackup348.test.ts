import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #348: `attemptLogout` refuses, with NO override, until a known backup holds this key. Refused
 * before anything is asked, stopped or erased. A terminal (no backup key) is not asked. The
 * confirmation names where the key is and says not to delete it.
 */

const calls: string[] = []

vi.mock('../nap', () => ({
  getSession: () => ({ logout: vi.fn(async () => void calls.push('session-logout')) }),
  keyStore: { clear: vi.fn(async () => void calls.push('key-clear')) },
  resetSession: vi.fn(),
}))
vi.mock('../dmPoll', () => ({
  stopDmPoll: vi.fn(() => void calls.push('stop-dm')),
  startDmPoll: vi.fn(),
  drainDmPoll: vi.fn(async () => true),
}))
vi.mock('../terminalRosterSyncNet', () => ({ stopRosterSync: vi.fn(), startRosterSync: vi.fn() }))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn(), startIncomingNotifications: vi.fn() }))
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => undefined) }))
vi.mock('../resume', () => ({ forgetResume: vi.fn() }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => void calls.push('wipe')),
  openWallet: async () => ({ getAllVouchers: async () => [], getAllTransactions: async () => [] }),
  voucherWriteCount: () => 0,
}))
vi.mock('../voucherRecords', () => ({ confirmBackups: vi.fn(async () => ({ ok: true, confirmed: 0, fingerprint: '' })), heldFingerprint: () => '' }))

globalThis.localStorage = { removeItem: () => {}, getItem: () => null } as unknown as Storage

const { attemptLogout, LOGOUT_WARNING, LOGOUT_BLOCKED_COPY } = await import('../logout')
const { blockedMessage } = await import('../logoutBlockedCopy')

const PK = 'cd'.repeat(32)
const DRIVE = {
  location: 'drive' as const,
  deviceId: 'd1',
  deviceName: 'Chrome on Android',
  createdAt: 1,
  lastVerifiedAt: 1,
  keyFingerprint: 'a'.repeat(16),
}
const base = {
  checkBackups: async () => ({ ok: true as const, confirmed: 0, fingerprint: '' }),
  checkStash: async () => ({ ok: true as const, fingerprint: '', count: 0 }),
  stashNow: () => '',
  checkCodes: async () => ({ ok: true as const, fingerprint: '' }),
  codesNow: () => '',
  inFlight: () => ({ sends: 0, swaps: 0 }),
  settleInFlight: async () => {},
  strandedLinks: async () => 0,
  drainReceives: async () => true,
  receivesNow: () => 0,
  heldNow: async () => '',
  writeCount: () => 0,
  isTerminal: () => false,
  pauseTabs: async () => ({
    ok: true as const,
    tabs: { resume: () => {}, done: () => {}, stillPaused: async () => true },
  }),
}

beforeEach(() => {
  calls.length = 0
})

describe('#348 logout refuses until the key backup is known', () => {
  it('no known backup: blocked before anything is asked, stopped or erased', async () => {
    const asked: string[] = []
    const out = await attemptLogout(PK, (m) => (asked.push(m), true), () => {}, {
      ...base,
      checkKey: async () => ({ ok: false, backups: [] }),
    })
    expect(out).toMatchObject({ status: 'blocked', reason: 'key-not-backed-up' })
    expect(asked).toEqual([])
    expect(calls).toEqual([])
    if (out.status === 'blocked') expect(blockedMessage(out)).toBe(LOGOUT_BLOCKED_COPY.keyNotBackedUp)
  })

  it('a check that throws blocks, it never reads as backed up', async () => {
    const out = await attemptLogout(PK, () => true, () => {}, {
      ...base,
      checkKey: async () => {
        throw new Error('boom')
      },
    })
    expect(out).toMatchObject({ status: 'blocked', reason: 'key-not-backed-up' })
    expect(calls).not.toContain('wipe')
  })

  it('one known backup: the confirmation says where the key is and not to delete it, then logs out', async () => {
    const asked: string[] = []
    const out = await attemptLogout(PK, (m) => (asked.push(m), true), () => {}, {
      ...base,
      checkKey: async () => ({ ok: true, backups: [DRIVE] }),
    })
    expect(out).toEqual({ status: 'done' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/Your key is backed up here:/)
    expect(asked[0]).toMatch(/Google Drive/)
    expect(asked[0]).toMatch(/Do not delete it/)
    expect(asked[0].endsWith(LOGOUT_WARNING)).toBe(true)
    expect(calls).toContain('wipe')
  })

  it('a terminal is not asked for a key backup it cannot have', async () => {
    const checkKey = vi.fn(async () => ({ ok: false as const, backups: [] }))
    const out = await attemptLogout(PK, () => true, () => {}, { ...base, isTerminal: () => true, checkKey })
    expect(out).toEqual({ status: 'done' })
    expect(checkKey).not.toHaveBeenCalled()
  })

  it('there is no override: no dep, flag or copy lets an unbacked key log out', async () => {
    expect(LOGOUT_BLOCKED_COPY.keyNotBackedUp).not.toMatch(/anyway/i)
    const out = await attemptLogout(PK, () => true, () => {}, {
      ...base,
      checkKey: async () => ({ ok: false, backups: [DRIVE] }),
    })
    expect(out.status).toBe('blocked')
  })
})
