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
 * Review of imani-wallet#340 (#335). Owner rule: logout is impossible until
 * every bit of value is verifiably backed up, and a block wipes nothing and
 * keeps the key.
 *
 * B. A tab opened DURING the push teardown (`disableNotifications` awaits the
 *    gateway) was never asked about: the only re-ping ran before it. That tab
 *    kept receiving and sending while the key and the store were deleted.
 * C. A paused tab whose listener was stopped (the authed tree unmounted, for a
 *    lapsed session) lost its orphan fallback, so its gates stayed closed and
 *    its writers stopped for the rest of the page's life.
 *
 * Plus pins for what the PR's own tests let through (mutation survivors):
 * closeSpends at logout, writers restarted independently, a throw after the
 * wipe began tells the tabs, and stillPaused needs "paused" from each tab.
 */

const calls: string[] = []
const hooks = vi.hoisted(() => ({
  disable: async () => {},
  startDm: () => {},
}))
vi.mock('../nap', () => ({
  getSession: () => ({ logout: vi.fn(async () => void calls.push('session-logout')) }),
  keyStore: { clear: vi.fn(async () => void calls.push('key-clear')) },
  resetSession: vi.fn(),
}))
vi.mock('../dmPoll', () => ({
  stopDmPoll: vi.fn(() => void calls.push('stop-dm')),
  startDmPoll: vi.fn(() => {
    calls.push('start-dm')
    hooks.startDm()
  }),
  drainDmPoll: vi.fn(async () => true),
}))
vi.mock('../terminalRosterSyncNet', () => ({
  stopRosterSync: vi.fn(),
  startRosterSync: vi.fn(() => void calls.push('start-roster')),
}))
vi.mock('../incomingNotifications', () => ({
  stopIncomingNotifications: vi.fn(),
  startIncomingNotifications: vi.fn(() => void calls.push('start-incoming')),
}))
vi.mock('../notifications/manager', () => ({
  disableNotifications: vi.fn(async () => {
    calls.push('push-off')
    await hooks.disable()
  }),
}))
vi.mock('../resume', () => ({ forgetResume: vi.fn(() => void calls.push('forget-resume')) }))
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
const tabs = await import('../logoutTabs')
const gate = await import('../receiveGate')

const PK = 'cd'.repeat(32)
const okStash = async () => ({ ok: true as const, fingerprint: '', count: 0 })

type Ch = { postMessage(m: unknown): void; close(): void; onmessage: ((e: { data: unknown }) => void) | null }
function bus() {
  const members = new Set<Ch>()
  return {
    make(): Ch {
      const ch: Ch = {
        onmessage: null,
        postMessage(m) {
          for (const other of members) if (other !== ch) setTimeout(() => other.onmessage?.({ data: structuredClone(m) }), 0)
        },
        close() {
          members.delete(ch)
        },
      }
      members.add(ch)
      return ch
    },
  }
}

function otherTab(b: ReturnType<typeof bus>, deps: Partial<Parameters<typeof tabs.listenForLogout>[1]> = {}) {
  const log: string[] = []
  const stop = tabs.listenForLogout(PK, {
    channel: () => b.make(),
    locks: () => null,
    pause: () => void log.push('pause'),
    drain: async () => true,
    resume: () => void log.push('resume'),
    reload: () => void log.push('reload'),
    keyStillHere: async () => true,
    orphanMs: 10_000,
    ...deps,
  })
  return { log, stop }
}

const FAST = { pingWindowMs: 20, pauseTimeoutMs: 300 }

beforeEach(() => {
  calls.length = 0
  hooks.disable = async () => {}
  hooks.startDm = () => {}
  gate.openReceives()
  gate.openSpends()
})

describe('B: a tab opened during the push teardown (review of #340)', () => {
  it('refuses the wipe: the key and the store stay, and the paused tab resumes', async () => {
    const b = bus()
    const paused = otherTab(b)
    let late: ReturnType<typeof otherTab> | undefined
    // The gateway is slow; a new tab of this wallet opens while it is asked.
    hooks.disable = async () => {
      late = otherTab(b)
      await new Promise((r) => setTimeout(r, 5))
    }
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: () => tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null }),
    })
    expect(out).toEqual({ status: 'blocked', reason: 'other-tab', unconfirmed: [] })
    expect(calls).toContain('push-off')
    for (const gone of ['session-logout', 'key-clear', 'forget-resume', 'wipe', 'reload']) {
      expect(calls).not.toContain(gone)
    }
    // Refused, so everything is put back: the paused tab carries on, the gates open.
    await vi.waitFor(() => expect(paused.log).toEqual(['pause', 'resume']))
    expect(late!.log).toEqual([])
    expect(() => gate.beginSpend()()).not.toThrow()
    expect(() => gate.beginReceive()()).not.toThrow()
    paused.stop()
    late!.stop()
  })

  it('with no new tab the logout still completes, and the paused tab reloads', async () => {
    const b = bus()
    const paused = otherTab(b)
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: () => tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null }),
    })
    expect(out).toEqual({ status: 'done' })
    expect(calls).toContain('wipe')
    await vi.waitFor(() => expect(paused.log).toEqual(['pause', 'reload']))
    paused.stop()
  })
})

