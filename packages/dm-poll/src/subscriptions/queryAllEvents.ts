/**
 * Fetching every gift wrap a recipient holds, not just the first page.
 *
 * `limit` on a nostr filter is a PAGE SIZE, not a budget. Asking once means a
 * wallet holding more coupons than one page can carry receives exactly one
 * page and never asks again: the rest are not late, they are never requested,
 * and nothing reports an error. The wallet shows a plausible number and looks
 * correct (#38).
 *
 * Raising the constant only moves the cliff, and the cliff is invisible when
 * you reach it. So this pages until a short page arrives.
 *
 * Shared because there were two capped queries in `DmPollService` and a third
 * in `NostrdbQueryFetcher`, each with its own constant. Fixing one would have
 * left the others silently truncating.
 */

import type { GiftWrapEvent } from '../types/dm'
import type { EventFilter } from '../types/subscription'
import type { NostrdbAdapter } from '../adapters/NostrdbAdapter'

export interface PagedQueryOptions {
  /** Events per request. Paging continues past this. */
  pageSize?: number
  /**
   * How many pages to walk before giving up.
   *
   * A safety rail on a loop that talks to a server, not a real limit: at the
   * default page size this is 10,000 coupons, far past any wallet, and a
   * runaway is a bug worth stopping rather than following forever.
   */
  maxPages?: number
  /** Where to report progress and anomalies. */
  log?: (message: string) => void
}

/**
 * Query every event matching `filter`, paging backwards through time.
 *
 * Backwards because the newest events are the ones a customer most wants
 * first: if the walk is interrupted, what arrived is the most recent rather
 * than an arbitrary slice.
 */
export async function queryAllEvents(
  adapter: NostrdbAdapter,
  filter: EventFilter,
  { pageSize = 50, maxPages = 200, log = () => {} }: PagedQueryOptions = {},
): Promise<GiftWrapEvent[]> {
  const collected: GiftWrapEvent[] = []
  const seen = new Set<string>()
  let until: number | undefined = filter.until

  try {
    for (let page = 0; page < maxPages; page++) {
      const events = await adapter.queryEvents({ ...filter, until, limit: pageSize })

      // Dedup by id. `until` is inclusive on this gateway — asking for events
      // at-or-before a timestamp returns the event AT it — so consecutive
      // pages overlap at the boundary, and any event sharing that second
      // appears twice. Observed: a 50-event page followed by one of 51.
      let added = 0
      for (const event of events) {
        if (seen.has(event.id)) continue
        seen.add(event.id)
        collected.push(event)
        added++
      }

      // A short page means the end. Judged on what the SERVER returned, not on
      // how many were new: a full page of duplicates still means there may be
      // more behind it.
      if (events.length < pageSize) break

      // A full page with nothing new means `until` cannot advance, which would
      // loop. Only possible when every event in the page shares one timestamp.
      if (added === 0) {
        log('a full page held no new events; stopping')
        break
      }

      const oldest = Math.min(...events.map((e) => e.created_at))

      // Guard against a server that ignores `until` and keeps returning the
      // same newest page: otherwise the loop runs to maxPages, slowly,
      // collecting nothing.
      if (until !== undefined && oldest >= until) {
        log('pagination stopped advancing; stopping')
        break
      }
      until = oldest
    }

    return collected
  } catch (error) {
    // Whatever arrived before the failure is still the customer's money, and
    // dropping it would turn a transient network fault into a wallet that
    // shows nothing. Only a failure on the FIRST page has nothing to keep.
    if (collected.length > 0) {
      log(`query failed after ${collected.length} events; keeping them`)
      return collected
    }
    throw error
  }
}
