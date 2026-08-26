/**
 * Voucher types and interfaces
 *
 * This is the canonical Voucher type for the @imani ecosystem.
 * It's a superset of the auto-redemption Voucher type.
 */

import { getDecimals as getDefaultDecimals } from '@imani/money';

/**
 * Backing strategy for vouchers
 */
export enum BackingStrategy {
  /** Legacy 1:1 ratio vouchers */
  LEGACY = 'LEGACY',
  /** Face value can exceed sats backing */
  MINIMAL = 'MINIMAL',
  /** Full sats backing */
  FULL = 'FULL',
}

/**
 * Voucher status
 */
export enum VoucherStatus {
  ACTIVE = 'active',
  SPENT = 'spent',
  EXPIRED = 'expired',
}

/**
 * Rounding mode for MINIMAL backing
 */
export enum RoundingMode {
  FLOOR = 'FLOOR',
  CEIL = 'CEIL',
  ROUND = 'ROUND',
}

/**
 * How the voucher was received
 */
export type ReceptionMethod = 'manual' | 'dm' | 'dm_nip17' | 'nutzap' | 'api';

/**
 * Merchant metadata
 */
export interface MerchantMetadata {
  merchantId: string;
  merchantName: string;
  description?: string;
  logoUrl?: string;
}

/**
 * Core voucher record stored in IndexedDB and synced to relays
 */
export interface Voucher {
  // ==========================================
  // Identity
  // ==========================================

  /** Unique voucher identifier */
  id: string;
  /** Nostr event ID (if synced to relay) */
  eventId?: string;
  /** Cashu token string */
  token: string;

  // ==========================================
  // Face Value (customer-visible)
  // ==========================================

  /** Face value in minor units (cents, satoshis) */
  faceValue: number;
  /** Currency code (EUR, USD, SAT, XAF) */
  faceUnit: string;
  /** Decimal precision (0 for SAT, 2 for USD) */
  faceDecimals: number;

  // ==========================================
  // Token Backing (sats)
  // ==========================================

  /** Sats backing the voucher */
  tokenAmount: number;
  /** Token unit (usually 'sat') */
  tokenUnit: string;
  /** Face value / token amount ratio */
  issuanceRatio: number;
  /** Backing strategy */
  backingStrategy: BackingStrategy;
  /** Rounding mode for MINIMAL backing */
  roundingMode?: RoundingMode;

  // ==========================================
  // Status & Lifecycle
  // ==========================================

  /** Voucher status */
  status: VoucherStatus;
  /** Expiration timestamp (ISO 8601) */
  expiresAt?: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt?: string;

  // ==========================================
  // Merchant/Issuer
  // ==========================================

  /** Merchant/issuer pubkey (hex) */
  issuerId?: string;
  /** Cached merchant display name */
  issuerName?: string;
  /** Full merchant metadata */
  merchantMetadata?: MerchantMetadata;
  /** Mint URL */
  mintUrl?: string;

  // ==========================================
  // Reception Info
  // ==========================================

  /** User memo */
  memo?: string;
  /** How the voucher was received */
  receivedVia?: ReceptionMethod;
  /** Sender pubkey (hex) */
  senderPubkey?: string;
  /** Sender display name (cached) */
  senderName?: string;

  // ==========================================
  // Wallet Association
  // ==========================================

  /** Parent wallet identifier */
  walletId?: string;

  // ==========================================
  // Sync Status
  // ==========================================

  /** Synced to relay */
  synced: boolean;
  /** Last sync timestamp (unix seconds) */
  syncedAt?: number;
  /** Needs metadata refresh from API */
  needsRefresh?: boolean;

  // ==========================================
  // Extensibility
  // ==========================================

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new voucher (without auto-generated fields)
 */
export interface VoucherInput {
  /** Cashu token string */
  token: string;

  // Face Value
  faceValue: number;
  faceUnit: string;
  faceDecimals?: number;

  // Backing
  tokenAmount: number;
  tokenUnit?: string;
  issuanceRatio?: number;
  backingStrategy?: BackingStrategy;
  roundingMode?: RoundingMode;

  // Status
  status?: VoucherStatus;
  expiresAt?: string;

  // Merchant
  issuerId?: string;
  issuerName?: string;
  merchantMetadata?: MerchantMetadata;
  mintUrl?: string;

  // Reception
  memo?: string;
  receivedVia?: ReceptionMethod;
  senderPubkey?: string;
  senderName?: string;

  // Wallet
  walletId?: string;

