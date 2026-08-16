/**
 * NostrdbSseSubscription - Backend SSE subscription for real-time events
 *
 * PRIMARY subscription method - receives events via Server-Sent Events
 * from the nostrdb backend API.
 */

import type { GiftWrapEvent } from '../types/dm';
import type { SubscriptionHandle, EventFilter } from '../types/subscription';
import type { NostrdbAdapter } from '../adapters/NostrdbAdapter';

/**
 * Options for NostrdbSseSubscription
 */
export interface NostrdbSseSubscriptionOptions {
  /** nostrdb adapter for SSE subscription */
  nostrdbAdapter: NostrdbAdapter;

  /** Event filter */
  filter: EventFilter;

  /** Callback when event is received */
  onEvent: (event: GiftWrapEvent) => void;

  /** Callback when error occurs */
  onError: (error: Error) => void;

  /** Callback when connection state changes */
  onStateChange?: (state: 'connecting' | 'connected' | 'disconnected' | 'error') => void;

  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;

  /** Reconnect delay in ms */
  reconnectDelayMs?: number;

  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number;
}

/**
 * SSE subscription to nostrdb backend for real-time gift wrap events
 */
export class NostrdbSseSubscription implements SubscriptionHandle {
  readonly id: string;
  private active = false;
  private subscription: SubscriptionHandle | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly options: Required<NostrdbSseSubscriptionOptions>;

  constructor(options: NostrdbSseSubscriptionOptions) {
    this.id = `nostrdb-sse-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.options = {
      autoReconnect: true,
      reconnectDelayMs: 5000,
      maxReconnectAttempts: 10,
      onStateChange: () => {},
      ...options,
    };
  }

  /**
   * Start the SSE subscription
   */
  start(): void {
    if (this.active) {
      console.log('[NostrdbSseSubscription] Already active');
      return;
    }

    this.active = true;
    this.connect();
  }

  /**
   * Stop the subscription
   */
  stop(): void {
    this.active = false;
    this.cleanup();
    this.options.onStateChange?.('disconnected');
    console.log('[NostrdbSseSubscription] Stopped');
  }

  /**
   * Check if subscription is active
   */
  isActive(): boolean {
    return this.active && this.subscription !== null;
  }

  /**
   * Connect to SSE stream
   */
  private connect(): void {
    if (!this.active) return;

    this.options.onStateChange?.('connecting');
    console.log('[NostrdbSseSubscription] Connecting to SSE stream...');

    try {
      this.subscription = this.options.nostrdbAdapter.subscribeEvents(
        this.options.filter,
        (event) => {
          // Reset reconnect attempts on successful event
          this.reconnectAttempts = 0;
          this.options.onEvent(event);
        },
        (error) => {
          console.error('[NostrdbSseSubscription] SSE error:', error);
          this.options.onStateChange?.('error');
          this.handleDisconnect(error);
        }
      );

      this.options.onStateChange?.('connected');
      this.reconnectAttempts = 0;
      console.log('[NostrdbSseSubscription] Connected');
    } catch (error) {
      console.error('[NostrdbSseSubscription] Failed to connect:', error);
      this.options.onStateChange?.('error');
      this.handleDisconnect(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Handle disconnection with auto-reconnect
   */
  private handleDisconnect(error: Error): void {
    this.cleanup();

    if (!this.active) return;

    if (!this.options.autoReconnect) {
      this.options.onError(error);
      return;
    }

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error('[NostrdbSseSubscription] Max reconnect attempts reached');
      this.options.onError(new Error(`Failed to reconnect after ${this.reconnectAttempts} attempts: ${error.message}`));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay();

    console.log(`[NostrdbSseSubscription] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Calculate reconnect delay with exponential backoff
   */
  private calculateReconnectDelay(): number {
    const baseDelay = this.options.reconnectDelayMs;
    const exponentialDelay = baseDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    const maxDelay = 60000; // 1 minute max
    const delay = Math.min(exponentialDelay, maxDelay);

    // Add jitter (±20%)
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.subscription) {
      this.subscription.stop();
      this.subscription = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
}

/**
 * Create a NostrdbSseSubscription
 */
export function createNostrdbSseSubscription(
  options: NostrdbSseSubscriptionOptions
): NostrdbSseSubscription {
  const subscription = new NostrdbSseSubscription(options);
  subscription.start();
  return subscription;
}
