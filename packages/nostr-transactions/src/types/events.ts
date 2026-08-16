/**
 * Event types for transaction service
 */

import type { Transaction } from './transaction';

/**
 * Event types emitted by the TransactionService
 */
export type TransactionEventType =
  | 'transaction:added'
  | 'transaction:updated'
  | 'transaction:deleted'
  | 'transaction:batch-added'
  | 'sync:started'
  | 'sync:progress'
  | 'sync:completed'
  | 'sync:error'
  | 'store:opened'
  | 'store:closed'
  | 'store:error';

/**
 * Event payloads for each event type
 */
export interface TransactionEventPayloads {
  'transaction:added': TransactionAddedEvent;
  'transaction:updated': TransactionUpdatedEvent;
  'transaction:deleted': TransactionDeletedEvent;
  'transaction:batch-added': TransactionBatchAddedEvent;
  'sync:started': SyncStartedEvent;
  'sync:progress': SyncProgressEvent;
  'sync:completed': SyncCompletedEvent;
  'sync:error': SyncErrorEvent;
  'store:opened': StoreOpenedEvent;
  'store:closed': StoreClosedEvent;
  'store:error': StoreErrorEvent;
}

/**
 * Transaction added event
 */
export interface TransactionAddedEvent {
  transaction: Transaction;
}

/**
 * Transaction updated event
 */
export interface TransactionUpdatedEvent {
  transaction: Transaction;
  changes: Partial<Transaction>;
}

/**
 * Transaction deleted event
 */
export interface TransactionDeletedEvent {
  id: string;
  transaction?: Transaction;
}

/**
 * Batch transactions added event
 */
export interface TransactionBatchAddedEvent {
  transactions: Transaction[];
  count: number;
}

/**
 * Sync started event
 */
export interface SyncStartedEvent {
  direction: 'push' | 'pull' | 'full';
  timestamp: number;
}

/**
 * Sync progress event
 */
export interface SyncProgressEvent {
  direction: 'push' | 'pull';
  processed: number;
  total: number;
  percentage: number;
}

/**
 * Sync completed event
 */
export interface SyncCompletedEvent {
  direction: 'push' | 'pull' | 'full';
  pushed?: number;
  pulled?: number;
  duration: number;
  timestamp: number;
}

/**
 * Sync error event
 */
export interface SyncErrorEvent {
  direction: 'push' | 'pull' | 'full';
  error: Error;
  timestamp: number;
}

/**
 * Store opened event
 */
export interface StoreOpenedEvent {
  dbName: string;
  version: number;
}

/**
 * Store closed event
 */
export interface StoreClosedEvent {
  dbName: string;
}

/**
 * Store error event
 */
export interface StoreErrorEvent {
  error: Error;
  operation: string;
}

/**
 * Event handler function type
 */
export type EventHandler<T> = (event: T) => void;

/**
 * Event unsubscribe function
 */
export type Unsubscribe = () => void;

/**
 * Statistics result
 */
export interface TransactionStats {
  totalIn: number; // Total received (token amount)
  totalOut: number; // Total sent (token amount)
  totalInternal: number; // Internal transfers
  countIn: number; // Number of received
  countOut: number; // Number of sent
  countInternal: number; // Number of internal
  netFlow: number; // totalIn - totalOut
  byType: Record<
    string,
    {
      count: number;
      total: number;
    }
  >;
  byUnit: Record<
    string,
    {
      count: number;
      totalFaceValue: number;
      totalTokenAmount: number;
    }
  >;
}

/**
 * Export options
 */
export interface ExportOptions {
  format: 'json' | 'csv';
  filter?: import('./filter').TransactionFilter;
  includeMetadata?: boolean;
}

/**
 * Export result
 */
export interface ExportResult {
  format: 'json' | 'csv';
  data: string;
  count: number;
  timestamp: number;
}

/**
 * Sync status
 */
export interface SyncStatus {
  lastSync?: number;
  lastPush?: number;
  lastPull?: number;
  pendingCount: number;
  synced: boolean;
  inProgress: boolean;
}