  // Extensibility
  metadata?: Record<string, unknown>;
}

/**
 * Voucher update input (partial update)
 */
export interface VoucherUpdate {
  // Status
  status?: VoucherStatus;

  // Merchant
  issuerName?: string;
  merchantMetadata?: MerchantMetadata;

  // Reception
  memo?: string;
  senderName?: string;

  // Wallet
  walletId?: string;

  // Sync
  synced?: boolean;
  syncedAt?: number;
  eventId?: string;
  needsRefresh?: boolean;

  // Extensibility
  metadata?: Record<string, unknown>;
}

// ==========================================
// Utility Functions
// ==========================================

/**
 * Generate a unique voucher ID
 */
export function generateVoucherId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `v_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Calculate issuance ratio from face value and token amount
 */
export function calculateIssuanceRatio(faceValue: number, tokenAmount: number): number {
  if (tokenAmount === 0) return 0;
  return faceValue / tokenAmount;
}

/**
 * Check if a voucher is expired
 */
export function isVoucherExpired(voucher: Voucher): boolean {
  if (!voucher.expiresAt) return false;
  return new Date(voucher.expiresAt) <= new Date();
}

/**
 * Check if a voucher has value
 */
export function hasVoucherValue(voucher: Voucher): boolean {
  return voucher.faceValue > 0 || voucher.tokenAmount > 0;
}

/**
 * Create a voucher from input
 */
export function createVoucher(input: VoucherInput): Voucher {
  const now = new Date().toISOString();
  const tokenAmount = input.tokenAmount;
  const faceValue = input.faceValue;

  return {
    id: generateVoucherId(),
    token: input.token,

    // Face Value
    faceValue,
    faceUnit: input.faceUnit,
    faceDecimals: input.faceDecimals ?? getDefaultDecimals(input.faceUnit),

    // Backing
    tokenAmount,
    tokenUnit: input.tokenUnit ?? 'sat',
    issuanceRatio: input.issuanceRatio ?? calculateIssuanceRatio(faceValue, tokenAmount),
    backingStrategy: input.backingStrategy ?? BackingStrategy.LEGACY,
    roundingMode: input.roundingMode,

    // Status
    status: input.status ?? VoucherStatus.ACTIVE,
    expiresAt: input.expiresAt,
    createdAt: now,

    // Merchant
    issuerId: input.issuerId,
    issuerName: input.issuerName,
    merchantMetadata: input.merchantMetadata,
    mintUrl: input.mintUrl,

    // Reception
    memo: input.memo,
    receivedVia: input.receivedVia,
    senderPubkey: input.senderPubkey,
    senderName: input.senderName,

    // Wallet
    walletId: input.walletId,

    // Sync
    synced: false,

    // Extensibility
    metadata: input.metadata,
  };
}

/**
 * Get default decimal places for a currency
 */
// Re-exported from @imani/money — import is at the top of this file
export { getDefaultDecimals };

/**
 * Convert auto-redemption Voucher format to canonical format
 * This helper assists with integrating @imani/auto-redemption
 */
export function fromAutoRedemptionVoucher(arVoucher: {
  voucher_id: string;
  token: string;
  face_value: number;
  face_unit: string;
  face_decimals: number;
  token_amount: number;
  token_unit: string;
  backing_strategy: 'MINIMAL' | 'FULL' | 'LEGACY';
  issuer_id?: string;
  sender_pubkey?: string;
  memo?: string;
  expires_at?: string;
  created_at: string;
  status: 'active' | 'spent' | 'expired';
  mint_url: string;
  merchant_metadata?: Record<string, unknown>;
}): Voucher {
  return {
    id: arVoucher.voucher_id,
    token: arVoucher.token,
    faceValue: arVoucher.face_value,
    faceUnit: arVoucher.face_unit,
    faceDecimals: arVoucher.face_decimals,
    tokenAmount: arVoucher.token_amount,
    tokenUnit: arVoucher.token_unit,
    issuanceRatio: calculateIssuanceRatio(arVoucher.face_value, arVoucher.token_amount),
    backingStrategy: arVoucher.backing_strategy as BackingStrategy,
    status: arVoucher.status as VoucherStatus,
    expiresAt: arVoucher.expires_at,
    createdAt: arVoucher.created_at,
    issuerId: arVoucher.issuer_id,
    issuerName: (arVoucher.merchant_metadata as MerchantMetadata | undefined)?.merchantName,
    merchantMetadata: arVoucher.merchant_metadata as MerchantMetadata | undefined,
    mintUrl: arVoucher.mint_url,
    memo: arVoucher.memo,
    senderPubkey: arVoucher.sender_pubkey,
    synced: false,
  };
}