/**
 * Filter and query types for vouchers
 */

import type { Voucher } from './voucher';
import { BackingStrategy, VoucherStatus, isVoucherExpired, hasVoucherValue } from './voucher';

/**
 * Query options for filtering vouchers
 */
export interface VoucherFilter {
  // ==========================================
  // Status Filtering
  // ==========================================

  /** Filter by status (single or multiple) */
  status?: VoucherStatus | VoucherStatus[];
  /** Include expired vouchers (default: false) */
  includeExpired?: boolean;
  /** Only include vouchers with value */
  hasValue?: boolean;

  // ==========================================
  // Merchant Filtering
  // ==========================================

  /** Filter by merchant pubkey */
  issuerId?: string;
  /** Filter by multiple merchants */
  issuerIds?: string[];

  // ==========================================
  // Currency Filtering
  // ==========================================

  /** Filter by single currency */
  faceUnit?: string;
  /** Filter by multiple currencies */
  faceUnits?: string[];

  // ==========================================
  // Backing Strategy Filtering
  // ==========================================

  /** Filter by backing strategy */
  backingStrategy?: BackingStrategy | BackingStrategy[];

  // ==========================================
  // Time Filtering
  // ==========================================

  /** Created after timestamp (ISO 8601) */
  createdAfter?: string;
  /** Created before timestamp (ISO 8601) */
  createdBefore?: string;
  /** Expires after timestamp (ISO 8601) */
  expiresAfter?: string;
  /** Expires before timestamp (ISO 8601) */
  expiresBefore?: string;
  /** Expiring within N days */
  expiringWithin?: number;

  // ==========================================
  // Value Filtering
  // ==========================================

  /** Minimum face value */
  minFaceValue?: number;
  /** Maximum face value */
  maxFaceValue?: number;
  /** Minimum token amount (sats) */
  minTokenAmount?: number;
  /** Maximum token amount (sats) */
  maxTokenAmount?: number;

  // ==========================================
  // Sender Filtering
  // ==========================================

  /** Filter by sender pubkey */
  senderPubkey?: string;

  // ==========================================
  // Wallet Filtering
  // ==========================================

  /** Filter by wallet ID */
  walletId?: string;

  // ==========================================
  // Text Search
  // ==========================================

  /** Search in memo, merchant name, sender name */
  searchText?: string;

  // ==========================================
  // Sync Filtering
  // ==========================================

  /** Filter by sync status */
  synced?: boolean;
  /** Needs refresh from API */
  needsRefresh?: boolean;

  // ==========================================
  // Pagination & Sorting
  // ==========================================

  /** Maximum results (default: 50) */
  limit?: number;
  /** Skip N results */
  offset?: number;
  /** Sort field */
  sortBy?: VoucherSortField;
  /** Sort direction (default: desc) */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Fields available for sorting
 */
export type VoucherSortField =
  | 'createdAt'
  | 'expiresAt'
  | 'faceValue'
  | 'tokenAmount'
  | 'issuanceRatio'
  | 'updatedAt';

/**
 * Sort configuration
 */
export interface SortConfig {
  field: VoucherSortField;
  order: 'asc' | 'desc';
}

/**
 * Query result with pagination metadata
 */
export interface VoucherQueryResult {
  /** Matching vouchers */
  vouchers: Voucher[];
  /** Total count of matching vouchers (before pagination) */
  total: number;
  /** Whether more results are available */
  hasMore: boolean;
  /** Current offset */
  offset: number;
  /** Applied limit */
  limit: number;
}

/**
 * Default filter values
 */
export const DEFAULT_FILTER: Required<
  Pick<VoucherFilter, 'limit' | 'offset' | 'sortBy' | 'sortOrder' | 'includeExpired' | 'hasValue'>
> = {
  limit: 50,
  offset: 0,
  sortBy: 'createdAt',
  sortOrder: 'desc',
  includeExpired: false,
  hasValue: true,
};

/**
 * Normalize a filter with defaults
 */
export function normalizeFilter(filter: VoucherFilter = {}): VoucherFilter & typeof DEFAULT_FILTER {
  return {
    ...DEFAULT_FILTER,
    ...filter,
  };
}

/**
 * Check if a voucher matches a filter
 */
export function matchesFilter(voucher: Voucher, filter: VoucherFilter): boolean {
  const normalized = normalizeFilter(filter);

  // Status filter
  if (normalized.status !== undefined) {
    const statuses = Array.isArray(normalized.status) ? normalized.status : [normalized.status];
    if (!statuses.includes(voucher.status)) {
      return false;
    }
  }

  // Expired filter
  if (!normalized.includeExpired && isVoucherExpired(voucher)) {
    return false;
  }

  // Has value filter
  if (normalized.hasValue && !hasVoucherValue(voucher)) {
    return false;
  }

  // Issuer filter
  if (filter.issuerId && voucher.issuerId !== filter.issuerId) {
    return false;
  }

  if (filter.issuerIds && filter.issuerIds.length > 0) {
    if (!voucher.issuerId || !filter.issuerIds.includes(voucher.issuerId)) {
      return false;
    }
  }

  // Currency filter
  if (filter.faceUnit && voucher.faceUnit !== filter.faceUnit) {
    return false;
  }

  if (filter.faceUnits && filter.faceUnits.length > 0) {
    if (!filter.faceUnits.includes(voucher.faceUnit)) {
      return false;
    }
  }

  // Backing strategy filter
  if (filter.backingStrategy !== undefined) {
    const strategies = Array.isArray(filter.backingStrategy)
      ? filter.backingStrategy
      : [filter.backingStrategy];
    if (!strategies.includes(voucher.backingStrategy)) {
      return false;
    }
  }

  // Time filters
  if (filter.createdAfter && voucher.createdAt < filter.createdAfter) {
    return false;
  }

  if (filter.createdBefore && voucher.createdAt > filter.createdBefore) {
    return false;
  }

  if (filter.expiresAfter && voucher.expiresAt && voucher.expiresAt < filter.expiresAfter) {
    return false;
  }

  if (filter.expiresBefore && voucher.expiresAt && voucher.expiresAt > filter.expiresBefore) {
    return false;
  }

  // Expiring within N days
  if (filter.expiringWithin !== undefined && filter.expiringWithin > 0) {
    if (!voucher.expiresAt) {
      return false; // No expiry date, doesn't match "expiring within"
    }
    const expiryDate = new Date(voucher.expiresAt);
    const now = new Date();
    const diffDays = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0 || diffDays > filter.expiringWithin) {
      return false;
    }
  }

