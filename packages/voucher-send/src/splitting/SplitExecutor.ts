/**
 * SplitExecutor
 *
 * Executes voucher split operations.
 */

import type { ApiAdapter } from '../adapters';
import type { Voucher, SplitResult, BackingStrategy } from '../types';
import { VoucherSendError, ErrorCodes } from '../core/errors';
import { SplitPreviewService } from './SplitPreview';

/**
 * Split execution options
 */
export interface SplitExecuteOptions {
  /** Memo for the transaction */
  memo?: string;

  /** Whether to skip preview validation */
  skipValidation?: boolean;

  /** Whether to allow swap (default: false) */
  allowSwap?: boolean;
}

/**
 * Split execution result with voucher objects
 */
export interface SplitExecutionResult extends SplitResult {
  /** Issuer ID (normalized from split result or source voucher) */
  issuerId: string;

  /** Face unit (normalized from split result or source voucher) */
  faceUnit: string;

  /** Face decimals (normalized from split result or source voucher) */
  faceDecimals: number;

  /** Backing strategy (normalized from split result or source voucher) */
  backingStrategy: BackingStrategy;

  /** Voucher object for the sent portion */
  sentVoucher: Voucher;

  /** Voucher object for the kept portion (change) */
  keepVoucher: Voucher;
}

type NormalizedSplitMetadata = Omit<SplitExecutionResult, 'sentVoucher' | 'keepVoucher'>;

/**
 * SplitExecutor
 *
 * Handles the execution of voucher split operations.
 */
export class SplitExecutor {
  private api: ApiAdapter;
  private previewService: SplitPreviewService;

  constructor(api: ApiAdapter) {
    this.api = api;
    this.previewService = new SplitPreviewService(api);
  }

  private normalizeFaceUnit(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const upper = trimmed.toUpperCase();
    return upper === 'UNKNOWN' ? null : upper;
  }

