/**
 * Sync module exports
 */

// Types
export {
  NIP60_HISTORY_KIND,
  type NostrEvent,
  type UnsignedEvent,
  type NostrSigner,
  type CryptoProvider,
  type RelaySyncConfig,
  type SyncDirection,
  type SyncResult,
  type SyncError,
  type SyncStatus,
  type Nip60HistoryContent,
  transactionToHistoryContent,
  historyContentToTransaction,
} from './types';

// Event Builder
export {
  EventBuilder,
  createEventBuilder,
  type EventBuilderConfig,
} from './EventBuilder';

// Relay Sync
export {
  RelaySync,
  createRelaySync,
  SimpleRelayPool,
  type RelayConnection,
  type RelayPool,
} from './RelaySync';
