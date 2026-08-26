/**
 * Filter and query types for transactions
 */

import type { Transaction, TransactionType, TransactionDirection } from './transaction';

/**
 * Query options for filtering transactions
 */
export interface TransactionFilter {
  // Type filtering
  type?: TransactionType | TransactionType[];
  direction?: TransactionDirection | TransactionDirection[];

  // Party filtering
  counterparty?: string; // Filter by counterparty pubkey
  issuerId?: string; // Filter by issuer/merchant
  walletId?: string; // Filter by wallet

  // Time filtering
  fromTimestamp?: number; // Start of date range (inclusive)
  toTimestamp?: number; // End of date range (inclusive)

  // Value filtering
  minAmount?: number; // Minimum face value
  maxAmount?: number; // Maximum face value
  unit?: string; // Filter by currency

  // Sync filtering
  synced?: boolean; // Filter by sync status

  // Text search
  searchText?: string; // Search in memo/names

  // Pagination & sorting
  limit?: number; // Max results (default: 50)
  offset?: number; // Skip N results
  sortBy?: 'timestamp' | 'amount' | 'faceValue'; // Sort field
  sortOrder?: 'asc' | 'desc'; // Sort direction (default: desc)
}

/**
 * Query result with pagination metadata
 */
export interface TransactionQueryResult {
  transactions: Transaction[];
  total: number; // Total matching count
  hasMore: boolean; // More results available
  offset: number; // Current offset
  limit: number; // Applied limit
}

/**
 * Sort configuration
 */
export interface SortConfig {
  field: 'timestamp' | 'amount' | 'faceValue';
  order: 'asc' | 'desc';
}

/**
 * Default filter values
 */
export const DEFAULT_FILTER: Required<Pick<TransactionFilter, 'limit' | 'offset' | 'sortBy' | 'sortOrder'>> = {
  limit: 50,
  offset: 0,
  sortBy: 'timestamp',
  sortOrder: 'desc',
};

/**
 * Normalize filter with defaults
 */
export function normalizeFilter(filter: TransactionFilter): TransactionFilter & typeof DEFAULT_FILTER {
  return {
    ...DEFAULT_FILTER,
    ...filter,
  };
}

/**
 * Check if a transaction matches a filter
 */
export function matchesFilter(tx: Transaction, filter: TransactionFilter): boolean {
  // Type filter
  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(tx.type)) {
      return false;
    }
  }

  // Direction filter
  if (filter.direction !== undefined) {
    const directions = Array.isArray(filter.direction) ? filter.direction : [filter.direction];
    if (!directions.includes(tx.direction)) {
      return false;
    }
  }

  // Counterparty filter
  if (filter.counterparty !== undefined && tx.counterparty !== filter.counterparty) {
    return false;
  }

  // Issuer filter
  if (filter.issuerId !== undefined && tx.issuerId !== filter.issuerId) {
    return false;
  }

  // Wallet filter
  if (filter.walletId !== undefined && tx.walletId !== filter.walletId) {
    return false;
  }

  // Time range filter
  if (filter.fromTimestamp !== undefined && tx.timestamp < filter.fromTimestamp) {
    return false;
  }
  if (filter.toTimestamp !== undefined && tx.timestamp > filter.toTimestamp) {
    return false;
  }

  // Amount filter
  if (filter.minAmount !== undefined && tx.faceValue < filter.minAmount) {
    return false;
  }
  if (filter.maxAmount !== undefined && tx.faceValue > filter.maxAmount) {
    return false;
  }

  // Unit filter
  if (filter.unit !== undefined && tx.faceUnit !== filter.unit) {
    return false;
  }

  // Sync filter
  if (filter.synced !== undefined && tx.synced !== filter.synced) {
    return false;
  }

  // Text search
  if (filter.searchText !== undefined) {
    const searchLower = filter.searchText.toLowerCase();
    const searchable = [
      tx.memo,
      tx.issuerName,
      tx.counterpartyName,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (!searchable.includes(searchLower)) {
      return false;
    }
  }

  return true;
}

/**
 * Sort transactions based on sort config
 */
export function sortTransactions(
  transactions: Transaction[],
  sortBy: 'timestamp' | 'amount' | 'faceValue' = 'timestamp',
  sortOrder: 'asc' | 'desc' = 'desc'
): Transaction[] {
  const sorted = [...transactions];

  sorted.sort((a, b) => {
    let comparison: number;

    switch (sortBy) {
      case 'timestamp':
        comparison = a.timestamp - b.timestamp;
        break;
      case 'amount':
        comparison = a.tokenAmount - b.tokenAmount;
        break;
      case 'faceValue':
        comparison = a.faceValue - b.faceValue;
        break;
      default:
        comparison = a.timestamp - b.timestamp;
    }

    return sortOrder === 'desc' ? -comparison : comparison;
  });

  return sorted;
}

/**
 * Apply pagination to a transaction list
 */
export function paginateTransactions(
  transactions: Transaction[],
  offset: number = 0,
  limit: number = 50
): { transactions: Transaction[]; hasMore: boolean } {
  const paginated = transactions.slice(offset, offset + limit);
  const hasMore = offset + limit < transactions.length;
  return { transactions: paginated, hasMore };
}
