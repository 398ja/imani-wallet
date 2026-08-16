/**
 * Event Types
 *
 * Types for balance-related events.
 */

import type { CurrencyBalance, IssuerBalance, WalletBalance } from './balance';

/**
 * Trigger that caused a balance update
 */
export type BalanceUpdateTrigger =
  | 'voucher-added'
  | 'voucher-removed'
  | 'voucher-updated'
  | 'voucher-expired'
  | 'voucher-spent'
  | 'transaction-added'
  | 'refresh'
  | 'init';

/**
 * Balance updated event data
 */
export interface BalanceUpdatedEvent {
  /** Previous balance (null on init) */
  previous: WalletBalance | null;
  /** Current balance */
  current: WalletBalance;
  /** What triggered the update */
  trigger: BalanceUpdateTrigger;
  /** Timestamp */
  timestamp: number;
}

/**
 * Currency balance changed event data
 */
export interface CurrencyChangedEvent {
  /** Currency code */
  currency: string;
  /** Previous balance (null if new currency) */
  previous: CurrencyBalance | null;
  /** Current balance (null if currency removed) */
  current: CurrencyBalance | null;
  /** Difference in amount */
  difference: number;
}

/**
 * Issuer balance changed event data
 */
export interface IssuerChangedEvent {
  /** Issuer ID */
  issuerId: string;
  /** Previous balance (null if new issuer) */
  previous: IssuerBalance | null;
  /** Current balance (null if issuer removed) */
  current: IssuerBalance | null;
}

/**
 * Balance error event data
 */
export interface BalanceErrorEvent {
  /** Error that occurred */
  error: Error;
  /** Operation that failed */
  operation: string;
  /** Context data */
  context?: Record<string, unknown>;
}

/**
 * Balance event map for typed event emitter
 */
export type BalanceEventMap = {
  /** Overall balance changed */
  'balance:updated': BalanceUpdatedEvent;
  /** Specific currency balance changed */
  'balance:currency-changed': CurrencyChangedEvent;
  /** Issuer balance changed */
  'balance:issuer-changed': IssuerChangedEvent;
  /** Balance calculation error */
  'balance:error': BalanceErrorEvent;
  /** Balance refresh started */
  'balance:refreshing': { timestamp: number };
  /** Balance refresh completed */
  'balance:refreshed': { balance: WalletBalance; duration: number };
}

/**
 * Event listener type
 */
export type BalanceEventListener<K extends keyof BalanceEventMap> = (
  event: BalanceEventMap[K]
) => void;
