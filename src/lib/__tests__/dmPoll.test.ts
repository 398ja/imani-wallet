import { afterEach, describe, expect, it, vi } from 'vitest'

import { nostrdbAdapter } from '../dmPoll'

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
