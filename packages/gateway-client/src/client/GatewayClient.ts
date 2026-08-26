/**
 * GatewayClient - Main client for Imani gateway wallet/mint operations
 */

import type {
  GatewayClientConfig,
  ResolvedGatewayClientConfig,
  MintQuoteResponse,
  PaymentConfirmedEvent,
  SubscriptionHandlers,
  SubscriptionOptions,
  SubscriptionHandle,
  Logger,
  LogLevel,
} from '../types';
import { DEFAULT_SSE_CONFIG, DEFAULT_POLLING_CONFIG, MAX_SSE_TIMEOUT_MS } from '../types/config';
import { SseManager } from '../sse/SseManager';
import { PollingFallback } from '../polling/PollingFallback';
import {
  ConfigurationError,
  ConnectionTimeoutError,
  QuoteNotFoundError,
  ApiError,
} from '../errors';

/**
 * Default console logger
 */
function createDefaultLogger(debug: boolean): Logger {
  return (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    if (level === 'debug' && !debug) {
      return;
    }
    const prefix = '[gateway-client]';
    const formatted = data ? `${message} ${JSON.stringify(data)}` : message;
    switch (level) {
      case 'debug':
        console.debug(`${prefix} ${formatted}`);
        break;
      case 'info':
        console.info(`${prefix} ${formatted}`);
        break;
      case 'warn':
        console.warn(`${prefix} ${formatted}`);
        break;
      case 'error':
        console.error(`${prefix} ${formatted}`);
        break;
    }
  };
}

/**
 * Resolve configuration with defaults
 */
function resolveConfig(config: GatewayClientConfig): ResolvedGatewayClientConfig {
  if (!config.baseUrl) {
    throw new ConfigurationError('baseUrl is required');
  }

  // Remove trailing slash from baseUrl
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  return {
    baseUrl,
    apiKey: config.apiKey ?? null,
    apiSecret: config.apiSecret ?? null,
    sse: {
      ...DEFAULT_SSE_CONFIG,
      ...config.sse,
      // Clamp timeout to server max
      timeoutMs: Math.min(
        config.sse?.timeoutMs ?? DEFAULT_SSE_CONFIG.timeoutMs,
        MAX_SSE_TIMEOUT_MS
      ),
    },
    polling: {
      ...DEFAULT_POLLING_CONFIG,
      ...config.polling,
    },
    fetch: config.fetch ?? fetch.bind(globalThis),
    eventSourceFactory: config.eventSourceFactory ?? null,
    debug: config.debug ?? false,
    logger: config.logger ?? createDefaultLogger(config.debug ?? false),
  };
}

/**
 * Main client for Imani gateway operations
 */
export class GatewayClient {
  private readonly config: ResolvedGatewayClientConfig;
  private readonly logger: Logger;

  constructor(config: GatewayClientConfig) {
    this.config = resolveConfig(config);
    this.logger = this.config.logger;
    this.log('debug', 'GatewayClient initialized', { baseUrl: this.config.baseUrl });
  }

  // ============================================
  // REST Methods
  // ============================================

