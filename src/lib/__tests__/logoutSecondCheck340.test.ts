/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Second check of imani-wallet#340 (review commit 402d46d). Owner rule: logout is
 * impossible until every bit of value is verifiably backed up, and a block wipes
 * nothing and keeps the key.
 *
 * E. 402d46d keeps a stopped listener's orphan fallback alive (C). That fallback
 *    still resumed when ANOTHER listener in the same document had paused the tab
 *    since, for a newer logout: it opened the gates and restarted the writers
 *    under that logout, which then wiped with this tab receiving and sending.
 * F. The second re-ping (B) runs before `session.logout()`, which awaits
 *    POST /auth/logout with no timeout. A tab that logged in during that POST was
 *    never asked about, and the key and the store were erased under it.
 */

const calls: string[] = []
const hooks = vi.hoisted(() => ({
  sessionLogout: async () => {},
}))
vi.mock('../nap', () => ({
  getSession: () => ({
    logout: vi.fn(async () => {
      calls.push('session-logout')
      await hooks.sessionLogout()
    }),
  }),
  keyStore: { clear: vi.fn(async () => void calls.push('key-clear')) },
  resetSession: vi.fn(),
}))
vi.mock('../dmPoll', () => ({
  stopDmPoll: vi.fn(() => void calls.push('stop-dm')),
  startDmPoll: vi.fn(() => void calls.push('start-dm')),
  drainDmPoll: vi.fn(async () => true),
}))
vi.mock('../terminalRosterSyncNet', () => ({ stopRosterSync: vi.fn(), startRosterSync: vi.fn() }))
vi.mock('../incomingNotifications', () => ({
  stopIncomingNotifications: vi.fn(),
  startIncomingNotifications: vi.fn(),
}))
vi.mock('../notifications/manager', () => ({ disableNotifications: vi.fn(async () => void calls.push('push-off')) }))
vi.mock('../resume', () => ({ forgetResume: vi.fn(() => void calls.push('forget-resume')) }))
vi.mock('../wallet', () => ({
  wipeWallet: vi.fn(async () => void calls.push('wipe')),
  openWallet: vi.fn(async () => ({ getAllVouchers: async () => [] })),
  voucherWriteCount: () => 0,
}))
vi.mock('../voucherRecords', () => ({
  confirmBackups: vi.fn(async () => ({ ok: true, confirmed: 0, fingerprint: '' })),
  heldFingerprint: () => '',
}))

const { attemptLogout } = await import('../logout')
const tabs = await import('../logoutTabs')
const gate = await import('../receiveGate')

