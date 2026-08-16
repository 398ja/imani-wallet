/**
 * VoucherSelector
 *
 * Selects vouchers for sending based on amount and merchant.
 * Only supports single-voucher selection (no consolidation).
 */

import type { StorageAdapter } from '../adapters';
import type { Voucher, MerchantGroup } from '../types';
import { VoucherSendError, ErrorCodes } from '../core/errors';
import { VoucherGrouper, type VoucherGrouperConfig } from './VoucherGrouper';

/**
 * Selection result
 */
export interface SelectionResult {
  /** Selected voucher */
  voucher: Voucher;

  /** Whether consolidation would be needed (always false, we don't support it) */
  needsConsolidation: false;

  /** Total available in selected voucher */
  totalAvailable: number;

  /** Merchant group the voucher belongs to */
  merchantGroup: MerchantGroup;
}

/**
 * VoucherSelector configuration
 */
export interface VoucherSelectorConfig extends VoucherGrouperConfig {
  /** Storage adapter for fetching vouchers */
  storage?: StorageAdapter;
}

/**
 * VoucherSelector
 *
 * Selects a single voucher that can cover the requested amount.
 * Does NOT support multi-voucher consolidation.
 */
export class VoucherSelector {
  private storage?: StorageAdapter;
  private grouper: VoucherGrouper;

  constructor(config: VoucherSelectorConfig = {}) {
    this.storage = config.storage;
    this.grouper = new VoucherGrouper(config);
  }

  /**
   * Get all merchant groups from storage
   */
  async getMerchantGroups(): Promise<MerchantGroup[]> {
    const vouchers = await this.getVouchers();
    return this.grouper.groupToArray(vouchers);
  }

  /**
   * Get a specific merchant group
   */
  async getMerchantGroup(merchantId: string, unit?: string): Promise<MerchantGroup | null> {
    const vouchers = await this.getVouchers();
    return this.grouper.getGroupForMerchant(vouchers, merchantId, unit);
  }

  /**
   * Select a voucher for the given amount from a merchant group
   *
   * @param merchantGroup - Merchant group to select from
   * @param targetAmount - Target face value in minor units
   * @returns Selection result
   * @throws VoucherSendError if no single voucher has sufficient balance
   */
  selectFromGroup(merchantGroup: MerchantGroup, targetAmount: number): SelectionResult {
    if (!merchantGroup.vouchers.length) {
      throw new VoucherSendError(
        `No vouchers found for merchant: ${merchantGroup.merchantId}`,
        ErrorCodes.MERCHANT_NOT_FOUND,
        { merchantId: merchantGroup.merchantId }
      );
    }

    // Vouchers are already sorted by face_value descending
    // Find the first voucher that covers the amount
    const voucher = merchantGroup.vouchers.find(
      (v) => (v.face_value || 0) >= targetAmount
    );

    if (!voucher) {
      // Find the best available for error message
      const bestAvailable = merchantGroup.vouchers[0]?.face_value || 0;

      throw VoucherSendError.noVoucherWithBalance(
        targetAmount,
        bestAvailable,
        merchantGroup.unit
      );
    }

    return {
      voucher,
      needsConsolidation: false,
      totalAvailable: voucher.face_value || 0,
      merchantGroup,
    };
  }

  /**
   * Select a voucher for the given amount by merchant ID
   *
   * @param merchantId - Merchant ID to select from
   * @param targetAmount - Target face value in minor units
   * @param unit - Optional currency unit filter
   * @returns Selection result
   * @throws VoucherSendError if merchant not found or insufficient balance
   */
  async selectByMerchant(
    merchantId: string,
    targetAmount: number,
    unit?: string
  ): Promise<SelectionResult> {
    const merchantGroup = await this.getMerchantGroup(merchantId, unit);

    if (!merchantGroup) {
      throw VoucherSendError.merchantNotFound(merchantId);
    }

    return this.selectFromGroup(merchantGroup, targetAmount);
  }

