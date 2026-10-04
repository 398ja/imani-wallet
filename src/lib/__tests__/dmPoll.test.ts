import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { nostrdbAdapter, startDmPoll, stopDmPoll } from '../dmPoll'
import { checkMintAndUnit } from '../trustedMint'
import { recordHeld } from '../heldCoupons'
import { gatewayAnswers, resetGate } from './trustedMintKit'

const fake = vi.hoisted(() => ({
  fetchRecentDms: vi.fn(async () => []),
  start: vi.fn(async () => {}),
  reofferEvents: vi.fn(async () => 0),
  hasProcessed: vi.fn(() => false),
}))
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: () => ({ ...fake, stop: () => {} }),
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
    resetGate()
  })

  /** A reconnect re-runs the catch-up the SSE gap may have missed. */
  it('re-queries when the SSE stream reconnects', async () => {
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    startDmPoll('b'.repeat(64))
    fake.fetchRecentDms.mockClear()
    subscribe().source.onopen!()
    await vi.waitFor(() => expect(fake.fetchRecentDms).toHaveBeenCalled())
  })

  /** Returning to the foreground re-runs the catch-up a frozen WebView missed. */
  it('re-queries when the app comes back to the foreground', async () => {
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    startDmPoll('c'.repeat(64))
    fake.fetchRecentDms.mockClear()
    fire('visibilitychange')
    await vi.waitFor(() => expect(fake.fetchRecentDms).toHaveBeenCalled())
  })

  /** A stopped poller does not keep querying on visibility changes. */
  it('stops listening once the poller is stopped', async () => {
    startDmPoll('d'.repeat(64))
    stopDmPoll()
    fake.fetchRecentDms.mockClear()
    fire('visibilitychange')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.fetchRecentDms).not.toHaveBeenCalled()
  })
})

/**
 * #133: the trusted-mint list is loaded BEFORE the poller's first catch-up.
 *
 * That catch-up redeems at once, and every redeem asks the mint gate. Started
 * first, it would meet an unknown list and defer the whole backlog; worse, before
 * this fix the unknown list read as "no mint configured" and passed everything.
 */
describe('startDmPoll — the trusted mint is known before the first receive', () => {
  const target = { addEventListener: () => {}, removeEventListener: () => {} }

  beforeEach(() => {
    vi.stubGlobal('document', { ...target, visibilityState: 'visible' })
    vi.stubGlobal('window', target)
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    resetGate()
    fake.start.mockClear()
  })

  afterEach(() => {
    stopDmPoll()
    vi.unstubAllEnvs()
    resetGate()
  })

  /**
   * The order is the point: when `start()` runs, the gate already knows the
   * gateway's mint, so a rogue token in the first catch-up is refused rather than
   * deferred or passed.
   */
  it('fetches /api/v1/config and learns the mint before starting the poller', async () => {
    let release!: () => void
    const configAnswered = new Promise<void>((resolve) => (release = resolve))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe('/api/v1/config')
        await configAnswered
        return Response.json({ nip05_domain: 'imani.test', mint_url: 'https://mint.staging.398ja.xyz' })
      }),
    )
    const verdictAtStart: string[] = []
    fake.start.mockImplementation(async () => {
      verdictAtStart.push(checkMintAndUnit({ mintUrl: 'https://rogue.example.test', unit: 'sat' }))
    })

    startDmPoll('e'.repeat(64))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.start).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => expect(fake.start).toHaveBeenCalledTimes(1))
    expect(verdictAtStart).toEqual(['untrusted-mint'])
  })

  /**
   * A gateway that cannot be reached must not keep coupons from arriving for ever.
   * The poller still starts; the gate defers until a later catch-up loads the list.
   */
  it('still starts the poller when the config cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )

    startDmPoll('f'.repeat(64))

    await vi.waitFor(() => expect(fake.start).toHaveBeenCalledTimes(1))
    expect(checkMintAndUnit({ mintUrl: 'https://rogue.example.test', unit: 'sat' })).toBe('not-ready')
  })

  /** A poller stopped (logout) while the config was in flight is not started afterwards. */
  it('does not start a poller that was stopped while the config was loading', async () => {
    let release!: () => void
    const configAnswered = new Promise<void>((resolve) => (release = resolve))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await configAnswered
        return Response.json({ nip05_domain: 'imani.test', mint_url: 'https://mint.staging.398ja.xyz' })
      }),
    )

    startDmPoll('9'.repeat(64))
    stopDmPoll()
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fake.start).not.toHaveBeenCalled()
  })
})

/**
 * A 404 from the profile endpoint is the ORDINARY case, not a broken build.
 *
 * Coupon DMs are gift-wrapped by the gateway's own identity, and the gateway
 * publishes no kind-0, so the pubkey handed to getProfile usually has no
 * profile to find. What matters is that a receipt never depends on it: the
 * lookup must resolve null rather than throw or hang, because DmPollService
 * awaits it inside its sequential redemption loop and one rejection there
 * strands every remaining coupon behind it.
 */
describe('profile lookup never blocks a coupon receipt', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves null when the pubkey has published no profile', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    )
    await expect(nostrdbAdapter().getProfile('e'.repeat(64))).resolves.toBeNull()
  })

  it('returns the profile when one exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ pubkey: 'f'.repeat(64), name: 'candles' })),
    )
    await expect(nostrdbAdapter().getProfile('f'.repeat(64))).resolves.toMatchObject({
      name: 'candles',
    })
  })

  it('resolves null instead of rejecting when the lookup fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    await expect(nostrdbAdapter().getProfile('a'.repeat(64))).resolves.toBeNull()
  })
})

/**
 * #133 review, MEDIUM-2: a deferral heals itself. When the config fetch fails at
 * start-up, the trusted-mint loader retries on a backoff; the moment it succeeds
 * the poller runs a catch-up AND re-offers every delivery it is holding, however
 * old, with no reload and no user action.
 */
describe('startDmPoll — held and deferred coupons are offered again when the mints arrive', () => {
  const target = { addEventListener: () => {}, removeEventListener: () => {} }
  const ME = '7'.repeat(64)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('document', { ...target, visibilityState: 'visible' })
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    })
    vi.stubGlobal('window', { ...target, dispatchEvent: () => true })
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    resetGate()
    fake.start.mockReset().mockImplementation(async () => {})
    fake.fetchRecentDms.mockClear()
    fake.reofferEvents.mockClear()
  })

  afterEach(() => {
    stopDmPoll()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    resetGate()
  })

  it('catches up and re-offers held deliveries once the gateway answers', async () => {
    recordHeld(ME, {
      eventId: 'held-long-ago',
      senderPubkey: 'b'.repeat(64),
      voucherId: 'v',
      reason: 'no-trusted-mint',
      detail: '',
      token: 'cashuB',
      createdAt: 1_000,
    })
    let reachable = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!reachable) throw new TypeError('network down')
        return Response.json({ nip05_domain: 'imani.test', token_mint_urls: ['https://mint.staging.398ja.xyz'] })
      }),
    )

    startDmPoll(ME)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.start).toHaveBeenCalledTimes(1)
    fake.fetchRecentDms.mockClear()
    fake.reofferEvents.mockClear()

    reachable = true
    await vi.advanceTimersByTimeAsync(5_000)

    expect(fake.fetchRecentDms).toHaveBeenCalled()
    expect(fake.reofferEvents).toHaveBeenCalledWith(['held-long-ago'], 1_000 - 60)
  })
})
