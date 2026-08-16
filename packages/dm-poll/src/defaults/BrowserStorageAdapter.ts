/**
 * BrowserStorageAdapter - localStorage implementation
 *
 * Default storage adapter using browser localStorage.
 */

import type { StorageAdapter } from '../adapters/StorageAdapter';
import type { Voucher } from '../types/voucher';
import type { FailedEvent } from '../types/events';

/**
 * Options for BrowserStorageAdapter
 */
export interface BrowserStorageAdapterOptions {
  /** Storage key prefix */
  prefix?: string;

  /** Key for vouchers */
  vouchersKey?: string;

  /** Key for processed event IDs */
  processedEventsKey?: string;

  /** Key for received token fingerprints */
  receivedTokensKey?: string;

  /** Key for failed events */
  failedEventsKey?: string;
}

/**
 * localStorage-based storage adapter
 */
export class BrowserStorageAdapter implements StorageAdapter {
  private readonly prefix: string;
  private readonly vouchersKey: string;
  private readonly processedEventsKey: string;
  private readonly receivedTokensKey: string;
  private readonly failedEventsKey: string;

  constructor(options: BrowserStorageAdapterOptions = {}) {
    this.prefix = options.prefix ?? 'imani_dm_';
    this.vouchersKey = options.vouchersKey ?? `${this.prefix}vouchers`;
    this.processedEventsKey = options.processedEventsKey ?? `${this.prefix}processed_events`;
    this.receivedTokensKey = options.receivedTokensKey ?? `${this.prefix}received_tokens`;
    this.failedEventsKey = options.failedEventsKey ?? `${this.prefix}failed_events`;
  }

  /**
   * Save a voucher
   */
  async saveVoucher(voucher: Voucher): Promise<void> {
    const vouchers = await this.getVouchers();

    // Update or add voucher
    const index = vouchers.findIndex(v => v.voucher_id === voucher.voucher_id);
    if (index >= 0) {
      vouchers[index] = voucher;
    } else {
      vouchers.push(voucher);
    }

    this.setItem(this.vouchersKey, vouchers);
  }

  /**
   * Check if token was already received
   */
  async hasTokenBeenReceived(tokenFingerprint: string): Promise<boolean> {
    const received = this.getReceivedTokens();
    return received.has(tokenFingerprint);
  }

  /**
   * Mark token as received
   */
  async markTokenAsReceived(tokenFingerprint: string): Promise<void> {
    const received = this.getReceivedTokens();
    received.add(tokenFingerprint);
    this.setItem(this.receivedTokensKey, Array.from(received));
  }

  /**
   * Get processed event IDs
   */
  async getProcessedEventIds(): Promise<string[]> {
    return this.getItem<string[]>(this.processedEventsKey) ?? [];
  }

  /**
   * Save processed event IDs
   */
  async saveProcessedEventIds(ids: string[]): Promise<void> {
    this.setItem(this.processedEventsKey, ids);
  }

  /**
   * Get all vouchers
   */
  async getVouchers(): Promise<Voucher[]> {
    return this.getItem<Voucher[]>(this.vouchersKey) ?? [];
  }

  /**
   * Get a voucher by ID
   */
  async getVoucher(voucherId: string): Promise<Voucher | null> {
    const vouchers = await this.getVouchers();
    return vouchers.find(v => v.voucher_id === voucherId) ?? null;
  }

  // ==================== FAILED EVENTS ====================

  /**
   * Get all failed events
   */
  async getFailedEvents(): Promise<Map<string, FailedEvent>> {
    const obj = this.getItem<Record<string, FailedEvent>>(this.failedEventsKey) ?? {};
    return new Map(Object.entries(obj));
  }

  /**
   * Save a failed event
   */
  async saveFailedEvent(eventId: string, failedEvent: FailedEvent): Promise<void> {
    const events = await this.getFailedEvents();
    events.set(eventId, failedEvent);
    this.setItem(this.failedEventsKey, Object.fromEntries(events));
  }

  /**
   * Remove a failed event
   */
  async removeFailedEvent(eventId: string): Promise<void> {
    const events = await this.getFailedEvents();
    events.delete(eventId);
    this.setItem(this.failedEventsKey, Object.fromEntries(events));
  }

  /**
   * Clear all failed events
   */
  async clearFailedEvents(): Promise<void> {
    localStorage.removeItem(this.failedEventsKey);
  }

  /**
   * Get received token fingerprints as Set
   */
  private getReceivedTokens(): Set<string> {
    const arr = this.getItem<string[]>(this.receivedTokensKey) ?? [];
    return new Set(arr);
  }

  /**
   * Get item from localStorage
   */
  private getItem<T>(key: string): T | null {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (error) {
      console.error('[BrowserStorageAdapter] Failed to get item:', key, error);
      return null;
    }
  }

  /**
   * Set item in localStorage
   */
  private setItem<T>(key: string, value: T): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error('[BrowserStorageAdapter] Failed to set item:', key, error);
    }
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    localStorage.removeItem(this.vouchersKey);
    localStorage.removeItem(this.processedEventsKey);
    localStorage.removeItem(this.receivedTokensKey);
    localStorage.removeItem(this.failedEventsKey);
  }
}

/**
 * Create a BrowserStorageAdapter
 */
export function createBrowserStorageAdapter(
  options?: BrowserStorageAdapterOptions
): BrowserStorageAdapter {
  return new BrowserStorageAdapter(options);
}
