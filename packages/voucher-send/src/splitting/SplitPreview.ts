/**
 * SplitPreview
 *
 * Handles split preview operations to validate amounts before splitting.
 */

import type { ApiAdapter } from '../adapters';
import type { Voucher, SplitPreview as SplitPreviewResult } from '../types';
import { VoucherSendError, ErrorCodes } from '../core/errors';

/**
 * Preview options
 */
export interface PreviewOptions {
  /** Whether to allow rounding */
  allowRounding?: boolean;
}

/**
 * SplitPreviewService
 *
 * Validates split amounts and provides preview information.
 */
export class SplitPreviewService {
  private api: ApiAdapter;

  constructor(api: ApiAdapter) {
    this.api = api;
  }

  /**
   * Get a preview of a split operation
   *
   * @param voucher - Voucher to split (or just the token)
   * @param amount - Amount to send (face value in minor units)
   * @returns Preview result
   */
  async preview(
    voucher: Voucher | string,
    amount: number
  ): Promise<SplitPreviewResult> {
    const token = typeof voucher === 'string' ? voucher : voucher.token;

    if (!token) {
      throw new VoucherSendError(
        'Voucher has no token',
        ErrorCodes.VALIDATION_ERROR,
        { voucherId: typeof voucher === 'object' ? voucher.voucher_id : undefined }
      );
    }

    if (amount <= 0) {
      throw new VoucherSendError(
        'Amount must be greater than 0',
        ErrorCodes.INVALID_AMOUNT,
        { required: amount }
      );
    }

    try {
      const result = await this.api.splitPreview(token, amount);
      return result;
    } catch (error) {
      if (error instanceof VoucherSendError) {
        throw error;
      }
      throw new VoucherSendError(
        `Split preview failed: ${(error as Error).message}`,
        ErrorCodes.SPLIT_FAILED,
        { cause: error as Error }
      );
    }
  }

  /**
   * Validate that a split can be performed
   *
   * @param voucher - Voucher to validate
   * @param amount - Amount to send
   * @returns Validation result with details
   */
  async validate(
    voucher: Voucher,
    amount: number
  ): Promise<{
    valid: boolean;
    preview?: SplitPreviewResult;
    error?: string;
  }> {
    // Check basic amount validity
    if (amount <= 0) {
      return { valid: false, error: 'Amount must be greater than 0' };
    }

    // Check if voucher has sufficient balance
    const balance = voucher.face_value || 0;
    if (amount > balance) {
      return {
        valid: false,
        error: `Insufficient balance: need ${amount}, have ${balance}`,
      };
    }

    // If sending exact balance, no split needed
    if (amount === balance) {
      return {
        valid: true,
        preview: {
          canSplit: true,
          actualAmount: amount,
          roundingApplied: false,
          swapRequired: false,
        },
      };
    }

    // Get preview from API
    try {
      const preview = await this.preview(voucher, amount);

      if (!preview.canSplit) {
        return {
          valid: false,
          preview,
          error: preview.error || 'Cannot split this amount',
        };
      }

      if (preview.swapRequired) {
        return {
          valid: false,
          preview,
          error: 'Swap required but not supported',
        };
      }

      return { valid: true, preview };
    } catch (error) {
      return {
        valid: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Check if an amount requires rounding
   */
  async requiresRounding(voucher: Voucher, amount: number): Promise<boolean> {
    const preview = await this.preview(voucher, amount);
    return preview.roundingApplied;
  }

  /**
   * Get the actual amount after rounding
   */
  async getActualAmount(voucher: Voucher, amount: number): Promise<number> {
    const preview = await this.preview(voucher, amount);
    return preview.actualAmount;
  }

  /**
   * Get the minimum split amount for a voucher
   */
  async getMinimumAmount(voucher: Voucher): Promise<number> {
    // Try to get preview with a very small amount
    try {
      const preview = await this.preview(voucher, 1);
      return preview.minSplitAmount || 1;
    } catch {
      return 1;
    }
  }
}

/**
 * Create a split preview service
 */
export function createSplitPreviewService(api: ApiAdapter): SplitPreviewService {
  return new SplitPreviewService(api);
}
