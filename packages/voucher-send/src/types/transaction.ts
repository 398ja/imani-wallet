/**
 * Transaction Types
 *
 * Types for transaction recording.
 */

/**
 * Transaction type
 */
export type TransactionType =
  | 'voucher_sent'
  | 'voucher_received'
  | 'voucher_purchased'
  | 'voucher_redeemed'
  | 'voucher_split'
  | 'voucher_expired';

/**
 * Transaction direction
 */
export type TransactionDirection = 'in' | 'out' | 'internal';

/**
 * Transaction record
 */
export interface Transaction {
  /** Unique transaction ID */
  id?: string;

  /** Transaction type */
  type: TransactionType;

  /** Direction of funds */
  direction: TransactionDirection;

  /** Face value amount */
  faceValue: number;

  /** Face value unit */
  faceUnit: string;

  /** Decimal places */
  faceDecimals: number;

  /** Token amount in sats */
  tokenAmount?: number;

  /** Associated voucher ID */
  voucherId?: string;

  /** Issuer/merchant ID */
  issuerId?: string;

  /** Issuer/merchant name */
  issuerName?: string;

  /** Counterparty (recipient or sender) pubkey */
  counterparty?: string;

  /** Counterparty display name */
  counterpartyName?: string;

  /** Transaction memo */
  memo?: string;

  /** Timestamp (ISO string or Unix ms) */
  timestamp?: string | number;
}

/**
 * Transaction input for recording
 */
export type TransactionInput = Omit<Transaction, 'id' | 'timestamp'>;
