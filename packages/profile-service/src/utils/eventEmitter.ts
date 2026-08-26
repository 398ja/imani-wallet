import type { Profile } from '../types/profile.js';
import type { ProfileFilter } from '../types/filters.js';
import type { ProfileEvent, ProfileEventListener, ProfileEventEmitter } from '../types/events.js';

/**
 * Simple event emitter for profile events
 */
export class SimpleEventEmitter implements ProfileEventEmitter {
  private listeners: Set<ProfileEventListener> = new Set();

  /**
   * Subscribe to events
   * @param listener - Event listener function
   * @returns Unsubscribe function
   */
  on(listener: ProfileEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Emit an event to all listeners
   * @param event - Profile event to emit
   */
  emit(event: ProfileEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Event listener error:', error);
      }
    }
  }

  /**
   * Remove all listeners
   */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * Get the number of listeners
   */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * Create event helper functions
 */
export function createEventHelpers(emitter: ProfileEventEmitter) {
  return {
    emitFollowAdded: (pubkey: string, labels?: string[]) => {
      emitter.emit({
        type: 'followAdded',
        pubkey,
        labels,
        timestamp: Date.now(),
      });
    },

    emitFollowRemoved: (pubkey: string) => {
      emitter.emit({
        type: 'followRemoved',
        pubkey,
        timestamp: Date.now(),
      });
    },

    emitFollowSyncError: (error: string, retryable: boolean) => {
      emitter.emit({
        type: 'followSyncError',
        error,
        retryable,
        timestamp: Date.now(),
      });
    },

    emitSearchExecuted: (
      filter: ProfileFilter,
      resultCount: number,
      durationMs: number
    ) => {
      emitter.emit({
        type: 'searchExecuted',
        filter,
        resultCount,
        durationMs,
        timestamp: Date.now(),
      });
    },

    emitProfileViewed: (pubkey: string, profile?: Profile) => {
      emitter.emit({
        type: 'profileViewed',
        pubkey,
        profile,
        timestamp: Date.now(),
      });
    },

    emitCacheHit: (key: string, cacheType: 'memory' | 'indexeddb') => {
      emitter.emit({
        type: 'cacheHit',
        key,
        cacheType,
        timestamp: Date.now(),
      });
    },

    emitCacheMiss: (key: string) => {
      emitter.emit({
        type: 'cacheMiss',
        key,
        timestamp: Date.now(),
      });
    },
  };
}
