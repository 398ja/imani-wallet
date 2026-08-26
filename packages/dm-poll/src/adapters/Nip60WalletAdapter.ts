/**
 * Nip60WalletAdapter - Interface for NIP-60 wallet transaction recording
 *
 * Optional adapter for recording transactions in NIP-60 wallet state.
 */

import type { Transaction } from '../types/voucher';

/**
 * Adapter for NIP-60 wallet operations
 */
export interface Nip60WalletAdapter {
  /**
   * Record a transaction
   *
   * @param tx - Transaction to record
   */
  recordTransaction(tx: Transaction): Promise<void>;

  /**
   * Get transaction history
   *
   * @param limit - Maximum number of transactions to return
   * @returns Array of transactions
   */
  getTransactions?(limit?: number): Promise<Transaction[]>;

  /**
   * Sync wallet state to relay
   */
  sync?(): Promise<void>;
}

/**
 * Type guard to check if an object implements Nip60WalletAdapter
 */
export function isNip60WalletAdapter(obj: unknown): obj is Nip60WalletAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const adapter = obj as Nip60WalletAdapter;
  return typeof adapter.recordTransaction === 'function';
}
