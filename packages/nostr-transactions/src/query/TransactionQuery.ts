/**
 * TransactionQuery - Fluent query builder for transactions
 *
 * Provides a chainable API for building complex transaction queries.
 *
 * @example
 * ```typescript
 * const query = new TransactionQuery(store)
 *   .type(TransactionType.RECEIVED)
 *   .from('2024-01-01')
 *   .to('2024-12-31')
 *   .counterparty('alice-pubkey')
 *   .minAmount(1000)
 *   .limit(50)
 *   .sortBy('amount', 'desc');
 *
 * const results = await query.execute();
 * ```
 */

import type {
  Transaction,
  TransactionFilter,
  TransactionQueryResult,
  TransactionStats,
} from '../types';
import { TransactionType, TransactionDirection } from '../types';
import type { TransactionStore } from '../store/TransactionStore';

/**
 * Fluent query builder for transactions
 */
export class TransactionQuery {
  private store: TransactionStore;
  private filter: TransactionFilter = {};

  constructor(store: TransactionStore) {
    this.store = store;
  }

  /**
   * Filter by transaction type(s)
   */
  type(type: TransactionType | TransactionType[]): this {
    this.filter.type = type;
    return this;
  }

  /**
   * Filter by received transactions only
   */
  received(): this {
    return this.type(TransactionType.RECEIVED);
  }

  /**
   * Filter by sent transactions only
   */
  sent(): this {
    return this.type(TransactionType.SENT);
  }

  /**
   * Filter by purchased transactions only
   */
  purchased(): this {
    return this.type(TransactionType.PURCHASED);
  }

  /**
   * Filter by direction(s)
   */
  direction(direction: TransactionDirection | TransactionDirection[]): this {
    this.filter.direction = direction;
    return this;
  }

  /**
   * Filter by incoming transactions only
   */
  incoming(): this {
    return this.direction(TransactionDirection.IN);
  }

  /**
   * Filter by outgoing transactions only
   */
  outgoing(): this {
    return this.direction(TransactionDirection.OUT);
  }

  /**
   * Filter by counterparty pubkey
   */
  counterparty(pubkey: string): this {
    this.filter.counterparty = pubkey;
    return this;
  }

  /**
   * Alias for counterparty
   */
  from(pubkeyOrDate: string): this {
    // If it looks like a date, treat it as fromTimestamp
    if (this.isDateLike(pubkeyOrDate)) {
      return this.fromDate(pubkeyOrDate);
    }
    return this.counterparty(pubkeyOrDate);
  }

  /**
   * Filter by issuer/merchant pubkey
   */
  issuer(pubkey: string): this {
    this.filter.issuerId = pubkey;
    return this;
  }

  /**
   * Filter by wallet ID
   */
  wallet(walletId: string): this {
    this.filter.walletId = walletId;
    return this;
  }

  /**
   * Filter by start date/timestamp
   */
  fromDate(date: string | number | Date): this {
    this.filter.fromTimestamp = this.toTimestamp(date);
    return this;
  }

  /**
   * Filter by end date/timestamp
   */
  toDate(date: string | number | Date): this {
    this.filter.toTimestamp = this.toTimestamp(date);
    return this;
  }

  /**
   * Alias for toDate
   */
  to(date: string | number | Date): this {
    return this.toDate(date);
  }

  /**
   * Filter by date range
   */
  between(from: string | number | Date, to: string | number | Date): this {
    this.filter.fromTimestamp = this.toTimestamp(from);
    this.filter.toTimestamp = this.toTimestamp(to);
    return this;
  }

  /**
   * Filter transactions from today
   */
  today(): this {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
    return this.between(startOfDay, endOfDay);
  }

  /**
   * Filter transactions from this week
   */
  thisWeek(): this {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    startOfWeek.setHours(0, 0, 0, 0);
    return this.fromDate(startOfWeek);
  }

  /**
   * Filter transactions from this month
   */
  thisMonth(): this {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return this.fromDate(startOfMonth);
  }

  /**
   * Filter transactions from the last N days
   */
  lastDays(days: number): this {
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return this.fromDate(start);
  }

  /**
   * Filter by minimum face value
   */
  minAmount(amount: number): this {
    this.filter.minAmount = amount;
    return this;
  }

  /**
   * Filter by maximum face value
   */
  maxAmount(amount: number): this {
    this.filter.maxAmount = amount;
    return this;
  }

  /**
   * Filter by amount range
   */
  amountBetween(min: number, max: number): this {
    this.filter.minAmount = min;
    this.filter.maxAmount = max;
    return this;
  }

