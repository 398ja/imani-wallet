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
  /** Listeners registered by type, as a real EventSource keeps them. */
  readonly listeners = new Map<string, (e: { data: string }) => void>()

  constructor(readonly url: string) {
    FakeEventSource.last = this
  }

  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, fn)
  }

  /**
   * Deliver a frame the way the spec does: a NAMED frame goes only to a
   * listener registered for that name, never to `onmessage`.
   */
  emit(type: string, data: string) {
    if (type === 'message') this.onmessage?.({ data })
    else this.listeners.get(type)?.({ data })
  }

  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
}

function subscribe() {
  vi.stubGlobal('EventSource', FakeEventSource)
  const onError = vi.fn()
  const onEvent = vi.fn()
  const handle = nostrdbAdapter().subscribeEvents(
    { kinds: [1059], pTags: ['a'.repeat(64)] },
    onEvent,
    onError,
  )
  return { onError, onEvent, handle, source: FakeEventSource.last! }
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

  /**
   * The bug that made a 0.50 EUR coupon vanish while the stream was healthy.
   *
   * The gateway sends `SseEmitter.event().name("event")`, which puts
   * `event: event` on the wire. Per the EventSource spec a NAMED frame is
   * dispatched only to a listener registered for that name — `onmessage` fires
   * for unnamed frames alone. So every gift wrap arrived, was parsed by the
   * browser, and was dropped for want of a listener: no error, no gap, no
   * coupon.
   */
  it('receives the named `event` frame the gateway actually sends', () => {
    const { source, onEvent } = subscribe()
    source.emit(
      'event',
      JSON.stringify({ id: 'ev1', pubkey: 'p', kind: 1059, createdAt: 1, tags: [], content: 'c' }),
    )
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0]).toMatchObject({ id: 'ev1', kind: 1059 })
  })

  /** An unnamed frame still works, so a gateway change cannot break it back. */
  it('still receives an unnamed frame', () => {
    const { source, onEvent } = subscribe()
    source.emit(
      'message',
      JSON.stringify({ id: 'ev2', pubkey: 'p', kind: 1059, createdAt: 1, tags: [], content: 'c' }),
    )
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('reports a malformed frame rather than throwing into EventSource', () => {
    const { source, onEvent, onError } = subscribe()
    source.emit('event', 'not json')
    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
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
  })

  it('re-queries when the SSE stream reconnects', () => {
    startDmPoll('b'.repeat(64))
    fake.fetchRecentDms.mockClear()
    subscribe().source.onopen!()
    expect(fake.fetchRecentDms).toHaveBeenCalled()
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
