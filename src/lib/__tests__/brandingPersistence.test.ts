/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearBrandingCache, knownBranding, merchantBranding } from '../branding'
import { allEvents } from '../relay'

vi.mock('../relay', () => ({ allEvents: vi.fn() }))

/**
 * Profiles survive a reload.
 *
 * The session cache above this spares a second request inside ONE document, and
 * that is all it ever did: every reload started cold, and a cold kind-0 lookup
 * is two network round trips before any name exists. So the app re-earned the
 * same answer on every launch, and the seconds it spent doing so were the
 * seconds a row had nothing to show.
 *
 * Nostr makes this safe in a way a general cache would not be: kind-0 is a
 * REPLACEABLE event carrying its own `created_at`, so a stored copy is never
 * ambiguous — it is simply the newest one this device has seen, and the fetch
 * behind it either confirms it or replaces it. There is no invalidation problem
 * to get wrong, only a staleness window, and the window costs a name being one
 * version old rather than being a hex key.
 */

const PUBKEY = 'ab'.repeat(32)
const STORE_KEY = `imani-wallet:identity:${PUBKEY}`

const relayHas = (events: unknown[]) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as unknown as Response))
  vi.mocked(allEvents).mockResolvedValue(events as never)
}

beforeEach(() => {
  localStorage.clear()
  clearBrandingCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(allEvents).mockReset()
})

describe('a profile that was already fetched once', () => {
  it('is still there after the session cache is gone', async () => {
    relayHas([{ content: '{"name":"Rosa Green Farm"}', created_at: 900 }])
    await merchantBranding(PUBKEY)

    // What a reload looks like: the module-level Map is empty again, but
    // localStorage is not.
    const stored = localStorage.getItem(STORE_KEY)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored as string).branding.organizationName).toBe('Rosa Green Farm')
  })

  /**
   * SYNCHRONOUSLY, which is the whole requirement. A promise that resolves in a
   * microtask still resolves after the first paint, so a renderer asking through
   * one draws the placeholder anyway — the answer has to be available DURING the
   * first render or it buys nothing.
   */
  it('is readable without waiting for anything', () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ branding: { organizationName: 'Rosa Green Farm' }, at: Date.now() }),
    )

    expect(knownBranding(PUBKEY)?.organizationName).toBe('Rosa Green Farm')
  })

  it('answers for a pubkey in either case', () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ branding: { organizationName: 'Rosa' }, at: Date.now() }),
    )

    expect(knownBranding(PUBKEY.toUpperCase())?.organizationName).toBe('Rosa')
  })

  it('serves a fresh one without asking the network at all', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ branding: { organizationName: 'Rosa' }, at: Date.now() }),
    )
    relayHas([])

    expect((await merchantBranding(PUBKEY)).organizationName).toBe('Rosa')
    expect(allEvents).not.toHaveBeenCalled()
  })

  /**
   * A day old and we ask again — but the stored copy is still what renders while
   * we do. Staleness decides whether the REQUEST is worth making, never whether
   * the name is worth showing.
   */
  it('refetches a stale one, and still shows it meanwhile', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        branding: { organizationName: 'Old Name' },
        at: Date.now() - 48 * 60 * 60 * 1000,
      }),
    )
    relayHas([{ content: '{"name":"New Name"}', created_at: 900 }])

    // Available immediately, before the fetch settles.
    expect(knownBranding(PUBKEY)?.organizationName).toBe('Old Name')
    expect((await merchantBranding(PUBKEY)).organizationName).toBe('New Name')
    expect(knownBranding(PUBKEY)?.organizationName).toBe('New Name')
  })

  /**
   * A FAILED LOOKUP MUST NOT ERASE A NAME. Both stores being briefly unreachable
   * is the ordinary case on a phone, and the old behaviour — fall through to
   * `EMPTY_BRANDING` — would take a merchant the user has seen a hundred times
   * and render them as a hex key because the train went into a tunnel.
   */
  it('keeps the known name when the lookup comes back empty', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        branding: { organizationName: 'Rosa' },
        at: Date.now() - 48 * 60 * 60 * 1000,
      }),
    )
    relayHas([])

    expect((await merchantBranding(PUBKEY)).organizationName).toBe('Rosa')
  })

  /**
   * localStorage is not a trust boundary. These URLs were authored by whoever
   * published the kind-0 and they go straight into an `img src`, so they are
   * narrowed again on the way out rather than trusted because we wrote them.
   */
  it('re-sanitises image urls on the way out', () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        branding: { organizationName: 'Rosa', logoUrl: 'javascript:alert(1)' },
        at: Date.now(),
      }),
    )

    const known = knownBranding(PUBKEY)
    expect(known?.organizationName).toBe('Rosa')
    expect(known?.logoUrl).toBeUndefined()
  })

  it('shrugs off a record written by an older build', () => {
    localStorage.setItem(STORE_KEY, 'not json')
    expect(knownBranding(PUBKEY)).toBeUndefined()

    localStorage.setItem(STORE_KEY, JSON.stringify({ nonsense: true }))
    expect(knownBranding(PUBKEY)).toBeUndefined()
  })
})
