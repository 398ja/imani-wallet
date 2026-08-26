/**
 * VoucherGrouper - Fluent builder for grouping and aggregating vouchers
 *
 * Provides a chainable API for building complex voucher grouping operations.
 */

import type {
  VoucherFilter,
  GroupByField,
  AggregationType,
  GroupSortField,
  GroupOptions,
  GroupResult,
  VoucherGroup,
} from '../types';
import {
  VoucherStatus,
  generateGroupKey,
  createEmptyGroup,
  addVoucherToGroup,
  finalizeGroup,
  sortGroups,
  normalizeFilter,
  matchesFilter,
  DEFAULT_GROUP_OPTIONS,
} from '../types';
import type { VoucherStore } from '../store';

/**
 * Fluent builder for grouping vouchers
 */
export class VoucherGrouper {
  private store: VoucherStore;
  private options: GroupOptions;

  constructor(store: VoucherStore) {
    this.store = store;
    this.options = {
      groupBy: 'issuerId',
      ...DEFAULT_GROUP_OPTIONS,
    };
  }

  // ==========================================
  // Group By Configuration
  // ==========================================

  /**
   * Group by issuer (merchant)
   */
  byIssuer(): this {
    this.options.groupBy = 'issuerId';
    return this;
  }

  /**
   * Group by currency
   */
  byCurrency(): this {
    this.options.groupBy = 'faceUnit';
    return this;
  }

  /**
   * Group by backing strategy
   */
  byBackingStrategy(): this {
    this.options.groupBy = 'backingStrategy';
    return this;
  }

  /**
   * Group by issuance ratio
   */
  byIssuanceRatio(): this {
    this.options.groupBy = 'issuanceRatio';
    return this;
  }

  /**
   * Group by wallet
   */
  byWallet(): this {
    this.options.groupBy = 'walletId';
    return this;
  }

  /**
   * Group by multiple fields
   */
  by(...fields: GroupByField[]): this {
    this.options.groupBy = fields.length === 1 ? fields[0] : fields;
    return this;
  }

  // ==========================================
  // Pre-filters
  // ==========================================

  /**
   * Apply a filter before grouping
   */
  filter(filter: VoucherFilter): this {
    this.options.filter = { ...this.options.filter, ...filter };
    return this;
  }

  /**
   * Only include active vouchers
   */
  activeOnly(): this {
    this.options.filter = {
      ...this.options.filter,
      status: VoucherStatus.ACTIVE,
      includeExpired: false,
    };
    return this;
  }

  /**
   * Only include vouchers from a specific issuer
   */
  fromIssuer(issuerId: string): this {
    this.options.filter = { ...this.options.filter, issuerId };
    return this;
  }

  /**
   * Only include vouchers with a specific currency
   */
  withCurrency(faceUnit: string): this {
    this.options.filter = { ...this.options.filter, faceUnit };
    return this;
  }

  /**
   * Only include vouchers expiring within N days
   */
  expiringWithin(days: number): this {
    this.options.filter = { ...this.options.filter, expiringWithin: days };
    return this;
  }

  // ==========================================
  // Aggregation Configuration
  // ==========================================

  /**
   * Include all aggregations
   */
  withAllAggregations(): this {
    this.options.aggregations = [
      'totalFaceValue',
      'totalTokenAmount',
      'count',
      'minExpiry',
      'maxExpiry',
      'avgFaceValue',
      'avgTokenAmount',
    ];
    return this;
  }

  /**
   * Include specific aggregations
   */
  withAggregations(...aggregations: AggregationType[]): this {
    this.options.aggregations = aggregations;
    return this;
  }

  /**
   * Include vouchers in results
   */
  includeVouchers(include: boolean = true): this {
    this.options.includeVouchers = include;
    return this;
  }

  // ==========================================
  // Sorting
  // ==========================================

  /**
   * Sort groups by field
   */
  sortBy(field: GroupSortField, order: 'asc' | 'desc' = 'desc'): this {
    this.options.sortGroupsBy = field;
    this.options.sortOrder = order;
    return this;
  }

  /**
   * Sort by total face value (highest first)
   */
  sortByValue(): this {
    this.options.sortGroupsBy = 'totalFaceValue';
    this.options.sortOrder = 'desc';
    return this;
  }

  /**
   * Sort by count (highest first)
   */
  sortByCount(): this {
    this.options.sortGroupsBy = 'count';
    this.options.sortOrder = 'desc';
    return this;
  }

  /**
   * Sort by name (alphabetically)
   */
  sortByName(): this {
    this.options.sortGroupsBy = 'name';
    this.options.sortOrder = 'asc';
    return this;
  }

  /**
   * Sort by expiry (soonest first)
   */
  sortByExpiry(): this {
    this.options.sortGroupsBy = 'minExpiry';
    this.options.sortOrder = 'asc';
    return this;
  }

  // ==========================================
  // Limits
  // ==========================================

