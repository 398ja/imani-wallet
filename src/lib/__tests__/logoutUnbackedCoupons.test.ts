import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Owner rule 2026-10-18 17:52Z (review of #326): "Never allow a logout until
 * we have verifiable confirmation that the vouchers were backed up."
 *
 * Logout is BLOCKED, not warned, while any held voucher is unconfirmed, and
 * there is no "log out anyway". These pin the teardown's side of it: what is
 * stopped, what is erased, and what is restarted, in each outcome. The
 * read-back itself is pinned end to end in restoreAfterLogout.test.ts.
 */

const calls: string[] = []

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
  stopRosterSync: vi.fn(() => void calls.push('stop-roster')),
  startRosterSync: vi.fn(() => void calls.push('start-roster')),
}))
vi.mock('../incomingNotifications', () => ({
  stopIncomingNotifications: vi.fn(() => void calls.push('stop-incoming')),
  startIncomingNotifications: vi.fn(() => void calls.push('start-incoming')),
}))
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => undefined) }))
vi.mock('../resume', () => ({ forgetResume: vi.fn() }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => void calls.push('wipe')),
  openWallet: async () => ({ getAllVouchers: async () => [] }),
  voucherWriteCount: () => 0,
}))
vi.mock('../voucherRecords', () => ({
  confirmBackups: vi.fn(),
  heldFingerprint: () => '',
}))

globalThis.localStorage = { removeItem: () => {}, getItem: () => null } as unknown as Storage

const { attemptLogout, logout, LOGOUT_WARNING, LOGOUT_BLOCKED_COPY } = await import('../logout')

const PK = 'cd'.repeat(32)
const yes = () => true
const noReload = () => {}

type Check = Awaited<ReturnType<typeof import('../voucherRecords').confirmBackups>>
const OK = (fingerprint = 'A'): Check => ({ ok: true, confirmed: 2, fingerprint })
const UNCONFIRMED: Check = {
  ok: false,
  reason: 'unconfirmed',
  fingerprint: 'A',
  unconfirmed: [
    { token_id: 't1', face_value: 1100, face_unit: 'GBP', face_decimals: 2 },
    { token_id: 't2', face_value: 250, face_unit: 'GBP', face_decimals: 2 },
  ],
}

beforeEach(() => {
  calls.length = 0
})

