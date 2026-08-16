/**
 * VoucherQuery - Fluent query builder for vouchers
 *
 * Provides a chainable API for building complex voucher queries.
 */

import type {
  Voucher,
  VoucherFilter,
  VoucherQueryResult,
  VoucherSortField,
} from '../types';
import { VoucherStatus, BackingStrategy } from '../types';
import type { VoucherStore } from '../store';

/**
 * Fluent query builder for vouchers
 */
export class VoucherQuery {
  private store: VoucherStore;
  private filter: VoucherFilter = {};

  constructor(store: VoucherStore) {
    this.store = store;
  }

  // ==========================================
  // Status Filters
  // ==========================================

  /**
   * Filter by status
   */
  status(status: VoucherStatus | VoucherStatus[]): this {
    this.filter.status = status;
    return this;
  }

  /**
   * Filter to only active vouchers
   */
  active(): this {
    this.filter.status = VoucherStatus.ACTIVE;
    this.filter.includeExpired = false;
    return this;
  }

  /**
   * Filter to only spent vouchers
   */
  spent(): this {
    this.filter.status = VoucherStatus.SPENT;
    return this;
  }

  /**
   * Filter to only expired vouchers
   */
  expired(): this {
    this.filter.status = VoucherStatus.EXPIRED;
    return this;
  }

  /**
   * Include expired vouchers in results
   */
  includeExpired(include: boolean = true): this {
    this.filter.includeExpired = include;
    return this;
  }

  // ==========================================
  // Entity Filters
  // ==========================================

  /**
   * Filter by issuer ID
   */
  issuer(issuerId: string): this {
    this.filter.issuerId = issuerId;
    return this;
  }

  /**
   * Filter by currency
   */
  currency(faceUnit: string): this {
    this.filter.faceUnit = faceUnit;
    return this;
  }

  /**
   * Filter by backing strategy
   */
  backingStrategy(strategy: BackingStrategy | BackingStrategy[]): this {
    this.filter.backingStrategy = strategy;
    return this;
  }

  // ==========================================
  // Value Filters
  // ==========================================

  /**
   * Filter by minimum face value
   */
  minValue(value: number): this {
    this.filter.minFaceValue = value;
    return this;
  }

  /**
   * Filter by maximum face value
   */
  maxValue(value: number): this {
    this.filter.maxFaceValue = value;
    return this;
  }

  /**
   * Filter by value range
   */
  valueRange(min: number, max: number): this {
    this.filter.minFaceValue = min;
    this.filter.maxFaceValue = max;
    return this;
  }

  /**
   * Filter by minimum token amount
   */
  minTokens(amount: number): this {
    this.filter.minTokenAmount = amount;
    return this;
  }

  /**
   * Filter by maximum token amount
   */
  maxTokens(amount: number): this {
    this.filter.maxTokenAmount = amount;
    return this;
  }

  // ==========================================
  // Date Filters
  // ==========================================

  /**
   * Filter by creation date range
   */
  createdBetween(from: Date | string, to: Date | string): this {
    this.filter.createdAfter = typeof from === 'string' ? from : from.toISOString();
    this.filter.createdBefore = typeof to === 'string' ? to : to.toISOString();
    return this;
  }

  /**
   * Filter by vouchers created after a date
   */
  createdAfter(date: Date | string): this {
    this.filter.createdAfter = typeof date === 'string' ? date : date.toISOString();
    return this;
  }

  /**
   * Filter by vouchers created before a date
   */
  createdBefore(date: Date | string): this {
    this.filter.createdBefore = typeof date === 'string' ? date : date.toISOString();
    return this;
  }

  /**
   * Filter by vouchers expiring within N days
   */
  expiringWithin(days: number): this {
    this.filter.expiringWithin = days;
    return this;
  }

  /**
   * Filter by expiration date range
   */
  expiresBetween(from: Date | string, to: Date | string): this {
    this.filter.expiresAfter = typeof from === 'string' ? from : from.toISOString();
    this.filter.expiresBefore = typeof to === 'string' ? to : to.toISOString();
    return this;
  }

