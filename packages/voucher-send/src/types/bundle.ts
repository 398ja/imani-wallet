/**
 * Bundle types for the multi-voucher send orchestrator (spec 012).
 *
 * Source of truth: contracts/bundle-orchestrator-interface.md §1.1 and §1.3,
 * data-model.md "Sender-side entities".
 *
 * Note: these types are TypeScript surface for the typed sender-orchestrator
 * package; the matching shape on the wire uses snake_case fields per
 * contracts/bundle-metadata-wire-format.md (the api.js client maps
 * camelCase params to snake_case body fields).
 */

import type { Recipient } from './recipient';
import type { MerchantGroup, Voucher } from './voucher';

/* ---------- Plan-time entities (in-memory before journaling) ---------- */

/**
 * A single source-voucher draw in a bundle plan.
 *
 * Per data-model.md `BundlePartPlan`. Earlier parts (index < parts.length-1)
 * fully consume their source voucher; only the final part may be partial
 * (it carries the change that gets returned to the sender's wallet).
 */
export interface BundlePartPlan {
  /** Position within plan.parts (0-based). */
  partIndex: number;
  /** Local source-voucher identifier. */
  sourceVoucherId: string;
  /** Authoritative token at plan time (refreshed via existing ensureSourceVoucherToken). */
  sourceVoucherToken: string;
  /** Source voucher's expiry, used by FR-009a to fix the change voucher's expiry. */
  sourceVoucherExpiresAt: string | null;
  /** Amount drawn from this source, in minor units of the bundle's faceUnit. */
  partAmount: number;
  /** Derived: `${bundleId}:${partIndex}` (Phase 0 R2). */
  partId: string;
  /** Derived: `bundle:${bundleId}:${partIndex}:${attempt}` (Phase 0 R6). */
  idempotencyKey: string;
}

/**
 * A complete plan to satisfy one user-initiated multi-source send.
 *
 * Per data-model.md `BundlePlan`. Built before journaling; the orchestrator
 * journals it to localStorage as a `BundleSendJournalEntry` before the first
 * sub-send executes (FR-024a).
 */
export interface BundlePlan {
  /** 32-char lowercase hex; cryptographically random (Phase 0 R1). */
  bundleId: string;
  recipientPubkeyHex: string;
  /** From `groupVouchersByMerchant` group key; anchors the same-merchant constraint (FR-005). */
  merchantGroupKey: string;
  /** Sum of parts[].partAmount; equals user-requested amount (FR-024). */
  totalAmount: number;
  faceUnit: string;
  faceDecimals: number;
  parts: BundlePartPlan[];
  /** ISO 8601 UTC. */
  createdAt: string;
  /** Retry attempt number; 0 for the original send (FR-011a / Phase 0 R6). */
  attempt: number;
}

/* ---------- Journal entries (persisted to localStorage) ---------- */

/**
 * Per-part runtime state nested inside a BundleSendJournalEntry.
 *
 * Per data-model.md `BundleSubSendRecord`. Carries the saga ID returned by
 * the per-part atomic-send call so FR-024a crash-recovery can reconcile.
 */
export interface BundleSubSendRecord {
  partIndex: number;
  partId: string;
  sourceVoucherId: string;
  sourceVoucherExpiresAt: string | null;
  partAmount: number;
  idempotencyKey: string;
  state: 'PLANNED' | 'RESERVED' | 'EXECUTING' | 'DELIVERED' | 'FAILED' | 'RECLAIMED';
  /** Backend atomic-send saga ID; null until the call has been issued. */
  sendId: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  /** For the change-bearing last part: the change face value the sender keeps. */
  keepTokenFaceValue: number | null;
  /** Per FR-009a, MUST equal sourceVoucherExpiresAt for change-bearing parts. */
  keepTokenExpiresAt: string | null;
  /**
   * Spec 013 high-2: non-null when the recipient received the funds (state
   * reached DELIVERED) but the local sender wallet mutation failed. The
   * keep_token is NOT acked in this state — the backend's 48h fallback
   * retains the bearer material for a future retry/recovery to complete
   * the local mutation. Cleared (set null) on a subsequent successful apply.
   */
  localApplyError?: string | null;
}

/**
 * Persistent record of a bundle in flight. Mirrors today's
 * imani_pending_consolidations field-for-field where applicable.
 *
 * Per data-model.md `BundleSendJournalEntry`. Stored in the per-user
 * localStorage array `imani_pending_bundle_sends`.
 */
export interface BundleSendJournalEntry {
  bundleId: string;
  userId: string;
  state: 'RESERVED' | 'EXECUTING' | 'PARTIAL' | 'DELIVERED' | 'FAILED' | 'ABANDONED';
  recipientPubkeyHex: string;
  merchantGroupKey: string;
  totalAmount: number;
  /** Σ partAmount across DELIVERED parts. */
  deliveredAmount: number;
  faceUnit: string;
  faceDecimals: number;
  parts: BundleSubSendRecord[];
  /** 0 for original; >0 for remainder retries. */
  attempt: number;
  /**
   * For retries: same value as bundleId (per FR-011a — retries reuse the
   * original bundleId so the receiver updates in place). Null on the original.
   */
  parentBundleId: string | null;
  createdAt: string;
  updatedAt: string;
  lastErrorCode: string | null;
  cutoverOrigin: string | null;
}

