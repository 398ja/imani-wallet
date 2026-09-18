/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearBrandingCache, fetchNewestKind0, merchantBranding, onBrandingChanged } from '../branding'
import { allEvents } from '../relay'

vi.mock('../relay', () => ({ allEvents: vi.fn() }))

/**
 * A profile read must not wait for the store that is not answering.
 *
 * This is the cause of "profiles sometimes take too long", and it was not the
 * lookup being slow — it was a fast lookup being held behind a slow one it had
 * already beaten. `fetchNewestKind0` awaited `Promise.all` over the gateway and
 * the relay, so every read cost the SLOWER of the two, and the relay is slower
 * by two orders of magnitude whenever it is not directly reachable:
 *
 *   healthy relay ..................... 25ms
 *   port not published (refused) ....... 5ms
 *   unroutable host (dropped) ....... 3001ms   <- SimplePool's connection timeout
 *   no EOSE from a connected relay .. 4400ms   <- nostr-tools' baseEoseTimeout
 *
 * (Measured against a real strfry and two dead addresses.) A browser WebSocket
 * to a host that drops packets fails on a CLOCK, not on a refusal — and a
 * deployment that does not publish strfry's port is the documented normal case.
 * So nostrdb's answer sat complete in milliseconds while the browser counted
 * down someone else's timeout.
 *
 * The fix must not give up what the two-store read is FOR: the relay overruling
 * a nostrdb that never saw a profile published straight to it. It still does —
 * just after the name is on screen rather than instead of it.
 */

const PUBKEY = 'ab'.repeat(32)

const gatewayReturns = (body: unknown, ok = true) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, json: async () => body } as unknown as Response),
  )

/** A relay that never answers, the way an unreachable one behaves in the wild. */
const relayHangs = () => vi.mocked(allEvents).mockReturnValue(new Promise(() => {}))

/**
 * A relay that answers only AFTER the grace window has closed.
 *
 * 250ms, comfortably past `GRACE_MS`. A shorter delay would land inside the
 * window and be merged into the returned value — correct behaviour, but it
 * tests the wrong path: these cases are about the store that arrives too late
 * to be waited for and has to correct the answer instead.
 */
const relayAnswersAfter = (ms: number, content: string, created_at: number) =>
  vi.mocked(allEvents).mockReturnValue(
    new Promise((resolve) => setTimeout(() => resolve([{ content, created_at }] as never), ms)),
  )

beforeEach(() => {
  localStorage.clear()
  clearBrandingCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(allEvents).mockReset()
})

describe('when one store is slow', () => {
  it('answers from nostrdb without waiting for the relay', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Rosa Green Farm"}', createdAt: 900 }] })
    relayHangs()

    // If this awaited both, the test would time out rather than fail — which is
    // exactly what the user experienced, scaled down.
    expect(await fetchNewestKind0(PUBKEY)).toEqual({
      content: '{"name":"Rosa Green Farm"}',
      createdAt: 900,
    })
  })

  /** And the mirror case: nostrdb cold, the relay holding the profile. */
  it('answers from the relay without waiting for the gateway', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})))
    vi.mocked(allEvents).mockResolvedValue([
      { content: '{"name":"Rosa Green Farm"}', created_at: 900 },
    ] as never)

    expect(await fetchNewestKind0(PUBKEY)).toEqual({
      content: '{"name":"Rosa Green Farm"}',
      createdAt: 900,
    })
  })

  /**
   * A FAST "no" MUST NOT BEAT A SLOW "yes". `Promise.race` would resolve on the
   * first store to SETTLE, and the quickest settlement of all is a store that
   * is not configured returning null in 5ms — handing back "no such profile"
   * while the store that has it is still reading. Same class of bug as caching
   * a miss, which this module already refuses to do.
   */
  it('does not let an empty store win the race', async () => {
    gatewayReturns({ events: [] })
    vi.mocked(allEvents).mockReturnValue(
      new Promise((resolve) =>
        setTimeout(() => resolve([{ content: '{"name":"Rosa"}', created_at: 900 }] as never), 20),
      ),
    )

    expect(await fetchNewestKind0(PUBKEY)).toEqual({
      content: '{"name":"Rosa"}',
      createdAt: 900,
    })
  })

  it('reports nothing only when BOTH stores come back empty', async () => {
    gatewayReturns({ events: [] })
    vi.mocked(allEvents).mockResolvedValue([] as never)

    expect(await fetchNewestKind0(PUBKEY)).toBeNull()
  })
})

