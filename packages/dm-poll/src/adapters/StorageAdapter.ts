/**
 * StorageAdapter - Interface for voucher and state persistence
 *
 * Optional adapter for persisting vouchers and tracking processed events.
 */

import type { Voucher } from '../types/voucher';
import type { FailedEvent } from '../types/events';

/**
 * Adapter for persistent storage operations
 */
export interface StorageAdapter {
  /**
   * Save a voucher to storage
   *
   * @param voucher - Voucher to save
   */
  saveVoucher(voucher: Voucher): Promise<void>;

  /**
   * Check if a token has already been received
   *
   * @param tokenFingerprint - Token fingerprint for deduplication
   * @returns true if already received
   */
  hasTokenBeenReceived(tokenFingerprint: string): Promise<boolean>;

  /**
   * Mark a token as received
   *
   * @param tokenFingerprint - Token fingerprint
   */
  markTokenAsReceived(tokenFingerprint: string): Promise<void>;

  /**
   * Get list of processed event IDs
   *
   * @returns Array of event IDs that have been processed
   */
  getProcessedEventIds(): Promise<string[]>;

  /**
   * Save list of processed event IDs
   *
   * @param ids - Event IDs to save
   */
  saveProcessedEventIds(ids: string[]): Promise<void>;

  /**
   * Get all vouchers
   *
   * @returns Array of all stored vouchers
   */
  getVouchers?(): Promise<Voucher[]>;

  /**
   * Get a voucher by ID
   *
   * @param voucherId - Voucher ID
   * @returns Voucher if found
   */
  getVoucher?(voucherId: string): Promise<Voucher | null>;

  // ==================== FAILED EVENT METHODS ====================

  /**
   * Get list of failed events
   *
   * @returns Map of event ID to FailedEvent data
   */
  getFailedEvents?(): Promise<Map<string, FailedEvent>>;

  /**
   * Save a failed event
   *
   * @param eventId - Event ID
   * @param failedEvent - Failed event data
   */
  saveFailedEvent?(eventId: string, failedEvent: FailedEvent): Promise<void>;

  /**
   * Remove a failed event (after successful replay)
   *
   * @param eventId - Event ID to remove
   */
  removeFailedEvent?(eventId: string): Promise<void>;

  /**
   * Clear all failed events
   */
  clearFailedEvents?(): Promise<void>;
}

/**
 * Type guard to check if an object implements StorageAdapter
 */
export function isStorageAdapter(obj: unknown): obj is StorageAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const adapter = obj as StorageAdapter;
  return (
    typeof adapter.saveVoucher === 'function' &&
    typeof adapter.hasTokenBeenReceived === 'function' &&
    typeof adapter.markTokenAsReceived === 'function' &&
    typeof adapter.getProcessedEventIds === 'function' &&
    typeof adapter.saveProcessedEventIds === 'function'
  );
}
