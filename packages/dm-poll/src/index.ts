/**
 * @imani/dm-poll
 *
 * NIP-17 DM polling and auto-redemption service for Cashu tokens.
 *
 * All reads go through nostrdb - never connects directly to relays.
 */

// Core
export { DmPollService, createDmPollService } from './core/DmPollService';
export { TypedEventEmitter } from './core/EventEmitter';
export { ProcessedEventTracker } from './core/ProcessedEventTracker';
export type { ProcessedEventTrackerOptions } from './core/ProcessedEventTracker';
export { FailedEventTracker } from './core/FailedEventTracker';
export type { FailedEventTrackerOptions } from './core/FailedEventTracker';

// Subscriptions
export {
  NostrdbSseSubscription,
  createNostrdbSseSubscription,
  NostrdbQueryFetcher,
  createNostrdbQueryFetcher,
  LegacyApiPolling,
  createLegacyApiPolling,
} from './subscriptions';
export type {
  NostrdbSseSubscriptionOptions,
  NostrdbQueryFetcherOptions,
  LegacyApiPollingOptions,
} from './subscriptions';

// Processing
export {
  GiftWrapProcessor,
  createGiftWrapProcessor,
  TokenParser,
  extractToken,
  hasToken,
  parseTokenTransferMessage,
  getTokenFingerprint,
  isValidToken,
  getTokenVersion,
  TokenRedeemer,
  createTokenRedeemer,
} from './processing';
export type {
  GiftWrapProcessorOptions,
  TokenRedeemerOptions,
  RedemptionResult,
} from './processing';

// Default adapters
export {
  BrowserStorageAdapter,
  createBrowserStorageAdapter,
  NoopUiAdapter,
  createNoopUiAdapter,
  ConsoleUiAdapter,
  createConsoleUiAdapter,
  DefaultCryptoAdapter,
  createDefaultCryptoAdapter,
} from './defaults';
export type {
  BrowserStorageAdapterOptions,
  ConsoleUiAdapterOptions,
  DefaultCryptoAdapterOptions,
} from './defaults';

// Types
export type {
  // Config
  SubscriptionMode,
  DmPollConfig,
  ResolvedDmPollConfig,

  // DM types
  GiftWrapEvent,
  UnwrappedDm,
  TokenDm,
  TokenMetadata,
  Profile,

  // Voucher types
  BackingStrategy,
  VoucherStatus,
  Voucher,
  Transaction,

  // Subscription types
  SubscriptionHandle,
  EventFilter,
  NostrEvent,

  // Event types
  TokenReceivedEvent,
  RedemptionSuccessEvent,
  RedemptionErrorEvent,
  SubscriptionStateEvent,
  DmPollEvents,

  // Failed event types
  FailedEvent,
  DmPollStatus,
  ProcessUnclaimedResult,
  ReplayResult,
} from './types';

export { DEFAULT_CONFIG } from './types/config';

// Adapters (re-exported for convenience)
export type {
  NostrdbAdapter,
  CryptoAdapter,
  StorageAdapter,
  RedemptionAdapter,
  RedemptionOptions,
  UiAdapter,
  LegacyApiAdapter,
  LegacyDm,
  ClaimResponse,
  ReceiveResponse,
  Nip60WalletAdapter,
} from './adapters';

export {
  isNostrdbAdapter,
  isCryptoAdapter,
  isStorageAdapter,
  isRedemptionAdapter,
  isUiAdapter,
  isLegacyApiAdapter,
  isNip60WalletAdapter,
} from './adapters';

// Errors
export {
  DmPollError,
  GiftWrapError,
  RedemptionError,
  SubscriptionError,
  AdapterError,
} from './errors';

// Spec 038 — unified receive pipeline surfaces
export {
  WATERMARK_BUFFER_SECONDS,
  WATERMARK_GRACE_SECONDS,
  loadDmWatermark,
  saveDmWatermark,
  watermarkKey,
} from './watermark';
export type { WatermarkStorage, WatermarkLogger } from './watermark';

export {
  TRANSIENT_RECEIVE_BACKOFFS_MS,
  RetryExhaustedError,
  retryOnTransientMintError,
} from './retryOnTransientMintError';
export type {
  IsTransientReceiveError,
  SleepFn,
  RetryOptions,
} from './retryOnTransientMintError';

export { classifyEventOutcome } from './classifyEventOutcome';
export type { EventOutcome, OutcomeDecision } from './classifyEventOutcome';

export { runCatchupTick } from './runCatchupTick';
export type {
  CatchupNostrEvent,
  ProcessResult,
  CatchupTickDeps,
  CatchupTickSummary,
} from './runCatchupTick';

export { reconcileVoucherTxOrphans } from './orphanReconcile';
export type {
  OrphanReconcileDeps,
  OrphanReconcileSummary,
} from './orphanReconcile';
