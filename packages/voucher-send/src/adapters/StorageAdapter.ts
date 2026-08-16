/**
 * Storage Adapter Interface
 *
 * Defines the interface for voucher storage operations.
 * Implementations can use localStorage, IndexedDB, or external services.
 */

import type { Voucher, TransactionInput } from '../types';

/**
 * Voucher filter options
 */
export interface VoucherFilter {
  /** Filter by status */
  status?: 'active' | 'spent' | 'expired';

  /** Filter by merchant ID */
  merchantId?: string;

  /** Filter by currency unit */
  unit?: string;

  /** Minimum face value */
  minFaceValue?: number;

  /** Maximum face value */
  maxFaceValue?: number;
}

/**
 * Storage Adapter Interface
 *
 * Implementations of this interface handle voucher persistence.
 */
export interface StorageAdapter {
  /**
   * Get all vouchers, optionally filtered
   *
   * @param filter - Optional filter criteria
   * @returns Array of vouchers
   */
  getVouchers(filter?: VoucherFilter): Voucher[] | Promise<Voucher[]>;

  /**
   * Get a single voucher by ID
   *
   * @param id - Voucher ID
   * @returns Voucher or null if not found
   */
  getVoucher(id: string): Voucher | null | Promise<Voucher | null>;

  /**
   * Save a voucher (create or update)
   *
   * @param voucher - Voucher to save
   */
  saveVoucher(voucher: Voucher): void | Promise<void>;

  /**
   * Remove a voucher
   *
   * @param id - Voucher ID to remove
   */
  removeVoucher(id: string): void | Promise<void>;

  /**
   * Update a voucher's properties
   *
   * @param id - Voucher ID
   * @param updates - Properties to update
   */
  updateVoucher(id: string, updates: Partial<Voucher>): void | Promise<void>;

  /**
   * Record a transaction
   *
   * @param transaction - Transaction to record
   */
  addTransaction(transaction: TransactionInput): void | Promise<void>;
}

/**
 * Type guard to check if an object implements StorageAdapter
 */
export function isStorageAdapter(obj: unknown): obj is StorageAdapter {
  if (typeof obj !== 'object' || obj === null) return false;
  const adapter = obj as Partial<StorageAdapter>;
  return (
    typeof adapter.getVouchers === 'function' &&
    typeof adapter.getVoucher === 'function' &&
    typeof adapter.saveVoucher === 'function' &&
    typeof adapter.removeVoucher === 'function' &&
    typeof adapter.updateVoucher === 'function' &&
    typeof adapter.addTransaction === 'function'
  );
}
