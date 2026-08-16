/**
 * SSE Manager for payment status subscriptions
 */

import type {
  ConnectedEvent,
  DiagnosticsEvent,
  PaymentConfirmedEvent,
  SubscriptionHandlers,
  SubscriptionState,
  EventSourceFactory,
  Logger,
} from '../types';
import { SseConnectionError } from '../errors';
import { calculateBackoff, delay } from '../utils/backoff';

/**
 * Configuration for SseManager
 */
export interface SseManagerConfig {
  baseUrl: string;
  timeoutMs: number;
  reconnectAttempts: number;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
  reconnectMultiplier: number;
  eventSourceFactory: EventSourceFactory | null;
  logger: Logger;
}

/**
 * Internal state for the SSE manager
 */
interface SseState {
  eventSource: EventSource | null;
  reconnectAttempt: number;
  closed: boolean;
  currentState: SubscriptionState;
}

/**
 * Result of attempting SSE connection
 */
export type SseResult =
  | { type: 'payment'; event: PaymentConfirmedEvent }
  | { type: 'fallback'; reason: string }
  | { type: 'error'; error: Error }
  | { type: 'closed' };

/**
 * Manages SSE connections for quote payment status
 */
export class SseManager {
  private readonly config: SseManagerConfig;
  private state: SseState;

  constructor(config: SseManagerConfig) {
    this.config = config;
    this.state = {
      eventSource: null,
      reconnectAttempt: 0,
      closed: false,
      currentState: 'connecting',
    };
  }

  /**
   * Check if EventSource is available in the environment
   */
  static isAvailable(): boolean {
    return typeof EventSource !== 'undefined';
  }

  /**
   * Subscribe to payment status via SSE
   *
   * @param quoteId - Quote ID to monitor
   * @param handlers - Event handlers
   * @returns Promise that resolves with result type
   */
  async subscribe(quoteId: string, handlers: SubscriptionHandlers): Promise<SseResult> {
    // Check if EventSource is available
    if (!SseManager.isAvailable() && !this.config.eventSourceFactory) {
      this.log('info', 'EventSource not available, falling back to polling', { quoteId });
      return { type: 'fallback', reason: 'EventSource not available' };
    }

    return new Promise<SseResult>((resolve) => {
      this.connect(quoteId, handlers, resolve);
    });
  }

  /**
   * Close the SSE connection
   */
  close(): void {
    this.state.closed = true;
    this.closeEventSource();
    this.updateState('closed');
  }

  /**
   * Get current connection state
   */
  get currentState(): SubscriptionState {
    return this.state.currentState;
  }

  /**
   * Connect to SSE endpoint
   */
  private connect(
    quoteId: string,
    handlers: SubscriptionHandlers,
    resolve: (result: SseResult) => void
  ): void {
    if (this.state.closed) {
      resolve({ type: 'closed' });
      return;
    }

    const timeoutSeconds = Math.min(
      Math.max(1, Math.floor(this.config.timeoutMs / 1000)),
      600 // Server max
    );

    const url = `${this.config.baseUrl}/api/v1/wallet/mint/quote/${quoteId}/subscribe?timeout=${timeoutSeconds}`;

    this.log('debug', 'Connecting to SSE', { quoteId, url, attempt: this.state.reconnectAttempt });

    try {
      const es = this.createEventSource(url);
      this.state.eventSource = es;
      this.updateState('connecting', handlers);

      // Handle connection open
      es.onopen = () => {
        this.log('info', 'SSE connection opened', { quoteId });
        this.state.reconnectAttempt = 0; // Reset on successful connection
      };

      // Handle 'connected' event
      es.addEventListener('connected', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as ConnectedEvent;
          this.log('info', 'SSE connected event received', { quoteId, data });
          this.updateState('connected', handlers);
          handlers.onConnected?.(data);
        } catch (err) {
          this.log('warn', 'Failed to parse connected event', { quoteId, error: String(err) });
        }
      });

