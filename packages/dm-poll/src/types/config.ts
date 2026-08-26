/**
 * Configuration types for DmPollService
 */

import type { NostrdbAdapter } from '../adapters/NostrdbAdapter';
import type { CryptoAdapter } from '../adapters/CryptoAdapter';
import type { StorageAdapter } from '../adapters/StorageAdapter';
import type { RedemptionAdapter } from '../adapters/RedemptionAdapter';
import type { UiAdapter } from '../adapters/UiAdapter';
import type { LegacyApiAdapter } from '../adapters/LegacyApiAdapter';
import type { Nip60WalletAdapter } from '../adapters/Nip60WalletAdapter';

/**
 * Subscription mode for receiving DMs
 * - 'nostrdb-sse': Real-time SSE from backend (RECOMMENDED)
 * - 'nostrdb-polling': Periodic queries to backend
 * - 'legacy-api': Old DM API (listTokenDms/claimTokenDm)
 * - 'auto': Try nostrdb-sse first, fallback to nostrdb-polling
 */
export type SubscriptionMode = 'nostrdb-sse' | 'nostrdb-polling' | 'legacy-api' | 'auto';

/**
 * Configuration for the DM polling service
 */
export interface DmPollConfig {
  /** Recipient's public key (hex) */
  recipientPubkey: string;

  /** Recipient's private key (hex) - for NIP-17 unwrapping */
  recipientPrivkey: string;

  /**
   * Subscription mode for receiving DMs
   * @default 'auto'
   */
  subscriptionMode?: SubscriptionMode;

  /**
   * Polling interval in milliseconds (for nostrdb-polling mode)
   * @default 30000
   */
  pollIntervalMs?: number;

  /**
   * Whether to fetch recent DMs on service start
   * @default true
   */
  fetchRecentOnStart?: boolean;

  /**
   * How far back to fetch recent DMs (in seconds)
   * @default 86400 (24 hours)
   */
  recentDmsSince?: number;

  /**
   * Maximum retry attempts for failed operations
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay between retries in milliseconds
   * @default 2000
   */
  retryDelayMs?: number;

  /**
   * Cooldown period in ms before retrying a failed event
   * @default 3600000 (1 hour)
   */
  retryCooldownMs?: number;

  /**
   * Maximum number of processed events to track (LRU)
   * @default 100
   */
  maxProcessedEvents?: number;

  /**
   * LocalStorage key for processed event IDs
   * @default 'imani_dm_processed_events'
   */
  storageKey?: string;

  /**
   * Enable automatic token redemption
   * @default true
   */
  enableAutoRedemption?: boolean;

  /**
   * Enable NIP-60 transaction recording
   * @default true
   */
  enableNip60Recording?: boolean;

  /**
   * Enable UI notifications for received tokens
   * @default true
   */
  enableUiNotifications?: boolean;

  // Required adapters

  /**
   * Adapter for reading from nostrdb backend API
   * REQUIRED - All reads go through this adapter
   */
  nostrdbAdapter: NostrdbAdapter;

  /**
   * Adapter for client-side cryptographic operations
   * REQUIRED - Handles NIP-17 unwrapping
   */
  cryptoAdapter: CryptoAdapter;

  // Optional adapters

  /** Adapter for voucher storage */
  storageAdapter?: StorageAdapter;

  /** Adapter for token redemption */
  redemptionAdapter?: RedemptionAdapter;

  /** Adapter for UI notifications */
  uiAdapter?: UiAdapter;

  /** Adapter for legacy API (only for legacy-api mode) */
  legacyApiAdapter?: LegacyApiAdapter;

  /** Adapter for NIP-60 wallet recording */
  nip60Wallet?: Nip60WalletAdapter;
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedDmPollConfig extends Required<Omit<DmPollConfig,
  'storageAdapter' | 'redemptionAdapter' | 'uiAdapter' | 'legacyApiAdapter' | 'nip60Wallet'
>> {
  storageAdapter: StorageAdapter | null;
  redemptionAdapter: RedemptionAdapter | null;
  uiAdapter: UiAdapter | null;
  legacyApiAdapter: LegacyApiAdapter | null;
  nip60Wallet: Nip60WalletAdapter | null;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Omit<ResolvedDmPollConfig,
  'recipientPubkey' | 'recipientPrivkey' | 'nostrdbAdapter' | 'cryptoAdapter' |
  'storageAdapter' | 'redemptionAdapter' | 'uiAdapter' | 'legacyApiAdapter' | 'nip60Wallet'
> = {
  subscriptionMode: 'auto',
  pollIntervalMs: 30000,
  fetchRecentOnStart: true,
  recentDmsSince: 86400,
  maxRetries: 3,
  retryDelayMs: 2000,
  retryCooldownMs: 3600000,
  maxProcessedEvents: 100,
  storageKey: 'imani_dm_processed_events',
  enableAutoRedemption: true,
  enableNip60Recording: true,
  enableUiNotifications: true,
};
