/**
 * VoucherGrouper
 *
 * Groups vouchers by merchant for display and selection.
 * Handles normalization of issuer IDs and currency units.
 */

import type { Voucher, MerchantGroup } from '../types';
import { isZeroDecimal } from '@imani/money';

/**
 * Check if a voucher is expired
 */
function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  try {
    return new Date(expiresAt).getTime() < Date.now();
  } catch {
    return false;
  }
}

/**
 * Normalize issuer ID to consistent format
 * Converts npub to hex for consistent grouping
 */
function normalizeIssuerId(id: string): string {
  if (!id) return 'unknown';

  // If it starts with npub1, try to decode to hex
  if (id.startsWith('npub1')) {
    // For now, just use the npub as-is since we don't have nostr-tools here
    // The actual implementation would decode: nip19.decode(id).data as string
    return id;
  }

  // If it looks like a hex pubkey, normalize to lowercase
  if (/^[0-9a-f]{64}$/i.test(id)) {
    return id.toLowerCase();
  }

  return id;
}

/**
 * Get decimal places for a currency unit
 */
function getDecimalsForUnit(unit: string, storedDecimals?: number): number {
  if (isZeroDecimal(unit)) {
    return 0;
  }
  return storedDecimals ?? 2;
}

/**
 * VoucherGrouper configuration
 */
export interface VoucherGrouperConfig {
  /** Include expired vouchers in groups (default: false) */
  includeExpired?: boolean;

  /** Include spent vouchers in groups (default: false) */
  includeSpent?: boolean;

  /** Include zero-balance vouchers (default: false) */
  includeZeroBalance?: boolean;
}

/**
 * VoucherGrouper
 *
 * Groups vouchers by merchant, handling:
 * - Issuer ID normalization
 * - Currency unit normalization
 * - Issuance ratio grouping (vouchers with different ratios can't be mixed)
 * - Expiry and status filtering
 */
export class VoucherGrouper {
  private config: Required<VoucherGrouperConfig>;

  constructor(config: VoucherGrouperConfig = {}) {
    this.config = {
      includeExpired: config.includeExpired ?? false,
      includeSpent: config.includeSpent ?? false,
      includeZeroBalance: config.includeZeroBalance ?? false,
    };
  }

  /**
   * Group vouchers by merchant
   *
   * @param vouchers - Array of vouchers to group
   * @returns Map of group key to MerchantGroup
   */
  group(vouchers: Voucher[]): Map<string, MerchantGroup> {
    const groups = new Map<string, MerchantGroup>();

    // Filter vouchers based on config
    const filteredVouchers = vouchers.filter((v) => this.shouldInclude(v));

    for (const voucher of filteredVouchers) {
      const groupKey = this.getGroupKey(voucher);
      const group = groups.get(groupKey) || this.createGroup(voucher, groupKey);

      // Add to totals
      group.totalFaceValue += voucher.face_value || 0;
      group.totalTokenAmount += voucher.token_amount || 0;
      group.voucherCount += 1;
      group.vouchers.push(voucher);

      groups.set(groupKey, group);
    }

    // Sort vouchers within each group by face_value descending
    for (const group of groups.values()) {
      group.vouchers.sort((a, b) => (b.face_value || 0) - (a.face_value || 0));
    }

    return groups;
  }

  /**
   * Group vouchers and return as array
   */
  groupToArray(vouchers: Voucher[]): MerchantGroup[] {
    return Array.from(this.group(vouchers).values());
  }

  /**
   * Get a single group for a specific merchant
   */
  getGroupForMerchant(
    vouchers: Voucher[],
    merchantId: string,
    unit?: string
  ): MerchantGroup | null {
    const normalizedId = normalizeIssuerId(merchantId);
    const groups = this.group(vouchers);

    for (const group of groups.values()) {
      if (group.merchantId === normalizedId) {
        if (!unit || group.unit === unit.toUpperCase()) {
          return group;
        }
      }
    }

    return null;
  }

  /**
   * Check if a voucher should be included based on config
   */
  private shouldInclude(voucher: Voucher): boolean {
    // Check status
    if (!this.config.includeSpent && voucher.status === 'spent') {
      return false;
    }

    if (!this.config.includeExpired) {
      if (voucher.status === 'expired' || isExpired(voucher.expires_at)) {
        return false;
      }
    }

    // Check value
    if (!this.config.includeZeroBalance) {
      const hasValue = (voucher.face_value || 0) > 0 || (voucher.token_amount || 0) > 0;
      if (!hasValue) {
        return false;
      }
    }

    return true;
  }

  /**
   * Generate a unique group key for a voucher
   */
  private getGroupKey(voucher: Voucher): string {
    const merchantId = this.getMerchantId(voucher);
    const unit = (voucher.face_unit || 'SAT').toUpperCase();
    const issuanceRatio = this.getIssuanceRatio(voucher);

    return `${merchantId}-${unit}-${issuanceRatio}`;
  }

  /**
   * Get normalized merchant ID from voucher
   */
  private getMerchantId(voucher: Voucher): string {
    const rawId = voucher.issuer_id || 'unknown';
    return normalizeIssuerId(rawId);
  }

  /**
   * Get issuance ratio for grouping
   */
  private getIssuanceRatio(voucher: Voucher): number {
    const strategy = voucher.backing_strategy || 'LEGACY';
    if (strategy === 'LEGACY') {
      return 1;
    }
    return voucher.issuance_ratio || 1;
  }

  /**
   * Create a new group for a voucher
   */
  private createGroup(voucher: Voucher, _groupKey: string): MerchantGroup {
    const merchantId = this.getMerchantId(voucher);
    const unit = (voucher.face_unit || 'SAT').toUpperCase();
    const decimals = getDecimalsForUnit(unit, voucher.face_decimals);
    const issuanceRatio = this.getIssuanceRatio(voucher);

    return {
      merchantId,
      merchantName: voucher.merchant_metadata?.merchant_name || merchantId,
      unit,
      decimals,
      issuanceRatio,
      totalFaceValue: 0,
      totalTokenAmount: 0,
      voucherCount: 0,
      vouchers: [],
    };
  }
}

/**
 * Create a voucher grouper instance
 */
export function createVoucherGrouper(config?: VoucherGrouperConfig): VoucherGrouper {
  return new VoucherGrouper(config);
}