  /**
   * Filter by currency unit
   */
  unit(unit: string): this {
    this.filter.unit = unit;
    return this;
  }

  /**
   * Filter by sync status
   */
  synced(synced: boolean = true): this {
    this.filter.synced = synced;
    return this;
  }

  /**
   * Filter by unsynced status
   */
  unsynced(): this {
    return this.synced(false);
  }

  /**
   * Search by text in memo/names
   */
  search(text: string): this {
    this.filter.searchText = text;
    return this;
  }

  /**
   * Set result limit
   */
  limit(count: number): this {
    this.filter.limit = count;
    return this;
  }

  /**
   * Set result offset
   */
  offset(count: number): this {
    this.filter.offset = count;
    return this;
  }

  /**
   * Skip N results (alias for offset)
   */
  skip(count: number): this {
    return this.offset(count);
  }

  /**
   * Take N results (alias for limit)
   */
  take(count: number): this {
    return this.limit(count);
  }

  /**
   * Set page for pagination
   */
  page(pageNumber: number, pageSize: number = 50): this {
    this.filter.offset = (pageNumber - 1) * pageSize;
    this.filter.limit = pageSize;
    return this;
  }

  /**
   * Set sort field and order
   */
  sortBy(field: 'timestamp' | 'amount' | 'faceValue', order: 'asc' | 'desc' = 'desc'): this {
    this.filter.sortBy = field;
    this.filter.sortOrder = order;
    return this;
  }

  /**
   * Sort by timestamp descending (newest first)
   */
  newest(): this {
    return this.sortBy('timestamp', 'desc');
  }

  /**
   * Sort by timestamp ascending (oldest first)
   */
  oldest(): this {
    return this.sortBy('timestamp', 'asc');
  }

  /**
   * Sort by amount descending (largest first)
   */
  largest(): this {
    return this.sortBy('faceValue', 'desc');
  }

  /**
   * Sort by amount ascending (smallest first)
   */
  smallest(): this {
    return this.sortBy('faceValue', 'asc');
  }

  /**
   * Get the current filter
   */
  getFilter(): TransactionFilter {
    return { ...this.filter };
  }

  /**
   * Reset the query builder
   */
  reset(): this {
    this.filter = {};
    return this;
  }

  /**
   * Clone the query builder
   */
  clone(): TransactionQuery {
    const query = new TransactionQuery(this.store);
    query.filter = { ...this.filter };
    return query;
  }

  /**
   * Execute the query and return results
   */
  async execute(): Promise<TransactionQueryResult> {
    return this.store.query(this.filter);
  }

  /**
   * Execute and return just the transactions
   */
  async get(): Promise<Transaction[]> {
    const result = await this.execute();
    return result.transactions;
  }

  /**
   * Execute and return the first matching transaction
   */
  async first(): Promise<Transaction | null> {
    const originalLimit = this.filter.limit;
    this.filter.limit = 1;
    const result = await this.execute();
    this.filter.limit = originalLimit;
    return result.transactions[0] ?? null;
  }

  /**
   * Execute and return just the count
   */
  async count(): Promise<number> {
    return this.store.count(this.filter);
  }

  /**
   * Check if any transactions match
   */
  async exists(): Promise<boolean> {
    const count = await this.count();
    return count > 0;
  }

  /**
   * Get statistics for matching transactions
   */
  async stats(): Promise<TransactionStats> {
    return this.store.getStats(this.filter);
  }

  // ==================== Private Helpers ====================

  /**
   * Convert date input to Unix timestamp (seconds)
   */
  private toTimestamp(date: string | number | Date): number {
    if (typeof date === 'number') {
      // Already a timestamp - if in ms, convert to seconds
      return date > 1e12 ? Math.floor(date / 1000) : date;
    }
    if (date instanceof Date) {
      return Math.floor(date.getTime() / 1000);
    }
    // String - parse as date
    return Math.floor(new Date(date).getTime() / 1000);
  }

  /**
   * Check if a string looks like a date
   */
  private isDateLike(str: string): boolean {
    // Check for common date patterns: YYYY-MM-DD, MM/DD/YYYY, etc.
    return /^\d{4}-\d{2}-\d{2}/.test(str) || /^\d{2}\/\d{2}\/\d{4}/.test(str);
  }
}

/**
 * Create a new query builder
 */
export function createQuery(store: TransactionStore): TransactionQuery {
  return new TransactionQuery(store);
}
