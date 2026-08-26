/**
 * UiAdapter - Interface for UI notifications
 *
 * Optional adapter for displaying notifications to the user.
 */

import type { Voucher } from '../types/voucher';
import type { Profile } from '../types/dm';

/**
 * Adapter for UI notification operations
 */
export interface UiAdapter {
  /**
   * Show notification that a voucher was received
   *
   * @param voucher - The received voucher
   * @param senderProfile - Sender's profile (if available)
   */
  showReceivedNotification(voucher: Voucher, senderProfile?: Profile): void;

  /**
   * Show error notification
   *
   * @param message - Error message to display
   */
  showErrorNotification(message: string): void;

  /**
   * Play notification sound
   */
  playNotificationSound?(): void;

  /**
   * Show toast message
   *
   * @param message - Toast message
   * @param duration - Duration in milliseconds
   */
  showToast?(message: string, duration?: number): void;
}

/**
 * Type guard to check if an object implements UiAdapter
 */
export function isUiAdapter(obj: unknown): obj is UiAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const adapter = obj as UiAdapter;
  return (
    typeof adapter.showReceivedNotification === 'function' &&
    typeof adapter.showErrorNotification === 'function'
  );
}
