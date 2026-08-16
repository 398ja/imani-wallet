/**
 * Custom error classes for @imani/nostr-transactions
 */

/**
 * Base error class for all transaction errors
 */
export class TransactionError extends Error {
  public readonly code: string;
  public readonly cause?: Error;

  constructor(message: string, code: string, cause?: Error) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
    this.cause = cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error codes
 */
export const ErrorCodes = {
  // Storage errors
  STORAGE_NOT_INITIALIZED: 'STORAGE_NOT_INITIALIZED',
  STORAGE_OPEN_FAILED: 'STORAGE_OPEN_FAILED',
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
  STORAGE_READ_FAILED: 'STORAGE_READ_FAILED',
  STORAGE_DELETE_FAILED: 'STORAGE_DELETE_FAILED',

  // Transaction errors
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  TRANSACTION_INVALID: 'TRANSACTION_INVALID',
  TRANSACTION_DUPLICATE: 'TRANSACTION_DUPLICATE',

  // Query errors
  QUERY_INVALID: 'QUERY_INVALID',
  QUERY_FAILED: 'QUERY_FAILED',

  // Sync errors
  SYNC_FAILED: 'SYNC_FAILED',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_NETWORK_ERROR: 'SYNC_NETWORK_ERROR',

  // Validation errors
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_FILTER: 'INVALID_FILTER',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Storage error - thrown when storage operations fail
 */
export class StorageError extends TransactionError {
  constructor(message: string, code: string = ErrorCodes.STORAGE_WRITE_FAILED, cause?: Error) {
    super(message, code, cause);
    this.name = 'StorageError';
  }
}

/**
 * Not found error - thrown when a transaction is not found
 */
export class NotFoundError extends TransactionError {
  public readonly transactionId: string;

  constructor(id: string) {
    super(`Transaction not found: ${id}`, ErrorCodes.TRANSACTION_NOT_FOUND);
    this.name = 'NotFoundError';
    this.transactionId = id;
  }
}

/**
 * Validation error - thrown when transaction data is invalid
 */
export class ValidationError extends TransactionError {
  public readonly field?: string;
  public readonly value?: unknown;

  constructor(message: string, field?: string, value?: unknown) {
    super(message, ErrorCodes.VALIDATION_FAILED);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Query error - thrown when a query operation fails
 */
export class QueryError extends TransactionError {
  public readonly filter?: Record<string, unknown>;

  constructor(message: string, filter?: Record<string, unknown>, cause?: Error) {
    super(message, ErrorCodes.QUERY_FAILED, cause);
    this.name = 'QueryError';
    this.filter = filter;
  }
}

/**
 * Sync error - thrown when sync operations fail
 */
export class SyncError extends TransactionError {
  public readonly direction?: 'push' | 'pull' | 'full';

  constructor(message: string, direction?: 'push' | 'pull' | 'full', cause?: Error) {
    super(message, ErrorCodes.SYNC_FAILED, cause);
    this.name = 'SyncError';
    this.direction = direction;
  }
}

/**
 * Sync conflict error - thrown when there's a conflict during sync
 */
export class SyncConflictError extends TransactionError {
  public readonly localTransaction?: unknown;
  public readonly remoteTransaction?: unknown;

  constructor(
    message: string,
    localTransaction?: unknown,
    remoteTransaction?: unknown
  ) {
    super(message, ErrorCodes.SYNC_CONFLICT);
    this.name = 'SyncConflictError';
    this.localTransaction = localTransaction;
    this.remoteTransaction = remoteTransaction;
  }
}

/**
 * Check if an error is a TransactionError
 */
export function isTransactionError(error: unknown): error is TransactionError {
  return error instanceof TransactionError;
}

/**
 * Check if an error is a specific error type
 */
export function isErrorCode(error: unknown, code: ErrorCode): boolean {
  return isTransactionError(error) && error.code === code;
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!isTransactionError(error)) {
    return false;
  }

  const retryableCodes: ErrorCode[] = [
    ErrorCodes.SYNC_NETWORK_ERROR,
    ErrorCodes.STORAGE_WRITE_FAILED,
    ErrorCodes.STORAGE_READ_FAILED,
  ];

  return retryableCodes.includes(error.code as ErrorCode);
}