/* ---------- Orchestrator inputs ---------- */

/**
 * Inputs to BundleSendOrchestrator.send().
 *
 * Per contracts/bundle-orchestrator-interface.md §1.1.
 */
export interface BundleSendParams {
  userId: string;
  recipient: string | Recipient;
  merchantGroup: MerchantGroup;
  /** Total face value to send, in minor units of merchantGroup.unit. */
  amount: number;
  memo?: string;
  callbacks: BundleSendCallbacks;
}

export interface BundleSendCallbacks {
  onPlanReady?: (summary: BundleSendPlanSummary) => void;
  /**
   * Called when the plan would create N >= 10 sub-sends (Phase 0 R10 / Edge Cases).
   * The promise's resolution gates execution: 'proceed' continues, 'cancel' aborts.
   */
  onSoftCapWarning?: (partsCount: number) => Promise<'proceed' | 'cancel'>;
  onPartProgress?: (event: BundlePartProgress) => void;
  onPartialOutcome?: (outcome: BundlePartialOutcome) => void;
  onComplete?: (result: BundleCompleteResult) => void;
  onError?: (error: BundleSendError) => void;
}

/**
 * Outcome of a single bundle's reconciliation in `BundleSender.resumePending`.
 */
export interface BundleResumeResult {
  bundleId: string;
  outcome: 'DELIVERED' | 'PARTIAL' | 'FAILED';
  /** Sum of partAmounts for all DELIVERED parts after reconciliation. */
  deliveredAmount: number;
  /** Optional first error code observed during recovery (for diagnostics). */
  errorCode?: string | null;
}

/**
 * Summary the orchestrator emits via onPlanReady.
 *
 * Carries only what the UI needs for "preparing N vouchers" — never carries
 * tokens, proofs, or full voucher objects (FR-023 + Phase 0 R13).
 */
export interface BundleSendPlanSummary {
  bundleId: string;
  totalAmount: number;
  partsCount: number;
  unit: string;
  decimals: number;
}

/* ---------- Orchestrator outputs ---------- */

/**
 * Per-part progress event. Emitted as each part transitions terminal states.
 */
export interface BundlePartProgress {
  bundleId: string;
  partIndex: number;
  partCount: number;
  /**
   * `DELIVERED_LOCAL_ERROR` (spec 013 high-2): the recipient received the funds
   * (DM was published) but the sender's local wallet mutation failed —
   * displayed balance may be stale until next sync. The keep_token is NOT
   * acked in this state so a future retry can complete the local mutation.
   */
  state: 'EXECUTING' | 'DELIVERED' | 'DELIVERED_LOCAL_ERROR' | 'FAILED';
  errorCode?: string;
  /** Spec 013 high-2: human-readable reason for `DELIVERED_LOCAL_ERROR`. */
  error?: string;
}

/**
 * The "Sent X of Y, Z remaining" outcome (FR-019).
 */
export interface BundlePartialOutcome {
  bundleId: string;
  totalAmount: number;
  deliveredAmount: number;
  remainingAmount: number;
  unit: string;
  decimals: number;
  /** ISO 8601; bundle's createdAt + 24h (FR-021). */
  retryUntil: string;
  failedPartCount: number;
}

/**
 * Full success outcome.
 */
export interface BundleCompleteResult {
  bundleId: string;
  totalAmount: number;
  unit: string;
  decimals: number;
  partsCount: number;
  deliveredAt: string;
  /** Transaction record ID created in the local TransactionStore. */
  transactionId: string;
}

/**
 * Distinguished error codes the orchestrator throws or emits via onError.
 *
 * Per contracts/bundle-orchestrator-interface.md §1.3.
 */
export type BundleSendErrorCode =
  | 'INSUFFICIENT_BALANCE'         // Pre-flight (FR-006)
  | 'INSUFFICIENT_BALANCE_RETRY'   // Retry-time reselection failed (FR-021 sub-case)
  | 'CONCURRENT_BUNDLE'            // Another bundle for the same merchant group is in flight
  | 'RECIPIENT_RESOLVE_FAILED'
  | 'USER_CANCELLED_SOFTCAP'
  | 'ALL_PARTS_FAILED'             // Terminal FAILED state
  | 'INVALID_PLAN'                 // Pre-flight validation failure
  | 'CUTOVER_REQUIRED'             // Orphan consolidation operations must be drained first
  | 'BUNDLE_NOT_FOUND'             // retryRemainder / dismissPartial called with unknown bundleId
  | 'BUNDLE_NOT_RETRYABLE'         // bundleId is not in PARTIAL state, or 24h retry window elapsed
  | 'BUNDLE_NOT_DISMISSABLE';      // dismissPartial called on a terminal entry

export class BundleSendError extends Error {
  code: BundleSendErrorCode;
  bundleId?: string;
  attempt?: number;

  constructor(message: string, code: BundleSendErrorCode, bundleId?: string, attempt?: number) {
    super(message);
    this.name = 'BundleSendError';
    this.code = code;
    this.bundleId = bundleId;
    this.attempt = attempt;
  }
}

/* ---------- Convenience re-exports ---------- */

export type { Voucher, MerchantGroup, Recipient };