  // Value filters
  if (filter.minFaceValue !== undefined && voucher.faceValue < filter.minFaceValue) {
    return false;
  }

  if (filter.maxFaceValue !== undefined && voucher.faceValue > filter.maxFaceValue) {
    return false;
  }

  if (filter.minTokenAmount !== undefined && voucher.tokenAmount < filter.minTokenAmount) {
    return false;
  }

  if (filter.maxTokenAmount !== undefined && voucher.tokenAmount > filter.maxTokenAmount) {
    return false;
  }

  // Sender filter
  if (filter.senderPubkey && voucher.senderPubkey !== filter.senderPubkey) {
    return false;
  }

  // Wallet filter
  if (filter.walletId && voucher.walletId !== filter.walletId) {
    return false;
  }

  // Sync filter
  if (filter.synced !== undefined && voucher.synced !== filter.synced) {
    return false;
  }

  if (filter.needsRefresh !== undefined && voucher.needsRefresh !== filter.needsRefresh) {
    return false;
  }

  // Text search
  if (filter.searchText) {
    const searchLower = filter.searchText.toLowerCase();
    const searchableFields = [
      voucher.memo,
      voucher.issuerName,
      voucher.senderName,
      voucher.merchantMetadata?.merchantName,
      voucher.merchantMetadata?.description,
    ];

    const found = searchableFields.some(
      (field) => field && field.toLowerCase().includes(searchLower)
    );

    if (!found) {
      return false;
    }
  }

  return true;
}

/**
 * Sort vouchers by field
 */
export function sortVouchers(vouchers: Voucher[], config: SortConfig): Voucher[] {
  const sorted = [...vouchers];
  const { field, order } = config;
  const multiplier = order === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    let aVal: string | number | undefined;
    let bVal: string | number | undefined;

    switch (field) {
      case 'createdAt':
        aVal = a.createdAt;
        bVal = b.createdAt;
        break;
      case 'expiresAt':
        aVal = a.expiresAt ?? '';
        bVal = b.expiresAt ?? '';
        break;
      case 'faceValue':
        aVal = a.faceValue;
        bVal = b.faceValue;
        break;
      case 'tokenAmount':
        aVal = a.tokenAmount;
        bVal = b.tokenAmount;
        break;
      case 'issuanceRatio':
        aVal = a.issuanceRatio;
        bVal = b.issuanceRatio;
        break;
      case 'updatedAt':
        aVal = a.updatedAt ?? a.createdAt;
        bVal = b.updatedAt ?? b.createdAt;
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
 * Paginate vouchers
 */
export function paginateVouchers(
  vouchers: Voucher[],
  offset: number,
  limit: number
): { vouchers: Voucher[]; hasMore: boolean } {
  const paginated = vouchers.slice(offset, offset + limit);
  return {
    vouchers: paginated,
    hasMore: offset + limit < vouchers.length,
  };
}