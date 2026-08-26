/**
 * Store module exports
 */

export {
  DB_NAME,
  DB_VERSION,
  STORES,
  TRANSACTION_INDEXES,
  PENDING_RECEIPT_INDEXES,
  SYNC_METADATA_KEYS,
  type IndexDefinition,
  createSchema,
  upgradeSchema,
} from './schema';

// Spec 014-payment-receipts: late-binding window for receipts arriving
// before their matching transaction is locally available.
export {
  PendingReceiptStore,
  type PendingReceiptRecord,
} from './PendingReceiptStore';

export {
  TransactionStore,
  createTransactionStore,
  type TransactionStoreConfig,
  type StorageType,
} from './TransactionStore';

// Spec 012-multi-voucher-send: receiver-side bundle aggregation.
export {
  BundleReceiptStore,
  createBundleReceiptStore,
  type BundleReceiptStoreConfig,
  type BundleReceiptStorageAdapter,
  type BundleReceiptClock,
  type BundleReceiptIngestInput,
  type BundleReceiptDirective,
  type BundleReceiptRecord,
  type BundleReceiptState,
  type RedemptionStatus,
  type ReceivedPartRecord,
  type MetadataDisagreement,
  type ReconciliationResult,
} from './BundleReceiptStore';
