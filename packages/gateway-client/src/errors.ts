/**
 * Error classes for @imani/gateway-client
 */

/**
 * Base error class for gateway client errors
 */
export class GatewayClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly quoteId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'GatewayClientError';

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error when a quote is not found (404)
 */
export class QuoteNotFoundError extends GatewayClientError {
  constructor(quoteId: string) {
    super(`Quote not found: ${quoteId}`, 'QUOTE_NOT_FOUND', quoteId);
    this.name = 'QuoteNotFoundError';
  }
}

/**
 * Error when a quote has expired
 */
export class QuoteExpiredError extends GatewayClientError {
  constructor(quoteId: string) {
    super(`Quote expired: ${quoteId}`, 'QUOTE_EXPIRED', quoteId);
    this.name = 'QuoteExpiredError';
  }
}

/**
 * Error when connection times out waiting for payment
 */
export class ConnectionTimeoutError extends GatewayClientError {
  constructor(quoteId: string, timeoutMs: number) {
    super(
      `Connection timeout after ${timeoutMs}ms waiting for payment on quote: ${quoteId}`,
      'CONNECTION_TIMEOUT',
      quoteId
    );
    this.name = 'ConnectionTimeoutError';
  }
}

/**
 * Error when SSE connection fails
 */
export class SseConnectionError extends GatewayClientError {
  constructor(quoteId: string, message: string, cause?: Error) {
    super(
      `SSE connection error for quote ${quoteId}: ${message}`,
      'SSE_CONNECTION_ERROR',
      quoteId,
      cause
    );
    this.name = 'SseConnectionError';
  }
}

/**
 * Error when polling fails
 */
export class PollingError extends GatewayClientError {
  constructor(quoteId: string, message: string, cause?: Error) {
    super(`Polling error for quote ${quoteId}: ${message}`, 'POLLING_ERROR', quoteId, cause);
    this.name = 'PollingError';
  }
}

/**
 * Error when API request fails
 */
export class ApiError extends GatewayClientError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly response?: unknown,
    quoteId?: string
  ) {
    super(message, `API_ERROR_${statusCode}`, quoteId);
    this.name = 'ApiError';
  }
}

/**
 * Error when configuration is invalid
 */
export class ConfigurationError extends GatewayClientError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
  }
}
