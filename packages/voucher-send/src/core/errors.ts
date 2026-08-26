/**
 * Error Types
 *
 * Custom error classes for the voucher-send library.
 */

/**
 * Error codes
 */
export const ErrorCodes = {
  // Selection errors
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  VOUCHER_NOT_FOUND: 'VOUCHER_NOT_FOUND',
  MERCHANT_NOT_FOUND: 'MERCHANT_NOT_FOUND',
  NO_VOUCHER_WITH_BALANCE: 'NO_VOUCHER_WITH_BALANCE',

  // Split errors
  SWAP_REQUIRED: 'SWAP_REQUIRED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  SPLIT_FAILED: 'SPLIT_FAILED',
  AMOUNT_TOO_SMALL: 'AMOUNT_TOO_SMALL',

  // Recipient errors
  RECIPIENT_NOT_FOUND: 'RECIPIENT_NOT_FOUND',
  NIP05_RESOLUTION_FAILED: 'NIP05_RESOLUTION_FAILED',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',

  // Transmission errors
  DM_SEND_FAILED: 'DM_SEND_FAILED',
  RELAY_CONNECTION_FAILED: 'RELAY_CONNECTION_FAILED',
  CHUNK_PUBLISH_FAILED: 'CHUNK_PUBLISH_FAILED',

  // Payment request errors
  PAYMENT_REQUEST_EXPIRED: 'PAYMENT_REQUEST_EXPIRED',
  PAYMENT_REQUEST_INVALID: 'PAYMENT_REQUEST_INVALID',
  PAYMENT_REQUEST_MERCHANT_NOT_FOUND: 'PAYMENT_REQUEST_MERCHANT_NOT_FOUND',

  // General errors
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  ADAPTER_ERROR: 'ADAPTER_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Error details type
 */
export interface ErrorDetails {
  /** Required amount (for balance errors) */
  required?: number;

  /** Available amount */
  available?: number;

  /** Currency unit */
  unit?: string;

  /** Voucher ID */
  voucherId?: string;

  /** Merchant ID */
  merchantId?: string;

  /** Recipient identifier */
  recipient?: string;

  /** Stage where error occurred */
  stage?: string;

  /** Original error */
  cause?: Error;

  /** Additional context */
  [key: string]: unknown;
}

/**
 * VoucherSendError
 *
 * Custom error class for voucher-send operations.
 */
export class VoucherSendError extends Error {
  /** Error code */
  readonly code: ErrorCode;

  /** Error details */
  readonly details: ErrorDetails;

  constructor(message: string, code: ErrorCode, details: ErrorDetails = {}) {
    super(message);
    this.name = 'VoucherSendError';
    this.code = code;
    this.details = details;

    // Maintain proper stack trace (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, VoucherSendError);
    }
  }

  /**
   * Create an insufficient balance error
   */
  static insufficientBalance(
    required: number,
    available: number,
    unit: string
  ): VoucherSendError {
    return new VoucherSendError(
      `Insufficient balance: need ${required} ${unit}, have ${available} ${unit}`,
      ErrorCodes.INSUFFICIENT_BALANCE,
      { required, available, unit }
    );
  }

  /**
   * Create a voucher not found error
   */
  static voucherNotFound(voucherId: string): VoucherSendError {
    return new VoucherSendError(
      `Voucher not found: ${voucherId}`,
      ErrorCodes.VOUCHER_NOT_FOUND,
      { voucherId }
    );
  }

  /**
   * Create a merchant not found error
   */
  static merchantNotFound(merchantId: string): VoucherSendError {
    return new VoucherSendError(
      `No vouchers found for merchant: ${merchantId}`,
      ErrorCodes.MERCHANT_NOT_FOUND,
      { merchantId }
    );
  }

  /**
   * Create a no voucher with balance error
   */
  static noVoucherWithBalance(
    required: number,
    bestAvailable: number,
    unit: string
  ): VoucherSendError {
    return new VoucherSendError(
      `No single voucher with enough balance. Need ${required} ${unit}, best available: ${bestAvailable} ${unit}`,
      ErrorCodes.NO_VOUCHER_WITH_BALANCE,
      { required, available: bestAvailable, unit }
    );
  }

  /**
   * Create a swap required error
   */
  static swapRequired(amount: number, minAmount: number): VoucherSendError {
    return new VoucherSendError(
      `Cannot split amount ${amount}. Minimum split amount: ${minAmount}`,
      ErrorCodes.SWAP_REQUIRED,
      { required: amount, available: minAmount }
    );
  }

  /**
   * Create a recipient not found error
   */
  static recipientNotFound(identifier: string, reason?: string): VoucherSendError {
    return new VoucherSendError(
      `Recipient not found: ${identifier}${reason ? ` (${reason})` : ''}`,
      ErrorCodes.RECIPIENT_NOT_FOUND,
      { recipient: identifier }
    );
  }

  /**
   * Create a NIP-05 resolution error
   */
  static nip05Failed(identifier: string, reason?: string): VoucherSendError {
    return new VoucherSendError(
      `NIP-05 resolution failed for ${identifier}${reason ? `: ${reason}` : ''}`,
      ErrorCodes.NIP05_RESOLUTION_FAILED,
      { recipient: identifier }
    );
  }

  /**
   * Create a DM send failed error
   */
  static dmSendFailed(reason: string, cause?: Error): VoucherSendError {
    return new VoucherSendError(
      `Failed to send DM: ${reason}`,
      ErrorCodes.DM_SEND_FAILED,
      { cause }
    );
  }

  /**
   * Create a payment request expired error
   */
  static paymentRequestExpired(): VoucherSendError {
    return new VoucherSendError(
      'Payment request has expired',
      ErrorCodes.PAYMENT_REQUEST_EXPIRED
    );
  }

  /**
   * Create a payment request invalid error
   */
  static paymentRequestInvalid(reason: string): VoucherSendError {
    return new VoucherSendError(
      `Invalid payment request: ${reason}`,
      ErrorCodes.PAYMENT_REQUEST_INVALID
    );
  }

  /**
   * Create a timeout error
   */
  static timeout(operation: string): VoucherSendError {
    return new VoucherSendError(
      `Operation timed out: ${operation}`,
      ErrorCodes.TIMEOUT,
      { stage: operation }
    );
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
    };
  }
}
