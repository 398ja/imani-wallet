/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../keyBackups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../keyBackups')>()),
  checkKeyBackup: async () => ({ ok: true, backups: [] }),
}))

/**
 * #389: logout before a lost-answer send is resolved. The default settle step asks the gateway
 * (pay.ts's reconcile, which now resolves send intents); logout unblocks once that gives a definite
 * answer, and stays off with copy that fits while the outcome is unknown.
 */
const calls: string[] = []
const reconcile = vi.hoisted(() => ({ impl: (async () => 0) as (pk: string) => Promise<number> }))
vi.mock('../pay', () => ({ reconcilePendingSends: (pk: string) => reconcile.impl(pk) }))
vi.mock('../nap', () => ({
  getSession: () => ({ logout: vi.fn(async () => void calls.push('session-logout')) }),
  keyStore: { clear: vi.fn(async () => void calls.push('key-clear')) },
  resetSession: vi.fn(),
}))
vi.mock('../dmPoll', () => ({ stopDmPoll: vi.fn(), startDmPoll: vi.fn(), drainDmPoll: vi.fn(async () => true) }))
vi.mock('../terminalRosterSyncNet', () => ({ stopRosterSync: vi.fn(), startRosterSync: vi.fn() }))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn(), startIncomingNotifications: vi.fn() }))
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => undefined) }))
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

const { attemptLogout, LOGOUT_BLOCKED_COPY } = await import('../logout')
const { blockedMessage } = await import('../logoutBlockedCopy')

const PK = 'ef'.repeat(32)
const intentsKey = `imani-wallet:send-intents:${PK}`
const pendingKey = `imani-wallet:pending-sends:${PK}`
const intent = () => JSON.stringify([{ key: 'c2c_x', recipientPubkey: 'b'.repeat(64), amount: 300, voucherId: 'v', at: Date.now() - 60_000 }])

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
})

describe('logout and a send with no answer (#389)', () => {
  it('still unknown: blocked as send-unknown, with copy that does not say "in a moment"', async () => {
    localStorage.setItem(intentsKey, intent())
    reconcile.impl = async () => 0
    const out = await attemptLogout(PK, () => true, () => {})
    expect(out).toEqual({ status: 'blocked', reason: 'send-unknown', unconfirmed: [] })
    const copy = blockedMessage(out as Extract<typeof out, { status: 'blocked' }>)
    expect(copy).toBe(LOGOUT_BLOCKED_COPY.sendUnknown)
    expect(copy).not.toMatch(/in a moment/i)
    expect(copy).toMatch(/did not get an answer/)
    expect(calls).toEqual([])
  })

  it('unblocks once the gateway gives a definite answer (the intent cleared by the reconcile)', async () => {
    localStorage.setItem(intentsKey, intent())
    reconcile.impl = async () => {
      localStorage.removeItem(intentsKey)
      return 0
    }
    expect(await attemptLogout(PK, () => true, () => calls.push('reload'))).toEqual({ status: 'done' })
    expect(calls).toContain('wipe')
  })

  it('found and still running at the gateway: an accepted send in flight, the ordinary refusal', async () => {
    localStorage.setItem(intentsKey, intent())
    reconcile.impl = async () => {
      localStorage.removeItem(intentsKey)
      localStorage.setItem(pendingKey, JSON.stringify([{ sendId: 's1', tokenId: 't', amount: 1, sourceFaceValue: 2, at: Date.now() }]))
      return 0
    }
    expect(await attemptLogout(PK, () => true, () => {})).toMatchObject({ status: 'blocked', reason: 'in-flight' })
  })

  it('an unknown send beside other money in flight reads as in-flight', async () => {
    localStorage.setItem(intentsKey, intent())
    localStorage.setItem(pendingKey, JSON.stringify([{ sendId: 's1', tokenId: 't', amount: 1, sourceFaceValue: 2, at: Date.now() }]))
    expect(await attemptLogout(PK, () => true, () => {})).toMatchObject({ status: 'blocked', reason: 'in-flight' })
  })
})
