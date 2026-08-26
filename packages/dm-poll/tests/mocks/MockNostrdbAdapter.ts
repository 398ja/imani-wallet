/**
 * Mock NostrdbAdapter for testing
 */

import type { NostrdbAdapter } from '../../src/adapters/NostrdbAdapter';
import type { GiftWrapEvent, Profile } from '../../src/types/dm';
import type { SubscriptionHandle, EventFilter } from '../../src/types/subscription';

/**
 * Mock NostrdbAdapter implementation for testing
 */
export class MockNostrdbAdapter implements NostrdbAdapter {
  private events: GiftWrapEvent[] = [];
  private profiles: Map<string, Profile> = new Map();
  private available = true;
  private subscriptionCallbacks: Array<{
    onEvent: (event: GiftWrapEvent) => void;
    onError: (error: Error) => void;
  }> = [];

  /**
   * Set mock events
   */
  setEvents(events: GiftWrapEvent[]): void {
    this.events = events;
  }

  /**
   * Add a mock event
   */
  addEvent(event: GiftWrapEvent): void {
    this.events.push(event);
    // Notify subscribers
    this.subscriptionCallbacks.forEach(cb => cb.onEvent(event));
  }

  /**
   * Set mock profile
   */
  setProfile(pubkey: string, profile: Profile): void {
    this.profiles.set(pubkey, profile);
  }

  /**
   * Set availability
   */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /**
   * Trigger error on all subscriptions
   */
  triggerError(error: Error): void {
    this.subscriptionCallbacks.forEach(cb => cb.onError(error));
  }

  // NostrdbAdapter implementation

  subscribeEvents(
    filter: EventFilter,
    onEvent: (event: GiftWrapEvent) => void,
    onError: (error: Error) => void
  ): SubscriptionHandle {
    const id = `mock-sub-${Date.now()}`;

    this.subscriptionCallbacks.push({ onEvent, onError });

    // Send existing events that match filter
    const matching = this.filterEvents(filter);
    matching.forEach(event => onEvent(event));

    return {
      id,
      stop: () => {
        const index = this.subscriptionCallbacks.findIndex(
          cb => cb.onEvent === onEvent
        );
        if (index >= 0) {
          this.subscriptionCallbacks.splice(index, 1);
        }
      },
      isActive: () => this.subscriptionCallbacks.some(cb => cb.onEvent === onEvent),
    };
  }

  async queryEvents(filter: EventFilter): Promise<GiftWrapEvent[]> {
    if (!this.available) {
      throw new Error('nostrdb not available');
    }
    return this.filterEvents(filter);
  }

  async getProfile(pubkey: string): Promise<Profile | null> {
    if (!this.available) {
      throw new Error('nostrdb not available');
    }
    return this.profiles.get(pubkey) ?? null;
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Filter events based on filter criteria
   */
  private filterEvents(filter: EventFilter): GiftWrapEvent[] {
    return this.events.filter(event => {
      // Check kinds
      if (filter.kinds && !filter.kinds.includes(event.kind)) {
        return false;
      }

      // Check pTags
      if (filter.pTags) {
        const pTag = event.tags.find(t => t[0] === 'p');
        if (!pTag || !filter.pTags.includes(pTag[1])) {
          return false;
        }
      }

      // Check since
      if (filter.since && event.created_at < filter.since) {
        return false;
      }

      // Check until
      if (filter.until && event.created_at > filter.until) {
        return false;
      }

      return true;
    }).slice(0, filter.limit ?? this.events.length);
  }
}

/**
 * Create a mock gift wrap event
 */
export function createMockGiftWrap(
  overrides: Partial<GiftWrapEvent> = {}
): GiftWrapEvent {
  return {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: 1059,
    pubkey: 'ephemeral-pubkey-123',
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', 'recipient-pubkey-456']],
    content: 'encrypted-content',
    sig: 'signature-789',
    ...overrides,
  };
}

/**
 * Create a mock profile
 */
export function createMockProfile(
  overrides: Partial<Profile> = {}
): Profile {
  return {
    pubkey: 'pubkey-123',
    name: 'Test User',
    display_name: 'Test User',
    nip05: 'test@example.com',
    picture: 'https://example.com/avatar.png',
    ...overrides,
  };
}
