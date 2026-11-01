/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Third check of #326. Pins the parts of the in-flight refusal that the second
 * check's tests reached only through injected doubles: the DEFAULT settle step
 * (pay.ts's reconcile, bounded), the DEFAULT ledger read (storage that throws),
 * and that the bound times out to BLOCKED, never to the wipe.
 */

const calls: string[] = []
const reconcile = vi.hoisted(() => ({ impl: (() => new Promise<number>(() => {})) as (pk: string) => Promise<number> }))

vi.mock('../pay', () => ({ reconcilePendingSends: (pk: string) => reconcile.impl(pk) }))
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

const { attemptLogout, SETTLE_IN_FLIGHT_TIMEOUT_MS } = await import('../logout')

const PK = 'cd'.repeat(32)
const sendsKey = `imani-wallet:pending-sends:${PK}`
const pending = () => JSON.stringify([{ sendId: 's1', tokenId: 't1', amount: 1, sourceFaceValue: 2, at: Date.now() }])

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the default settle step (third check of #326)', () => {
  it('a reconcile that never answers times out to BLOCKED after the bound, never to the wipe', async () => {
    vi.useFakeTimers()
    localStorage.setItem(sendsKey, pending())
    reconcile.impl = () => new Promise<number>(() => {})
    const asked: string[] = []
    let settled = false
    const run = attemptLogout(PK, (m) => (asked.push(m), true), () => calls.push('reload')).then((o) => {
      settled = true
      return o
    })
    await vi.advanceTimersByTimeAsync(SETTLE_IN_FLIGHT_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run).toEqual({ status: 'blocked', reason: 'in-flight', unconfirmed: [] })
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  it('a reconcile that settles the send lets logout proceed', async () => {
    localStorage.setItem(sendsKey, pending())
    reconcile.impl = async () => {
      localStorage.removeItem(sendsKey)
      return 1
    }
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'))
    expect(out).toEqual({ status: 'done' })
    expect(calls).toContain('wipe')
  })

  it('a reconcile that throws still blocks while the send is in the ledger', async () => {
    localStorage.setItem(sendsKey, pending())
    reconcile.impl = async () => {
      throw new Error('gateway down')
    }
    expect(await attemptLogout(PK, () => true, () => {})).toMatchObject({ status: 'blocked', reason: 'in-flight' })
    expect(calls).toEqual([])
  })

  it('local storage that cannot be read blocks (the default reader, not a double)', async () => {
    reconcile.impl = async () => 0
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    // The stash check (#331) would block on this too; it is passed here so the
    // ledger's own default reader is what refuses.
    const checkStash = async () => ({ ok: true as const, fingerprint: '', count: 0 })
    expect(await attemptLogout(PK, () => true, () => {}, { checkStash })).toMatchObject({
      status: 'blocked',
      reason: 'in-flight',
    })
    expect(calls).toEqual([])
  })

  it('and with the default stash check, unreadable storage blocks there first (#331)', async () => {
    reconcile.impl = async () => 0
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(await attemptLogout(PK, () => true, () => {})).toMatchObject({ status: 'blocked', reason: 'store-unreadable' })
    expect(calls).toEqual([])
  })
})