  /**
   * Create a new mint quote
   *
   * @param amount - Amount in the specified unit
   * @param unit - Currency unit (default: 'sat')
   * @returns Mint quote response
   */
  async createMintQuote(amount: number, unit: string = 'sat'): Promise<MintQuoteResponse> {
    const url = `${this.config.baseUrl}/api/v1/wallet/mint/quote`;
    const response = await this.config.fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ amount, unit }),
    });

    if (!response.ok) {
      throw new ApiError(
        `Failed to create mint quote: ${response.statusText}`,
        response.status,
        await this.safeParseJson(response)
      );
    }

    return (await response.json()) as MintQuoteResponse;
  }

  /**
   * Get mint quote status
   *
   * @param quoteId - Quote ID
   * @returns Mint quote response
   */
  async getMintQuote(quoteId: string): Promise<MintQuoteResponse> {
    const url = `${this.config.baseUrl}/api/v1/wallet/mint/quote/${quoteId}`;
    const response = await this.config.fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.status === 404) {
      throw new QuoteNotFoundError(quoteId);
    }

    if (!response.ok) {
      throw new ApiError(
        `Failed to get mint quote: ${response.statusText}`,
        response.status,
        await this.safeParseJson(response),
        quoteId
      );
    }

    return (await response.json()) as MintQuoteResponse;
  }

  /**
   * Check if a quote is already paid
   *
   * @param quoteId - Quote ID
   * @returns true if quote is paid or issued
   */
  async isQuotePaid(quoteId: string): Promise<boolean> {
    try {
      const quote = await this.getMintQuote(quoteId);
      return quote.state === 'PAID' || quote.state === 'ISSUED';
    } catch (err) {
      if (err instanceof QuoteNotFoundError) {
        return false;
      }
      throw err;
    }
  }

  // ============================================
  // Payment Notification Methods
  // ============================================

  /**
   * Subscribe to quote payment status via SSE with polling fallback
   *
   * @param quoteId - Quote ID to monitor
   * @param handlers - Event handlers for payment lifecycle
   * @param options - Subscription options
   * @returns Subscription handle for control and status
   */
  subscribeToQuoteStatus(
    quoteId: string,
    handlers: SubscriptionHandlers,
    options?: SubscriptionOptions
  ): SubscriptionHandle {
    let currentState:
      | 'connecting'
      | 'connected'
      | 'reconnecting'
      | 'polling'
      | 'completed'
      | 'timeout'
      | 'error'
      | 'closed' = 'connecting';
    let closed = false;
    let sseManager: SseManager | null = null;
    let pollingFallback: PollingFallback | null = null;

    // Create promise for result
    let resolveResult: ((event: PaymentConfirmedEvent) => void) | null = null;
    let rejectResult: ((error: Error) => void) | null = null;

    const resultPromise = new Promise<PaymentConfirmedEvent>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    // Start the subscription
    const run = async () => {
      const timeoutMs = options?.timeoutMs ?? this.config.sse.timeoutMs;
      const usePollingFallback = options?.usePollingFallback ?? true;
      const pollingOnly = options?.pollingOnly ?? false;

      // Check if already paid first
      try {
        const isPaid = await this.isQuotePaid(quoteId);
        if (isPaid) {
          this.log('info', 'Quote already paid, fetching details', { quoteId });
          const quote = await this.getMintQuote(quoteId);
          const event: PaymentConfirmedEvent = {
            quote_id: quoteId,
            payment_method: 'bolt11',
            amount: quote.amount ?? 0,
            unit: quote.unit ?? 'sat',
            paid_at: new Date().toISOString(),
          };
          currentState = 'completed';
          handlers.onStateChange?.('completed');
          handlers.onPaymentConfirmed(event);
          resolveResult?.(event);
          return;
        }
      } catch (err) {
        this.log('warn', 'Failed to check if quote is paid', { quoteId, error: String(err) });
        // Continue with subscription
      }

      // Helper to run polling (updates outer pollingFallback reference)
      const startPolling = async () => {
        pollingFallback = new PollingFallback({
          baseUrl: this.config.baseUrl,
          apiKey: this.config.apiKey,
          initialIntervalMs: this.config.polling.initialIntervalMs,
          multiplier: this.config.polling.multiplier,
          maxIntervalMs: this.config.polling.maxIntervalMs,
          timeoutMs: Math.min(timeoutMs, this.config.polling.timeoutMs),
          fetch: this.config.fetch,
          logger: this.logger,
        });

        const pollingResult = await pollingFallback.poll(quoteId, handlers);

        switch (pollingResult.type) {
          case 'payment':
            handlers.onPaymentConfirmed(pollingResult.event);
            resolveResult?.(pollingResult.event);
            break;

          case 'timeout':
            handlers.onTimeout?.();
            rejectResult?.(new ConnectionTimeoutError(quoteId, timeoutMs));
            break;

          case 'error':
            handlers.onError?.(pollingResult.error);
            rejectResult?.(pollingResult.error);
            break;

          case 'closed':
            // Already handled by close()
            break;
        }
      };

      // If polling only, skip SSE
      if (pollingOnly) {
        await startPolling();
        return;
      }

      // Try SSE first
      sseManager = new SseManager({
        baseUrl: this.config.baseUrl,
        timeoutMs,
        reconnectAttempts: this.config.sse.reconnectAttempts,
        reconnectDelayMs: this.config.sse.reconnectDelayMs,
        maxReconnectDelayMs: this.config.sse.maxReconnectDelayMs,
        reconnectMultiplier: this.config.sse.reconnectMultiplier,
        eventSourceFactory: options?.eventSourceFactory ?? this.config.eventSourceFactory,
        logger: this.logger,
      });

      const sseResult = await sseManager.subscribe(quoteId, {
        ...handlers,
        onStateChange: (state, detail) => {
          currentState = state;
          handlers.onStateChange?.(state, detail);
        },
      });

      switch (sseResult.type) {
        case 'payment':
          currentState = 'completed';
          handlers.onPaymentConfirmed(sseResult.event);
          resolveResult?.(sseResult.event);
          break;

        case 'fallback':
          if (usePollingFallback && !closed) {
            await startPolling();
          } else {
            currentState = 'error';
            const error = new Error(sseResult.reason);
            handlers.onError?.(error);
            rejectResult?.(error);
          }
          break;

        case 'error':
          currentState = 'error';
          handlers.onError?.(sseResult.error);
          rejectResult?.(sseResult.error);
          break;

        case 'closed':
          currentState = 'closed';
          break;
      }
    };

    // Run async
    run().catch((err: unknown) => {
      currentState = 'error';
      const error = err instanceof Error ? err : new Error(String(err));
      handlers.onError?.(error);
      rejectResult?.(error);
    });

    // Return handle
    return {
      get state() {
        return currentState;
      },
      get quoteId() {
        return quoteId;
      },
      close() {
        closed = true;
        currentState = 'closed';
        sseManager?.close();
        pollingFallback?.close();
        handlers.onStateChange?.('closed');
      },
      get result() {
        return resultPromise;
      },
    };
  }

  /**
   * Wait for payment confirmation (Promise-based convenience wrapper)
   *
   * @param quoteId - Quote ID to wait for
   * @param options - Subscription options with optional state change callback
   * @returns Promise that resolves with PaymentConfirmedEvent
   */
  async waitForPayment(
    quoteId: string,
    options?: SubscriptionOptions & { onStateChange?: (state: string) => void }
  ): Promise<PaymentConfirmedEvent> {
    return new Promise((resolve, reject) => {
      const handle = this.subscribeToQuoteStatus(
        quoteId,
        {
          onPaymentConfirmed: (event) => {
            resolve(event);
          },
          onError: (error) => {
            reject(error);
          },
          onTimeout: () => {
            const timeoutMs = options?.timeoutMs ?? this.config.sse.timeoutMs;
            reject(new ConnectionTimeoutError(quoteId, timeoutMs));
          },
          onStateChange: options?.onStateChange,
        },
        options
      );

      // Store handle for potential cleanup (not exposed to caller currently)
      void handle;
    });
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Get headers for API requests
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    return headers;
  }

  /**
   * Safely parse JSON from response
   */
  private async safeParseJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * Log a message
   */
  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.logger(level, message, data);
  }
}

/**
 * Create a GatewayClient instance
 */
export function createGatewayClient(config: GatewayClientConfig): GatewayClient {
  return new GatewayClient(config);
}
