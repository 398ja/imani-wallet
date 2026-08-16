/**
 * Subscription types for payment status monitoring
 */

import type { ConnectedEvent, DiagnosticsEvent, PaymentConfirmedEvent } from './dto';
import type { EventSourceFactory } from './config';

/**
 * Subscription connection state
 */
export type SubscriptionState =
  | 'connecting' // Initial connection attempt
  | 'connected' // SSE connected, waiting for payment
  | 'reconnecting' // Reconnecting after error
  | 'polling' // Fell back to polling
  | 'completed' // Payment confirmed
  | 'timeout' // Timed out waiting
  | 'error' // Unrecoverable error
  | 'closed'; // Manually closed

/**
 * Event handlers for subscription lifecycle
 */
export interface SubscriptionHandlers {
  /**
   * Called when SSE connection is established
   */
  onConnected?: (event: ConnectedEvent) => void;

  /**
   * Called when payment is confirmed (SSE or polling)
   * This is the main success callback
   */
  onPaymentConfirmed: (event: PaymentConfirmedEvent) => void;

  /**
   * Called on connection state changes (for UI feedback)
   */
  onStateChange?: (state: SubscriptionState, detail?: string) => void;

  /**
   * Called on unrecoverable error
   */
  onError?: (error: Error) => void;

  /**
   * Called when timeout expires without payment
   */
  onTimeout?: () => void;

  /**
   * Called on diagnostics event (optional, for monitoring)
   */
  onDiagnostics?: (event: DiagnosticsEvent) => void;
}

/**
 * Options for subscription behavior
 */
export interface SubscriptionOptions {
  /**
   * Override default SSE timeout (milliseconds)
   */
  timeoutMs?: number;

  /**
   * Enable polling fallback when SSE fails
   * @default true
   */
  usePollingFallback?: boolean;

  /**
   * Skip SSE entirely and go straight to polling
   * @default false
   */
  pollingOnly?: boolean;

  /**
   * Custom EventSource factory for this subscription only
   */
  eventSourceFactory?: EventSourceFactory;
}

/**
 * Handle returned from subscription for control and status
 */
export interface SubscriptionHandle {
  /**
   * Current subscription state
   */
  readonly state: SubscriptionState;

  /**
   * Quote ID being monitored
   */
  readonly quoteId: string;

  /**
   * Close the subscription and cleanup resources
   */
  close(): void;

  /**
   * Promise that resolves with payment or rejects on error/timeout
   */
  readonly result: Promise<PaymentConfirmedEvent>;
}

/**
 * Internal subscription state management
 */
export interface SubscriptionInternals {
  state: SubscriptionState;
  quoteId: string;
  eventSource: EventSource | null;
  pollingTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  closed: boolean;
  resolve: ((event: PaymentConfirmedEvent) => void) | null;
  reject: ((error: Error) => void) | null;
}
