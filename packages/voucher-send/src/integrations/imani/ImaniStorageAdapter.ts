/**
 * ImaniStorageAdapter
 *
 * Adapts the Imani storage.js functions to the StorageAdapter interface.
 * Wraps existing localStorage-based storage for use with VoucherSender.
 */

import type { StorageAdapter, VoucherFilter } from '../../adapters';
import type { Voucher, Transaction, TransactionInput, BackingStrategy, VoucherStatus } from '../../types';

/**
 * Imani storage functions interface (from shared/storage.js)
 */
export interface ImaniStorageFunctions {
  getVouchers: (migrate?: boolean) => ImaniVoucher[];
  getVoucher: (voucherId: string) => ImaniVoucher | null;
  saveVoucher: (voucher: ImaniVoucher, normalize?: boolean, skipSync?: boolean) => void;
  deleteVoucher: (voucherId: string) => void;
  updateVoucherAfterSplit: (voucherId: string, splitResult: ImaniSplitResult) => void;
  addTransaction: (tx: ImaniTransactionInput) => void;
  getTransactions: (limit?: number | null) => ImaniTransaction[];
  groupVouchersByMerchant?: () => Record<string, ImaniMerchantGroup>;
}

/**
 * Imani voucher format (from storage.js)
 */
export interface ImaniVoucher {
  voucher_id: string;
  token?: string;
  face_value?: number;
  face_unit?: string;
  face_decimals?: number;
  token_amount?: number;
  token_unit?: string;
  issuance_ratio?: number;
  backing_strategy?: string;
  rounding_mode?: string;
  status?: string;
  expires_at?: string;
  created_at?: string;
  updated_at?: string;
  issuer_id?: string;
  merchant_metadata?: {
    merchant_name?: string;
    name?: string;
    [key: string]: unknown;
  };
  balance?: number;
  _needs_refresh?: boolean;
}

export interface ImaniSplitResult {
  keep_token?: string;
  keep_face_value?: number;
  keep_token_amount?: number;
  rounding_mode?: string;
}

export interface ImaniTransactionInput {
  type: string;
  amount?: number;
  unit?: string;
  decimals?: number;
  merchantName?: string | null;
  merchantId?: string | null;
  counterparty?: string | null;
  voucherId?: string;
  memo?: string | null;
}

export interface ImaniTransaction {
  id: string;
  type: string;
  direction?: string;
  amount?: number;
  unit?: string;
  decimals?: number;
  merchantName?: string;
  merchantId?: string;
  counterparty?: string;
  voucherId?: string;
  memo?: string;
  timestamp?: string;
  created_at?: string;
}

export interface ImaniMerchantGroup {
  groupKey: string;
  merchantId: string;
  merchantName: string;
  vouchers: ImaniVoucher[];
  totalFaceValue: number;
  totalTokenAmount: number;
  unit: string;
  decimals: number;
}

/**
 * ImaniStorageAdapter configuration
 */
export interface ImaniStorageAdapterConfig {
  /** Storage functions object (window globals in browser) */
  storage: ImaniStorageFunctions;
}

/**
 * ImaniStorageAdapter
 *
 * Adapts the Imani storage.js functions to the voucher-send StorageAdapter interface.
 */
export class ImaniStorageAdapter implements StorageAdapter {
  private storage: ImaniStorageFunctions;

  constructor(config: ImaniStorageAdapterConfig) {
    this.storage = config.storage;
  }

  /**
   * Get all vouchers, optionally filtered
   */
  getVouchers(filter?: VoucherFilter): Voucher[] {
    let vouchers = this.storage.getVouchers(true);

    // Apply filters
    if (filter?.status) {
      vouchers = vouchers.filter((v) => v.status === filter.status);
    }
    if (filter?.merchantId) {
      vouchers = vouchers.filter((v) => v.issuer_id === filter.merchantId);
    }
    if (filter?.unit) {
      vouchers = vouchers.filter((v) => v.face_unit === filter.unit);
    }
    if (filter?.minFaceValue != null) {
      vouchers = vouchers.filter((v) => (v.face_value ?? 0) >= filter.minFaceValue!);
    }

    return vouchers.map((v) => this.mapToVoucher(v));
  }

  /**
   * Get a single voucher by ID
   */
  getVoucher(voucherId: string): Voucher | null {
    const voucher = this.storage.getVoucher(voucherId);
    return voucher ? this.mapToVoucher(voucher) : null;
  }

  /**
   * Save or update a voucher
   */
  saveVoucher(voucher: Voucher): void {
    const imaniVoucher = this.mapToImaniVoucher(voucher);
    this.storage.saveVoucher(imaniVoucher, true, false);
  }

