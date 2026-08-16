/**
 * Voucher-related types
 */

/**
 * Backing strategy for vouchers
 */
export type BackingStrategy = 'MINIMAL' | 'FULL' | 'LEGACY';

/**
 * Voucher status
 */
export type VoucherStatus = 'active' | 'spent' | 'expired';

/**
 * A redeemed voucher
 */
export interface Voucher {
  /** Unique voucher identifier */
  voucher_id: string;

  /** Cashu token string */
  token: string;

  /** Display face value */
  face_value: number;

  /** Face value currency unit */
  face_unit: string;

  /** Decimal places for face value */
  face_decimals: number;

  /** Actual token amount in base unit */
  token_amount: number;

  /** Token currency unit (usually 'sat') */
  token_unit: string;

  /** Backing strategy used */
  backing_strategy: BackingStrategy;

  /** Current status */
  status: VoucherStatus;

  /** Creation timestamp (ISO string) */
  created_at: string;

  /** Expiration timestamp (ISO string) */
  expires_at?: string;

  /** Sender's public key */
  sender_pubkey?: string;

  /** Optional memo */
  memo?: string;

  /** How the voucher was received */
  received_via?: string;

  /** Issuer's ID or public key */
  issuer_id?: string;

  /** Issuance ratio (for MINIMAL strategy) */
  issuance_ratio?: number;

  /** Additional merchant-specific data */
  merchant_metadata?: Record<string, unknown>;
}

/**
 * Transaction recorded in NIP-60 wallet
 */
export interface Transaction {
  /** Unique transaction ID */
  id: string;

  /** Transaction type */
  type: 'send' | 'receive' | 'redeem' | 'issue';

  /** Amount in base unit */
  amount: number;

  /** Currency unit */
  unit: string;

  /** Timestamp (ISO string) */
  timestamp: string;

  /** Counterparty pubkey */
  counterparty?: string;

  /** Optional memo */
  memo?: string;

  /** Related voucher ID */
  voucher_id?: string;
}
