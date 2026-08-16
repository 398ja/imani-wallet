/**
 * @imani/voucher-send
 *
 * Voucher sending library for the Imani wallet.
 * Handles splitting, recipient resolution, and DM transmission.
 *
 * @packageDocumentation
 */

// Core exports
export {
  SendConfig,
  TypedEventEmitter,
  createEventEmitter,
  VoucherSendError,
  ErrorCodes,
  type SendConfigOptions,
  type ChunkingConfig,
  type RelayConfig,
  type Nip60Config,
  type ErrorCode,
  type ErrorDetails,
} from './core';

// Adapter exports
export {
  // Interfaces
  type ApiAdapter,
  type StorageAdapter,
  type NostrAdapter,
  type Adapters,
  // Type guards
  isApiAdapter,
  isStorageAdapter,
  isNostrAdapter,
  // Built-in adapters
  VoucherServiceAdapter,
  // Adapter types
  type SplitPreviewRequest,
  type SplitExecuteRequest,
  type DmSendOptions,
  type VoucherFilter,
  type ChunkEventOptions,
  type PublishedEvent,
  type Nip60ProofData,
  type VoucherStoreInterface,
  type TransactionStoreInterface,
  type ServiceVoucher,
  type ServiceVoucherInput,
} from './adapters';

// Type exports
export {
  // Voucher types
  type BackingStrategy,
  type VoucherStatus,
  type RoundingMode,
  type MerchantMetadata,
  type Voucher,
  type MerchantGroup,
  type VoucherSelection,
  // Recipient types
  type Recipient,
  type Nip05Result,
  type NostrProfile,
  type RecipientInput,
  // Transaction types
  type TransactionType,
  type TransactionDirection,
  type Transaction,
  type TransactionInput,
  // Split types
  type SplitPreview,
  type SplitResult,
  type SplitRequest,
  // Payment request types
  type TransportType,
  type PaymentTransport,
  type PaymentRequest,
  type PaymentRequestValidation,
  type PaymentRequestMatch,
  // Event types
  SendStages,
  type SendStage,
  type DmResult,
  type ChunkProgress,
  type SendEventMap,
  type SendParams,
  type SendResult,
  type PreviewParams,
  type PreviewResult,
} from './types';

// Re-export types namespace for convenience
export * as Types from './types';

// Selection exports
export {
  VoucherGrouper,
  createVoucherGrouper,
  VoucherSelector,
  createVoucherSelector,
  type VoucherGrouperConfig,
  type VoucherSelectorConfig,
  type SelectionResult,
} from './selection';

// Splitting exports
export {
  SplitPreviewService,
  createSplitPreviewService,
  SplitExecutor,
  createSplitExecutor,
  type PreviewOptions,
  type SplitExecuteOptions,
  type SplitExecutionResult,
} from './splitting';

// Recipient exports
export {
  Nip05Resolver,
  createNip05Resolver,
  RelayDiscovery,
  createRelayDiscovery,
  ProfileFetcher,
  createProfileFetcher,
  RecipientResolver,
  createRecipientResolver,
  type Nip05ResolverConfig,
  type RelayDiscoveryConfig,
  type RelayList,
  type ProfileFetcherConfig,
  type ProfileResult,
  type RecipientResolverConfig,
  type ResolveOptions,
} from './recipient';

// Transmission exports
export {
  PayloadBuilder,
  createPayloadBuilder,
  MissingFaceUnitError,
  TokenChunker,
  createTokenChunker,
  DmSender,
  createDmSender,
  Nip60Publisher,
  createNip60Publisher,
  CHUNK_THRESHOLD,
  CHUNK_SIZE,
  type DmPayload,
  type ChunkReferencePayload,
  type PayloadBuilderConfig,
  type ChunkData,
  type ChunkReference,
  type TokenChunkerConfig,
  type PublishChunkedOptions,
  type DmSenderConfig,
  type SendOptions as DmSendOptions_Transmission,
  type SendResult as DmSendResult,
  type CashuProof,
  type TokenEntry,
  type DecodedToken,
  type Nip60PublisherConfig,
  type PublishOptions,
  type PublishResult,
} from './transmission';

// Orchestrator exports (main entry point)
export {
  VoucherSender,
  createVoucherSender,
  type VoucherSenderConfig,
} from './orchestrator';

// Integration exports (platform-specific adapters)
export {
  // Imani wallet integration
  createImaniAdapters,
  createImaniVoucherSender,
  createStorageFunctions,
  ImaniApiAdapter,
  createImaniApiAdapter,
  ImaniStorageAdapter,
  createImaniStorageAdapter,
  ImaniNostrAdapter,
  createImaniNostrAdapter,
  // Types
  type ImaniAdaptersConfig,
  type ImaniVoucherSenderConfig,
  type GatewayAPI,
  type ImaniStorageFunctions,
  type NostrUtilsInterface,
  type Nip60PublisherInterface,
} from './integrations';

// Spec 039 — QR-share reconciliation entry point
export { reconcileQrShares } from './reconcileQrShares';

/**
 * Library version
 */
export const VERSION = '0.1.0';