describe('logout is BLOCKED while any held voucher is unconfirmed', () => {
  it('blocks when nothing can be confirmed (relay and gateway both down): no confirm, nothing stopped or erased', async () => {
    const asked: string[] = []
    const out = await attemptLogout(PK, (m) => (asked.push(m), true), noReload, {
      checkBackups: async () => UNCONFIRMED,
    })

    expect(out).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(out.status === 'blocked' && out.unconfirmed).toHaveLength(2)
    // Not even asked: there is no question whose "yes" could erase these.
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  it('blocks a locked wallet holding vouchers, and a store that cannot be read', async () => {
    for (const reason of ['locked', 'store-unreadable'] as const) {
      calls.length = 0
      const out = await attemptLogout(PK, yes, noReload, {
        checkBackups: async () => ({ ok: false, reason, unconfirmed: [], fingerprint: '' }),
      })
      expect(out).toMatchObject({ status: 'blocked', reason })
      expect(calls).toEqual([])
    }
  })

  it('a check that THROWS blocks, it never reads as confirmed', async () => {
    const out = await attemptLogout(PK, yes, noReload, {
      checkBackups: async () => {
        throw new Error('offline')
      },
    })
    expect(out.status).toBe('blocked')
    expect(calls).not.toContain('wipe')
  })

  it('the boolean wrapper reports a block as "did not log out"', async () => {
    await expect(logout(PK, yes, noReload, { checkBackups: async () => UNCONFIRMED })).resolves.toBe(false)
  })
})

describe('all confirmed: logout proceeds', () => {
  it('asks the ordinary question, stops the writers, wipes, reloads', async () => {
    const reload = vi.fn()
    const asked: string[] = []
    const out = await attemptLogout(PK, (m) => (asked.push(m), true), reload, {
      checkBackups: async () => OK(),
      heldNow: async () => 'A',
      writeCount: () => 7,
    })
    expect(out).toEqual({ status: 'done' })
    expect(asked).toEqual([LOGOUT_WARNING])
    expect(calls.slice(0, 3)).toEqual(['stop-dm', 'stop-roster', 'stop-incoming'])
    expect(calls).toContain('wipe')
    expect(calls).not.toContain('start-dm')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('a declined confirmation is cancelled, untouched', async () => {
    const out = await attemptLogout(PK, () => false, noReload, { checkBackups: async () => OK() })
    expect(out).toEqual({ status: 'cancelled' })
    expect(calls).toEqual([])
  })
})

describe('the race: a voucher arrives between the confirmation and the wipe', () => {
  it('re-verifies only when the held set changed: unchanged means ONE check', async () => {
    const check = vi.fn(async () => OK('A'))
    await attemptLogout(PK, yes, noReload, { checkBackups: check, heldNow: async () => 'A', writeCount: () => 1 })
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('changed and the final check confirms: wipes', async () => {
    const check = vi.fn<() => Promise<Check>>().mockResolvedValueOnce(OK('A')).mockResolvedValueOnce(OK('B'))
    const out = await attemptLogout(PK, yes, noReload, {
      checkBackups: check,
      heldNow: async () => 'B',
      writeCount: () => 1,
    })
    expect(check).toHaveBeenCalledTimes(2)
    expect(out.status).toBe('done')
  })

  it('changed and the final check FAILS: restarts what it stopped, erases nothing, blocks', async () => {
    const check = vi.fn<() => Promise<Check>>().mockResolvedValueOnce(OK('A')).mockResolvedValueOnce(UNCONFIRMED)
    const out = await attemptLogout(PK, yes, noReload, {
      checkBackups: check,
      heldNow: async () => 'B',
      writeCount: () => 1,
    })
    expect(out).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(calls).toEqual(['stop-dm', 'stop-roster', 'stop-incoming', 'start-dm', 'start-roster', 'start-incoming'])
  })

  it('a write that lands and is undone (same fingerprint, counter moved) still re-verifies', async () => {
    let n = 1
    const check = vi.fn<() => Promise<Check>>().mockResolvedValueOnce(OK('A')).mockImplementationOnce(async () => UNCONFIRMED)
    const out = await attemptLogout(PK, () => ((n = 2), true), noReload, {
      checkBackups: check,
      heldNow: async () => 'A',
      writeCount: () => n,
    })
    expect(check).toHaveBeenCalledTimes(2)
    expect(out.status).toBe('blocked')
  })

  it('a redemption still in flight past the drain bound blocks and restarts', async () => {
    const out = await attemptLogout(PK, yes, noReload, {
      checkBackups: async () => OK('A'),
      drainWriters: async () => false,
      heldNow: async () => 'A',
      writeCount: () => 1,
    })
    expect(out).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(calls).toContain('start-dm')
    expect(calls).not.toContain('wipe')
  })

  it('a write DURING the final check blocks', async () => {
    let n = 1
    const check = vi
      .fn<() => Promise<Check>>()
      .mockResolvedValueOnce(OK('A'))
      .mockImplementationOnce(async () => {
        n = 3
        return OK('B')
      })
    const out = await attemptLogout(PK, () => ((n = 2), true), noReload, {
      checkBackups: check,
      heldNow: async () => 'B',
      writeCount: () => n,
    })
    expect(out).toMatchObject({ status: 'blocked', reason: 'changed' })
    expect(calls).not.toContain('wipe')
  })
})

describe('no override path', () => {
  it('there is no copy offering to log out anyway', () => {
    const copy = JSON.stringify(LOGOUT_BLOCKED_COPY) + LOGOUT_BLOCKED_COPY.unconfirmed(2, '£13.50')
    expect(copy).not.toMatch(/anyway|lose (it|them)\?|log out now/i)
    expect(LOGOUT_WARNING).not.toMatch(/anyway/i)
  })

  it('a confirm that always says yes still cannot pass a failed check', async () => {
    const out = await attemptLogout(PK, () => true, noReload, { checkBackups: async () => UNCONFIRMED })
    expect(out.status).toBe('blocked')
  })

  it('no production code calls wipeWallet except logout and the terminal-only removal', () => {
    // A second door to the wipe would be an override. terminalEnrol's is for a
    // terminal device's own store, which holds no customer coupons.
    const root = join(__dirname, '..', '..')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (name === '__tests__' || name === 'node_modules') continue
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name) && /wipeWallet\(/.test(readFileSync(path, 'utf8'))) hits.push(path.slice(root.length + 1))
      }
    }
    walk(root)
    expect(hits.sort()).toEqual(['lib/logout.ts', 'lib/terminalEnrol.ts', 'lib/wallet.ts'])
  })

  it('the blocked copy names the count and the value, in plain words', () => {
    const text = LOGOUT_BLOCKED_COPY.unconfirmed(2, '£13.50')
    expect(text).toMatch(/^2 vouchers worth £13\.50 are not confirmed as backed up/)
    expect(text).toMatch(/Nothing has been erased/)
    for (const copy of [text, LOGOUT_BLOCKED_COPY.locked, LOGOUT_BLOCKED_COPY.unreadable, LOGOUT_BLOCKED_COPY.changed, LOGOUT_WARNING]) {
      expect(copy).not.toMatch(/\b(nsec|npub|relay|nostr)\b/i)
    }
  })
})

describe('money in flight outside the coupon rows (second check of #326)', () => {
  const none = () => ({ sends: 0, swaps: 0 })

  it('a pending send blocks even when every row is confirmed: no confirm, nothing stopped or erased', async () => {
    const asked: string[] = []
    const settle = vi.fn(async () => undefined)
    const out = await attemptLogout(PK, (m) => (asked.push(m), true), noReload, {
      checkBackups: async () => OK('A'),
      inFlight: () => ({ sends: 1, swaps: 0 }),
      settleInFlight: settle,
    })
    expect(out).toEqual({ status: 'blocked', reason: 'in-flight', unconfirmed: [] })
    // It first tried to finish the send, so one that has settled does not block.
    expect(settle).toHaveBeenCalledWith(PK)
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  it('an interrupted swap back to sats blocks', async () => {
    const out = await attemptLogout(PK, yes, noReload, {
      checkBackups: async () => OK('A'),
      inFlight: () => ({ sends: 0, swaps: 1 }),
      settleInFlight: async () => undefined,
    })
    expect(out).toMatchObject({ status: 'blocked', reason: 'in-flight' })
    expect(calls).not.toContain('wipe')
  })

  it('one that starts after the confirmation (another tab) blocks at the end and restarts the writers', async () => {
    let state = none()
    const out = await attemptLogout(PK, () => ((state = { sends: 1, swaps: 0 }), true), noReload, {
      checkBackups: async () => OK('A'),
      heldNow: async () => 'A',
      writeCount: () => 1,
      inFlight: () => state,
      settleInFlight: async () => undefined,
    })
    expect(out).toMatchObject({ status: 'blocked', reason: 'in-flight' })
    expect(calls).toEqual(['stop-dm', 'stop-roster', 'stop-incoming', 'start-dm', 'start-roster', 'start-incoming'])
  })

  it('a ledger that cannot be read blocks; a settled one does not', async () => {
    const unreadable = await attemptLogout(PK, yes, noReload, {
      checkBackups: async () => OK('A'),
      inFlight: () => {
        throw new Error('storage denied')
      },
      settleInFlight: async () => undefined,
    })
    expect(unreadable).toMatchObject({ status: 'blocked', reason: 'in-flight' })
    const clear = await attemptLogout(PK, yes, noReload, {
      checkBackups: async () => OK('A'),
      heldNow: async () => 'A',
      writeCount: () => 1,
      inFlight: none,
      settleInFlight: async () => undefined,
    })
    expect(clear.status).toBe('done')
  })

  it('says so in plain words', async () => {
    const { blockedMessage } = await import('../logoutBlockedCopy')
    const text = blockedMessage({ status: 'blocked', reason: 'in-flight', unconfirmed: [] })
    expect(text).toBe(LOGOUT_BLOCKED_COPY.inFlight)
    expect(text).toMatch(/Nothing has been erased/)
    expect(text).not.toMatch(/\b(nsec|npub|relay|nostr|anyway)\b/i)
  })
})