  /**
   * Limit number of groups returned
   */
  limit(count: number): this {
    this.options.limit = count;
    return this;
  }

  /**
   * Get top N groups by value
   */
  top(count: number): this {
    this.options.limit = count;
    this.options.sortGroupsBy = 'totalFaceValue';
    this.options.sortOrder = 'desc';
    return this;
  }

  // ==========================================
  // Execution
  // ==========================================

  /**
   * Execute the grouping operation
   */
  async execute(): Promise<GroupResult> {
    // Get all vouchers
    const allVouchers = await this.store.getAll();

    // Apply filter if provided
    const filter = this.options.filter;
    const normalizedFilter = filter ? normalizeFilter(filter) : null;
    const vouchers = normalizedFilter
      ? allVouchers.filter((v) => matchesFilter(v, normalizedFilter))
      : allVouchers;

    // Normalize groupBy to array
    const groupByFields = Array.isArray(this.options.groupBy)
      ? this.options.groupBy
      : [this.options.groupBy];

    // Group vouchers
    const groupMap = new Map<string, VoucherGroup>();

    for (const voucher of vouchers) {
      const key = generateGroupKey(voucher, groupByFields);

      if (!groupMap.has(key)) {
        groupMap.set(key, createEmptyGroup(key));
      }

      const group = groupMap.get(key)!;
      addVoucherToGroup(
        group,
        voucher,
        groupByFields,
        this.options.includeVouchers ?? false
      );
    }

    // Finalize groups (calculate averages)
    const aggregations = this.options.aggregations ?? DEFAULT_GROUP_OPTIONS.aggregations;
    for (const group of groupMap.values()) {
      finalizeGroup(group, aggregations);
    }

    // Sort groups
    const sortBy = this.options.sortGroupsBy ?? DEFAULT_GROUP_OPTIONS.sortGroupsBy;
    const sortOrder = this.options.sortOrder ?? DEFAULT_GROUP_OPTIONS.sortOrder;
    let groups = sortGroups(Array.from(groupMap.values()), sortBy, sortOrder);

    // Apply limit
    if (this.options.limit && this.options.limit > 0) {
      groups = groups.slice(0, this.options.limit);
    }

    // Calculate totals
    const totalFaceValueByCurrency: Record<string, number> = {};
    let totalTokenAmount = 0;

    for (const voucher of vouchers) {
      totalFaceValueByCurrency[voucher.faceUnit] =
        (totalFaceValueByCurrency[voucher.faceUnit] ?? 0) + voucher.faceValue;
      totalTokenAmount += voucher.tokenAmount;
    }

    return {
      groups,
      totalVouchers: vouchers.length,
      totalFaceValueByCurrency,
      totalTokenAmount,
    };
  }

  /**
   * Execute and return just the groups array
   */
  async get(): Promise<VoucherGroup[]> {
    const result = await this.execute();
    return result.groups;
  }

  /**
   * Get the current options object
   */
  getOptions(): GroupOptions {
    return { ...this.options };
  }

  /**
   * Reset options
   */
  reset(): this {
    this.options = {
      groupBy: 'issuerId',
      ...DEFAULT_GROUP_OPTIONS,
    };
    return this;
  }

  /**
   * Clone this grouper
   */
  clone(): VoucherGrouper {
    const cloned = new VoucherGrouper(this.store);
    cloned.options = { ...this.options };
    return cloned;
  }
}

/**
 * Create a new VoucherGrouper instance
 */
export function createVoucherGrouper(store: VoucherStore): VoucherGrouper {
  return new VoucherGrouper(store);
}

// ==========================================
// Convenience Functions
// ==========================================

/**
 * Group vouchers by issuer and return summary
 */
export async function groupByIssuer(store: VoucherStore): Promise<GroupResult> {
  return new VoucherGrouper(store).byIssuer().activeOnly().execute();
}

/**
 * Group vouchers by currency and return summary
 */
export async function groupByCurrency(store: VoucherStore): Promise<GroupResult> {
  return new VoucherGrouper(store).byCurrency().activeOnly().execute();
}

/**
 * Group vouchers by backing strategy and return summary
 */
export async function groupByBackingStrategy(store: VoucherStore): Promise<GroupResult> {
  return new VoucherGrouper(store).byBackingStrategy().activeOnly().execute();
}

/**
 * Get top issuers by total value
 */
export async function getTopIssuers(
  store: VoucherStore,
  limit: number = 5
): Promise<VoucherGroup[]> {
  return new VoucherGrouper(store)
    .byIssuer()
    .activeOnly()
    .sortByValue()
    .limit(limit)
    .get();
}

/**
 * Get expiring vouchers grouped by issuer
 */
export async function getExpiringByIssuer(
  store: VoucherStore,
  days: number = 7
): Promise<GroupResult> {
  return new VoucherGrouper(store)
    .byIssuer()
    .activeOnly()
    .expiringWithin(days)
    .sortByExpiry()
    .includeVouchers()
    .execute();
}
