/**
 * Voucher Types
 *
 * Types for voucher data structures used throughout the library.
 */

/**
 * Backing strategy for vouchers
 */
export type BackingStrategy = 'LEGACY' | 'MINIMAL' | 'FULL';

/**
 * Voucher status
 */
export type VoucherStatus = 'active' | 'spent' | 'expired';

/**
 * Rounding mode for split operations
 */
export type RoundingMode = 'FLOOR' | 'CEIL' | 'ROUND';

/**
 * Merchant metadata
 */
export interface MerchantMetadata {
  merchant_name?: string;
  merchant_logo?: string;
  merchant_url?: string;
  [key: string]: unknown;
}

/**
 * Voucher data structure
 * Uses snake_case to match existing Imani wallet format
 */
export interface Voucher {
  /** Unique voucher identifier */
  voucher_id: string;

  /** Cashu token string */
  token: string;

  /** Face value in minor units (e.g., cents) */
  face_value: number;

  /** Face value currency unit (e.g., 'EUR', 'USD') */
  face_unit: string;

  /** Number of decimal places for face value */
  face_decimals: number;

  /** Token amount in sats */
  token_amount: number;

  /** Token unit (typically 'sat') */
  token_unit?: string;

  /** Backing strategy */
  backing_strategy: BackingStrategy;

  /** Issuance ratio (face value per sat) */
  issuance_ratio?: number;

  /** Issuer (merchant) public key */
  issuer_id?: string;

  /** Merchant metadata */
  merchant_metadata?: MerchantMetadata;

  /** Voucher status */
  status: VoucherStatus;

  /** Expiration timestamp (ISO string) */
  expires_at?: string;

  /** Creation timestamp (ISO string) */
  created_at?: string;

  /** Mint URL */
  mint_url?: string;

  /** Memo/note */
  memo?: string;
}

/**
 * Merchant group - vouchers grouped by merchant
 */
export interface MerchantGroup {
  /** Merchant public key */
  merchantId: string;

  /** Merchant display name */
  merchantName: string;

  /** Currency unit for this merchant */
  unit: string;

  /** Decimal places */
  decimals: number;

  /** Issuance ratio */
  issuanceRatio: number;

  /** Total face value across all vouchers */
  totalFaceValue: number;

  /** Total token amount (sats) */
  totalTokenAmount: number;

  /** Number of vouchers */
  voucherCount: number;

  /** Vouchers in this group */
  vouchers: Voucher[];
}

/**
 * Voucher selection result
 */
export interface VoucherSelection {
  /** Selected voucher */
  voucher: Voucher;

  /** Merchant group the voucher belongs to */
  merchantGroup: MerchantGroup;
}
