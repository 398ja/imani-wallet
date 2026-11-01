/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #335 item 4: a logout in one tab must not wipe while another tab is receiving
 * or spending. The other tabs are paused first over a BroadcastChannel, under an
 * exclusive Web Lock, and anything that cannot be coordinated BLOCKS.
 *
 * The bus below is an in-memory BroadcastChannel: every channel sees every other
 * channel's posts, never its own, delivered asynchronously like the real one.
 */

vi.mock('../dmPoll', () => ({ stopDmPoll: vi.fn(), startDmPoll: vi.fn(), drainDmPoll: vi.fn(async () => true) }))
vi.mock('../terminalRosterSyncNet', () => ({ stopRosterSync: vi.fn(), startRosterSync: vi.fn() }))
vi.mock('../incomingNotifications', () => ({ stopIncomingNotifications: vi.fn(), startIncomingNotifications: vi.fn() }))

const tabs = await import('../logoutTabs')
const gate = await import('../receiveGate')

type Ch = { postMessage(m: unknown): void; close(): void; onmessage: ((e: { data: unknown }) => void) | null }
function bus() {
  const members = new Set<Ch>()
  const make = (): Ch => {
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
  }
  return { make }
}

/** A Locks API that grants an exclusive lock once, like the real one with ifAvailable. */
function fakeLocks() {
  let held = false
  return {
    request: async (_n: string, opts: { mode?: string; ifAvailable?: boolean }, cb: (l: unknown) => unknown) => {
      if (opts.mode === 'shared') return held ? new Promise(() => {}) : cb({})
      if (held && opts.ifAvailable) return cb(null)
      held = true
      try {
        return await cb({})
      } finally {
        held = false
      }
    },
  }
}

const FAST = { pingWindowMs: 20, pauseTimeoutMs: 200 }

beforeEach(() => {
  gate.openReceives()
  gate.openSpends()
})
afterEach(() => {
  gate.openReceives()
  gate.openSpends()
})

/** Another tab, on its own channel of the same bus. */
function otherTab(b: ReturnType<typeof bus>, deps: Partial<Parameters<typeof tabs.listenForLogout>[1]> = {}) {
  const calls: string[] = []
  const stop = tabs.listenForLogout('ab'.repeat(32), {
    channel: () => b.make(),
    locks: () => null,
    pause: () => void calls.push('pause'),
    drain: async () => true,
    resume: () => void calls.push('resume'),
    reload: () => void calls.push('reload'),
    keyStillHere: async () => true,
    orphanMs: 10_000,
    ...deps,
  })
  return { calls, stop }
}

describe('pausing the other tabs', () => {
  it('no other tab: ok, at once', async () => {
    const b = bus()
    const out = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null })
    expect(out.ok).toBe(true)
  })

  it('every other tab pauses before the logout goes on, and reloads once it is done', async () => {
    const b = bus()
    const one = otherTab(b)
    const two = otherTab(b)
    const out = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null })
    expect(out.ok).toBe(true)
    expect(one.calls).toEqual(['pause'])
    expect(two.calls).toEqual(['pause'])
    if (!out.ok) return
    expect(await out.tabs.stillPaused()).toBe(true)
    out.tabs.done()
    await vi.waitFor(() => expect(one.calls).toEqual(['pause', 'reload']))
    expect(two.calls).toEqual(['pause', 'reload'])
  })

  it('a tab still receiving or spending (its drain does not finish) BLOCKS, and every tab carries on', async () => {
    const b = bus()
    const idle = otherTab(b)
    const busy = otherTab(b, { drain: async () => false })
    const out = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null })
    expect(out.ok).toBe(false)
    await vi.waitFor(() => expect(idle.calls).toEqual(['pause', 'resume']))
    await vi.waitFor(() => expect(busy.calls).toContain('resume'))
  })

  it('a tab that answers but never pauses BLOCKS', async () => {
    const b = bus()
    const stuck = otherTab(b, { drain: () => new Promise<boolean>(() => {}) })
    const out = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null })
    expect(out.ok).toBe(false)
    await vi.waitFor(() => expect(stuck.calls).toEqual(['pause', 'resume']))
  })

  it('no BroadcastChannel at all: the other tabs cannot be reached, so it BLOCKS', async () => {
    expect((await tabs.pauseOtherTabs({ ...FAST, channel: () => null })).ok).toBe(false)
  })

  it('another logout holds the lock: BLOCKS', async () => {
    const b = bus()
    const locks = fakeLocks()
    const first = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => locks })
    expect(first.ok).toBe(true)
    const second = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => locks })
    expect(second.ok).toBe(false)
    if (first.ok) first.tabs.resume()
    // Released: the next logout may take it.
    await new Promise((r) => setTimeout(r, 0))
    expect((await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => locks })).ok).toBe(true)
  })

  it('a tab opened after the pause is caught just before the wipe', async () => {
    const b = bus()
    otherTab(b)
    const out = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null })
    expect(out.ok).toBe(true)
    otherTab(b) // a new tab, never paused
    if (out.ok) expect(await out.tabs.stillPaused()).toBe(false)
  })
})

describe('a paused tab, with the real gates', () => {
  it('closes its receive and send gates while paused, and opens them on resume', async () => {
    const b = bus()
    const stop = tabs.listenForLogout('ab'.repeat(32), {
      channel: () => b.make(),
      locks: () => null,
      drain: async () => true,
      resume: () => {},
      reload: () => {},
    })
    const out = await tabs.pauseOtherTabs({ ...FAST, channel: () => b.make(), locks: () => null })
    expect(out.ok).toBe(true)
    expect(() => gate.beginReceive()).toThrow()
    expect(() => gate.beginSpend()).toThrow(gate.SPEND_PAUSED_MESSAGE)
    if (out.ok) out.tabs.resume()
    await vi.waitFor(() => expect(() => gate.beginSpend()()).not.toThrow())
    expect(() => gate.beginReceive()()).not.toThrow()
    stop()
  })

  it('a paused tab whose logout tab vanished resumes when the key is still here, and reloads when it is gone', async () => {
    for (const keyStillHere of [true, false]) {
      const b = bus()
      const t = otherTab(b, { orphanMs: 30, keyStillHere: async () => keyStillHere })
      const ch = b.make()
      ch.postMessage({ t: 'pause', run: 'r1', from: 'gone-tab' })
      await vi.waitFor(() => expect(t.calls).toEqual(['pause', keyStillHere ? 'resume' : 'reload']))
      t.stop()
    }
  })
})
