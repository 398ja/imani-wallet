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
 * #331: logout and the receives that do not go through dm-poll (cashback
 * claims, the stash replay, gift links), and the cashback stash itself.
 *
 * 1. The drain waits for a direct `TokenRedemption.redeem` in flight.
 * 2. Once logout has started, a new direct receive is refused before anything
 *    is claimed or swapped (deferred, not lost).
 * 3. No window: a coupon saved by a receive that answers late can never land
 *    after the final check and then be wiped.
 * 4. The stash is backed up and read back first, or logout stays blocked.
 */

const calls: string[] = []
vi.mock('../nap', () => ({
  getSession: () => ({ logout: vi.fn(async () => void calls.push('session-logout')) }),
  keyStore: { clear: vi.fn(async () => void calls.push('key-clear')) },
  resetSession: vi.fn(),
  getSigner: () => {
    throw new Error('locked')
  },
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
const wallet = vi.hoisted(() => ({ writes: 0 }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => void calls.push('wipe')),
  openWallet: vi.fn(async () => ({ getAllVouchers: async () => [], getAllTransactions: async () => [] })),
  voucherWriteCount: () => wallet.writes,
}))
vi.mock('../voucherRecords', () => ({
  confirmBackups: vi.fn(async () => {
    calls.push('check')
    return { ok: true, confirmed: 0, fingerprint: "" }
  }),
  heldFingerprint: () => '',
}))

const { attemptLogout, LOGOUT_BLOCKED_COPY } = await import('../logout')
const gate = await import('../receiveGate')
const { blockedMessage } = await import('../logoutBlockedCopy')

const PK = 'ab'.repeat(32)
const okStash = async () => ({ ok: true as const, fingerprint: '', count: 0 })

/** A fake coordinator: `redeem` registers in-flight like the real one, and saves (a write) on answer. */
function fakeCoordinator() {
  const inFlight = new Map<string, Promise<void>>()
  let release: () => void = () => undefined
  const tr = {
    _inFlightRedemptions: inFlight,
    inFlightCount: () => inFlight.size,
    redeem: (token: string) => {
      const p = new Promise<void>((resolve) => (release = resolve)).then(() => {
        wallet.writes++
        calls.push('saved')
        inFlight.delete(token)
      })
      inFlight.set(token, p)
      return p
    },
  }
  ;(window as unknown as { TokenRedemption: unknown }).TokenRedemption = tr
  return { tr, release: () => release() }
}

beforeEach(() => {
  calls.length = 0
  wallet.writes = 0
  localStorage.clear()
  gate.openReceives()
  delete (window as unknown as { TokenRedemption?: unknown }).TokenRedemption
})

describe('the drain waits for direct redeems (#331 gap 1)', () => {
  it('waits for a TokenRedemption.redeem in flight, then re-checks before the wipe', async () => {
    const { tr, release } = fakeCoordinator()
    void tr.redeem('cashuBdirect')
    const outcome = attemptLogout(PK, () => {
      // The redeem answers while logout drains (after the confirm).
      setTimeout(release, 30)
      return true
    }, () => undefined, { checkStash: okStash })
    await expect(outcome).resolves.toEqual({ status: 'done' })
    // Saved BEFORE the final check, which ran before the wipe.
    expect(calls.indexOf('saved')).toBeGreaterThan(-1)
    expect(calls.lastIndexOf('check')).toBeGreaterThan(calls.indexOf('saved'))
    expect(calls.indexOf('wipe')).toBeGreaterThan(calls.lastIndexOf('check'))
  })

  it('a direct redeem that never answers inside the bound BLOCKS, erasing nothing', async () => {
    const { tr } = fakeCoordinator()
    void tr.redeem('cashuBhung')
    const outcome = await attemptLogout(PK, () => true, () => undefined, {
      checkStash: okStash,
      drainReceives: async () => false,
    })
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(calls).not.toContain('wipe')
    expect(calls).toContain('start-dm')
  })

  it('a receive still running at the last step BLOCKS (no save after the final check)', async () => {
    const outcome = await attemptLogout(PK, () => true, () => undefined, {
      checkStash: okStash,
      drainReceives: async () => true,
      receivesNow: () => 1,
    })
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(calls).not.toContain('wipe')
  })

  it('the default drain sees the coordinator through its accessor', async () => {
    const { tr, release } = fakeCoordinator()
    void tr.redeem('cashuBx')
    expect(gate.tokenRedemptionsInFlight()).toBe(1)
    const drained = gate.drainTokenRedemptions(1_000, 5)
    release()
    await expect(drained).resolves.toBe(true)
    expect(gate.tokenRedemptionsInFlight()).toBe(0)
  })
})

describe('new direct receives are refused once logout starts (#331 gap 1)', () => {
  it('logout closes the gate before it stops the poller; a blocked logout reopens it', async () => {
    let openDuringConfirm = true
    const outcome = await attemptLogout(PK, () => {
      openDuringConfirm = (() => {
        try {
          gate.beginReceive()()
          return true
        } catch {
          return false
        }
      })()
      return true
    }, () => undefined, { checkStash: okStash, drainReceives: async () => false })
    // During the confirm, receives still run (nothing has started yet).
    expect(openDuringConfirm).toBe(true)
    expect(outcome).toMatchObject({ status: 'blocked' })
    // Reopened with the poller.
    expect(() => gate.beginReceive()()).not.toThrow()
  })

  it('after a completed logout a receive is DEFERRED, not run', async () => {
    await expect(attemptLogout(PK, () => true, () => undefined, { checkStash: okStash })).resolves.toEqual({
      status: 'done',
    })
    let err: unknown
    try {
      gate.beginReceive()
    } catch (e) {
      err = e
    }
    expect(gate.isReceiveDeferred(err)).toBe(true)
  })
})

describe('the cashback stash is backed up first (#331 gap 2)', () => {
  it('a stash that cannot be confirmed BLOCKS before anything is asked or stopped', async () => {
    localStorage.setItem('imani:cashback:pending', JSON.stringify(['cashuBone', 'cashuBtwo']))
    const confirm = vi.fn(() => true)
    const outcome = await attemptLogout(PK, confirm, () => undefined, {
      checkStash: async () => ({ ok: false, reason: 'unconfirmed', count: 2, fingerprint: 'x' }),
    })
    expect(outcome).toEqual({ status: 'blocked', reason: 'cashback-unconfirmed', unconfirmed: [], cashback: 2 })
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).not.toContain('stop-dm')
    expect(calls).not.toContain('wipe')
    expect(localStorage.getItem('imani:cashback:pending')).not.toBeNull()
    if (outcome.status === 'blocked') expect(blockedMessage(outcome)).toBe(LOGOUT_BLOCKED_COPY.cashbackUnconfirmed(2))
  })

  it('the DEFAULT check blocks on a real stash while the key is locked', async () => {
    localStorage.setItem('imani:cashback:pending', JSON.stringify(['cashuBone']))
    const outcome = await attemptLogout(PK, () => true, () => undefined)
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'locked' })
    expect(calls).not.toContain('wipe')
  })

  it('the DEFAULT check does not block on garbage entries', async () => {
    localStorage.setItem('imani:cashback:pending', JSON.stringify(['', 'not-a-token', 42]))
    await expect(attemptLogout(PK, () => true, () => undefined)).resolves.toEqual({ status: 'done' })
  })

  it('a stash that changed during the drain is checked again; refused there, it BLOCKS', async () => {
    let n = 0
    const outcome = await attemptLogout(PK, () => true, () => undefined, {
      stashNow: () => (n++ === 0 ? 'moved' : 'moved'),
      checkStash: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, fingerprint: '', count: 0 })
        .mockResolvedValueOnce({ ok: false, reason: 'unconfirmed', count: 1, fingerprint: 'moved' }),
    })
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'cashback-unconfirmed' })
    expect(calls).not.toContain('wipe')
    expect(calls).toContain('start-dm')
  })

  it('a check that throws BLOCKS', async () => {
    const outcome = await attemptLogout(PK, () => true, () => undefined, {
      checkStash: async () => {
        throw new Error('boom')
      },
    })
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'store-unreadable' })
  })
})
