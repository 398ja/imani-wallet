import { describe, it, expect, vi } from 'vitest'

vi.mock('../nip98', () => ({ signedFetch: async () => new Response('{}', { status: 200 }) }))
vi.mock('../wallet', () => ({ notifyWalletChanged: () => {}, recordCashbackStatus: async () => {} }))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: async () => ({}) }))

const { nextPollDelay, startStatusPoller, POLL_BASE_MS, POLL_MAX_MS } = await import('../cashbackLiveStatus')
import type { CashbackStatusReading } from '../cashback'

/**
 * The merchant screen's live status (spec 4.1): every 5 s while open, gentle on failure, silent
 * while hidden, finished once settled. A fake clock drives it so each rule is pinned exactly.
 */
function harness(answers: (CashbackStatusReading | null)[], visible = { now: true }) {
  const timers: { run: () => void; ms: number; id: number }[] = []
  let next = 1
  const reads: string[] = []
  const seen: string[] = []
  const poller = startStatusPoller('cb-1', {
    read: async (id) => {
      reads.push(id)
      return answers.length ? answers.shift()! : { status: 'Unclaimed' }
    },
    onReading: (r) => seen.push(r.status),
    isVisible: () => visible.now,
    setTimer: (run, ms) => {
      const t = { run, ms, id: next++ }
      timers.push(t)
      return t.id
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  /** Fire the one pending timer and let the read settle. */
  const fire = async () => {
    const t = timers.shift()
    if (!t) return null
    t.run()
    await new Promise((ok) => setTimeout(ok, 0))
    return t.ms
  }
  return { poller, timers, reads, seen, fire }
}

describe('nextPollDelay', () => {
  it('is 5 s while reads succeed and doubles to a 60 s cap on failures', () => {
    expect(nextPollDelay(0)).toBe(POLL_BASE_MS)
    expect([1, 2, 3, 4, 5, 50].map(nextPollDelay)).toEqual([10_000, 20_000, 40_000, POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS])
  })
})

describe('startStatusPoller', () => {
  it('asks every 5 s and stops for good once the cashback is claimed', async () => {
    const h = harness([{ status: 'Unclaimed' }, { status: 'Claimed', claimedAt: 1 }])
    expect(h.reads).toEqual([]) // nothing on mount: the generate answer is fresh
    expect(await h.fire()).toBe(5_000)
    expect(await h.fire()).toBe(5_000)
    expect(h.seen).toEqual(['Unclaimed', 'Claimed'])
    expect(h.timers).toEqual([])
  })

  it('backs off on failures and resets after a success', async () => {
    const h = harness([null, null, null, { status: 'Unclaimed' }])
    const delays = []
    for (let i = 0; i < 5; i++) delays.push(await h.fire())
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 5_000])
  })

  it('asks nothing while the page is hidden, and asks at once when it is shown', async () => {
    const visible = { now: false }
    const h = harness([{ status: 'Claimed' }], visible)
    await h.fire()
    expect(h.reads).toEqual([])
    expect(h.timers).toEqual([]) // no loop runs in the background
    visible.now = true
    h.poller.wake()
    await new Promise((ok) => setTimeout(ok, 0))
    expect(h.seen).toEqual(['Claimed'])
  })

  it('stop cancels the pending read', async () => {
    const h = harness([])
    h.poller.stop()
    expect(h.timers).toEqual([])
    h.poller.wake()
    await new Promise((ok) => setTimeout(ok, 0))
    expect(h.reads).toEqual([])
  })
})
