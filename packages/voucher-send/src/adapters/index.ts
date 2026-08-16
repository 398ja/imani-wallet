/**
 * Adapters Module
 *
 * Exports adapter interfaces and implementations.
 */

// Adapter interfaces
export type {
  ApiAdapter,
  SplitPreviewRequest,
  SplitExecuteRequest,
  DmSendOptions,
} from './ApiAdapter';
export { isApiAdapter } from './ApiAdapter';

export type {
  StorageAdapter,
  VoucherFilter,
} from './StorageAdapter';
export { isStorageAdapter } from './StorageAdapter';

export type {
  NostrAdapter,
  ChunkEventOptions,
  PublishedEvent,
  Nip60ProofData,
} from './NostrAdapter';
export { isNostrAdapter } from './NostrAdapter';

// Built-in adapters
export {
  VoucherServiceAdapter,
  type VoucherStoreInterface,
  type TransactionStoreInterface,
  type ServiceVoucher,
  type ServiceVoucherInput,
} from './VoucherServiceAdapter';

/**
 * Adapters configuration object
 */
export interface Adapters {
  /** API adapter for backend operations */
  api: import('./ApiAdapter').ApiAdapter;

  /** Storage adapter for voucher persistence */
  storage: import('./StorageAdapter').StorageAdapter;

  /** Nostr adapter for protocol operations */
  nostr: import('./NostrAdapter').NostrAdapter;
}