describe('the grace window', () => {
  /**
   * NEWEST-WINS IS NOT SACRIFICED FOR SPEED. Returning the first answer
   * outright was the obvious fix and it was wrong: a relay holding a SUPERSEDED
   * kind-0 can beat the gateway by a microtask, which would hand back the old
   * name and call it fast. So the faster store waits a bounded moment for the
   * slower one, and the newest of what arrives wins.
   *
   * A healthy store answers in 5-25ms, well inside the window, so in the normal
   * case the semantics are exactly what they were before.
   */
  it('lets a slower store still win on created_at', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Old Name"}', createdAt: 100 }] })
    relayAnswersAfter(20, '{"name":"New Name"}', 900)

    expect((await fetchNewestKind0(PUBKEY))?.content).toBe('{"name":"New Name"}')
  })

  /** And an older event never wins merely by being quick. */
  it('ignores a faster store holding a superseded profile', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Current"}', createdAt: 900 }] })
    relayAnswersAfter(20, '{"name":"Stale"}', 100)

    expect((await fetchNewestKind0(PUBKEY))?.content).toBe('{"name":"Current"}')
  })

  /**
   * THE CASE THAT MADE THIS BOUND REAL, found in review.
   *
   * An earlier version waited for a first ANSWER and only then started the
   * clock. That looks equivalent and is not: when the fast store legitimately
   * holds nothing, there is no first answer to start it with, so the deadline
   * never began and the entire relay timeout was back. And "nostrdb has no
   * profile" is not an edge case — it is routine for a stall whose kind-0 was
   * published straight to the relay, which is the very reason both stores are
   * read at all.
   *
   * Measured at 3003ms before the fix, 150ms after.
   */
  it('caps the wait even when the fast store has nothing to say', async () => {
    gatewayReturns({ events: [] })
    vi.mocked(allEvents).mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve([] as never), 3000)),
    )

    const started = Date.now()
    await fetchNewestKind0(PUBKEY)
    expect(Date.now() - started).toBeLessThan(600)
  }, 10_000)

  /**
   * The window is a CEILING, not a delay. A read where both stores answer
   * immediately must not sit waiting for a timer that has nothing left to wait
   * for — that would trade a 3s stall for a 150ms one on every profile in the
   * app.
   */
  it('returns as soon as both stores are in, not when the timer expires', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Rosa"}', createdAt: 900 }] })
    vi.mocked(allEvents).mockResolvedValue([] as never)

    const started = Date.now()
    await fetchNewestKind0(PUBKEY)
    expect(Date.now() - started).toBeLessThan(50)
  })

  /**
   * And an empty answer COUNTS as an answer. "No profile here" is a real
   * reply from a store, so a pubkey that genuinely has no kind-0 anywhere must
   * resolve at once rather than idling out the window — otherwise every
   * unregistered key on a screen costs the full grace period.
   */
  it('resolves immediately when both stores answer empty', async () => {
    gatewayReturns({ events: [] })
    vi.mocked(allEvents).mockResolvedValue([] as never)

    const started = Date.now()
    expect(await fetchNewestKind0(PUBKEY)).toBeNull()
    expect(Date.now() - started).toBeLessThan(50)
  })
})

describe('the store that lost the race', () => {
  /**
   * THE WHOLE POINT OF READING BOTH. The gateway's ingest subscribes to kind
   * 1059 only, so a profile published straight to the relay may never enter
   * nostrdb — answering from nostrdb because it answered FIRST would pin a
   * merchant to the name they registered with. The relay still overrules it,
   * now as a correction rather than a wait.
   */
  it('still corrects the answer when it holds something newer', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Old Name"}', createdAt: 100 }] })
    // The relay is the SLOW store here, which is the shape being tested: the
    // fast answer is returned, and this one arrives later holding something
    // newer. Delayed explicitly because two mocks that both resolve in the same
    // tick race on microtask order, not on the behaviour under test.
    relayAnswersAfter(250, '{"name":"New Name"}', 900)

    const corrections: string[] = []
    const first = await fetchNewestKind0(PUBKEY, (later) => corrections.push(later.content))

    // The fast answer came back first...
    expect(first?.content).toBe('{"name":"Old Name"}')
    // ...and the newer one followed.
    await vi.waitFor(() => expect(corrections).toEqual(['{"name":"New Name"}']))
  })

  it('says nothing when it merely agrees', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Rosa"}', createdAt: 900 }] })
    vi.mocked(allEvents).mockResolvedValue([
      { content: '{"name":"Rosa"}', created_at: 900 },
    ] as never)

    const corrections: string[] = []
    await fetchNewestKind0(PUBKEY, (later) => corrections.push(later.content))
    await new Promise((r) => setTimeout(r, 10))

    expect(corrections).toEqual([])
  })

  /**
   * A correction that reaches the cache but not the screen is only half a fix:
   * it would surface on the next reload, which is the "I renamed myself and
   * customers still see the old name" failure wearing a different hat.
   */
  it('reaches a rendered row through the subscription', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Old Name"}', createdAt: 100 }] })
    relayAnswersAfter(250, '{"name":"New Name"}', 900)

    const seen: (string | undefined)[] = []
    const off = onBrandingChanged(PUBKEY, (b) => seen.push(b.organizationName))

    expect((await merchantBranding(PUBKEY)).organizationName).toBe('Old Name')
    await vi.waitFor(() => expect(seen).toEqual(['New Name']))

    // And the corrected value is what the next caller gets, rather than the
    // superseded one sitting in the cache.
    off()
    expect((await merchantBranding(PUBKEY)).organizationName).toBe('New Name')
  })

  it('stops calling a listener that has unsubscribed', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Old Name"}', createdAt: 100 }] })
    relayAnswersAfter(250, '{"name":"New Name"}', 900)

    const seen: string[] = []
    const off = onBrandingChanged(PUBKEY, (b) => seen.push(b.organizationName ?? ''))
    off()

    await merchantBranding(PUBKEY)
    await new Promise((r) => setTimeout(r, 10))

    expect(seen).toEqual([])
  })
})
