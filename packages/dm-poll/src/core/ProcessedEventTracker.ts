/**
 * ProcessedEventTracker - Deduplication logic for processed events
 */

import type { StorageAdapter } from '../adapters/StorageAdapter';

/**
 * Options for ProcessedEventTracker
 */
export interface ProcessedEventTrackerOptions {
  /** Maximum number of events to track (LRU) */
  maxEvents: number;

  /** Storage key for persistence */
  storageKey: string;

  /** Optional storage adapter for persistence */
  storageAdapter?: StorageAdapter | null;
}

/**
 * Tracks processed event IDs to prevent duplicate processing
 *
 * Uses an LRU-style tracking with optional persistence.
 */
export class ProcessedEventTracker {
  private processedIds: Set<string> = new Set();
  private orderedIds: string[] = [];
  private readonly maxEvents: number;
  private readonly storageAdapter: StorageAdapter | null;

  constructor(options: ProcessedEventTrackerOptions) {
    this.maxEvents = options.maxEvents;
    this.storageAdapter = options.storageAdapter ?? null;
  }

  /**
   * Load processed events from storage
   */
  async load(): Promise<void> {
    if (this.storageAdapter) {
      try {
        const ids = await this.storageAdapter.getProcessedEventIds();
        this.orderedIds = ids.slice(-this.maxEvents);
        this.processedIds = new Set(this.orderedIds);
        console.log(`[ProcessedEventTracker] Loaded ${this.processedIds.size} processed event IDs`);
      } catch (error) {
        console.warn('[ProcessedEventTracker] Failed to load from storage:', error);
      }
    }
  }

  /**
   * Check if an event has been processed
   *
   * @param eventId - Event ID to check
   * @returns true if already processed
   */
  has(eventId: string): boolean {
    return this.processedIds.has(eventId);
  }

  /**
   * Mark an event as processed
   *
   * @param eventId - Event ID to mark
   */
  async add(eventId: string): Promise<void> {
    if (this.processedIds.has(eventId)) {
      return;
    }

    this.processedIds.add(eventId);
    this.orderedIds.push(eventId);

    // Enforce LRU limit
    while (this.orderedIds.length > this.maxEvents) {
      const oldest = this.orderedIds.shift();
      if (oldest) {
        this.processedIds.delete(oldest);
      }
    }

    // Persist to storage
    await this.save();
  }

  /**
   * Save processed events to storage
   */
  private async save(): Promise<void> {
    if (this.storageAdapter) {
      try {
        await this.storageAdapter.saveProcessedEventIds(this.orderedIds);
      } catch (error) {
        console.warn('[ProcessedEventTracker] Failed to save to storage:', error);
      }
    }
  }

  /**
   * Clear all tracked events
   */
  async clear(): Promise<void> {
    this.processedIds.clear();
    this.orderedIds = [];
    await this.save();
  }

  /**
   * Get the number of tracked events
   */
  get size(): number {
    return this.processedIds.size;
  }

  /**
   * Get all tracked event IDs
   */
  getAll(): string[] {
    return [...this.orderedIds];
  }
}