  // ==========================================
  // Sync Filters
  // ==========================================

  /**
   * Filter to only unsynced vouchers
   */
  unsynced(): this {
    this.filter.synced = false;
    return this;
  }

  /**
   * Filter to only synced vouchers
   */
  synced(): this {
    this.filter.synced = true;
    return this;
  }

  // ==========================================
  // Text Search
  // ==========================================

  /**
   * Search by text (matches memo, merchant name, sender name)
   */
  search(text: string): this {
    this.filter.searchText = text;
    return this;
  }

  // ==========================================
  // Sorting
  // ==========================================

  /**
   * Sort by field
   */
  sortBy(field: VoucherSortField, order: 'asc' | 'desc' = 'desc'): this {
    this.filter.sortBy = field;
    this.filter.sortOrder = order;
    return this;
  }

  /**
   * Sort by creation date (newest first)
   */
  newest(): this {
    this.filter.sortBy = 'createdAt';
    this.filter.sortOrder = 'desc';
    return this;
  }

  /**
   * Sort by creation date (oldest first)
   */
  oldest(): this {
    this.filter.sortBy = 'createdAt';
    this.filter.sortOrder = 'asc';
    return this;
  }

  /**
   * Sort by face value (highest first)
   */
  highestValue(): this {
    this.filter.sortBy = 'faceValue';
    this.filter.sortOrder = 'desc';
    return this;
  }

  /**
   * Sort by face value (lowest first)
   */
  lowestValue(): this {
    this.filter.sortBy = 'faceValue';
    this.filter.sortOrder = 'asc';
    return this;
  }

  /**
   * Sort by expiry date (soonest first)
   */
  expiringFirst(): this {
    this.filter.sortBy = 'expiresAt';
    this.filter.sortOrder = 'asc';
    return this;
  }

  // ==========================================
  // Pagination
  // ==========================================

  /**
   * Limit results
   */
  limit(count: number): this {
    this.filter.limit = count;
    return this;
  }

  /**
   * Skip results (offset)
   */
  offset(count: number): this {
    this.filter.offset = count;
    return this;
  }

  /**
   * Paginate results
   */
  page(pageNumber: number, pageSize: number = 20): this {
    this.filter.offset = (pageNumber - 1) * pageSize;
    this.filter.limit = pageSize;
    return this;
  }

  // ==========================================
  // Execution
  // ==========================================

  /**
   * Execute the query and return results
   */
  async execute(): Promise<VoucherQueryResult> {
    return this.store.query(this.filter);
  }

  /**
   * Execute and return just the vouchers array
   */
  async get(): Promise<Voucher[]> {
    const result = await this.execute();
    return result.vouchers;
  }

  /**
   * Execute and return the first voucher
   */
  async first(): Promise<Voucher | null> {
    this.filter.limit = 1;
    const result = await this.execute();
    return result.vouchers[0] ?? null;
  }

  /**
   * Execute and return the count
   */
  async count(): Promise<number> {
    const result = await this.execute();
    return result.total;
  }

  /**
   * Check if any vouchers match
   */
  async exists(): Promise<boolean> {
    this.filter.limit = 1;
    const result = await this.execute();
    return result.vouchers.length > 0;
  }

  /**
   * Get the current filter object
   */
  getFilter(): VoucherFilter {
    return { ...this.filter };
  }

  /**
   * Reset the filter
   */
  reset(): this {
    this.filter = {};
    return this;
  }

  /**
   * Clone this query
   */
  clone(): VoucherQuery {
    const cloned = new VoucherQuery(this.store);
    cloned.filter = { ...this.filter };
    return cloned;
  }
}

/**
 * Create a new VoucherQuery instance
 */
export function createVoucherQuery(store: VoucherStore): VoucherQuery {
  return new VoucherQuery(store);
}
