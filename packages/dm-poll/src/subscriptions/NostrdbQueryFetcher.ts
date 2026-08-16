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

  /** Maximum number of events to fetch */
  limit?: number;
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

    const filter: EventFilter = {
      kinds: [1059],
      pTags: [this.options.recipientPubkey],
      since,
      limit: this.options.limit,
    };

    console.log('[NostrdbQueryFetcher] Fetching recent DMs since:', new Date(since * 1000).toISOString());

    try {
      const events = await this.options.nostrdbAdapter.queryEvents(filter);
      console.log(`[NostrdbQueryFetcher] Fetched ${events.length} gift wrap events`);
      return events;
    } catch (error) {
      console.error('[NostrdbQueryFetcher] Query failed:', error);
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
