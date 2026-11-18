/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #348: the key backup gate is pinned in logoutKeyBackup348.test.ts. Here the key is backed up.
vi.mock('../keyBackups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../keyBackups')>()),
  checkKeyBackup: async () => ({ ok: true, backups: [] }),
}))

/**
 * Fourth check of #334: the receive gate and logout's last checks, pinned where
 * the mutation battery found them unpinned (G5, G6, L4, L6, L9, T1).
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
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => void calls.push('wipe')),
  openWallet: vi.fn(async () => ({ getAllVouchers: async () => [], getAllTransactions: async () => [] })),
  voucherWriteCount: () => 0,
}))
vi.mock('../voucherRecords', () => ({
  confirmBackups: vi.fn(async () => ({ ok: true, confirmed: 0, fingerprint: '' })),
  heldFingerprint: () => '',
}))

const { attemptLogout } = await import('../logout')
const gate = await import('../receiveGate')

const PK = 'cd'.repeat(32)
const okStash = async () => ({ ok: true as const, fingerprint: '', count: 0 })

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
  gate.openReceives()
  delete (window as unknown as { TokenRedemption?: unknown }).TokenRedemption
})
afterEach(() => {
  delete (window as unknown as { TokenRedemption?: unknown }).TokenRedemption
})

describe('the gate counts exactly (G6)', () => {
  it('ending a receive twice counts it once', () => {
    const a = gate.beginReceive()
    const b = gate.beginReceive()
    a()
    a()
    expect(gate.receivesInFlight()).toBe(1)
    b()
    expect(gate.receivesInFlight()).toBe(0)
  })
})

describe('a coordinator that cannot be read is BUSY (G5)', () => {
  it('an accessor that throws reads as one receive in flight', () => {
    ;(window as unknown as { TokenRedemption: unknown }).TokenRedemption = {
      inFlightCount: () => {
        throw new Error('broken')
      },
    }
    expect(gate.tokenRedemptionsInFlight()).toBe(1)
  })
})

describe('the last synchronous check, with the DEFAULT reader (L4, L6)', () => {
  it('a gated receive still running at the last step BLOCKS, erasing nothing', async () => {
    let end: () => void = () => undefined
    const outcome = await attemptLogout(PK, () => {
      // Got in while the confirm was up, before the gate closed, and never ends.
      end = gate.beginReceive()
      return true
    }, () => undefined, { checkStash: okStash, drainReceives: async () => true })
    end()
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(calls).not.toContain('wipe')
  })

  it('a coordinator redeem still running at the last step BLOCKS', async () => {
    ;(window as unknown as { TokenRedemption: unknown }).TokenRedemption = { inFlightCount: () => 1 }
    const outcome = await attemptLogout(PK, () => true, () => undefined, {
      checkStash: okStash,
      drainReceives: async () => true,
    })
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(calls).not.toContain('wipe')
  })

  it('a reader that throws BLOCKS', async () => {
    const outcome = await attemptLogout(PK, () => true, () => undefined, {
      checkStash: okStash,
      drainReceives: async () => true,
      receivesNow: () => {
        throw new Error('cannot tell')
      },
    })
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(calls).not.toContain('wipe')
  })
})

describe('the stash moving DURING its own re-check BLOCKS (L9)', () => {
  it('confirmed, but changed again while it was being confirmed', async () => {
    const seen = ['a', 'b', 'c']
    const outcome = await attemptLogout(PK, () => true, () => undefined, {
      // first check saw 'a'; after the drain it is 'b'; the re-check confirms 'b'; then it is 'c'.
      stashNow: () => seen.shift() === 'a' ? 'b' : 'c',
      checkStash: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, fingerprint: 'a', count: 1 })
        .mockResolvedValueOnce({ ok: true, fingerprint: 'b', count: 1 }),
    })
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(calls).not.toContain('wipe')
    expect(calls).toContain('start-dm')
  })
})

describe('the coordinator accessor reads the real in-flight map (T1)', () => {
  it('counts a redeem from its fingerprint step until it settles', async () => {
    const source = readFileSync('shared/tokenRedemption.js', 'utf8')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tr: any = new Function(
      'api', 'walletStorageIntegration', 'localStorage', 'resolveDecimals', 'TokenSecurity',
      'generateReceiveIdempotencyKey',
      `${source}; return TokenRedemption;`,
    )({}, {}, localStorage, () => 2, {}, () => 'k')
    expect(tr.inFlightCount()).toBe(0)
    tr._inFlightRedemptions.set('fp', Promise.resolve())
    expect(tr.inFlightCount()).toBe(1)
    tr._inFlightRedemptions.delete('fp')
    expect(tr.inFlightCount()).toBe(0)
  })
})
