/**
 * Grouping and aggregation types for vouchers
 */

import type { Voucher } from './voucher';
import type { VoucherFilter } from './filter';
import { BackingStrategy } from './voucher';

/**
 * Fields available for grouping
 */
export type GroupByField = 'issuerId' | 'faceUnit' | 'backingStrategy' | 'issuanceRatio' | 'walletId';

/**
 * Aggregation types
 */
export type AggregationType =
  | 'totalFaceValue'
  | 'totalTokenAmount'
  | 'count'
  | 'minExpiry'
  | 'maxExpiry'
  | 'avgFaceValue'
  | 'avgTokenAmount';

/**
 * Fields to sort groups by
 */
export type GroupSortField = 'totalFaceValue' | 'totalTokenAmount' | 'count' | 'name' | 'minExpiry';

/**
 * Options for grouping vouchers
 */
export interface GroupOptions {
  /** Field(s) to group by */
  groupBy: GroupByField | GroupByField[];
  /** Pre-filter before grouping */
  filter?: VoucherFilter;
  /** Aggregations to calculate per group */
  aggregations?: AggregationType[];
  /** Sort groups by */
  sortGroupsBy?: GroupSortField;
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Limit number of groups */
  limit?: number;
  /** Include vouchers in results */
  includeVouchers?: boolean;
}

/**
 * Grouped voucher result
 */
export interface VoucherGroup {
  /** Unique group key */
  key: string;

  // ==========================================
  // Group Identifiers
  // ==========================================

  /** Merchant pubkey (if grouped by issuerId) */
  issuerId?: string;
  /** Merchant name (resolved) */
  issuerName?: string;
  /** Currency code (if grouped by faceUnit) */
  faceUnit?: string;
  /** Backing strategy (if grouped by backingStrategy) */
  backingStrategy?: BackingStrategy;
  /** Issuance ratio (if grouped by issuanceRatio) */
  issuanceRatio?: number;
  /** Wallet ID (if grouped by walletId) */
  walletId?: string;

  // ==========================================
  // Aggregations
  // ==========================================

  /** Total face value in group */
  totalFaceValue: number;
  /** Total token amount (sats) in group */
  totalTokenAmount: number;
  /** Number of vouchers in group */
  count: number;
  /** Earliest expiry date in group */
  minExpiry?: string;
  /** Latest expiry date in group */
  maxExpiry?: string;
  /** Average face value */
  avgFaceValue?: number;
  /** Average token amount */
  avgTokenAmount?: number;

  // ==========================================
  // Nested Data
  // ==========================================

  /** Vouchers in this group (if includeVouchers is true) */
  vouchers?: Voucher[];
}

/**
 * Result of grouping operation
 */
export interface GroupResult {
  /** Grouped vouchers */
  groups: VoucherGroup[];
  /** Total vouchers across all groups */
  totalVouchers: number;
  /** Total face value across all groups (by currency) */
  totalFaceValueByCurrency: Record<string, number>;
  /** Total token amount across all groups */
  totalTokenAmount: number;
}

/**
 * Default group options
 */
export const DEFAULT_GROUP_OPTIONS: Required<
  Pick<GroupOptions, 'aggregations' | 'sortGroupsBy' | 'sortOrder' | 'includeVouchers'>
> = {
  aggregations: ['totalFaceValue', 'totalTokenAmount', 'count', 'minExpiry'],
  sortGroupsBy: 'totalFaceValue',
  sortOrder: 'desc',
  includeVouchers: false,
};

/**
 * Generate a group key from voucher and group-by fields
 */
export function generateGroupKey(voucher: Voucher, groupBy: GroupByField[]): string {
  const parts: string[] = [];

  for (const field of groupBy) {
    switch (field) {
      case 'issuerId':
        parts.push(voucher.issuerId ?? 'unknown');
        break;
      case 'faceUnit':
        parts.push(voucher.faceUnit);
        break;
      case 'backingStrategy':
        parts.push(voucher.backingStrategy);
        break;
      case 'issuanceRatio':
        parts.push(voucher.issuanceRatio.toFixed(6));
        break;
      case 'walletId':
        parts.push(voucher.walletId ?? 'default');
        break;
    }
  }

  return parts.join('-');
}

/**
 * Create an empty group with default values
 */
export function createEmptyGroup(key: string): VoucherGroup {
  return {
    key,
    totalFaceValue: 0,
    totalTokenAmount: 0,
    count: 0,
  };
}

