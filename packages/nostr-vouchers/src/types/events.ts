/**
 * Event types for VoucherService
 */

import type { Voucher } from './voucher';
import type { VoucherGroup } from './group';

/**
 * All voucher event types
 */
export type VoucherEventType =
  // Voucher lifecycle events
  | 'voucher:added'
  | 'voucher:updated'
  | 'voucher:deleted'
  | 'voucher:batch-added'
  // Status change events
  | 'voucher:expired'
  | 'voucher:expiring'
  | 'voucher:spent'
  // Sync events
  | 'sync:started'
  | 'sync:progress'
  | 'sync:completed'
  | 'sync:error'
  // Store events
  | 'store:opened'
  | 'store:closed'
  | 'store:error';

/**
 * Event payloads for each event type
 */
export interface VoucherEventPayloads {
  // ==========================================
  // Voucher Lifecycle Events
  // ==========================================

  'voucher:added': VoucherAddedEvent;
  'voucher:updated': VoucherUpdatedEvent;
  'voucher:deleted': VoucherDeletedEvent;
  'voucher:batch-added': VoucherBatchAddedEvent;

  // ==========================================
  // Status Change Events
  // ==========================================

  'voucher:expired': VoucherExpiredEvent;
  'voucher:expiring': VoucherExpiringEvent;
  'voucher:spent': VoucherSpentEvent;

  // ==========================================
  // Sync Events
  // ==========================================

  'sync:started': SyncStartedEvent;
  'sync:progress': SyncProgressEvent;
  'sync:completed': SyncCompletedEvent;
  'sync:error': SyncErrorEvent;

  // ==========================================
  // Store Events
  // ==========================================

  'store:opened': StoreOpenedEvent;
  'store:closed': StoreClosedEvent;
  'store:error': StoreErrorEvent;
}

// ==========================================
// Voucher Lifecycle Event Payloads
// ==========================================

export interface VoucherAddedEvent {
  /** The added voucher */
  voucher: Voucher;
  /** Source of the addition */
  source: 'local' | 'sync' | 'import';
}

export interface VoucherUpdatedEvent {
  /** The updated voucher */
  voucher: Voucher;
  /** Previous voucher state */
  previous: Voucher;
  /** Changed fields */
  changes: (keyof Voucher)[];
}

export interface VoucherDeletedEvent {
  /** ID of deleted voucher */
  voucherId: string;
  /** The deleted voucher (if available) */
  voucher?: Voucher;
}

export interface VoucherBatchAddedEvent {
  /** Added vouchers */
  vouchers: Voucher[];
  /** Number of vouchers added */
  count: number;
  /** Source of the addition */
  source: 'local' | 'sync' | 'import';
}

// ==========================================
// Status Change Event Payloads
// ==========================================

export interface VoucherExpiredEvent {
  /** The expired voucher */
  voucher: Voucher;
  /** When it expired */
  expiredAt: string;
}

export interface VoucherExpiringEvent {
  /** The expiring voucher */
  voucher: Voucher;
  /** Days until expiry */
  daysLeft: number;
  /** Expiry date */
  expiresAt: string;
}

export interface VoucherSpentEvent {
  /** The spent voucher */
  voucher: Voucher;
  /** When it was spent */
  spentAt: string;
}

// ==========================================
// Sync Event Payloads
// ==========================================

export interface SyncStartedEvent {
  /** Sync direction */
  direction: 'push' | 'pull' | 'full';
  /** Number of items to sync */
  totalItems?: number;
}

export interface SyncProgressEvent {
  /** Sync direction */
  direction: 'push' | 'pull' | 'full';
  /** Items processed so far */
  processed: number;
  /** Total items */
  total: number;
  /** Progress percentage (0-100) */
  percentage: number;
}

export interface SyncCompletedEvent {
  /** Sync direction */
  direction: 'push' | 'pull' | 'full';
  /** Number of items pushed */
  pushed?: number;
  /** Number of items pulled */
  pulled?: number;
  /** Duration in milliseconds */
  duration: number;
}

export interface SyncErrorEvent {
  /** Sync direction */
  direction: 'push' | 'pull' | 'full';
  /** Error that occurred */
  error: Error;
  /** Whether sync can be retried */
  retryable: boolean;
}

// ==========================================
// Store Event Payloads
// ==========================================

export interface StoreOpenedEvent {
  /** Database name */
  dbName: string;
  /** Whether using shared database */
  isShared: boolean;
}

export interface StoreClosedEvent {
  /** Database name */
  dbName: string;
}

export interface StoreErrorEvent {
  /** Error that occurred */
  error: Error;
  /** Operation that failed */
  operation: string;
}

// ==========================================
// Event Handler Types
// ==========================================

/**
 * Event handler function type
 */
export type EventHandler<T extends VoucherEventType> = (
  payload: VoucherEventPayloads[T]
) => void | Promise<void>;

/**
 * Unsubscribe function
 */
export type Unsubscribe = () => void;

// ==========================================
// Statistics Types
// ==========================================

/**
 * Voucher statistics
 */
export interface VoucherStats {
  /** Total number of vouchers */
  totalVouchers: number;
  /** Total face value by currency */
  totalFaceValue: Record<string, number>;
  /** Total token amount (sats) */
  totalTokenAmount: number;
  /** Count by status */
  byStatus: Record<string, number>;
  /** Count by backing strategy */
  byStrategy: Record<string, number>;
  /** Count by currency */
  byCurrency: Record<string, number>;
  /** Number expiring within 7 days */
  expiringWithin7Days: number;
  /** Number expiring within 30 days */
  expiringWithin30Days: number;
  /** Number of unique merchants */
  merchantCount: number;
  /** Groups by merchant (top N) */
  topMerchants?: VoucherGroup[];
}

// ==========================================
// Export Types
// ==========================================

/**
 * Export format
 */
export type ExportFormat = 'json' | 'csv';

/**
 * Export options
 */
export interface ExportOptions {
  /** Export format */
  format: ExportFormat;
  /** Filter to apply before export */
  filter?: import('./filter').VoucherFilter;
  /** Fields to include (default: all) */
  fields?: (keyof Voucher)[];
  /** Include token field (default: false for security) */
  includeToken?: boolean;
}

/**
 * Export result
 */
export interface ExportResult {
  /** Export data (string for CSV, object for JSON) */
  data: string;
  /** Number of vouchers exported */
  count: number;
  /** Export format used */
  format: ExportFormat;
  /** Export timestamp */
  timestamp: string;
}

// ==========================================
// Sync Status Types
// ==========================================

/**
 * Sync status
 */
export interface SyncStatus {
  /** Last sync timestamp (unix seconds) */
  lastSync: number | null;
  /** Last sync event ID */
  lastEventId: string | null;
  /** Number of unsynced vouchers */
  pendingCount: number;
  /** Whether currently syncing */
  isSyncing: boolean;
  /** Last sync error (if any) */
  lastError?: string;
}