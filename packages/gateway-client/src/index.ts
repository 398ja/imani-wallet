/**
 * @imani/gateway-client
 *
 * Typed REST + SSE client for Imani gateway wallet/mint operations
 * with automatic payment notification support.
 *
 * Features:
 * - SSE subscription for real-time payment confirmations
 * - Automatic polling fallback when SSE is unavailable
 * - Exponential backoff for reconnection and polling
 * - TypeScript types matching backend DTOs
 */

// Main client
export { GatewayClient, createGatewayClient } from './client';

// SSE manager (for advanced use cases)
export { SseManager, createSseManager } from './sse';
export type { SseManagerConfig, SseResult } from './sse';

// Polling fallback (for advanced use cases)
export { PollingFallback, createPollingFallback } from './polling';
export type { PollingFallbackConfig, PollingResult } from './polling';

// Utilities
export { calculateBackoff, calculateBackoffSequence, addJitter, delay, withTimeout } from './utils';

// Errors
export {
  GatewayClientError,
  QuoteNotFoundError,
  QuoteExpiredError,
  ConnectionTimeoutError,
  SseConnectionError,
  PollingError,
  ApiError,
  ConfigurationError,
} from './errors';

// Types - DTOs
export type {
  QuoteState,
  PaymentMethod,
  PaymentConfirmedEvent,
  PaymentWebhookPayload,
  MintQuoteResponse,
  ConnectedEvent,
  DiagnosticsEvent,
} from './types';

// Types - Configuration
export type {
  EventSourceFactory,
  LogLevel,
  Logger,
  SseConfig,
  PollingConfig,
  GatewayClientConfig,
  ResolvedGatewayClientConfig,
} from './types';

export { DEFAULT_SSE_CONFIG, DEFAULT_POLLING_CONFIG, MAX_SSE_TIMEOUT_MS } from './types';

// Types - Subscription
export type {
  SubscriptionState,
  SubscriptionHandlers,
  SubscriptionOptions,
  SubscriptionHandle,
} from './types';
