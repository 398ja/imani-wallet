/**
 * Type exports for @imani/nostr-vouchers
 */

// Voucher types
export type {
  Voucher,
  VoucherInput,
  VoucherUpdate,
  MerchantMetadata,
  ReceptionMethod,
} from './voucher';

export {
  BackingStrategy,
  VoucherStatus,
  RoundingMode,
  generateVoucherId,
  calculateIssuanceRatio,
  isVoucherExpired,
  hasVoucherValue,
  createVoucher,
  getDefaultDecimals,
  fromAutoRedemptionVoucher,
} from './voucher';

// Filter types
export type {
  VoucherFilter,
  VoucherSortField,
  SortConfig,
  VoucherQueryResult,
} from './filter';

export {
  DEFAULT_FILTER,
  normalizeFilter,
  matchesFilter,
  sortVouchers,
  paginateVouchers,
} from './filter';

// Group types
export type {
  GroupByField,
  AggregationType,
  GroupSortField,
  GroupOptions,
  VoucherGroup,
  GroupResult,
  ConsolidationCriteria,
} from './group';

export {
  DEFAULT_GROUP_OPTIONS,
  generateGroupKey,
  createEmptyGroup,
  addVoucherToGroup,
  finalizeGroup,
  sortGroups,
  canConsolidate,
} from './group';

// Event types
export type {
  VoucherEventType,
  VoucherEventPayloads,
  VoucherAddedEvent,
  VoucherUpdatedEvent,
  VoucherDeletedEvent,
  VoucherBatchAddedEvent,
  VoucherExpiredEvent,
  VoucherExpiringEvent,
  VoucherSpentEvent,
  SyncStartedEvent,
  SyncProgressEvent,
  SyncCompletedEvent,
  SyncErrorEvent,
  StoreOpenedEvent,
  StoreClosedEvent,
  StoreErrorEvent,
  EventHandler,
  Unsubscribe,
  VoucherStats,
  ExportFormat,
  ExportOptions,
  ExportResult,
  SyncStatus,
} from './events';