  /**
   * Select a specific voucher by ID
   *
   * @param voucherId - Voucher ID
   * @param targetAmount - Target face value (for validation)
   * @returns Selection result
   * @throws VoucherSendError if voucher not found or insufficient balance
   */
  async selectByVoucherId(voucherId: string, targetAmount: number): Promise<SelectionResult> {
    const vouchers = await this.getVouchers();
    const voucher = vouchers.find((v) => v.voucher_id === voucherId);

    if (!voucher) {
      throw VoucherSendError.voucherNotFound(voucherId);
    }

    if ((voucher.face_value || 0) < targetAmount) {
      throw VoucherSendError.insufficientBalance(
        targetAmount,
        voucher.face_value || 0,
        voucher.face_unit || 'SAT'
      );
    }

    // Get the merchant group for this voucher
    const merchantGroup = this.grouper.getGroupForMerchant(
      vouchers,
      voucher.issuer_id || 'unknown',
      voucher.face_unit
    );

    if (!merchantGroup) {
      // Create a minimal group
      const group: MerchantGroup = {
        merchantId: voucher.issuer_id || 'unknown',
        merchantName: voucher.merchant_metadata?.merchant_name || 'Unknown',
        unit: (voucher.face_unit || 'SAT').toUpperCase(),
        decimals: voucher.face_decimals ?? 2,
        issuanceRatio: voucher.issuance_ratio || 1,
        totalFaceValue: voucher.face_value || 0,
        totalTokenAmount: voucher.token_amount || 0,
        voucherCount: 1,
        vouchers: [voucher],
      };

      return {
        voucher,
        needsConsolidation: false,
        totalAvailable: voucher.face_value || 0,
        merchantGroup: group,
      };
    }

    return {
      voucher,
      needsConsolidation: false,
      totalAvailable: voucher.face_value || 0,
      merchantGroup,
    };
  }

  /**
   * Find the best voucher for an amount across all merchants
   * Prefers exact match, then smallest voucher that covers the amount
   *
   * @param targetAmount - Target face value in minor units
   * @param unit - Optional currency unit filter
   * @returns Selection result or null if no suitable voucher found
   */
  async findBestVoucher(
    targetAmount: number,
    unit?: string
  ): Promise<SelectionResult | null> {
    const groups = await this.getMerchantGroups();

    // Filter by unit if specified
    const filteredGroups = unit
      ? groups.filter((g) => g.unit === unit.toUpperCase())
      : groups;

    let bestMatch: { voucher: Voucher; group: MerchantGroup; diff: number } | null = null;

    for (const group of filteredGroups) {
      for (const voucher of group.vouchers) {
        const faceValue = voucher.face_value || 0;
        if (faceValue >= targetAmount) {
          const diff = faceValue - targetAmount;

          // Exact match - return immediately
          if (diff === 0) {
            return {
              voucher,
              needsConsolidation: false,
              totalAvailable: faceValue,
              merchantGroup: group,
            };
          }

          // Better match (smaller excess)
          if (!bestMatch || diff < bestMatch.diff) {
            bestMatch = { voucher, group, diff };
          }
        }
      }
    }

    if (bestMatch) {
      return {
        voucher: bestMatch.voucher,
        needsConsolidation: false,
        totalAvailable: bestMatch.voucher.face_value || 0,
        merchantGroup: bestMatch.group,
      };
    }

    return null;
  }

  /**
   * Validate that a voucher can cover an amount
   */
  validateAmount(voucher: Voucher, targetAmount: number): boolean {
    return (voucher.face_value || 0) >= targetAmount;
  }

  /**
   * Get vouchers from storage
   */
  private async getVouchers(): Promise<Voucher[]> {
    if (!this.storage) {
      throw new VoucherSendError(
        'No storage adapter configured',
        ErrorCodes.ADAPTER_ERROR
      );
    }

    const result = this.storage.getVouchers({ status: 'active' });
    return result instanceof Promise ? await result : result;
  }
}

/**
 * Create a voucher selector instance
 */
export function createVoucherSelector(config?: VoucherSelectorConfig): VoucherSelector {
  return new VoucherSelector(config);
}
