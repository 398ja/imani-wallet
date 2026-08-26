/**
 * NoopUiAdapter - Silent UI adapter
 *
 * Default UI adapter that does nothing. Use when UI notifications
 * are not needed or handled elsewhere.
 */

import type { UiAdapter } from '../adapters/UiAdapter';
import type { Voucher } from '../types/voucher';
import type { Profile } from '../types/dm';

/**
 * Silent UI adapter that does nothing
 */
export class NoopUiAdapter implements UiAdapter {
  /**
   * Show notification (does nothing)
   */
  showReceivedNotification(_voucher: Voucher, _senderProfile?: Profile): void {
    // Intentionally empty
  }

  /**
   * Show error notification (does nothing)
   */
  showErrorNotification(_message: string): void {
    // Intentionally empty
  }

  /**
   * Play notification sound (does nothing)
   */
  playNotificationSound(): void {
    // Intentionally empty
  }

  /**
   * Show toast (does nothing)
   */
  showToast(_message: string, _duration?: number): void {
    // Intentionally empty
  }
}

/**
 * Create a NoopUiAdapter
 */
export function createNoopUiAdapter(): NoopUiAdapter {
  return new NoopUiAdapter();
}
