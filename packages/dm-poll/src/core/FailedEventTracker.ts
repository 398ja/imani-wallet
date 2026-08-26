/**
 * FailedEventTracker - Tracks failed events for replay
 */

import type { StorageAdapter } from '../adapters/StorageAdapter';
import type { FailedEvent, GiftWrapEvent } from '../types';

/**
 * Options for FailedEventTracker
 */
export interface FailedEventTrackerOptions {
  /** Optional storage adapter for persistence */
  storageAdapter?: StorageAdapter | null;

  /** Cooldown period in ms before retrying a failed event (default: 1 hour) */
  retryCooldownMs?: number;
}

/**
 * Tracks failed events and allows replaying them
 */
export class FailedEventTracker {
  private failedEvents: Map<string, FailedEvent> = new Map();
  private readonly storageAdapter: StorageAdapter | null;
  private readonly retryCooldownMs: number;

  constructor(options: FailedEventTrackerOptions = {}) {
    this.storageAdapter = options.storageAdapter ?? null;
    this.retryCooldownMs = options.retryCooldownMs ?? 3600000; // 1 hour default
  }

  /**
   * Load failed events from storage
   */
  async load(): Promise<void> {
    if (this.storageAdapter?.getFailedEvents) {
      try {
        this.failedEvents = await this.storageAdapter.getFailedEvents();
        console.log(`[FailedEventTracker] Loaded ${this.failedEvents.size} failed events`);
      } catch (error) {
        console.warn('[FailedEventTracker] Failed to load from storage:', error);
        this.failedEvents = new Map();
      }
    }
  }

  /**
   * Check if an event is in the failed list
   *
   * @param eventId - Event ID to check
   * @returns true if event is tracked as failed
   */
  has(eventId: string): boolean {
    return this.failedEvents.has(eventId);
  }

  /**
   * Get a failed event by ID
   *
   * @param eventId - Event ID
   * @returns FailedEvent if found
   */
  get(eventId: string): FailedEvent | undefined {
    return this.failedEvents.get(eventId);
  }

  /**
   * Track a failed event
   *
   * @param eventId - Event ID
   * @param event - Original gift wrap event
   * @param error - Error message
   */
  async track(eventId: string, event: GiftWrapEvent, error: string): Promise<void> {
    const existing = this.failedEvents.get(eventId);
    const attempts = existing ? existing.attempts + 1 : 1;

    const failedEvent: FailedEvent = {
      eventId,
      event,
      error,
      attempts,
      lastAttempt: Date.now(),
      createdAt: event.created_at,
    };

    this.failedEvents.set(eventId, failedEvent);
    await this.save(eventId, failedEvent);

    console.log(
      `[FailedEventTracker] Tracked failed event: ${eventId.substring(0, 16)}... (attempts: ${attempts})`
    );
  }

  /**
   * Remove a failed event (after successful replay)
   *
   * @param eventId - Event ID to remove
   */
  async remove(eventId: string): Promise<void> {
    this.failedEvents.delete(eventId);

    if (this.storageAdapter?.removeFailedEvent) {
      try {
        await this.storageAdapter.removeFailedEvent(eventId);
      } catch (error) {
        console.warn('[FailedEventTracker] Failed to remove from storage:', error);
      }
    }
  }

  /**
   * Check if an event can be retried (not in cooldown)
   *
   * @param eventId - Event ID
   * @returns true if event can be retried
   */
  canRetry(eventId: string): boolean {
    const failed = this.failedEvents.get(eventId);
    if (!failed) {
      return true;
    }

    return Date.now() - failed.lastAttempt >= this.retryCooldownMs;
  }

  /**
   * Get all failed events
   *
   * @returns Array of FailedEvent
   */
  getAll(): FailedEvent[] {
    return Array.from(this.failedEvents.values());
  }

  /**
   * Get events that can be retried (not in cooldown)
   *
   * @returns Array of FailedEvent that can be retried
   */
  getRetryable(): FailedEvent[] {
    const now = Date.now();
    return this.getAll().filter((fe) => now - fe.lastAttempt >= this.retryCooldownMs);
  }

  /**
   * Clear all failed events
   */
  async clear(): Promise<void> {
    this.failedEvents.clear();

    if (this.storageAdapter?.clearFailedEvents) {
      try {
        await this.storageAdapter.clearFailedEvents();
      } catch (error) {
        console.warn('[FailedEventTracker] Failed to clear storage:', error);
      }
    }

    console.log('[FailedEventTracker] Cleared all failed events');
  }

  /**
   * Get the number of failed events
   */
  get size(): number {
    return this.failedEvents.size;
  }

  /**
   * Save a failed event to storage
   */
  private async save(eventId: string, failedEvent: FailedEvent): Promise<void> {
    if (this.storageAdapter?.saveFailedEvent) {
      try {
        await this.storageAdapter.saveFailedEvent(eventId, failedEvent);
      } catch (error) {
        console.warn('[FailedEventTracker] Failed to save to storage:', error);
      }
    }
  }
}
