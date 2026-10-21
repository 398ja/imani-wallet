/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimplePool, type Event, type Filter } from 'nostr-tools'

import { allEvents } from '../relay'

vi.mock('../gatewayNostr', () => ({ gatewayEvents: async () => [], newestByD: () => [] }))

/**
 * #206 review M2: strfry caps every filter at `maxFilterLimit` (500) newest
 * events, silently. A wallet past 500 kind-7375 events (chunked snapshots get
 * there faster) lost its oldest coupons on restore. `allEvents` must page with
 * an `until` cursor until the relay runs dry.
 */
const STRFRY_MAX_FILTER_LIMIT = 500

function fakeStrfry(store: Event[]) {
  const filters: Filter[] = []
  vi.spyOn(SimplePool.prototype, 'querySync').mockImplementation(async (_relays, filter: Filter) => {
    filters.push(filter)
    const limit = Math.min(filter.limit ?? STRFRY_MAX_FILTER_LIMIT, STRFRY_MAX_FILTER_LIMIT)
    return store
      .filter((e) => filter.until === undefined || e.created_at <= filter.until)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
  })
  return filters
}

const ev = (i: number, at: number) => ({ id: i.toString(16).padStart(64, '0'), created_at: at, kind: 7375, tags: [], content: '', pubkey: 'p', sig: '' }) as Event

afterEach(() => vi.restoreAllMocks())

describe('allEvents paginates past the relay filter cap', () => {
  it('returns all 1,234 events, not the newest 500', async () => {
    // Several events per second, as a chunked snapshot shares one created_at.
    const store = Array.from({ length: 1_234 }, (_, i) => ev(i, 1_000 + Math.floor(i / 3)))
    const filters = fakeStrfry(store)
    const got = await allEvents('ab'.repeat(32), 7375, ['ws://x'])
    expect(got).toHaveLength(1_234)
    expect(new Set(got.map((e) => e.id)).size).toBe(1_234)
    expect(filters.length).toBeGreaterThan(2)
    expect(filters.every((f) => f.limit === STRFRY_MAX_FILTER_LIMIT)).toBe(true)
  })

  it('does not lose events that share the cursor second across a page edge', async () => {
    const store = [...Array.from({ length: 499 }, (_, i) => ev(i, 2_000 + i)), ...Array.from({ length: 5 }, (_, i) => ev(10_000 + i, 1_999))]
    store.push(...Array.from({ length: 5 }, (_, i) => ev(20_000 + i, 2_000))) // straddles the edge
    fakeStrfry(store)
    expect(await allEvents('ab'.repeat(32), 7375, ['ws://x'])).toHaveLength(store.length)
  })

  it('stops after at most two queries for a small wallet', async () => {
    const filters = fakeStrfry([ev(1, 5), ev(2, 6)])
    expect(await allEvents('ab'.repeat(32), 7375, ['ws://x'])).toHaveLength(2)
    expect(filters.length).toBeLessThanOrEqual(2)
  })
})

describe('allEvents survives a page cut short by the EOSE timeout', () => {
  it('keeps walking when a page returns fewer than the limit but more remain', async () => {
    const store = Array.from({ length: 900 }, (_, i) => ev(i, 1_000 + i))
    vi.spyOn(SimplePool.prototype, 'querySync').mockImplementation(async (_r, filter: Filter) =>
      store
        .filter((e) => filter.until === undefined || e.created_at <= filter.until)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 151), // what strfry delivered in 1200ms on the probe
    )
    expect(await allEvents('ab'.repeat(32), 7375, ['ws://x'])).toHaveLength(900)
  })
})
