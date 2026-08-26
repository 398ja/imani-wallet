/**
 * Polling fallback for payment status when SSE is unavailable
 */

import type {
  MintQuoteResponse,
  PaymentConfirmedEvent,
  SubscriptionHandlers,
  SubscriptionState,
  Logger,
} from '../types';
import { PollingError, QuoteExpiredError, QuoteNotFoundError } from '../errors';
import { calculateBackoff, delay } from '../utils/backoff';

/**
 * Configuration for PollingFallback
 */
export interface PollingFallbackConfig {
  baseUrl: string;
  apiKey: string | null;
  initialIntervalMs: number;
  multiplier: number;
  maxIntervalMs: number;
  timeoutMs: number;
  fetch: typeof fetch;
  logger: Logger;
}

/**
 * Result of polling attempt
 */
export type PollingResult =
  | { type: 'payment'; event: PaymentConfirmedEvent }
  | { type: 'timeout' }
  | { type: 'error'; error: Error }
  | { type: 'closed' };

/**
 * Polling fallback for quote payment status
 */
export class PollingFallback {
  private readonly config: PollingFallbackConfig;
  private closed: boolean = false;
  private pollCount: number = 0;
  private currentState: SubscriptionState = 'polling';

  constructor(config: PollingFallbackConfig) {
    this.config = config;
  }

  /**
   * Poll for payment status
   *
   * @param quoteId - Quote ID to monitor
   * @param handlers - Event handlers
   * @returns Promise that resolves with result type
   */
  async poll(quoteId: string, handlers: SubscriptionHandlers): Promise<PollingResult> {
    this.updateState('polling', handlers);
    this.log('info', 'Starting polling', { quoteId, timeoutMs: this.config.timeoutMs });

    const startTime = Date.now();
    this.pollCount = 0;

    while (!this.closed) {
      const elapsed = Date.now() - startTime;

      // Check timeout
      if (elapsed >= this.config.timeoutMs) {
        this.log('info', 'Polling timeout', { quoteId, elapsed, pollCount: this.pollCount });
        this.updateState('timeout', handlers);
        return { type: 'timeout' };
      }

      try {
        const quote = await this.fetchQuote(quoteId);

        // Check if paid
        if (quote.state === 'PAID' || quote.state === 'ISSUED') {
          this.log('info', 'Payment detected via polling', {
            quoteId,
            state: quote.state,
            pollCount: this.pollCount,
          });

          // Synthesize PaymentConfirmedEvent from quote response
          const event: PaymentConfirmedEvent = {
            quote_id: quoteId,
            payment_method: 'bolt11', // Assume Lightning, backend doesn't expose method in quote
            amount: quote.amount ?? 0,
            unit: quote.unit ?? 'sat',
            paid_at: new Date().toISOString(),
          };

          this.updateState('completed', handlers);
          return { type: 'payment', event };
        }

        // Check if expired
        if (quote.state === 'EXPIRED') {
          this.log('info', 'Quote expired', { quoteId });
          return {
            type: 'error',
            error: new QuoteExpiredError(quoteId),
          };
        }

        // Check if failed
        if (quote.state === 'FAILED') {
          this.log('info', 'Quote failed', { quoteId });
          return {
            type: 'error',
            error: new PollingError(quoteId, 'Quote in FAILED state'),
          };
        }

        // Still pending, continue polling with backoff
        this.pollCount++;
        const intervalMs = calculateBackoff(
          this.pollCount - 1,
          this.config.initialIntervalMs,
          this.config.multiplier,
          this.config.maxIntervalMs
        );

        this.log('debug', 'Poll iteration', {
          quoteId,
          state: quote.state,
          pollCount: this.pollCount,
          nextIntervalMs: intervalMs,
          elapsed,
        });

        await delay(intervalMs);
      } catch (err) {
        // Handle specific errors
        if (err instanceof QuoteNotFoundError || err instanceof QuoteExpiredError) {
          return { type: 'error', error: err };
        }

        // Log and continue on transient errors
        this.log('warn', 'Poll request failed', {
          quoteId,
          error: String(err),
          pollCount: this.pollCount,
        });

        // Still apply backoff on error
        this.pollCount++;
        const intervalMs = calculateBackoff(
          this.pollCount - 1,
          this.config.initialIntervalMs,
          this.config.multiplier,
          this.config.maxIntervalMs
        );
        await delay(intervalMs);
      }
    }

    return { type: 'closed' };
  }

  /**
   * Stop polling
   */
  close(): void {
    this.closed = true;
  }

  /**
   * Get current state
   */
  get state(): SubscriptionState {
    return this.currentState;
  }

  /**
   * Fetch quote status from API
   */
  private async fetchQuote(quoteId: string): Promise<MintQuoteResponse> {
    const url = `${this.config.baseUrl}/api/v1/wallet/mint/quote/${quoteId}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    const response = await this.config.fetch(url, {
      method: 'GET',
      headers,
    });

    if (response.status === 404) {
      throw new QuoteNotFoundError(quoteId);
    }

    if (!response.ok) {
      throw new PollingError(quoteId, `HTTP ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as MintQuoteResponse;
  }

  /**
   * Update state and notify handler
   */
  private updateState(
    state: SubscriptionState,
    handlers: SubscriptionHandlers,
    detail?: string
  ): void {
    this.currentState = state;
    handlers.onStateChange?.(state, detail);
  }

  /**
   * Log a message
   */
  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>
  ): void {
    this.config.logger(level, `polling_${message.toLowerCase().replace(/\s+/g, '_')}`, data);
  }
}

/**
 * Create a PollingFallback instance
 */
export function createPollingFallback(config: PollingFallbackConfig): PollingFallback {
  return new PollingFallback(config);
}
