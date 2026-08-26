/**
 * Type exports for @imani/gateway-client
 */

// DTOs
export type {
  QuoteState,
  PaymentMethod,
  PaymentConfirmedEvent,
  PaymentWebhookPayload,
  MintQuoteResponse,
  ConnectedEvent,
  DiagnosticsEvent,
} from './dto';

// Configuration
export type {
  EventSourceFactory,
  LogLevel,
  Logger,
  SseConfig,
  PollingConfig,
  GatewayClientConfig,
  ResolvedGatewayClientConfig,
} from './config';

export { DEFAULT_SSE_CONFIG, DEFAULT_POLLING_CONFIG, MAX_SSE_TIMEOUT_MS } from './config';

// Subscription
export type {
  SubscriptionState,
  SubscriptionHandlers,
  SubscriptionOptions,
  SubscriptionHandle,
  SubscriptionInternals,
} from './subscription';
