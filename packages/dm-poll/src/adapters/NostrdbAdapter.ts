/**
 * NostrdbAdapter - Interface for reading from nostrdb backend API
 *
 * REQUIRED adapter - All reads go through this adapter.
 * The frontend NEVER connects directly to relays.
 */

import type { GiftWrapEvent, Profile } from '../types/dm';
import type { SubscriptionHandle, EventFilter } from '../types/subscription';

/**
 * Adapter for interacting with nostrdb backend API
 *
 * This adapter handles all read operations via the backend API,
 * which provides caching, chunk reassembly, and real-time subscriptions.
 */
export interface NostrdbAdapter {
  /**
   * Subscribe to events via Server-Sent Events (SSE)
   *
   * @param filter - Event filter (kinds, pTags, etc.)
   * @param onEvent - Callback when an event is received
   * @param onError - Callback when an error occurs
   * @returns Subscription handle for managing the subscription
   */
  subscribeEvents(
    filter: EventFilter,
    onEvent: (event: GiftWrapEvent) => void,
    onError: (error: Error) => void
  ): SubscriptionHandle;

  /**
   * Query events from nostrdb cache
   *
   * @param filter - Event filter
   * @returns Array of matching events
   */
  queryEvents(filter: EventFilter): Promise<GiftWrapEvent[]>;

  /**
   * Get profile for a public key (cached)
   *
   * @param pubkey - Public key (hex)
   * @returns Profile if found, null otherwise
   */
  getProfile(pubkey: string): Promise<Profile | null>;

  /**
   * Check if the backend API is available
   *
   * @returns true if available, false otherwise
   */
  isAvailable(): boolean;
}

/**
 * Type guard to check if an object implements NostrdbAdapter
 */
export function isNostrdbAdapter(obj: unknown): obj is NostrdbAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const adapter = obj as NostrdbAdapter;
  return (
    typeof adapter.subscribeEvents === 'function' &&
    typeof adapter.queryEvents === 'function' &&
    typeof adapter.getProfile === 'function' &&
    typeof adapter.isAvailable === 'function'
  );
}