  /**
   * Remove a voucher
   */
  removeVoucher(voucherId: string): void {
    this.storage.deleteVoucher(voucherId);
  }

  /**
   * Update a voucher's properties
   */
  updateVoucher(voucherId: string, updates: Partial<Voucher>): void {
    const voucher = this.storage.getVoucher(voucherId);
    if (voucher) {
      const updated = { ...this.mapToVoucher(voucher), ...updates };
      this.storage.saveVoucher(this.mapToImaniVoucher(updated), false, false);
    }
  }

  /**
   * Update voucher after split operation
   */
  updateAfterSplit(
    voucherId: string,
    keepToken: string,
    keepFaceValue: number,
    keepTokenAmount: number
  ): void {
    this.storage.updateVoucherAfterSplit(voucherId, {
      keep_token: keepToken,
      keep_face_value: keepFaceValue,
      keep_token_amount: keepTokenAmount,
    });
  }

  /**
   * Add a transaction record
   */
  addTransaction(transaction: TransactionInput): void {
    const imaniTx: ImaniTransactionInput = {
      type: transaction.type === 'voucher_sent' ? 'sent' : transaction.type,
      amount: transaction.faceValue,
      unit: transaction.faceUnit,
      decimals: transaction.faceDecimals,
      merchantName: transaction.issuerName ?? null,
      merchantId: transaction.issuerId ?? null,
      counterparty: transaction.counterparty ?? null,
      voucherId: transaction.voucherId,
      memo: transaction.memo ?? null,
    };
    this.storage.addTransaction(imaniTx);
  }

  /**
   * Get transaction history
   */
  getTransactions(limit?: number): Transaction[] {
    const transactions = this.storage.getTransactions(limit ?? null);
    return transactions.map((tx) => this.mapToTransaction(tx));
  }

  /**
   * Map Imani voucher to library Voucher type
   */
  private mapToVoucher(v: ImaniVoucher): Voucher {
    return {
      voucher_id: v.voucher_id,
      token: v.token ?? '',
      face_value: v.face_value ?? 0,
      face_unit: v.face_unit ?? 'SAT',
      face_decimals: v.face_decimals ?? 0,
      token_amount: v.token_amount ?? 0,
      backing_strategy: (v.backing_strategy as BackingStrategy) ?? 'LEGACY',
      issuer_id: v.issuer_id,
      status: (v.status as VoucherStatus) ?? 'active',
      merchant_metadata: v.merchant_metadata
        ? {
            merchant_name: v.merchant_metadata.merchant_name ?? v.merchant_metadata.name,
          }
        : undefined,
    };
  }

  /**
   * Map library Voucher to Imani voucher format
   */
  private mapToImaniVoucher(v: Voucher): ImaniVoucher {
    return {
      voucher_id: v.voucher_id,
      token: v.token,
      face_value: v.face_value,
      face_unit: v.face_unit,
      face_decimals: v.face_decimals,
      token_amount: v.token_amount,
      backing_strategy: v.backing_strategy,
      issuer_id: v.issuer_id,
      status: v.status,
      merchant_metadata: v.merchant_metadata,
    };
  }

  /**
   * Map Imani transaction to library Transaction type
   */
  private mapToTransaction(tx: ImaniTransaction): Transaction {
    return {
      id: tx.id,
      type: tx.type === 'sent' ? 'voucher_sent' : (tx.type as Transaction['type']),
      direction: tx.direction === 'out' || tx.type === 'sent' ? 'out' : 'in',
      faceValue: tx.amount ?? 0,
      faceUnit: tx.unit ?? 'SAT',
      faceDecimals: tx.decimals ?? 0,
      issuerId: tx.merchantId,
      counterparty: tx.counterparty,
      counterpartyName: tx.counterparty,
      memo: tx.memo,
      timestamp: tx.timestamp ?? tx.created_at ?? new Date().toISOString(),
    };
  }
}

/**
 * Create an ImaniStorageAdapter from storage functions
 *
 * @example
 * // In browser, pass window globals
 * const storage = createImaniStorageAdapter({
 *   getVouchers,
 *   getVoucher,
 *   saveVoucher,
 *   deleteVoucher,
 *   updateVoucherAfterSplit,
 *   addTransaction,
 *   getTransactions,
 * });
 */
export function createImaniStorageAdapter(
  storage: ImaniStorageFunctions
): ImaniStorageAdapter {
  return new ImaniStorageAdapter({ storage });
}