const PK = 'ef'.repeat(32)
const okStash = async () => ({ ok: true as const, fingerprint: '', count: 0 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

/** A listener whose pause really closes this document's gates, like the default one. */
function listener(b: ReturnType<typeof bus>, deps: Partial<Parameters<typeof tabs.listenForLogout>[1]> = {}) {
  const log: string[] = []
  const stop = tabs.listenForLogout(PK, {
    channel: () => b.make(),
    locks: () => null,
    pause: () => {
      gate.closeReceives()
      gate.closeSpends()
      log.push('pause')
    },
    drain: async () => true,
    resume: () => void log.push('resume'),
    reload: () => void log.push('reload'),
    keyStillHere: async () => true,
    orphanMs: 10_000,
    ...deps,
  })
  return { log, stop }
}

const spendsOpen = () => {
  try {
    gate.beginSpend()()
    return true
  } catch {
    return false
  }
}

const FAST = { pingWindowMs: 20, pauseTimeoutMs: 300 }

beforeEach(() => {
  calls.length = 0
  hooks.sessionLogout = async () => {}
  gate.openReceives()
  gate.openSpends()
})

describe('E: a stopped listener\'s orphan fallback and a newer pause (second check of #340)', () => {
  it('does not resume a tab that a newer listener has paused for another logout', async () => {
    const b = bus()
    // The first logout pauses this tab, then the authed tree unmounts (a lapsed session).
    const first = listener(b, { orphanMs: 150 })
    b.make().postMessage({ t: 'pause', run: 'r1', from: 'gone-tab' })
    await vi.waitFor(() => expect(first.log).toEqual(['pause']))
    first.stop()
    // Unlocked again: a fresh listener, which a second logout now pauses.
    const second = listener(b)
    b.make().postMessage({ t: 'pause', run: 'r2', from: 'logout-2' })
    await vi.waitFor(() => expect(second.log).toEqual(['pause']))
    // The first listener's fallback comes due while the second logout is running.
    await sleep(300)
    expect(first.log).toEqual(['pause'])
    expect(spendsOpen()).toBe(false)
    // The second logout refuses: the live listener resumes the tab, as before.
    b.make().postMessage({ t: 'resume', run: 'r2', from: 'logout-2' })
    await vi.waitFor(() => expect(second.log).toEqual(['pause', 'resume']))
    expect(spendsOpen()).toBe(true)
    second.stop()
  })

  it('a newer pause that lands while the fallback asks for the key still wins', async () => {
    const b = bus()
    let answer: (here: boolean) => void = () => {}
    let asked = false
    const first = listener(b, {
      orphanMs: 50,
      keyStillHere: () =>
        new Promise<boolean>((r) => {
          asked = true
          answer = r
        }),
    })
    b.make().postMessage({ t: 'pause', run: 'r1', from: 'gone-tab' })
    await vi.waitFor(() => expect(first.log).toEqual(['pause']))
    first.stop()
    await vi.waitFor(() => expect(asked).toBe(true))
    // While the key is being looked up, the remounted tree is paused for a new logout.
    const second = listener(b)
    b.make().postMessage({ t: 'pause', run: 'r2', from: 'logout-2' })
    await vi.waitFor(() => expect(second.log).toEqual(['pause']))
    answer(true)
    await sleep(20)
    expect(first.log).toEqual(['pause'])
    expect(spendsOpen()).toBe(false)
    second.stop()
  })

  it('still resumes through the fallback when nothing has paused the tab since (C kept)', async () => {
    const b = bus()
    const first = listener(b, { orphanMs: 150 })
    b.make().postMessage({ t: 'pause', run: 'r1', from: 'gone-tab' })
    await vi.waitFor(() => expect(first.log).toEqual(['pause']))
    first.stop()
    // A remount that has not been asked anything: the tab is still dead until the fallback.
    const second = listener(b)
    expect(spendsOpen()).toBe(false)
    await vi.waitFor(() => expect(first.log).toEqual(['pause', 'resume']), { timeout: 2000 })
    expect(spendsOpen()).toBe(true)
    second.stop()
  })
})

describe('F: a tab that logs in during POST /auth/logout (second check of #340)', () => {
  it('refuses before the key is cleared: the key and the store stay, and the paused tab resumes', async () => {
    const b = bus()
    const paused = listener(b)
    let late: ReturnType<typeof listener> | undefined
    // The gateway is slow to answer the logout POST; a tab logs in meanwhile.
    hooks.sessionLogout = async () => {
      late = listener(b)
      await sleep(5)
    }
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: () => tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null }),
    })
    expect(out).toEqual({ status: 'blocked', reason: 'other-tab', unconfirmed: [] })
    expect(calls).toContain('session-logout')
    for (const gone of ['key-clear', 'forget-resume', 'wipe', 'reload']) {
      expect(calls).not.toContain(gone)
    }
    await vi.waitFor(() => expect(paused.log).toEqual(['pause', 'resume']))
    expect(late!.log).toEqual([])
    expect(spendsOpen()).toBe(true)
    paused.stop()
    late!.stop()
  })

  it('with no new tab the logout completes, the key is cleared after the last look', async () => {
    const b = bus()
    const paused = listener(b)
    const out = await attemptLogout(PK, () => true, () => calls.push('reload'), {
      checkStash: okStash,
      pauseTabs: () => tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null }),
    })
    expect(out).toEqual({ status: 'done' })
    expect(calls.indexOf('key-clear')).toBeGreaterThan(calls.indexOf('session-logout'))
    expect(calls).toContain('wipe')
    await vi.waitFor(() => expect(paused.log).toEqual(['pause', 'reload']))
    paused.stop()
  })
})
