/**
 * NostrdbQueryFetcher - One-time query for recent DMs
 *
 * Used for initial fetch of recent DMs on startup and
 * for polling mode as a fallback.
 */

import type { GiftWrapEvent } from '../types/dm';
import type { EventFilter } from '../types/subscription';
import type { NostrdbAdapter } from '../adapters/NostrdbAdapter';

/**
 * Options for NostrdbQueryFetcher
 */
export interface NostrdbQueryFetcherOptions {
  /** nostrdb adapter for querying */
  nostrdbAdapter: NostrdbAdapter;

  /** Recipient's public key */
  recipientPubkey: string;

  /** How far back to fetch (in seconds) */
  sinceSec?: number;

  /** Maximum number of events per page. Paging continues past this. */
  limit?: number;

  /**
   * How many pages to walk before giving up.
   *
   * A safety rail on a loop that talks to a server, not a real limit: at the
   * default page size this is 10,000 coupons, far past any wallet, and a
   * runaway is a bug worth stopping rather than following forever.
   */
  maxPages?: number;
}

/**
 * Fetcher for querying recent gift wrap events from nostrdb
 */
export class NostrdbQueryFetcher {
  private readonly options: Required<NostrdbQueryFetcherOptions>;

  constructor(options: NostrdbQueryFetcherOptions) {
    this.options = {
      sinceSec: 86400, // 24 hours
      limit: 50,
      maxPages: 200,
      ...options,
    };
  }

  /**
   * Fetch recent gift wrap events
   *
   * @returns Array of gift wrap events
   */
  async fetch(): Promise<GiftWrapEvent[]> {
    const since = Math.floor(Date.now() / 1000) - this.options.sinceSec;

    console.log('[NostrdbQueryFetcher] Fetching recent DMs since:', new Date(since * 1000).toISOString());

    // Page until a short page arrives.
    //
    // `limit` is a page size, not a budget. Asking once meant a wallet holding
    // more coupons than one page could carry received exactly one page and
    // never asked again — the rest were not late, they were never requested,
    // and nothing reported an error (#38). Raising the constant would only
    // move the cliff; paging removes it.
    //
    // Walks BACKWARDS in time with `until`, because the newest page is the one
    // a customer most wants first: if the walk is interrupted, what arrived is
    // the most recent, not an arbitrary slice.
    const collected: GiftWrapEvent[] = [];
    const seen = new Set<string>();
    let until: number | undefined;

    try {
      for (let page = 0; page < this.options.maxPages; page++) {
        const filter: EventFilter = {
          kinds: [1059],
          pTags: [this.options.recipientPubkey],
          since,
          until,
          limit: this.options.limit,
        };

        const events = await this.options.nostrdbAdapter.queryEvents(filter);

        // Dedup by id. `until` is inclusive on this gateway — asking for
        // events at-or-before a timestamp returns the event AT it — so
        // consecutive pages overlap at the boundary, and any event sharing
        // that second appears twice. Observed: a 50-event page followed by a
        // page of 51.
        let added = 0;
        for (const event of events) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          collected.push(event);
          added++;
        }

        // A short page means the end. Judged on what the SERVER returned, not
        // on how many were new: a full page of entirely duplicate events still
        // means there may be more behind it.
        if (events.length < this.options.limit) break;

        // No new events in a full page means `until` is not advancing, which
        // would loop forever. Only possible if every event in the page shares
        // one timestamp, and stopping is better than spinning.
        if (added === 0) {
          console.warn('[NostrdbQueryFetcher] a full page held no new events; stopping');
          break;
        }

        const oldest = Math.min(...events.map((e) => e.created_at));
        // Guard against a server that ignores `until` and keeps returning the
        // same newest page: without this the loop would run to maxPages
        // collecting nothing new, slowly.
        if (until !== undefined && oldest >= until) {
          console.warn('[NostrdbQueryFetcher] pagination stopped advancing; stopping');
          break;
        }
        until = oldest;
      }

      console.log(`[NostrdbQueryFetcher] Fetched ${collected.length} gift wrap events`);
      return collected;
    } catch (error) {
      console.error('[NostrdbQueryFetcher] Query failed:', error);
      // Whatever arrived before the failure is still the customer's money, and
      // dropping it would turn a transient network fault into a wallet that
      // shows nothing. Only a failure on the FIRST page has nothing to keep.
      if (collected.length > 0) {
        console.warn(`[NostrdbQueryFetcher] keeping ${collected.length} already fetched`);
        return collected;
      }
      throw error;
    }
  }

  /**
   * Fetch events newer than a specific timestamp
   *
   * @param sinceTimestamp - Unix timestamp in seconds
   * @returns Array of gift wrap events
   */
  async fetchSince(sinceTimestamp: number): Promise<GiftWrapEvent[]> {
    const filter: EventFilter = {
      kinds: [1059],
      pTags: [this.options.recipientPubkey],
      since: sinceTimestamp,
      limit: this.options.limit,
    };

    try {
      const events = await this.options.nostrdbAdapter.queryEvents(filter);
      return events;
    } catch (error) {
      console.error('[NostrdbQueryFetcher] Query failed:', error);
      throw error;
    }
  }

  /**
   * Fetch a specific event by ID
   *
   * @param eventId - Event ID to fetch
   * @returns Event if found, null otherwise
   */
  async fetchById(eventId: string): Promise<GiftWrapEvent | null> {
    const filter: EventFilter = {
      kinds: [1059],
      tags: { '#e': [eventId] },
      limit: 1,
    };

    try {
      const events = await this.options.nostrdbAdapter.queryEvents(filter);
      return events.length > 0 ? events[0] : null;
    } catch (error) {
      console.error('[NostrdbQueryFetcher] Query by ID failed:', error);
      return null;
    }
  }
}

/**
 * Create a NostrdbQueryFetcher
 */
export function createNostrdbQueryFetcher(
  options: NostrdbQueryFetcherOptions
): NostrdbQueryFetcher {
  return new NostrdbQueryFetcher(options);
}
