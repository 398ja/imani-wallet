import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { nostrdbAdapter, startDmPoll, stopDmPoll } from '../dmPoll'

const fake = vi.hoisted(() => ({ fetchRecentDms: vi.fn(async () => []) }))
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: () => ({ ...fake, start: async () => {}, stop: () => {} }),
}))

/**
 * The gateway closes every nostr SSE stream after ten minutes and expects the
 * client to redial — EventSource does that on its own. Reporting the resulting
 * `error` to DmPollService made it abandon SSE and fall back to 30s polling
 * permanently, ten minutes into every session. Only a CLOSED stream is a real
 * failure, and only then is the polling fallback worth taking.
 */

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  static last: FakeEventSource | null = null

  readyState = FakeEventSource.OPEN
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.last = this
  }

  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
}

function subscribe() {
  vi.stubGlobal('EventSource', FakeEventSource)
  const onError = vi.fn()
  const handle = nostrdbAdapter().subscribeEvents(
    { kinds: [1059], pTags: ['a'.repeat(64)] },
    vi.fn(),
    onError,
  )
  return { onError, handle, source: FakeEventSource.last! }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nostrdbAdapter.subscribeEvents — SSE error classification', () => {
  it('stays quiet when EventSource is reconnecting after the 10-minute cap', () => {
    const { onError, source } = subscribe()
    source.readyState = FakeEventSource.CONNECTING
    source.onerror!()
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports the error when the browser has given up (CLOSED)', () => {
    const { onError, source } = subscribe()
    source.readyState = FakeEventSource.CLOSED
    source.onerror!()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('puts the filter in the query string, which is why /customer had to go', () => {
    const { source } = subscribe()
    expect(source.url).toContain('kinds=1059')
    expect(source.url).toContain(`pTags=${'a'.repeat(64)}`)
  })
})

/**
 * The hole that lost a redemption: SSE carries only what arrives while the
 * socket is up, and `start()` ran the only catch-up of the session. A wrap
 * delivered six seconds after Android froze the WebView was never queried
 * again, so it never reached the merchant's transaction list.
 */
describe('startDmPoll — catch-up after a gap', () => {
  // The suite runs in node, where there is no DOM. Only the two listener
  // surfaces the poller touches are needed, so a pair of maps beats pulling in
  // jsdom for three tests.
  const listeners = new Map<string, () => void>()
  const target = {
    addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
  }
  const fire = (type: string) => listeners.get(type)?.()

  beforeEach(() => {
    listeners.clear()
    vi.stubGlobal('document', { ...target, visibilityState: 'visible' })
    vi.stubGlobal('window', target)
  })

  afterEach(() => {
    stopDmPoll()
    fake.fetchRecentDms.mockClear()
    vi.useRealTimers()
  })

  it('re-queries when the SSE stream reconnects', () => {
    startDmPoll('b'.repeat(64))
    fake.fetchRecentDms.mockClear()
    subscribe().source.onopen!()
    expect(fake.fetchRecentDms).toHaveBeenCalled()
  })

  /**
   * The bug this heartbeat exists for: the staging gateway's SSE stream accepts
   * the subscription and then only keepalives — it never pushes an event and so
   * never errors, which is what dm-poll's own polling fallback waits for. Every
   * coupon sat on the relay until someone reloaded the page.
   */
  it('re-queries on a timer, because a silent SSE stream never errors', () => {
    vi.useFakeTimers()
    startDmPoll('e'.repeat(64))
    fake.fetchRecentDms.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(fake.fetchRecentDms).toHaveBeenCalled()
  })

  it('does not poll while the app is in the background', () => {
    vi.useFakeTimers()
    vi.stubGlobal('document', { ...target, visibilityState: 'hidden' })
    startDmPoll('f'.repeat(64))
    fake.fetchRecentDms.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(fake.fetchRecentDms).not.toHaveBeenCalled()
  })

  it('stops the timer once the poller is stopped', () => {
    vi.useFakeTimers()
    startDmPoll('g'.repeat(64))
    stopDmPoll()
    fake.fetchRecentDms.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(fake.fetchRecentDms).not.toHaveBeenCalled()
  })

  it('re-queries when the app comes back to the foreground', () => {
    startDmPoll('c'.repeat(64))
    fake.fetchRecentDms.mockClear()
    fire('visibilitychange')
    expect(fake.fetchRecentDms).toHaveBeenCalled()
  })

  it('stops listening once the poller is stopped', () => {
    startDmPoll('d'.repeat(64))
    stopDmPoll()
    fake.fetchRecentDms.mockClear()
    fire('visibilitychange')
    expect(fake.fetchRecentDms).not.toHaveBeenCalled()
  })
})
