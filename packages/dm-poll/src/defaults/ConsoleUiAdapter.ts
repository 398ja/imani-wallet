/**
 * ConsoleUiAdapter - Console logging UI adapter
 *
 * UI adapter that logs notifications to the console.
 * Useful for debugging and development.
 */

import type { UiAdapter } from '../adapters/UiAdapter';
import type { Voucher } from '../types/voucher';
import type { Profile } from '../types/dm';

/**
 * Options for ConsoleUiAdapter
 */
export interface ConsoleUiAdapterOptions {
  /** Prefix for log messages */
  prefix?: string;

  /** Log level for notifications */
  logLevel?: 'log' | 'info' | 'warn' | 'debug';
}

/**
 * Console-based UI adapter for debugging
 */
export class ConsoleUiAdapter implements UiAdapter {
  private readonly prefix: string;
  private readonly logLevel: 'log' | 'info' | 'warn' | 'debug';

  constructor(options: ConsoleUiAdapterOptions = {}) {
    this.prefix = options.prefix ?? '[DmPoll]';
    this.logLevel = options.logLevel ?? 'info';
  }

  /**
   * Show received notification in console
   */
  showReceivedNotification(voucher: Voucher, senderProfile?: Profile): void {
    const sender = senderProfile?.name ||
      senderProfile?.display_name ||
      senderProfile?.nip05 ||
      voucher.sender_pubkey?.substring(0, 8) ||
      'Unknown';

    const message = `${this.prefix} 🎁 Received ${voucher.face_value} ${voucher.face_unit} from ${sender}`;

    console[this.logLevel](message, {
      voucherId: voucher.voucher_id,
      faceValue: voucher.face_value,
      faceUnit: voucher.face_unit,
      tokenAmount: voucher.token_amount,
      backingStrategy: voucher.backing_strategy,
      memo: voucher.memo,
    });
  }

  /**
   * Show error notification in console
   */
  showErrorNotification(message: string): void {
    console.error(`${this.prefix} ❌ Error:`, message);
  }

  /**
   * Play notification sound (logs instead)
   */
  playNotificationSound(): void {
    console[this.logLevel](`${this.prefix} 🔔 [Sound would play here]`);
  }

  /**
   * Show toast in console
   */
  showToast(message: string, duration?: number): void {
    console[this.logLevel](`${this.prefix} 💬 Toast (${duration ?? 3000}ms):`, message);
  }
}

/**
 * Create a ConsoleUiAdapter
 */
export function createConsoleUiAdapter(
  options?: ConsoleUiAdapterOptions
): ConsoleUiAdapter {
  return new ConsoleUiAdapter(options);
}