describe('C: a paused tab whose listener is stopped (review of #340)', () => {
  it('still resumes through the orphan fallback once the logout tab is gone', async () => {
    const b = bus()
    const t = otherTab(b, { orphanMs: 300 })
    b.make().postMessage({ t: 'pause', run: 'r1', from: 'gone-tab' })
    await vi.waitFor(() => expect(t.log).toEqual(['pause']))
    // The authed tree unmounts (a lapsed session) while paused, before the fallback fires.
    t.stop()
    expect(t.log).toEqual(['pause'])
    await vi.waitFor(() => expect(t.log).toEqual(['pause', 'resume']), { timeout: 2000 })
  })

  it('with the Locks API, a paused tab settles as soon as the logout lock is released', async () => {
    for (const keyStillHere of [true, false]) {
      const b = bus()
      let release: () => void = () => {}
      const held = new Promise<void>((r) => (release = r))
      const locks = {
        request: async (_n: string, opts: { mode?: string }, cb: (l: unknown) => unknown) => {
          // The logging-out tab holds the lock; a shared request waits for it.
          if (opts.mode === 'shared') await held
          return cb({})
        },
      }
      const t = otherTab(b, { locks: () => locks, keyStillHere: async () => keyStillHere })
      b.make().postMessage({ t: 'pause', run: 'r1', from: 'gone-tab' })
      await vi.waitFor(() => expect(t.log).toEqual(['pause']))
      await new Promise((r) => setTimeout(r, 20))
      expect(t.log).toEqual(['pause'])
      release() // the logging-out tab closed
      await vi.waitFor(() => expect(t.log).toEqual(['pause', keyStillHere ? 'resume' : 'reload']))
      t.stop()
    }
  })

  it('a listener stopped while NOT paused leaves nothing running', async () => {
    const b = bus()
    const t = otherTab(b, { orphanMs: 30 })
    t.stop()
    await new Promise((r) => setTimeout(r, 60))
    expect(t.log).toEqual([])
  })
})

describe('survivor pins (mutation testing of #340)', () => {
  it('logout closes the SEND gate before it drains (a send started mid-logout is refused)', async () => {
    let refused: unknown = null
    const out = await attemptLogout(PK, () => true, () => {}, {
      checkStash: okStash,
      pauseTabs: async () => ({ ok: true, tabs: { stillPaused: async () => true, resume() {}, done() {} } }),
      drainWriters: async () => {
        try {
          gate.beginSpend()()
        } catch (e) {
          refused = e
        }
        return true
      },
    })
    expect(out.status).toBe('done')
    expect((refused as { code?: string } | null)?.code).toBe(gate.SPEND_DEFERRED)
  })

  it('a send counted after the drain still blocks the wipe (the synchronous last look counts spends)', async () => {
    let end: (() => void) | undefined
    const out = await attemptLogout(PK, () => true, () => {}, {
      checkStash: okStash,
      pauseTabs: async () => ({ ok: true, tabs: { stillPaused: async () => true, resume() {}, done() {} } }),
      drainReceives: async () => {
        // A writer this list does not know about: past the gate's check before it closed.
        gate.openSpends()
        end = gate.beginSpend()
        gate.closeSpends()
        return true
      },
    })
    end?.()
    expect(out).toEqual({ status: 'blocked', reason: 'changed', unconfirmed: [] })
    expect(calls).not.toContain('wipe')
  })

  it('a writer that throws on restart does not keep the others stopped', async () => {
    hooks.startDm = () => {
      throw new Error('dm-poll start failed')
    }
    const out = await attemptLogout(PK, () => true, () => {}, {
      checkStash: okStash,
      pauseTabs: async () => ({ ok: false }),
    })
    expect(out.status).toBe('blocked')
    // Refused before anything was stopped: nothing to restart.
    expect(calls).toEqual([])
    const blocked = await attemptLogout(PK, () => true, () => {}, {
      checkStash: okStash,
      pauseTabs: async () => ({ ok: true, tabs: { stillPaused: async () => false, resume() {}, done() {} } }),
    })
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'other-tab' })
    expect(calls).toEqual(expect.arrayContaining(['start-dm', 'start-roster', 'start-incoming']))
    expect(() => gate.beginReceive()()).not.toThrow()
  })

  it('a throw once the wipe has begun tells the paused tabs (they reload, not wait)', async () => {
    const log: string[] = []
    const { wipeWallet } = await import('../wallet')
    vi.mocked(wipeWallet).mockImplementationOnce(async () => {
      throw new Error('IndexedDB gone')
    })
    await expect(
      attemptLogout(PK, () => true, () => {}, {
        checkStash: okStash,
        pauseTabs: async () => ({
          ok: true,
          tabs: { stillPaused: async () => true, resume: () => void log.push('resume'), done: () => void log.push('done') },
        }),
      }),
    ).rejects.toThrow('IndexedDB gone')
    expect(log).toEqual(['done'])
  })

  it('stillPaused is false when a known tab answers but is no longer paused', async () => {
    const b = bus()
    const t = otherTab(b)
    // A listener on the bus that records the logout's run id from its PAUSE.
    const spy = b.make()
    let run = ''
    spy.onmessage = (e) => {
      const m = e.data as { t?: string; run?: string }
      if (m.t === 'pause' && m.run) run = m.run
    }
    const out = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null })
    spy.close()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(run).not.toBe('')
    // The same tab, now resumed on its own (a stale RESUME for this run).
    b.make().postMessage({ t: 'resume', run, from: 'x' })
    await vi.waitFor(() => expect(t.log).toContain('resume'))
    expect(await out.tabs.stillPaused()).toBe(false)
    out.tabs.resume()
    t.stop()
  })
})
