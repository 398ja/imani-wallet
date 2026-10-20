/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #335 items 2 and 4, at logout itself:
 * - a stop function that throws mid-logout must not leave receiving (or sending)
 *   paused until a reload;
 * - other tabs that cannot be paused BLOCK the logout, before anything is stopped;
 * - a send running in this tab is waited for, and one still running blocks.
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
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => undefined) }))
vi.mock('../resume', () => ({ forgetResume: vi.fn() }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => void calls.push('wipe')),
  openWallet: vi.fn(async () => ({ getAllVouchers: async () => [] })),
  voucherWriteCount: () => 0,
}))
vi.mock('../voucherRecords', () => ({
  confirmBackups: vi.fn(async () => ({ ok: true, confirmed: 0, fingerprint: '' })),
  heldFingerprint: () => '',
}))

const { attemptLogout, LOGOUT_BLOCKED_COPY } = await import('../logout')
const { blockedMessage } = await import('../logoutBlockedCopy')
const gate = await import('../receiveGate')

const PK = 'cd'.repeat(32)
const okStash = async () => ({ ok: true as const, fingerprint: '', count: 0 })
const tabsOk = (log: string[] = []) => async () => ({
  ok: true as const,
  tabs: {
    stillPaused: async () => true,
    resume: () => void log.push('tabs-resume'),
    done: () => void log.push('tabs-done'),
  },
})

beforeEach(() => {
  calls.length = 0
  fail.roster = false
  gate.openReceives()
  gate.openSpends()
})

describe('a stop that throws mid-logout (#335 item 2)', () => {
  it('re-opens the receive and send gates, and the other tabs carry on', async () => {
    fail.roster = true
    const log: string[] = []
    await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: tabsOk(log),
    }).catch(() => undefined)
    expect(calls).not.toContain('wipe')
    expect(calls).not.toContain('key-clear')
    // Receiving and sending work again, without a reload.
    expect(() => gate.beginReceive()()).not.toThrow()
    expect(() => gate.beginSpend()()).not.toThrow()
    expect(calls).toContain('start-dm')
    expect(log).toEqual(['tabs-resume'])
  })

  it('a restart that itself throws still leaves the gates open', async () => {
    const out = await attemptLogout(PK, () => true, () => {}, {
      checkStash: okStash,
      pauseTabs: tabsOk(),
      drainWriters: async () => false,
      restartWriters: () => {
        throw new Error('restart failed')
      },
    }).catch(() => ({ status: 'threw' as const }))
    expect(out).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(() => gate.beginReceive()()).not.toThrow()
    expect(() => gate.beginSpend()()).not.toThrow()
  })
})

describe('other tabs (#335 item 4)', () => {
  it('a tab that cannot be paused BLOCKS before anything is stopped, with plain words', async () => {
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: async () => ({ ok: false }),
    })
    expect(out).toEqual({ status: 'blocked', reason: 'other-tab', unconfirmed: [] })
    expect(calls).toEqual([])
    expect(blockedMessage(out as Extract<typeof out, { status: 'blocked' }>)).toBe(LOGOUT_BLOCKED_COPY.otherTab)
    expect(() => gate.beginReceive()()).not.toThrow()
  })

  it('a tab that is no longer paused just before the wipe BLOCKS, and the others resume', async () => {
    const log: string[] = []
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: async () => ({
        ok: true,
        tabs: { stillPaused: async () => false, resume: () => void log.push('resume'), done: () => void log.push('done') },
      }),
    })
    expect(out).toMatchObject({ status: 'blocked', reason: 'other-tab' })
    expect(calls).not.toContain('wipe')
    expect(log).toEqual(['resume'])
  })

  it('a done logout tells the paused tabs, so they reload', async () => {
    const log: string[] = []
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: tabsOk(log),
    })
    expect(out).toEqual({ status: 'done' })
    expect(log).toEqual(['tabs-done'])
  })

  it('a declined confirmation never disturbs the other tabs', async () => {
    const pauseTabs = vi.fn(tabsOk())
    expect(await attemptLogout(PK, () => false, () => {}, { checkStash: okStash, pauseTabs })).toEqual({
      status: 'cancelled',
    })
    expect(pauseTabs).not.toHaveBeenCalled()
  })
})

describe('a send in this tab (#335 item 4)', () => {
  it('is refused once logout has started, with plain words, and nothing moves', async () => {
    gate.closeSpends()
    await expect(gate.withSpend(async () => 'sent')).rejects.toThrow(gate.SPEND_PAUSED_MESSAGE)
  })

  it('one still running when the wait runs out BLOCKS the logout, and erases nothing', async () => {
    vi.useFakeTimers()
    try {
      const end = gate.beginSpend()
      const run = attemptLogout(PK, () => true, () => calls.push('reload'), {
        checkStash: okStash,
        pauseTabs: tabsOk(),
      })
      await vi.advanceTimersByTimeAsync(25_000)
      expect(await run).toMatchObject({ status: 'blocked', reason: 'changed' })
      expect(calls).not.toContain('wipe')
      end()
    } finally {
      vi.useRealTimers()
    }
  })

  it('one that finishes inside the wait lets the logout go on', async () => {
    const end = gate.beginSpend()
    setTimeout(end, 20)
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: tabsOk(),
    })
    expect(out).toEqual({ status: 'done' })
  })
})
