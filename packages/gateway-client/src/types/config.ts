/**
 * Configuration types for GatewayClient
 */

/**
 * Custom EventSource factory type for polyfills that support headers
 */
export type EventSourceFactory = (
  url: string,
  options?: { headers?: Record<string, string> }
) => EventSource;

/**
 * Logging level
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger callback type
 */
export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

/**
 * SSE-specific configuration
 */
export interface SseConfig {
  /**
   * SSE timeout in milliseconds
   * @default 300000 (5 minutes)
   * @max 600000 (10 minutes, server limit)
   */
  timeoutMs?: number;

  /**
   * Number of reconnect attempts before falling back to polling
   * @default 3
   */
  reconnectAttempts?: number;

  /**
   * Initial reconnect delay in milliseconds
   * @default 1000
   */
  reconnectDelayMs?: number;

  /**
   * Maximum reconnect delay in milliseconds
   * @default 4000
   */
  maxReconnectDelayMs?: number;

  /**
   * Reconnect delay multiplier for exponential backoff
   * @default 2
   */
  reconnectMultiplier?: number;
}

/**
 * Polling-specific configuration
 */
export interface PollingConfig {
  /**
   * Initial polling interval in milliseconds
   * @default 100
   */
  initialIntervalMs?: number;

  /**
   * Polling interval multiplier for exponential backoff
   * @default 1.5
   */
  multiplier?: number;

  /**
   * Maximum polling interval in milliseconds
   * @default 1000
   */
  maxIntervalMs?: number;

  /**
   * Total polling timeout in milliseconds
   * @default 60000 (1 minute)
   */
  timeoutMs?: number;
}

/**
 * Main configuration for GatewayClient
 */
export interface GatewayClientConfig {
  /**
   * Base URL of the gateway API
   * @example "https://account.imani.casa"
   */
  baseUrl: string;

  /**
   * API key for authenticated endpoints
   */
  apiKey?: string;

  /**
   * API secret (if required by deployment)
   */
  apiSecret?: string;

  /**
   * SSE configuration
   */
  sse?: SseConfig;

  /**
   * Polling configuration
   */
  polling?: PollingConfig;

  /**
   * Custom fetch implementation (for testing or non-browser environments)
   */
  fetch?: typeof fetch;

  /**
   * Custom EventSource factory (for header-capable polyfills)
   */
  eventSourceFactory?: EventSourceFactory;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Custom logger function
   */
  logger?: Logger;
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedGatewayClientConfig {
  baseUrl: string;
  apiKey: string | null;
  apiSecret: string | null;
  sse: Required<SseConfig>;
  polling: Required<PollingConfig>;
  fetch: typeof fetch;
  eventSourceFactory: EventSourceFactory | null;
  debug: boolean;
  logger: Logger;
}

/**
 * Default SSE configuration values
 */
export const DEFAULT_SSE_CONFIG: Required<SseConfig> = {
  timeoutMs: 300000, // 5 minutes (backend default)
  reconnectAttempts: 3,
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 4000,
  reconnectMultiplier: 2,
};

/**
 * Default polling configuration values
 */
export const DEFAULT_POLLING_CONFIG: Required<PollingConfig> = {
  initialIntervalMs: 100,
  multiplier: 1.5,
  maxIntervalMs: 1000,
  timeoutMs: 60000, // 1 minute
};

/**
 * Maximum SSE timeout allowed by server
 */
export const MAX_SSE_TIMEOUT_MS = 600000; // 10 minutes
