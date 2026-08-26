/**
 * Split Types
 *
 * Types for voucher splitting operations.
 */

import type { BackingStrategy, RoundingMode } from './voucher';

/**
 * Split preview result
 */
export interface SplitPreview {
  /** Whether the split can be performed */
  canSplit: boolean;

  /** Actual amount that will be sent (may differ due to rounding) */
  actualAmount: number;

  /** Whether rounding was applied */
  roundingApplied: boolean;

  /** Rounding mode used */
  roundingMode?: RoundingMode;

  /** Whether a swap is required (cannot split, need to swap) */
  swapRequired: boolean;

  /** Minimum amount that can be split */
  minSplitAmount?: number;

  /** Minimum denomination for this voucher */
  minDenomination?: number;

  /** Amount that will remain after split */
  remainingAmount?: number;

  /** Error message if cannot split */
  error?: string;
}

/**
 * Split execution result
 */
export interface SplitResult {
  /** Token to send to recipient */
  sendToken: string;

  /** Token to keep (change) */
  keepToken: string;

  /** Face value of send token */
  sendFaceValue: number;

  /** Face value of keep token */
  keepFaceValue: number;

  /** Token amount (sats) of send token */
  sendTokenAmount: number;

  /** Token amount (sats) of keep token */
  keepTokenAmount: number;

  /** Whether rounding was applied */
  roundingApplied: boolean;

  /** Rounding mode used */
  roundingMode?: RoundingMode;

  /** Issuer ID */
  issuerId?: string;

  /** Face unit */
  faceUnit?: string;

  /** Face decimals */
  faceDecimals?: number;

  /** Backing strategy */
  backingStrategy?: BackingStrategy;

  /** Issuance ratio */
  issuanceRatio?: number;
}

/**
 * Split request parameters
 */
export interface SplitRequest {
  /** Token to split */
  token: string;

  /** Amount to send (face value in minor units) */
  sendFaceValue: number;

  /** Optional memo for the transaction */
  memo?: string;

  /** Whether to allow swap if split not possible */
  allowSwap?: boolean;
}