/**
 * Add a voucher to a group and update aggregations
 */
export function addVoucherToGroup(
  group: VoucherGroup,
  voucher: Voucher,
  groupBy: GroupByField[],
  includeVouchers: boolean
): void {
  // Update aggregations
  group.totalFaceValue += voucher.faceValue;
  group.totalTokenAmount += voucher.tokenAmount;
  group.count += 1;

  // Update min/max expiry
  if (voucher.expiresAt) {
    if (!group.minExpiry || voucher.expiresAt < group.minExpiry) {
      group.minExpiry = voucher.expiresAt;
    }
    if (!group.maxExpiry || voucher.expiresAt > group.maxExpiry) {
      group.maxExpiry = voucher.expiresAt;
    }
  }

  // Set group identifiers from first voucher
  if (group.count === 1) {
    for (const field of groupBy) {
      switch (field) {
        case 'issuerId':
          group.issuerId = voucher.issuerId;
          group.issuerName = voucher.issuerName;
          break;
        case 'faceUnit':
          group.faceUnit = voucher.faceUnit;
          break;
        case 'backingStrategy':
          group.backingStrategy = voucher.backingStrategy;
          break;
        case 'issuanceRatio':
          group.issuanceRatio = voucher.issuanceRatio;
          break;
        case 'walletId':
          group.walletId = voucher.walletId;
          break;
      }
    }
  }

  // Add voucher to list if requested
  if (includeVouchers) {
    if (!group.vouchers) {
      group.vouchers = [];
    }
    group.vouchers.push(voucher);
  }
}

/**
 * Finalize group aggregations (calculate averages)
 */
export function finalizeGroup(group: VoucherGroup, aggregations: AggregationType[]): void {
  if (aggregations.includes('avgFaceValue') && group.count > 0) {
    group.avgFaceValue = group.totalFaceValue / group.count;
  }

  if (aggregations.includes('avgTokenAmount') && group.count > 0) {
    group.avgTokenAmount = group.totalTokenAmount / group.count;
  }
}

/**
 * Sort groups by field
 */
export function sortGroups(
  groups: VoucherGroup[],
  sortBy: GroupSortField,
  order: 'asc' | 'desc'
): VoucherGroup[] {
  const sorted = [...groups];
  const multiplier = order === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    let aVal: string | number | undefined;
    let bVal: string | number | undefined;

    switch (sortBy) {
      case 'totalFaceValue':
        aVal = a.totalFaceValue;
        bVal = b.totalFaceValue;
        break;
      case 'totalTokenAmount':
        aVal = a.totalTokenAmount;
        bVal = b.totalTokenAmount;
        break;
      case 'count':
        aVal = a.count;
        bVal = b.count;
        break;
      case 'name':
        aVal = a.issuerName ?? a.issuerId ?? '';
        bVal = b.issuerName ?? b.issuerId ?? '';
        break;
      case 'minExpiry':
        aVal = a.minExpiry ?? '';
        bVal = b.minExpiry ?? '';
        break;
      default:
        return 0;
    }

    if (aVal === bVal) return 0;
    if (aVal === undefined || aVal === '') return 1;
    if (bVal === undefined || bVal === '') return -1;

    if (aVal < bVal) return -1 * multiplier;
    if (aVal > bVal) return 1 * multiplier;
    return 0;
  });

  return sorted;
}

/**
 * Consolidation candidate criteria
 */
export interface ConsolidationCriteria {
  /** Same issuer */
  issuerId?: string;
  /** Same currency */
  faceUnit?: string;
  /** Same issuance ratio (required for MINIMAL backing) */
  sameRatio?: boolean;
  /** Minimum vouchers required */
  minVouchers?: number;
}

/**
 * Check if two vouchers can be consolidated
 */
export function canConsolidate(a: Voucher, b: Voucher): boolean {
  // Must be active
  if (a.status !== 'active' || b.status !== 'active') return false;

  // Must have same issuer
  if (a.issuerId !== b.issuerId) return false;

  // Must have same currency
  if (a.faceUnit !== b.faceUnit) return false;

  // For MINIMAL backing, must have same issuance ratio
  if (a.backingStrategy === 'MINIMAL' || b.backingStrategy === 'MINIMAL') {
    if (Math.abs(a.issuanceRatio - b.issuanceRatio) > 0.000001) return false;
  }

  // Must have same expiry (or both no expiry)
  if (a.expiresAt !== b.expiresAt) return false;

  return true;
}