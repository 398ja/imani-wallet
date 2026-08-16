/**
 * Custom error classes for @imani/nostr-vouchers
 */

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

  // Voucher errors
  VOUCHER_NOT_FOUND: 'VOUCHER_NOT_FOUND',
  VOUCHER_VALIDATION_FAILED: 'VOUCHER_VALIDATION_FAILED',
  VOUCHER_DUPLICATE: 'VOUCHER_DUPLICATE',
  VOUCHER_EXPIRED: 'VOUCHER_EXPIRED',

  // Query errors
  QUERY_INVALID_FILTER: 'QUERY_INVALID_FILTER',
  QUERY_INVALID_SORT: 'QUERY_INVALID_SORT',

  // Sync errors
  SYNC_FAILED: 'SYNC_FAILED',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_ENCRYPTION_FAILED: 'SYNC_ENCRYPTION_FAILED',
  SYNC_DECRYPTION_FAILED: 'SYNC_DECRYPTION_FAILED',

  // Database errors
  DATABASE_NOT_AVAILABLE: 'DATABASE_NOT_AVAILABLE',
  DATABASE_UPGRADE_FAILED: 'DATABASE_UPGRADE_FAILED',

  // Unknown
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Base error class for voucher operations
 */
export class VoucherError extends Error {
  public readonly code: ErrorCode;
  public readonly cause?: Error;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.UNKNOWN,
    options?: { cause?: Error; context?: Record<string, unknown> }
  ) {
    super(message);
    this.name = 'VoucherError';
    this.code = code;
    this.cause = options?.cause;
    this.context = options?.context;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, VoucherError);
    }
  }
}

/**
 * Storage-related errors
 */
export class StorageError extends VoucherError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.STORAGE_WRITE_FAILED,
    options?: { cause?: Error; context?: Record<string, unknown> }
  ) {
    super(message, code, options);
    this.name = 'StorageError';
  }
}

/**
 * Voucher not found error
 */
export class NotFoundError extends VoucherError {
  public readonly voucherId: string;

  constructor(voucherId: string) {
    super(`Voucher not found: ${voucherId}`, ErrorCodes.VOUCHER_NOT_FOUND, {
      context: { voucherId },
    });
    this.name = 'NotFoundError';
    this.voucherId = voucherId;
  }
}

/**
 * Validation error
 */
export class ValidationError extends VoucherError {
  public readonly field?: string;
  public readonly value?: unknown;

  constructor(
    message: string,
    options?: {
      field?: string;
      value?: unknown;
      cause?: Error;
    }
  ) {
    super(message, ErrorCodes.VOUCHER_VALIDATION_FAILED, {
      cause: options?.cause,
      context: { field: options?.field, value: options?.value },
    });
    this.name = 'ValidationError';
    this.field = options?.field;
    this.value = options?.value;
  }
}

/**
 * Query-related errors
 */
export class QueryError extends VoucherError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.QUERY_INVALID_FILTER,
    options?: { cause?: Error; context?: Record<string, unknown> }
  ) {
    super(message, code, options);
    this.name = 'QueryError';
  }
}

/**
 * Sync-related errors
 */
export class SyncError extends VoucherError {
  public readonly retryable: boolean;

  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.SYNC_FAILED,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
      retryable?: boolean;
    }
  ) {
    super(message, code, options);
    this.name = 'SyncError';
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Sync conflict error
 */
export class SyncConflictError extends SyncError {
  public readonly localVoucher?: unknown;
  public readonly remoteVoucher?: unknown;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      localVoucher?: unknown;
      remoteVoucher?: unknown;
    }
  ) {
    super(message, ErrorCodes.SYNC_CONFLICT, {
      cause: options?.cause,
      context: {
        localVoucher: options?.localVoucher,
        remoteVoucher: options?.remoteVoucher,
      },
      retryable: false,
    });
    this.name = 'SyncConflictError';
    this.localVoucher = options?.localVoucher;
    this.remoteVoucher = options?.remoteVoucher;
  }
}

/**
 * Expired voucher error
 */
export class ExpiredError extends VoucherError {
  public readonly expiresAt: string;

  constructor(voucherId: string, expiresAt: string) {
    super(`Voucher ${voucherId} has expired at ${expiresAt}`, ErrorCodes.VOUCHER_EXPIRED, {
      context: { voucherId, expiresAt },
    });
    this.name = 'ExpiredError';
    this.expiresAt = expiresAt;
  }
}

// ==========================================
// Type Guards
// ==========================================

/**
 * Check if an error is a VoucherError
 */
export function isVoucherError(error: unknown): error is VoucherError {
  return error instanceof VoucherError;
}

/**
 * Check if an error has a specific code
 */
export function isErrorCode(error: unknown, code: ErrorCode): boolean {
  return isVoucherError(error) && error.code === code;
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  // Sync errors have explicit retryable flag
  if (error instanceof SyncError) {
    return error.retryable;
  }

  // Storage errors are generally retryable
  if (error instanceof StorageError) {
    return true;
  }

  // Not found and validation errors are not retryable
  if (error instanceof NotFoundError || error instanceof ValidationError) {
    return false;
  }

  // Unknown errors might be retryable
  return false;
}

/**
 * Wrap an unknown error into a VoucherError
 */
export function wrapError(error: unknown, defaultMessage: string = 'An error occurred'): VoucherError {
  if (error instanceof VoucherError) {
    return error;
  }

  if (error instanceof Error) {
    return new VoucherError(error.message || defaultMessage, ErrorCodes.UNKNOWN, {
      cause: error,
    });
  }

  return new VoucherError(String(error) || defaultMessage, ErrorCodes.UNKNOWN);
}
