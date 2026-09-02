/**
 * Paging the gift-wrap query.
 *
 * `limit` is a page size, not a budget. Before #38 this fetcher asked once: a
 * wallet holding more coupons than one page could carry received exactly one
 * page and never asked again. The rest were not late, they were never
 * requested, and nothing reported an error.
 *
 * These tests are built from a fake adapter rather than the running stack,
 * because the cases worth pinning are the awkward ones — an inclusive `until`
 * that overlaps pages, a server that ignores `until` entirely, a failure
 * partway through — and those are hard to provoke on demand against a real
 * gateway.
 */

import { describe, it, expect, vi } from 'vitest'

import { NostrdbQueryFetcher } from './NostrdbQueryFetcher'
import type { EventFilter, GiftWrapEvent } from '../types/subscription'

const PUBKEY = 'a'.repeat(64)

/** Gift wraps one second apart, newest first, as a relay returns them. */
function wraps(count: number, startAt = 1_000_000): GiftWrapEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `event-${startAt - i}`,
    pubkey: PUBKEY,
    created_at: startAt - i,
    kind: 1059,
    tags: [],
    content: '',
    sig: '',
  })) as GiftWrapEvent[]
}

/**
 * An adapter that pages over a fixed set, with an INCLUSIVE `until`.
 *
 * Inclusive because the real gateway is: asking for events at-or-before a
 * timestamp returns the event at it, so consecutive pages overlap. Observed
 * against the running stack as a 50-event page followed by one of 51.
 */
function pagingAdapter(all: GiftWrapEvent[], pageSize: number) {
  const queried: EventFilter[] = []
  return {
    queried,
    isAvailable: () => true,
    async queryEvents(filter: EventFilter): Promise<GiftWrapEvent[]> {
      queried.push({ ...filter })
      const eligible = all
        .filter((e) => filter.until === undefined || e.created_at <= filter.until)
        .sort((a, b) => b.created_at - a.created_at)
      return eligible.slice(0, pageSize)
    },
    async getProfile() {
      return null
    },
    subscribeEvents() {
      return { close: () => {}, isActive: () => false }
    },
  }
}

function fetcher(adapter: ReturnType<typeof pagingAdapter>, limit = 50, maxPages?: number) {
  return new NostrdbQueryFetcher({
    recipientPubkey: PUBKEY,
    nostrdbAdapter: adapter as never,
    limit,
    ...(maxPages === undefined ? {} : { maxPages }),
  })
}

describe('NostrdbQueryFetcher pagination', () => {
  it('returns everything a wallet holds, not one page of it', async () => {
    // The bug: 500 coupons issued and served, 50 received.
    const adapter = pagingAdapter(wraps(500), 50)

    const events = await fetcher(adapter).fetch()

    expect(events).toHaveLength(500)
    expect(new Set(events.map((e) => e.id)).size).toBe(500)
  })

  it('stops on a short page rather than querying forever', async () => {
    const adapter = pagingAdapter(wraps(120), 50)

    await fetcher(adapter).fetch()

    // 50, 50, then a page of 21 (the boundary event repeats) which is short.
    expect(adapter.queried).toHaveLength(3)
  })

  it('asks for one page when that is all there is', async () => {
    const adapter = pagingAdapter(wraps(10), 50)

    const events = await fetcher(adapter).fetch()

    expect(events).toHaveLength(10)
    expect(adapter.queried).toHaveLength(1)
    // Nothing to page past, so no `until` is sent at all.
    expect(adapter.queried[0].until).toBeUndefined()
  })

  it('does not return the boundary event twice', async () => {
    // `until` is inclusive, so the oldest event of one page is the newest of
    // the next. Without dedup the wallet would try to redeem it twice.
    const adapter = pagingAdapter(wraps(100), 50)

    const events = await fetcher(adapter).fetch()

    expect(events).toHaveLength(100)
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length)
  })

  it('walks backwards in time, so the newest coupons arrive first', async () => {
    const adapter = pagingAdapter(wraps(150), 50)

    const events = await fetcher(adapter).fetch()

    // If the walk is interrupted, what arrived should be the most recent.
    expect(events[0].created_at).toBe(1_000_000)
    expect(adapter.queried[1].until).toBeLessThan(1_000_000)
  })

  it('gives up when the server ignores until, instead of looping', async () => {
    // A server that returns the same newest page forever would otherwise be
    // followed all the way to maxPages, slowly, collecting nothing.
    const stuck = {
      isAvailable: () => true,
      queryEvents: vi.fn(async () => wraps(50)),
      getProfile: async () => null,
      subscribeEvents: () => ({ close: () => {}, isActive: () => false }),
    }

    const events = await new NostrdbQueryFetcher({
      recipientPubkey: PUBKEY,
      nostrdbAdapter: stuck as never,
      limit: 50,
    }).fetch()

    expect(events).toHaveLength(50)
    // Page 1, then page 2 detects no progress.
    expect(stuck.queryEvents).toHaveBeenCalledTimes(2)
  })

  it('respects maxPages as a runaway guard', async () => {
    const adapter = pagingAdapter(wraps(1000), 50)

    const events = await fetcher(adapter, 50, 3).fetch()

    expect(adapter.queried).toHaveLength(3)
    expect(events.length).toBeLessThan(1000)
  })

  it('keeps what it already fetched when a later page fails', async () => {
    // A transient network fault partway through must not empty the wallet:
    // what arrived is still the customer's money.
    let calls = 0
    const flaky = {
      isAvailable: () => true,
      queryEvents: async (filter: EventFilter) => {
        calls++
        if (calls > 2) throw new Error('network died')
        return pagingAdapter(wraps(500), 50).queryEvents(filter)
      },
      getProfile: async () => null,
      subscribeEvents: () => ({ close: () => {}, isActive: () => false }),
    }

    const events = await new NostrdbQueryFetcher({
      recipientPubkey: PUBKEY,
      nostrdbAdapter: flaky as never,
      limit: 50,
    }).fetch()

    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThan(500)
  })

  it('throws when the very first page fails, having nothing to keep', async () => {
    const dead = {
      isAvailable: () => true,
      queryEvents: async () => {
        throw new Error('gateway down')
      },
      getProfile: async () => null,
      subscribeEvents: () => ({ close: () => {}, isActive: () => false }),
    }

    await expect(
      new NostrdbQueryFetcher({
        recipientPubkey: PUBKEY,
        nostrdbAdapter: dead as never,
      }).fetch(),
    ).rejects.toThrow('gateway down')
  })
})