      // Handle 'payment_confirmed' event
      es.addEventListener('payment_confirmed', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as PaymentConfirmedEvent;
          this.log('info', 'Payment confirmed via SSE', {
            quoteId,
            method: data.payment_method,
            amount: data.amount,
          });
          this.closeEventSource();
          this.updateState('completed', handlers);
          resolve({ type: 'payment', event: data });
        } catch (err) {
          this.log('error', 'Failed to parse payment_confirmed event', {
            quoteId,
            error: String(err),
          });
        }
      });

      // Handle 'diagnostics' event (optional)
      es.addEventListener('diagnostics', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as DiagnosticsEvent;
          this.log('debug', 'Diagnostics event received', { quoteId, data });
          handlers.onDiagnostics?.(data);
        } catch (err) {
          this.log('debug', 'Failed to parse diagnostics event', { quoteId, error: String(err) });
        }
      });

      // Handle errors
      es.onerror = (_event) => {
        this.log('warn', 'SSE error', { quoteId, readyState: es.readyState });

        // Close current connection
        this.closeEventSource();

        if (this.state.closed) {
          resolve({ type: 'closed' });
          return;
        }

        // Attempt reconnect if within limits
        if (this.state.reconnectAttempt < this.config.reconnectAttempts) {
          void this.handleReconnect(quoteId, handlers, resolve);
        } else {
          this.log('info', 'Max reconnect attempts reached, falling back to polling', {
            quoteId,
            attempts: this.state.reconnectAttempt,
          });
          resolve({
            type: 'fallback',
            reason: `Max reconnect attempts (${this.config.reconnectAttempts}) reached`,
          });
        }
      };
    } catch (err) {
      this.log('error', 'Failed to create EventSource', { quoteId, error: String(err) });
      resolve({
        type: 'error',
        error: new SseConnectionError(quoteId, 'Failed to create EventSource', err as Error),
      });
    }
  }

  /**
   * Handle reconnection with exponential backoff
   */
  private async handleReconnect(
    quoteId: string,
    handlers: SubscriptionHandlers,
    resolve: (result: SseResult) => void
  ): Promise<void> {
    this.state.reconnectAttempt++;

    const delayMs = calculateBackoff(
      this.state.reconnectAttempt - 1,
      this.config.reconnectDelayMs,
      this.config.reconnectMultiplier,
      this.config.maxReconnectDelayMs
    );

    this.log('info', 'Reconnecting SSE', {
      quoteId,
      attempt: this.state.reconnectAttempt,
      maxAttempts: this.config.reconnectAttempts,
      delayMs,
    });

    this.updateState(
      'reconnecting',
      handlers,
      `Attempt ${this.state.reconnectAttempt}/${this.config.reconnectAttempts}`
    );

    await delay(delayMs);

    if (!this.state.closed) {
      this.connect(quoteId, handlers, resolve);
    } else {
      resolve({ type: 'closed' });
    }
  }

  /**
   * Create EventSource instance
   */
  private createEventSource(url: string): EventSource {
    if (this.config.eventSourceFactory) {
      return this.config.eventSourceFactory(url);
    }
    return new EventSource(url);
  }

  /**
   * Close the EventSource connection
   */
  private closeEventSource(): void {
    if (this.state.eventSource) {
      this.state.eventSource.close();
      this.state.eventSource = null;
    }
  }

  /**
   * Update state and notify handler
   */
  private updateState(
    state: SubscriptionState,
    handlers?: SubscriptionHandlers,
    detail?: string
  ): void {
    this.state.currentState = state;
    handlers?.onStateChange?.(state, detail);
  }

  /**
   * Log a message
   */
  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>
  ): void {
    this.config.logger(level, `sse_${message.toLowerCase().replace(/\s+/g, '_')}`, data);
  }
}

/**
 * Create an SseManager instance
 */
export function createSseManager(config: SseManagerConfig): SseManager {
  return new SseManager(config);
}
