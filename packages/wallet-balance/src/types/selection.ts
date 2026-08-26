/**
 * Selection Types
 *
 * Types for voucher selection and payment optimization.
 */

/**
 * Minimal voucher interface for selection
 * (compatible with @imani/nostr-vouchers Voucher type)
 */
export interface SelectableVoucher {
  id: string;
  faceValue: number;
  faceUnit: string;
  faceDecimals: number;
  tokenAmount: number;
  tokenUnit: string;
  issuanceRatio: number;
  backingStrategy: string;
  status: string;
  expiresAt?: string;
  issuerId?: string;
  issuerName?: string;
}

/**
 * Selection strategy
 */
export type SelectionStrategy =
  | 'minimize-count'      // Use fewest vouchers possible
  | 'minimize-change'     // Minimize overpayment
  | 'use-expiring-first'  // Prefer vouchers expiring soon
  | 'prefer-single';      // Strongly prefer single voucher (default)

/**
 * Request to select vouchers for a payment
 */
export interface SelectionRequest {
  /** Target amount in minor units */
  amount: number;
  /** Currency code */
  currency: string;
  /** Optional: prefer specific issuer */
  preferredIssuerId?: string;
  /** Optional: exclude certain vouchers */
  excludeVoucherIds?: string[];
  /** Strategy for selection (default: 'prefer-single') */
  strategy?: SelectionStrategy;
  /** For 'use-expiring-first': days threshold */
  expiringWithinDays?: number;
}

/**
 * Result of voucher selection
 */
export interface SelectionResult {
  /** Selected vouchers */
  vouchers: SelectableVoucher[];
  /** Total selected amount (in minor units) */
  totalAmount: number;
  /** Change amount (overage) */
  changeAmount: number;
  /** Whether consolidation is needed (multiple vouchers) */
  needsConsolidation: boolean;
  /** Whether selection covers the request */
  sufficient: boolean;
  /** Shortfall if insufficient (in minor units) */
  shortfall: number;
  /** Groups for consolidation (if needed) */
  consolidationGroups?: SelectableVoucher[][];
}

/**
 * Consolidation compatibility check result
 */
export interface ConsolidationCheck {
  /** Whether vouchers can be consolidated */
  canConsolidate: boolean;
  /** Reason if cannot consolidate */
  reason?: string;
  /** Groups of compatible vouchers */
  compatibleGroups: SelectableVoucher[][];
}

/**
 * Empty selection result
 */
export const EMPTY_SELECTION_RESULT: SelectionResult = {
  vouchers: [],
  totalAmount: 0,
  changeAmount: 0,
  needsConsolidation: false,
  sufficient: false,
  shortfall: 0,
};