  private resolveFaceDecimals(faceUnit: string, explicit?: number): number {
    if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0) {
      return explicit;
    }
    return ['SAT', 'SATS'].includes(faceUnit) ? 0 : 2;
  }

  private normalizeSplitResult(source: Voucher, result: SplitResult): SplitExecutionResult {
    const faceUnit = this.normalizeFaceUnit(result.faceUnit)
      ?? this.normalizeFaceUnit(source.face_unit);

    if (!faceUnit) {
      throw new VoucherSendError(
        'Split result missing face_unit and source voucher has no known currency',
        ErrorCodes.VALIDATION_ERROR,
        { voucherId: source.voucher_id }
      );
    }

    const faceDecimals = this.resolveFaceDecimals(
      faceUnit,
      result.faceDecimals ?? source.face_decimals
    );
    const backingStrategy = result.backingStrategy ?? source.backing_strategy ?? 'LEGACY';

    const normalizedBase: NormalizedSplitMetadata = {
      ...result,
      issuerId: result.issuerId ?? source.issuer_id ?? '',
      faceUnit,
      faceDecimals,
      backingStrategy,
    };

    return {
      ...normalizedBase,
      sentVoucher: this.buildSentVoucher(source, {
        ...normalizedBase,
      }),
      keepVoucher: this.buildKeepVoucher(source, {
        ...normalizedBase,
      }),
    };
  }

  /**
   * Execute a voucher split
   *
   * @param voucher - Source voucher to split
   * @param amount - Amount to send (face value in minor units)
   * @param options - Split options
   * @returns Split result with tokens
   */
  async execute(
    voucher: Voucher,
    amount: number,
    options: SplitExecuteOptions = {}
  ): Promise<SplitExecutionResult> {
    // Validate voucher has token
    if (!voucher.token) {
      throw new VoucherSendError(
        'Voucher has no token',
        ErrorCodes.VALIDATION_ERROR,
        { voucherId: voucher.voucher_id }
      );
    }

    // Validate amount
    if (amount <= 0) {
      throw new VoucherSendError(
        'Amount must be greater than 0',
        ErrorCodes.INVALID_AMOUNT,
        { required: amount }
      );
    }

    const balance = voucher.face_value || 0;
    if (amount > balance) {
      throw VoucherSendError.insufficientBalance(
        amount,
        balance,
        voucher.face_unit || 'SAT'
      );
    }

    // Validate with preview unless skipped
    if (!options.skipValidation) {
      const validation = await this.previewService.validate(voucher, amount);
      if (!validation.valid) {
        throw new VoucherSendError(
          validation.error || 'Split validation failed',
          ErrorCodes.SPLIT_FAILED
        );
      }
    }

    // Execute the split
    try {
      const result = await this.api.splitExecute(voucher.token, amount, options.memo);
      const normalized = this.normalizeSplitResult(voucher, result);
      normalized.sentVoucher.memo = options.memo;
      return normalized;
    } catch (error) {
      if (error instanceof VoucherSendError) {
        throw error;
      }

      const message = (error as Error).message || 'Split failed';

      // Check for swap-related errors
      if (message.includes('swap')) {
        throw VoucherSendError.swapRequired(amount, 0);
      }

      throw new VoucherSendError(
        `Split failed: ${message}`,
        ErrorCodes.SPLIT_FAILED,
        { cause: error as Error }
      );
    }
  }

  /**
   * Execute a split and return only the send token
   * Useful when you just need the token to send
   */
  async splitForSend(
    voucher: Voucher,
    amount: number,
    memo?: string
  ): Promise<{ token: string; voucher: Voucher }> {
    const result = await this.execute(voucher, amount, { memo });
    return {
      token: result.sendToken,
      voucher: result.sentVoucher,
    };
  }

  /**
   * Check if splitting is needed (amount < full balance)
   */
  needsSplit(voucher: Voucher, amount: number): boolean {
    const balance = voucher.face_value || 0;
    return amount < balance && amount > 0;
  }

  /**
   * Get the token to send (either from split or full voucher)
   */
  async getTokenToSend(
    voucher: Voucher,
    amount: number,
    memo?: string
  ): Promise<{ token: string; voucher: Voucher; wasSplit: boolean }> {
    const balance = voucher.face_value || 0;

    // Sending full balance - no split needed
    if (amount >= balance) {
      return {
        token: voucher.token,
        voucher: voucher,
        wasSplit: false,
      };
    }

    // Need to split
    const result = await this.execute(voucher, amount, { memo });
    return {
      token: result.sendToken,
      voucher: result.sentVoucher,
      wasSplit: true,
    };
  }

  /**
   * Build a voucher object for the sent portion
   */
  private buildSentVoucher(
    source: Voucher,
    result: NormalizedSplitMetadata,
    memo?: string
  ): Voucher {
    return {
      voucher_id: `send-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      token: result.sendToken,
      face_value: result.sendFaceValue,
      face_unit: result.faceUnit,
      face_decimals: result.faceDecimals,
      token_amount: result.sendTokenAmount,
      token_unit: source.token_unit || 'sat',
      backing_strategy: result.backingStrategy,
      issuance_ratio: result.issuanceRatio || source.issuance_ratio,
      issuer_id: result.issuerId || source.issuer_id,
      merchant_metadata: source.merchant_metadata,
      status: 'active',
      expires_at: source.expires_at,
      created_at: new Date().toISOString(),
      mint_url: source.mint_url,
      memo,
    };
  }

  /**
   * Build a voucher object for the kept portion (change)
   */
  private buildKeepVoucher(source: Voucher, result: NormalizedSplitMetadata): Voucher {
    return {
      voucher_id: source.voucher_id,
      token: result.keepToken,
      face_value: result.keepFaceValue,
      face_unit: result.faceUnit,
      face_decimals: result.faceDecimals,
      token_amount: result.keepTokenAmount,
      token_unit: source.token_unit || 'sat',
      backing_strategy: result.backingStrategy,
      issuance_ratio: result.issuanceRatio || source.issuance_ratio,
      issuer_id: result.issuerId || source.issuer_id,
      merchant_metadata: source.merchant_metadata,
      status: 'active',
      expires_at: source.expires_at,
      created_at: source.created_at,
      mint_url: source.mint_url,
      memo: source.memo,
    };
  }
}

/**
 * Create a split executor instance
 */
export function createSplitExecutor(api: ApiAdapter): SplitExecutor {
  return new SplitExecutor(api);
}
