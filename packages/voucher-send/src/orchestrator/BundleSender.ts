/**
 * BundleSender — multi-source send orchestrator (spec 012-multi-voucher-send).
 *
 * Per `contracts/bundle-orchestrator-interface.md` §1 and `data-model.md`.
 *
 * Layered above the existing per-saga atomic-send (FR-007). For each user-initiated
 * send we:
 *   1. Build a BundlePlan in earliest-expiry-first order from a candidate voucher set
 *      (FR-002, FR-003).
 *   2. Short-circuit to a standalone send when the plan only needs one source voucher
 *      (no bundle metadata emitted; SC-007 no-regression).
 *   3. Otherwise, journal the bundle to localStorage BEFORE the first side effect
 *      (FR-024a), then issue N atomic-send calls with bundle metadata + a derived
 *      idempotency key per Phase 0 R6.
 *   4. Update local voucher state per FR-008 / FR-009a as parts deliver — the
 *      change-bearing last part keeps its source voucher's expiry intact.
 *   5. Surface ONE logical outcome to the caller (success / partial / failure).
 *
 * This module is a pure typed core: no DOM, no globals, no `window.*`. The vanilla-JS
 * bridge `shared/bundleSendOrchestrator.js` injects the adapters and wires the
 * callbacks to the page UI.
 */

import { BundleSendError } from '../types/bundle';
import type {
  BundlePlan,
  BundlePartPlan,
  BundleSendJournalEntry,
  BundleSubSendRecord,
  BundleSendParams,
  BundleSendPlanSummary,
  BundlePartialOutcome,
  BundleCompleteResult,
  BundleResumeResult,
  Voucher,
  MerchantGroup,
} from '../types/bundle';

/* =========================================================================
 * Adapter contracts — what BundleSender needs from the host environment.
 * =======================================================================*/

/**
 * What an "atomic-send call" looks like at the gateway-app boundary.
 * Mirrors the subset of `api.initiateAtomicSend` request fields that
 * BundleSender controls per part (the bridge layer fills in the rest).
 */
export interface AtomicSendInitiateParams {
  token: string;
  amount: number;
  recipientPubkey: string;
  memo?: string | null;
  faceValue?: number;
  faceUnit?: string;
  faceDecimals?: number;
  voucherId?: string;
  issuerId?: string | null;
  backingStrategy?: string | null;
  expiresAt?: number | null;
  // Bundle metadata (spec 012). All present-or-absent together (R3 + atomic-send-api §2).
  bundleId?: string;
  bundleTotal?: number;
  bundlePartIndex?: number;
  bundlePartCount?: number;
  bundlePartId?: string;
  bundleAttempt?: number;
}

export interface AtomicSendInitialResult {
  send_id: string;
  status: string;
  keep_token?: string | null;
}

export interface AtomicSendTerminalResult {
  status: 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'DM_ERROR' | 'RECLAIM_READY' | 'SPLIT_ERROR' | string;
  keep_token?: string | null;
  keep_face_value?: number | null;
  is_full_send?: boolean;
  error_code?: string | null;
}

/**
 * The API-side adapter the orchestrator uses. The bridge wraps the existing
 * `shared/api.js` and `shared/atomicSendIntegration.js` to satisfy this surface.
 */
export interface BundleSendApiAdapter {
  /** Issues `POST /api/v1/atomic-send` with the supplied per-part idempotency key. */
  initiateAtomicSend(
    params: AtomicSendInitiateParams,
    idempotencyKey: string
  ): Promise<AtomicSendInitialResult>;

  /**
   * Resolves when the saga reaches a terminal state (COMPLETED / FAILED / etc).
   * Implementation typically wraps `subscribeToSendProgress` with a Promise.
   */
  awaitTerminal(sendId: string): Promise<AtomicSendTerminalResult>;

  /**
   * One-shot status read for `BundleSender.resumePending` (FR-024a).
   * Returns the saga's current state — terminal if known, `{status: 'PENDING'}`
   * (or other non-terminal) if the backend still has the saga in-flight.
   * Optional: implementations that don't support out-of-band status lookup may
   * omit this method; resumePending will treat such bundles as needing re-issue.
   */
  getAtomicSendStatus?(sendId: string): Promise<AtomicSendTerminalResult>;

  /**
   * Spec 013 Layer 3 — ack-driven retention. After the orchestrator has
   * successfully applied a keep_token locally (via
   * {@link BundleSendVoucherAdapter#applyKeepToken}), it calls this to tell
   * the backend the bearer material can be cleared from its in-flight store.
   * Optional: implementations without ack support may omit; retention then
   * relies on the backend's fallback cleanup (typically 48h).
   */
  ackKeepToken?(sendId: string): Promise<void>;
}

/**
 * The local voucher mutations BundleSender needs to perform after each delivery.
 * The bridge wires these to the existing storage helpers (debitVoucher,
 * deleteVoucher, updateVoucherAfterSplit).
 */
export interface BundleSendVoucherAdapter {
  /**
   * Apply the keep-token to the source voucher (or remove it if fully consumed).
   * Per FR-008 + FR-009a: the source voucher's expiry MUST be carried on the
   * change voucher unchanged — implementations enforce this.
   *
   * @param voucherId Local source voucher ID.
   * @param partAmount Amount drawn from this source.
   * @param keepToken Replacement Cashu token for the residual value, or null if
   *                  the source was fully consumed.
   * @param keepFaceValue Face value of the keep-token in minor units (or null).
   * @param keepTokenAmount Sats of the keep-token (or null).
   * @param sourceExpiresAt The source voucher's original ISO expiry — the keep
   *                  voucher MUST inherit this value untouched.
   */
  applyKeepToken(
    voucherId: string,
    partAmount: number,
    keepToken: string | null,
    keepFaceValue: number | null,
    keepTokenAmount: number | null,
    sourceExpiresAt: string | null
  ): Promise<void>;

  /**
   * Release the bundle-level reservation on a source voucher (FR-020).
   * Called when a sub-send terminates FAILED, before the bundle's PARTIAL or FAILED
   * outcome is surfaced. NEVER called for DELIVERED parts (their lock is consumed by
   * `applyKeepToken`).
   *
   * Optional: bridges that don't track per-bundle UI locks may omit this method.
   * The orchestrator calls it via `?.()`.
   */
  releaseBundleReservation?(voucherId: string, bundleId: string): Promise<void>;
}

/**
 * Persistent journal the orchestrator writes through. The bridge wires this
 * to the spec-012 storage helpers (`shared/bundleSendJournal.js`).
 */
export interface BundleSendJournalAdapter {
  /** First write — typically transitions a fresh plan into RESERVED. */
  begin(entry: BundleSendJournalEntry): Promise<BundleSendJournalEntry>;
  /** Subsequent state / counter updates. */
  upsert(entry: BundleSendJournalEntry): Promise<BundleSendJournalEntry>;
  /** Convenience: terminal transition with optional error code. */
  markTerminal(
    bundleId: string,
    terminalState: 'DELIVERED' | 'FAILED' | 'ABANDONED',
    errorCode?: string | null
  ): Promise<BundleSendJournalEntry | null>;
  /**
   * Lookup an entry by bundle_id (US3 — required for retryRemainder / dismissPartial).
   * The bridge implementation is per-user-bound so does not need a userId argument.
   */
  get?(bundleId: string): Promise<BundleSendJournalEntry | null>;
  /**
   * List entries in non-terminal states (RESERVED / EXECUTING / PARTIAL).
   * Used by `BundleSender.resumePending` (FR-024a). The userId argument is honored
   * by global-scoped adapters; per-user-bound adapters may ignore it.
   */
  listInflight?(userId?: string): Promise<BundleSendJournalEntry[]>;
}

/**
 * Reselects an eligible voucher set at retry time. Required for `retryRemainder`
 * (FR-021): the retry MUST use currently-eligible vouchers, not the original plan's.
 * The bridge wires this to today's `selectVouchersForAmount`.
 */
export interface BundleSendSelectionAdapter {
  selectVouchersForAmount(
    merchantGroupKey: string,
    amount: number
  ): Promise<BundleCandidateSelection>;
}

/**
 * Receiver-side display recording (the bridge wires this to TransactionStore.record).
 * Per FR-009 a successful bundle creates exactly one outgoing transaction entry.
 */
export interface BundleSendTransactionAdapter {
  recordSentBundle(input: {
    bundleId: string;
    totalAmount: number;
    faceUnit: string;
    faceDecimals: number;
    recipientPubkeyHex: string;
    recipientDisplayName?: string;
    issuerId?: string | null;
    memo?: string | null;
    deliveredAt: Date;
    partsCount: number;
  }): Promise<{ transactionId: string }>;
}

export interface BundleSendIdAdapter {
  /** 32-char lower hex (Phase 0 R1). Tests may inject deterministic IDs. */
  newBundleId(): string;
}

export interface BundleSendClockAdapter {
  now(): Date;
}

export interface BundleSendAdapters {
  api: BundleSendApiAdapter;
  voucher: BundleSendVoucherAdapter;
  journal: BundleSendJournalAdapter;
  transaction: BundleSendTransactionAdapter;
  ids: BundleSendIdAdapter;
  clock: BundleSendClockAdapter;
  /**
   * Optional. Required only when `retryRemainder` is invoked — the orchestrator
   * uses it to reselect currently-eligible vouchers (FR-021). Original `send`
   * calls do not consult this adapter.
   */
  selection?: BundleSendSelectionAdapter;
}

/* =========================================================================
 * Telemetry — local helper that defers to a host logger when present, falls
 * back to a structured console line otherwise. The whitelist is enforced by
 * the host (shared/bundleLog.js R13); this module only emits known fields.
 * =======================================================================*/

type LogLevel = 'info' | 'warn' | 'error';

export interface BundleLogger {
  log(level: LogLevel, event: string, fields: Record<string, unknown>): void;
}

const noopLogger: BundleLogger = {
  log: () => {
    // No-op. Tests inject their own; the bridge injects shared/bundleLog.js.
  },
};

/* =========================================================================
 * Selection input — what the page provides to BundleSender.
 * =======================================================================*/

/**
 * The shape returned by today's `selectVouchersForAmount` in `shared/storage.js`.
 * BundleSender accepts it directly so the bridge layer doesn't need to translate.
 */
export interface BundleCandidateSelection {
  vouchers: Voucher[];
  needsConsolidation: boolean;
  totalAvailable: number;
  isValid: boolean;
  reason?: string | null;
  voucherIds?: string[];
  groupMetadata?: {
    merchantId?: string;
    unit?: string;
    decimals?: number;
    mintDomain?: string;
    expiresAt?: string | null;
  };
}

/* =========================================================================
 * BundleSender
 * =======================================================================*/

export interface BundleSenderConfig {
  adapters: BundleSendAdapters;
  logger?: BundleLogger;
  /**
   * Soft cap on bundle size. At-or-above this many parts the orchestrator
   * awaits `callbacks.onSoftCapWarning` before executing. Default per spec
   * Edge Cases: 10 parts.
   */
  softCapParts?: number;
}

export class BundleSender {
  private readonly adapters: BundleSendAdapters;
  private readonly logger: BundleLogger;
  private readonly softCapParts: number;

  constructor(config: BundleSenderConfig) {
    this.adapters = config.adapters;
    this.logger = config.logger ?? noopLogger;
    this.softCapParts = config.softCapParts ?? 10;
  }

  /**
   * Plan, journal, and execute a multi-source send.
   *
   * Caller responsibility:
   *   - Resolve `recipient` to a hex pubkey beforehand (BundleSender does not
   *     do recipient resolution; that lives in the existing send.js flow).
   *   - Provide a fresh `selection` from `selectVouchersForAmount(group, amount)`.
   *   - Implement the storage / journal / transaction adapters.
   *
   * @param params - High-level inputs (recipient + merchant group + amount + UI callbacks)
   * @param selection - Pre-computed voucher-selection result for this amount.
   * @returns The terminal outcome (success result, partial outcome, or thrown error).
   */
  async send(params: BundleSendParams, selection: BundleCandidateSelection): Promise<BundleCompleteResult | BundlePartialOutcome> {
    if (!params.userId) {
      throw new BundleSendError('userId is required', 'INVALID_PLAN');
    }
    if (!selection || !selection.isValid) {
      // Map to FR-006 with a message that names the gap, not the legacy
      // "no single voucher" wording.
      const available = selection?.totalAvailable ?? 0;
      throw new BundleSendError(
        `Insufficient balance for this merchant group. Need ${params.amount}, have ${available}.`,
        'INSUFFICIENT_BALANCE'
      );
    }
    if (!Array.isArray(selection.vouchers) || selection.vouchers.length === 0) {
      throw new BundleSendError('Selection produced no source vouchers', 'INVALID_PLAN');
    }

    const recipientHex = this.resolveRecipientHex(params.recipient);
    if (!recipientHex) {
      throw new BundleSendError('Recipient pubkey could not be resolved', 'RECIPIENT_RESOLVE_FAILED');
    }

    // Build the plan in earliest-expiry-first order (FR-002, FR-003).
    const plan = this.buildPlan(params, selection, recipientHex);

    // Single-voucher short-circuit (SC-007). Emit one standalone send with NO bundle
    // metadata — wire output is identical to today's single-voucher path.
    if (plan.parts.length === 1) {
      return this.executeSingleVoucherShortCircuit(params, plan, recipientHex);
    }

    // Soft cap (R10 / Edge Cases): warn the user before running >= 10-part bundles.
    if (plan.parts.length >= this.softCapParts) {
      const decision = await (params.callbacks.onSoftCapWarning?.(plan.parts.length) ??
        Promise.resolve('proceed'));
      if (decision !== 'proceed') {
        throw new BundleSendError(
          'Cancelled by user at soft-cap warning',
          'USER_CANCELLED_SOFTCAP',
          plan.bundleId
        );
      }
    }

    // Surface plan to UI (lets the page show "preparing N vouchers").
    const summary: BundleSendPlanSummary = {
      bundleId: plan.bundleId,
      totalAmount: plan.totalAmount,
      partsCount: plan.parts.length,
      unit: plan.faceUnit,
      decimals: plan.faceDecimals,
    };
    params.callbacks.onPlanReady?.(summary);
    this.logger.log('info', 'plan_built', {
      bundle_id: plan.bundleId,
      part_count: plan.parts.length,
      total_amount: plan.totalAmount,
      face_unit: plan.faceUnit,
    });

    // Journal RESERVED before any side effect (FR-024a).
    const journalEntry = await this.adapters.journal.begin(this.toJournalEntry(params, plan, 'RESERVED', 0, []));

    // Execute parts sequentially in earliest-expiry-first order.
    const subRecords: BundleSubSendRecord[] = plan.parts.map((p) => ({
      partIndex: p.partIndex,
      partId: p.partId,
      sourceVoucherId: p.sourceVoucherId,
      sourceVoucherExpiresAt: p.sourceVoucherExpiresAt,
      partAmount: p.partAmount,
      idempotencyKey: p.idempotencyKey,
      state: 'PLANNED',
      sendId: null,
      deliveredAt: null,
      failedAt: null,
      errorCode: null,
      keepTokenFaceValue: null,
      keepTokenExpiresAt: null,
    }));
    let deliveredAmount = 0;
    let firstError: { partIndex: number; errorCode: string } | null = null;

    // Mark journal EXECUTING.
    await this.adapters.journal.upsert({
      ...journalEntry,
      state: 'EXECUTING',
      parts: subRecords,
      updatedAt: this.adapters.clock.now().toISOString(),
    });

    for (const part of plan.parts) {
      const sub = subRecords[part.partIndex];

      sub.state = 'EXECUTING';
      params.callbacks.onPartProgress?.({
        bundleId: plan.bundleId,
        partIndex: part.partIndex,
        partCount: plan.parts.length,
        state: 'EXECUTING',
      });
      this.logger.log('info', 'part_executing', {
        bundle_id: plan.bundleId,
        part_index: part.partIndex,
        part_count: plan.parts.length,
        attempt: plan.attempt,
      });

      const initialOrTerminal = await this.tryInitiate(part, plan, recipientHex, params.memo ?? null);
      if (!initialOrTerminal.ok) {
        sub.state = 'FAILED';
        sub.failedAt = this.adapters.clock.now().toISOString();
        sub.errorCode = initialOrTerminal.errorCode;
        if (!firstError) {
          firstError = { partIndex: part.partIndex, errorCode: initialOrTerminal.errorCode };
        }
        params.callbacks.onPartProgress?.({
          bundleId: plan.bundleId,
          partIndex: part.partIndex,
          partCount: plan.parts.length,
          state: 'FAILED',
          errorCode: initialOrTerminal.errorCode,
        });
        this.logger.log('warn', 'part_failed', {
          bundle_id: plan.bundleId,
          part_index: part.partIndex,
          error_code: initialOrTerminal.errorCode,
        });
        await this.adapters.journal.upsert({
          ...journalEntry,
          state: 'EXECUTING',
          parts: subRecords,
          delivered_amount: deliveredAmount,
          updatedAt: this.adapters.clock.now().toISOString(),
        } as unknown as BundleSendJournalEntry);
        continue;
      }
      sub.sendId = initialOrTerminal.sendId;
      const terminal = initialOrTerminal.terminal;

      if (this.isTerminalSuccess(terminal.status)) {
        sub.state = 'DELIVERED';
        sub.deliveredAt = this.adapters.clock.now().toISOString();
        sub.keepTokenFaceValue = terminal.keep_face_value ?? null;
        // FR-009a: change voucher's expiry MUST equal the source voucher's expiry.
        sub.keepTokenExpiresAt = part.sourceVoucherExpiresAt;
        // deliveredAmount tracks recipient-side delivery (the DM was published);
        // it stays incremented even when local apply fails (mint already spent).
        deliveredAmount += part.partAmount;

        // Spec 013 high-2: gate ack-driven retention on applyKeepToken success.
        // If local apply throws (validation mismatch, storage failure, etc.) we
        // record the error on the sub AND skip the ack so the backend's 48h
        // fallback retains the bearer material for retry/recovery.
        let applyOk = false;
        try {
          await this.adapters.voucher.applyKeepToken(
            part.sourceVoucherId,
            part.partAmount,
            terminal.keep_token ?? null,
            terminal.keep_face_value ?? null,
            null, // keepTokenAmount is computed by host (existing logic) — we pass through null
            part.sourceVoucherExpiresAt
          );
          applyOk = true;
          sub.localApplyError = null;
        } catch (e) {
          sub.localApplyError = (e as Error).message;
          this.logger.log('error', 'voucher_debit_failed', {
            bundle_id: plan.bundleId,
            part_index: part.partIndex,
            error_code: sub.localApplyError,
          });
        }

        // Ack-driven retention runs ONLY after a successful local apply.
        if (applyOk) {
          await this.maybeAckKeepToken(plan.bundleId, part.partIndex, sub.sendId, terminal.keep_token);
        }

        params.callbacks.onPartProgress?.({
          bundleId: plan.bundleId,
          partIndex: part.partIndex,
          partCount: plan.parts.length,
          state: applyOk ? 'DELIVERED' : 'DELIVERED_LOCAL_ERROR',
          ...(applyOk ? {} : { error: sub.localApplyError ?? 'apply_keep_failed' }),
        });
        this.logger.log('info', 'part_delivered', {
          bundle_id: plan.bundleId,
          part_index: part.partIndex,
          part_count: plan.parts.length,
          face_value: part.partAmount,
        });
      } else {
        // Terminal but not success.
        sub.state = 'FAILED';
        sub.failedAt = this.adapters.clock.now().toISOString();
        sub.errorCode = terminal.error_code ?? terminal.status ?? 'unknown';
        if (!firstError) {
          firstError = { partIndex: part.partIndex, errorCode: sub.errorCode! };
        }
        params.callbacks.onPartProgress?.({
          bundleId: plan.bundleId,
          partIndex: part.partIndex,
          partCount: plan.parts.length,
          state: 'FAILED',
          errorCode: sub.errorCode!,
        });
        this.logger.log('warn', 'part_failed', {
          bundle_id: plan.bundleId,
          part_index: part.partIndex,
          error_code: sub.errorCode!,
        });
      }

      await this.adapters.journal.upsert({
        ...journalEntry,
        state: 'EXECUTING',
        parts: subRecords,
        delivered_amount: deliveredAmount,
        updatedAt: this.adapters.clock.now().toISOString(),
      } as unknown as BundleSendJournalEntry);
    }

    const allDelivered = subRecords.every((r) => r.state === 'DELIVERED');
    const anyDelivered = subRecords.some((r) => r.state === 'DELIVERED');

    if (allDelivered) {
      const deliveredAt = this.adapters.clock.now();
      const txResult = await this.adapters.transaction.recordSentBundle({
        bundleId: plan.bundleId,
        totalAmount: plan.totalAmount,
        faceUnit: plan.faceUnit,
        faceDecimals: plan.faceDecimals,
        recipientPubkeyHex: recipientHex,
        recipientDisplayName: typeof params.recipient === 'object' ? params.recipient.displayName : undefined,
        issuerId: this.firstIssuerId(selection),
        memo: params.memo ?? null,
        deliveredAt,
        partsCount: plan.parts.length,
      });
      await this.adapters.journal.markTerminal(plan.bundleId, 'DELIVERED');

      const result: BundleCompleteResult = {
        bundleId: plan.bundleId,
        totalAmount: plan.totalAmount,
        unit: plan.faceUnit,
        decimals: plan.faceDecimals,
        partsCount: plan.parts.length,
        deliveredAt: deliveredAt.toISOString(),
        transactionId: txResult.transactionId,
      };
      params.callbacks.onComplete?.(result);
      this.logger.log('info', 'bundle_complete', {
        bundle_id: plan.bundleId,
        outcome: 'DELIVERED',
        face_value: plan.totalAmount,
      });
      return result;
    }

    if (!anyDelivered) {
      // All parts failed → terminal FAILED. Release every failed part's reservation (FR-020 +
      // contract §1.4 postcondition for non-partial errors: "all source-voucher locks released").
      await this.releaseFailedPartReservations(plan.bundleId, subRecords);
      const errorCode = firstError?.errorCode ?? 'all_parts_failed';
      await this.adapters.journal.markTerminal(plan.bundleId, 'FAILED', errorCode);
      const error = new BundleSendError(
        `All ${plan.parts.length} sub-sends failed (${errorCode})`,
        'ALL_PARTS_FAILED',
        plan.bundleId,
        plan.attempt
      );
      params.callbacks.onError?.(error);
      this.logger.log('error', 'bundle_failed', {
        bundle_id: plan.bundleId,
        outcome: 'FAILED',
        error_code: errorCode,
      });
      throw error;
    }

    // Mixed outcome → PARTIAL (US3 territory). Release the failed parts' source-voucher locks
    // per FR-020 BEFORE emitting onPartialOutcome so the UI can show the released vouchers as
    // re-selectable. (FR-020 explicitly forbids holding the lock for the 24h retry window.)
    await this.releaseFailedPartReservations(plan.bundleId, subRecords);
    const partial: BundlePartialOutcome = {
      bundleId: plan.bundleId,
      totalAmount: plan.totalAmount,
      deliveredAmount,
      remainingAmount: plan.totalAmount - deliveredAmount,
      unit: plan.faceUnit,
      decimals: plan.faceDecimals,
      retryUntil: new Date(this.adapters.clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
      failedPartCount: subRecords.filter((r) => r.state === 'FAILED').length,
    };
    // Persist as PARTIAL via upsert (markTerminal would close the door on retries).
    await this.adapters.journal.upsert({
      ...journalEntry,
      state: 'PARTIAL',
      parts: subRecords,
      deliveredAmount,
      lastErrorCode: firstError?.errorCode ?? null,
      updatedAt: this.adapters.clock.now().toISOString(),
    });

    params.callbacks.onPartialOutcome?.(partial);
    this.logger.log('warn', 'bundle_partial', {
      bundle_id: plan.bundleId,
      outcome: 'PARTIAL',
      face_value: deliveredAmount,
      part_count: plan.parts.length,
    });
    return partial;
  }

  /* ---------- Plan construction ---------- */

  private buildPlan(
    params: BundleSendParams,
    selection: BundleCandidateSelection,
    recipientHex: string
  ): BundlePlan {
    const sortedVouchers = this.sortByExpiryFirst(selection.vouchers);
    const parts: BundlePartPlan[] = [];
    let remaining = params.amount;
    const bundleId = this.adapters.ids.newBundleId();
    const attempt = 0;

    for (let i = 0; i < sortedVouchers.length && remaining > 0; i++) {
      const v = sortedVouchers[i];
      const available = this.faceValueOf(v);
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      const partIndex = parts.length;
      parts.push({
        partIndex,
        sourceVoucherId: v.voucher_id,
        sourceVoucherToken: v.token ?? '',
        sourceVoucherExpiresAt: this.expiresAtOf(v),
        partAmount: take,
        partId: `${bundleId}:${partIndex}`,
        idempotencyKey: `bundle:${bundleId}:${partIndex}:${attempt}`,
      });
      remaining -= take;
    }

    if (remaining > 0) {
      throw new BundleSendError(
        `Insufficient balance: need ${params.amount}, can cover ${params.amount - remaining}`,
        'INSUFFICIENT_BALANCE'
      );
    }

    const groupKey = this.merchantGroupKey(params.merchantGroup);
    const unit = params.merchantGroup.unit ?? 'SAT';
    const decimals = params.merchantGroup.decimals ?? 0;

    const plan: BundlePlan = {
      bundleId,
      recipientPubkeyHex: recipientHex,
      merchantGroupKey: groupKey,
      totalAmount: params.amount,
      faceUnit: unit,
      faceDecimals: decimals,
      parts,
      createdAt: this.adapters.clock.now().toISOString(),
      attempt,
    };
    return plan;
  }

  private toJournalEntry(
    params: BundleSendParams,
    plan: BundlePlan,
    state: BundleSendJournalEntry['state'],
    deliveredAmount: number,
    parts: BundleSubSendRecord[]
  ): BundleSendJournalEntry {
    return {
      bundleId: plan.bundleId,
      userId: params.userId,
      state,
      recipientPubkeyHex: plan.recipientPubkeyHex,
      merchantGroupKey: plan.merchantGroupKey,
      totalAmount: plan.totalAmount,
      deliveredAmount,
      faceUnit: plan.faceUnit,
      faceDecimals: plan.faceDecimals,
      parts,
      attempt: plan.attempt,
      parentBundleId: null,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
      lastErrorCode: null,
      cutoverOrigin: null,
    };
  }

  private async tryInitiate(
    part: BundlePartPlan,
    plan: BundlePlan,
    recipientHex: string,
    memo: string | null
  ): Promise<
    | { ok: true; sendId: string; terminal: AtomicSendTerminalResult }
    | { ok: false; errorCode: string }
  > {
    try {
      const initial = await this.adapters.api.initiateAtomicSend(
        {
          token: part.sourceVoucherToken,
          amount: part.partAmount,
          recipientPubkey: recipientHex,
          memo,
          faceValue: part.partAmount,
          faceUnit: plan.faceUnit,
          faceDecimals: plan.faceDecimals,
          voucherId: part.sourceVoucherId,
          expiresAt: this.toUnixSeconds(part.sourceVoucherExpiresAt),
          bundleId: plan.bundleId,
          bundleTotal: plan.totalAmount,
          bundlePartIndex: part.partIndex,
          bundlePartCount: plan.parts.length,
          bundlePartId: part.partId,
          bundleAttempt: plan.attempt,
        },
        part.idempotencyKey
      );

      // If the saga reaches a terminal status synchronously, surface it directly.
      if (this.isTerminalAny(initial.status)) {
        return {
          ok: true,
          sendId: initial.send_id,
          terminal: {
            status: initial.status,
            keep_token: initial.keep_token ?? null,
          },
        };
      }
      // Otherwise wait for the SSE-driven terminal.
      const terminal = await this.adapters.api.awaitTerminal(initial.send_id);
      return { ok: true, sendId: initial.send_id, terminal };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, errorCode: err.code ?? err.message ?? 'initiate_failed' };
    }
  }

  /**
   * Single-voucher path: identical to today's existing single-shot send.
   * No bundle metadata, no journaling, no debit (caller handles).
   */
  private async executeSingleVoucherShortCircuit(
    params: BundleSendParams,
    plan: BundlePlan,
    recipientHex: string
  ): Promise<BundleCompleteResult> {
    const part = plan.parts[0];
    const initial = await this.adapters.api.initiateAtomicSend(
      {
        token: part.sourceVoucherToken,
        amount: part.partAmount,
        recipientPubkey: recipientHex,
        memo: params.memo ?? null,
        faceValue: part.partAmount,
        faceUnit: plan.faceUnit,
        faceDecimals: plan.faceDecimals,
        voucherId: part.sourceVoucherId,
        expiresAt: this.toUnixSeconds(part.sourceVoucherExpiresAt),
      },
      part.idempotencyKey
    );

    let terminal: AtomicSendTerminalResult;
    if (this.isTerminalAny(initial.status)) {
      terminal = { status: initial.status, keep_token: initial.keep_token ?? null };
    } else {
      terminal = await this.adapters.api.awaitTerminal(initial.send_id);
    }

    if (!this.isTerminalSuccess(terminal.status)) {
      const errorCode = terminal.error_code ?? terminal.status ?? 'send_failed';
      throw new BundleSendError(
        `Single-voucher send failed: ${errorCode}`,
        'ALL_PARTS_FAILED',
        plan.bundleId
      );
    }

    // Spec 013 high-2: gate ack on local apply success (mirror of bundle path).
    let applyOk = false;
    try {
      await this.adapters.voucher.applyKeepToken(
        part.sourceVoucherId,
        part.partAmount,
        terminal.keep_token ?? null,
        terminal.keep_face_value ?? null,
        null,
        part.sourceVoucherExpiresAt
      );
      applyOk = true;
    } catch (e) {
      this.logger.log('error', 'voucher_debit_failed', {
        bundle_id: plan.bundleId,
        part_index: 0,
        error_code: (e as Error).message,
      });
    }

    if (applyOk) {
      // Spec 013 Layer 3 — ack-driven retention (mirror of the bundle path).
      await this.maybeAckKeepToken(plan.bundleId, 0, initial.send_id, terminal.keep_token);
    }

    const deliveredAt = this.adapters.clock.now();
    const txResult = await this.adapters.transaction.recordSentBundle({
      bundleId: plan.bundleId,
      totalAmount: plan.totalAmount,
      faceUnit: plan.faceUnit,
      faceDecimals: plan.faceDecimals,
      recipientPubkeyHex: recipientHex,
      recipientDisplayName: typeof params.recipient === 'object' ? params.recipient.displayName : undefined,
      issuerId: null,
      memo: params.memo ?? null,
      deliveredAt,
      partsCount: 1,
    });

    const result: BundleCompleteResult = {
      bundleId: plan.bundleId,
      totalAmount: plan.totalAmount,
      unit: plan.faceUnit,
      decimals: plan.faceDecimals,
      partsCount: 1,
      deliveredAt: deliveredAt.toISOString(),
      transactionId: txResult.transactionId,
    };
    params.callbacks.onComplete?.(result);
    this.logger.log('info', 'bundle_complete', {
      bundle_id: plan.bundleId,
      outcome: 'DELIVERED',
      face_value: plan.totalAmount,
      part_count: 1,
    });
    return result;
  }

  /* =========================================================================
   * US3 — Partial-failure recovery: retry, dismiss, and crash resume.
   * Per contracts/bundle-orchestrator-interface.md §1.2.
   * =======================================================================*/

  /**
   * Retry just the undelivered remainder of a previously-PARTIAL bundle (FR-021, FR-022).
   *
   * Reuses the original `bundle_id` so the receiver updates its existing entry in place
   * (FR-011a + FR-022). Allocates fresh `part_index` values starting at the original
   * `parts.length` (Phase 0 R2) and increments `attempt` (R6).
   *
   * Vouchers are reselected from the currently-eligible set via the selection adapter
   * (FR-021); the original failed voucher may or may not be present.
   */
  async retryRemainder(bundleId: string): Promise<BundleCompleteResult | BundlePartialOutcome> {
    if (!this.adapters.journal.get) {
      throw new BundleSendError('journal.get adapter is required for retryRemainder', 'INVALID_PLAN', bundleId);
    }
    if (!this.adapters.selection) {
      throw new BundleSendError('selection adapter is required for retryRemainder', 'INVALID_PLAN', bundleId);
    }
    const original = await this.adapters.journal.get(bundleId);
    if (!original) {
      throw new BundleSendError(`Bundle ${bundleId} not found`, 'BUNDLE_NOT_FOUND', bundleId);
    }
    if (original.state !== 'PARTIAL') {
      throw new BundleSendError(
        `Bundle ${bundleId} is in state ${original.state}; only PARTIAL bundles can be retried`,
        'BUNDLE_NOT_RETRYABLE',
        bundleId
      );
    }
    const createdMs = Date.parse(original.createdAt);
    if (Number.isFinite(createdMs) && this.adapters.clock.now().getTime() - createdMs > 24 * 60 * 60 * 1000) {
      throw new BundleSendError(
        `Bundle ${bundleId} retry window (24h) has elapsed`,
        'BUNDLE_NOT_RETRYABLE',
        bundleId
      );
    }

    const remainingAmount = original.totalAmount - original.deliveredAmount;
    if (remainingAmount <= 0) {
      // Nothing to retry — defensive; arrived here through an inconsistent journal state.
      throw new BundleSendError(`Bundle ${bundleId} has no remaining amount`, 'BUNDLE_NOT_RETRYABLE', bundleId);
    }

    // Reselect from currently-eligible vouchers (FR-021).
    const reSelection = await this.adapters.selection.selectVouchersForAmount(
      original.merchantGroupKey,
      remainingAmount
    );
    if (!reSelection || !reSelection.isValid) {
      const available = reSelection?.totalAvailable ?? 0;
      throw new BundleSendError(
        `Cannot cover remainder: need ${remainingAmount}, have ${available}.`,
        'INSUFFICIENT_BALANCE_RETRY',
        bundleId
      );
    }

    // Build a retry plan with bundleId reused, attempt incremented, and
    // part_index allocated fresh starting at original.parts.length (R2).
    const newAttempt = original.attempt + 1;
    const startIndex = original.parts.length;
    const sortedRetryVouchers = this.sortByExpiryFirst(reSelection.vouchers);
    const retryParts: BundlePartPlan[] = [];
    let remaining = remainingAmount;
    for (let i = 0; i < sortedRetryVouchers.length && remaining > 0; i++) {
      const v = sortedRetryVouchers[i];
      const available = this.faceValueOf(v);
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      const partIndex = startIndex + retryParts.length;
      retryParts.push({
        partIndex,
        sourceVoucherId: v.voucher_id,
        sourceVoucherToken: v.token ?? '',
        sourceVoucherExpiresAt: this.expiresAtOf(v),
        partAmount: take,
        partId: `${bundleId}:${partIndex}`,
        idempotencyKey: `bundle:${bundleId}:${partIndex}:${newAttempt}`,
      });
      remaining -= take;
    }
    if (remaining > 0) {
      throw new BundleSendError(
        `Cannot cover remainder: need ${remainingAmount}, can cover ${remainingAmount - remaining}.`,
        'INSUFFICIENT_BALANCE_RETRY',
        bundleId
      );
    }

    const retryPlan: BundlePlan = {
      bundleId,
      recipientPubkeyHex: original.recipientPubkeyHex,
      merchantGroupKey: original.merchantGroupKey,
      totalAmount: remainingAmount,
      faceUnit: original.faceUnit,
      faceDecimals: original.faceDecimals,
      parts: retryParts,
      createdAt: this.adapters.clock.now().toISOString(),
      attempt: newAttempt,
    };

    this.logger.log('info', 'retry_planned', {
      bundle_id: bundleId,
      attempt: newAttempt,
      part_count: retryParts.length,
      face_value: remainingAmount,
    });

    // Execute and merge results into the original journal entry.
    const newSubRecords: BundleSubSendRecord[] = retryParts.map((p) => this.toFreshSubRecord(p));
    let updatedEntry: BundleSendJournalEntry = {
      ...original,
      state: 'EXECUTING',
      attempt: newAttempt,
      parts: [...original.parts, ...newSubRecords],
      updatedAt: this.adapters.clock.now().toISOString(),
    };
    updatedEntry = await this.adapters.journal.upsert(updatedEntry);

    let deliveredAmount = original.deliveredAmount;
    let firstError: { partIndex: number; errorCode: string } | null = null;

    for (const part of retryParts) {
      const sub = newSubRecords.find((r) => r.partIndex === part.partIndex)!;
      sub.state = 'EXECUTING';
      this.logger.log('info', 'part_executing', {
        bundle_id: bundleId,
        part_index: part.partIndex,
        part_count: retryParts.length,
        attempt: newAttempt,
      });

      const outcome = await this.tryInitiate(part, retryPlan, original.recipientPubkeyHex, null);
      if (!outcome.ok) {
        sub.state = 'FAILED';
        sub.failedAt = this.adapters.clock.now().toISOString();
        sub.errorCode = outcome.errorCode;
        if (!firstError) firstError = { partIndex: part.partIndex, errorCode: outcome.errorCode };
        this.logger.log('warn', 'part_failed', { bundle_id: bundleId, part_index: part.partIndex, error_code: outcome.errorCode });
        continue;
      }
      sub.sendId = outcome.sendId;
      const terminal = outcome.terminal;
      if (this.isTerminalSuccess(terminal.status)) {
        sub.state = 'DELIVERED';
        sub.deliveredAt = this.adapters.clock.now().toISOString();
        sub.keepTokenFaceValue = terminal.keep_face_value ?? null;
        sub.keepTokenExpiresAt = part.sourceVoucherExpiresAt;
        deliveredAmount += part.partAmount;
        // Spec 013 high-2: gate ack on local apply success.
        let retryApplyOk = false;
        try {
          await this.adapters.voucher.applyKeepToken(
            part.sourceVoucherId,
            part.partAmount,
            terminal.keep_token ?? null,
            terminal.keep_face_value ?? null,
            null,
            part.sourceVoucherExpiresAt
          );
          retryApplyOk = true;
          sub.localApplyError = null;
        } catch (e) {
          sub.localApplyError = (e as Error).message;
          this.logger.log('error', 'voucher_debit_failed', {
            bundle_id: bundleId,
            part_index: part.partIndex,
            error_code: sub.localApplyError,
          });
        }
        if (retryApplyOk) {
          // Spec 013 Layer 3 — ack-driven retention (mirror of the bundle path).
          await this.maybeAckKeepToken(bundleId, part.partIndex, sub.sendId, terminal.keep_token);
        }
        this.logger.log('info', 'part_delivered', {
          bundle_id: bundleId,
          part_index: part.partIndex,
          part_count: retryParts.length,
          face_value: part.partAmount,
        });
      } else {
        sub.state = 'FAILED';
        sub.failedAt = this.adapters.clock.now().toISOString();
        sub.errorCode = terminal.error_code ?? terminal.status ?? 'unknown';
        if (!firstError) firstError = { partIndex: part.partIndex, errorCode: sub.errorCode! };
        this.logger.log('warn', 'part_failed', { bundle_id: bundleId, part_index: part.partIndex, error_code: sub.errorCode });
      }
    }

    const allParts = [...original.parts, ...newSubRecords];
    const allDelivered = newSubRecords.every((r) => r.state === 'DELIVERED');
    const anyDelivered = newSubRecords.some((r) => r.state === 'DELIVERED');

    if (allDelivered) {
      // Original parts that already DELIVERED + all retry parts DELIVERED → bundle DELIVERED.
      await this.adapters.journal.markTerminal(bundleId, 'DELIVERED');
      // Sender-side does NOT record a transaction for the retry — the receiver's BundleReceiptStore
      // updates its existing display row in place when it sees the retry parts arrive (US2 path).
      const result: BundleCompleteResult = {
        bundleId,
        totalAmount: original.totalAmount,
        unit: original.faceUnit,
        decimals: original.faceDecimals,
        partsCount: allParts.length,
        deliveredAt: this.adapters.clock.now().toISOString(),
        transactionId: '',
      };
      this.logger.log('info', 'bundle_complete', {
        bundle_id: bundleId,
        outcome: 'DELIVERED',
        face_value: original.totalAmount,
        attempt: newAttempt,
      });
      return result;
    }

    // Mixed or all-failed retry — release failed retry-part reservations and stay in PARTIAL.
    await this.releaseFailedPartReservations(bundleId, newSubRecords);
    const partial: BundlePartialOutcome = {
      bundleId,
      totalAmount: original.totalAmount,
      deliveredAmount,
      remainingAmount: original.totalAmount - deliveredAmount,
      unit: original.faceUnit,
      decimals: original.faceDecimals,
      retryUntil: new Date(Date.parse(original.createdAt) + 24 * 60 * 60 * 1000).toISOString(),
      failedPartCount: allParts.filter((r) => r.state === 'FAILED').length,
    };
    await this.adapters.journal.upsert({
      ...updatedEntry,
      state: 'PARTIAL',
      parts: allParts,
      deliveredAmount,
      lastErrorCode: firstError?.errorCode ?? null,
      updatedAt: this.adapters.clock.now().toISOString(),
    });
    this.logger.log('warn', 'bundle_partial', {
      bundle_id: bundleId,
      outcome: 'PARTIAL',
      face_value: deliveredAmount,
      attempt: newAttempt,
      part_count: allParts.length,
    });
    void anyDelivered;
    return partial;
  }

  /**
   * Permanently dismiss a PARTIAL bundle. Releases any remaining source-voucher
   * reservations and marks the journal entry ABANDONED (FR-019 / contract §1.2).
   */
  async dismissPartial(bundleId: string): Promise<void> {
    if (!this.adapters.journal.get) {
      throw new BundleSendError('journal.get adapter is required for dismissPartial', 'INVALID_PLAN', bundleId);
    }
    const entry = await this.adapters.journal.get(bundleId);
    if (!entry) {
      throw new BundleSendError(`Bundle ${bundleId} not found`, 'BUNDLE_NOT_FOUND', bundleId);
    }
    if (entry.state !== 'PARTIAL' && entry.state !== 'RESERVED' && entry.state !== 'EXECUTING') {
      throw new BundleSendError(
        `Bundle ${bundleId} is in state ${entry.state}; only non-terminal entries can be dismissed`,
        'BUNDLE_NOT_DISMISSABLE',
        bundleId
      );
    }
    // Defensive: release every non-DELIVERED source-voucher's reservation. (FAILED parts
    // are already released at PARTIAL display; this catches PLANNED / RESERVED parts that
    // never got a chance to execute.)
    await this.releaseFailedPartReservations(bundleId, entry.parts);
    await this.adapters.journal.markTerminal(bundleId, 'ABANDONED');
    this.logger.log('info', 'bundle_dismissed', {
      bundle_id: bundleId,
      outcome: 'ABANDONED',
    });
  }

  /**
   * Reconcile any non-terminal bundles for this user that survived a wallet reload (FR-024a).
   *
   * For each in-flight entry:
   *   - DELIVERED parts: skip (no work).
   *   - EXECUTING with a non-null sendId: query saga via api.getAtomicSendStatus and apply
   *     its terminal status; if still PENDING, leave as EXECUTING for the next sweep.
   *   - RESERVED / EXECUTING with no sendId / PLANNED: re-issue via initiateAtomicSend with
   *     the SAME idempotency key (R6 — the saga layer dedups via the key).
   *   - FAILED parts: ensure reservation is released.
   *
   * Then transition the bundle's terminal state and persist.
   */
  async resumePending(userId: string): Promise<BundleResumeResult[]> {
    if (!this.adapters.journal.listInflight) {
      // Nothing to do without a list adapter.
      return [];
    }
    const inflight = await this.adapters.journal.listInflight(userId);
    const results: BundleResumeResult[] = [];

    for (const entry of inflight) {
      let deliveredAmount = 0;
      let firstError: string | null = null;
      const subRecords = entry.parts.map((p) => ({ ...p })); // shallow copy

      for (const sub of subRecords) {
        if (sub.state === 'DELIVERED') {
          deliveredAmount += sub.partAmount;
          continue;
        }
        if (sub.state === 'FAILED') {
          if (!firstError) firstError = sub.errorCode ?? 'unknown';
          continue;
        }

        // Non-terminal part — reconcile or re-issue.
        let terminal: AtomicSendTerminalResult | null = null;
        if (sub.sendId && this.adapters.api.getAtomicSendStatus) {
          try {
            const status = await this.adapters.api.getAtomicSendStatus(sub.sendId);
            if (status && this.isTerminalAny(status.status)) {
              terminal = status;
            }
          } catch (e) {
            this.logger.log('warn', 'resume_status_failed', {
              bundle_id: entry.bundleId,
              part_index: sub.partIndex,
              error_code: (e as Error).message,
            });
          }
        }
        if (!terminal) {
          // Re-issue using the same idempotency key — the saga layer dedups.
          const part: BundlePartPlan = {
            partIndex: sub.partIndex,
            sourceVoucherId: sub.sourceVoucherId,
            sourceVoucherToken: '', // re-issue path: token may not be available; backend uses its own state via idempotency key
            sourceVoucherExpiresAt: sub.sourceVoucherExpiresAt,
            partAmount: sub.partAmount,
            partId: sub.partId,
            idempotencyKey: sub.idempotencyKey,
          };
          const planLike: BundlePlan = {
            bundleId: entry.bundleId,
            recipientPubkeyHex: entry.recipientPubkeyHex,
            merchantGroupKey: entry.merchantGroupKey,
            totalAmount: entry.totalAmount,
            faceUnit: entry.faceUnit,
            faceDecimals: entry.faceDecimals,
            parts: subRecords.map((s) => ({
              partIndex: s.partIndex,
              sourceVoucherId: s.sourceVoucherId,
              sourceVoucherToken: '',
              sourceVoucherExpiresAt: s.sourceVoucherExpiresAt,
              partAmount: s.partAmount,
              partId: s.partId,
              idempotencyKey: s.idempotencyKey,
            })),
            createdAt: entry.createdAt,
            attempt: entry.attempt,
          };
          const outcome = await this.tryInitiate(part, planLike, entry.recipientPubkeyHex, null);
          if (outcome.ok) {
            sub.sendId = outcome.sendId;
            terminal = outcome.terminal;
          } else {
            sub.state = 'FAILED';
            sub.failedAt = this.adapters.clock.now().toISOString();
            sub.errorCode = outcome.errorCode;
            if (!firstError) firstError = outcome.errorCode;
            continue;
          }
        }

        if (this.isTerminalSuccess(terminal.status)) {
          sub.state = 'DELIVERED';
          sub.deliveredAt = this.adapters.clock.now().toISOString();
          sub.keepTokenFaceValue = terminal.keep_face_value ?? null;
          sub.keepTokenExpiresAt = sub.sourceVoucherExpiresAt;
          deliveredAmount += sub.partAmount;
          // Spec 013 high-1: resume MUST apply the keep_token locally — without
          // this, a crash between backend completion and local mutation leaves
          // the source voucher at full face_value while the mint considers it
          // spent (displayed-balance inflation + later double-spend attempts).
          // applyKeepToken is expected to be idempotent at the host adapter
          // level (re-applying an already-applied state is a no-op). On apply
          // failure we record localApplyError on the sub and skip the ack so
          // the backend's 48h fallback retains the bearer material for retry.
          let resumeApplyOk = false;
          try {
            await this.adapters.voucher.applyKeepToken(
              sub.sourceVoucherId,
              sub.partAmount,
              terminal.keep_token ?? null,
              terminal.keep_face_value ?? null,
              null,
              sub.sourceVoucherExpiresAt
            );
            resumeApplyOk = true;
            sub.localApplyError = null;
          } catch (e) {
            sub.localApplyError = (e as Error).message;
            this.logger.log('error', 'resume_voucher_debit_failed', {
              bundle_id: entry.bundleId,
              part_index: sub.partIndex,
              error_code: sub.localApplyError,
            });
          }
          if (resumeApplyOk) {
            await this.maybeAckKeepToken(entry.bundleId, sub.partIndex, sub.sendId, terminal.keep_token);
          }
        } else {
          sub.state = 'FAILED';
          sub.failedAt = this.adapters.clock.now().toISOString();
          sub.errorCode = terminal.error_code ?? terminal.status ?? 'unknown';
          if (!firstError) firstError = sub.errorCode;
        }
      }

      const allDelivered = subRecords.every((r) => r.state === 'DELIVERED');
      const anyDelivered = subRecords.some((r) => r.state === 'DELIVERED');

      let outcome: BundleResumeResult['outcome'];
      if (allDelivered) {
        outcome = 'DELIVERED';
        await this.adapters.journal.markTerminal(entry.bundleId, 'DELIVERED');
      } else if (!anyDelivered) {
        outcome = 'FAILED';
        await this.releaseFailedPartReservations(entry.bundleId, subRecords);
        await this.adapters.journal.markTerminal(entry.bundleId, 'FAILED', firstError ?? 'all_parts_failed');
      } else {
        outcome = 'PARTIAL';
        await this.releaseFailedPartReservations(entry.bundleId, subRecords);
        await this.adapters.journal.upsert({
          ...entry,
          parts: subRecords,
          state: 'PARTIAL',
          deliveredAmount,
          lastErrorCode: firstError,
          updatedAt: this.adapters.clock.now().toISOString(),
        });
      }

      this.logger.log('info', 'bundle_resumed', {
        bundle_id: entry.bundleId,
        outcome,
        face_value: deliveredAmount,
      });

      results.push({ bundleId: entry.bundleId, outcome, deliveredAmount, errorCode: firstError });
    }

    return results;
  }

  /**
   * Spec 013 Layer 3: ack-driven retention for the keep_token. After the
   * orchestrator has applied a partial-draw keep_token locally, tell the
   * backend it can clear the bearer material from voucher_send.keep_token.
   * Non-fatal on failure — the backend's 48h fallback cleanup eventually
   * runs, and the customer's change is already in the local wallet by this
   * point.
   *
   * No-ops when:
   *   - the api adapter doesn't expose ackKeepToken (host opted out or pre-Layer-3)
   *   - sendId is null (e.g., initiate threw before the saga was created)
   *   - keepToken is null/absent (full draw — nothing to ack)
   */
  private async maybeAckKeepToken(
    bundleId: string,
    partIndex: number,
    sendId: string | null,
    keepToken: string | null | undefined
  ): Promise<void> {
    const ack = this.adapters.api.ackKeepToken;
    if (!ack || !sendId || !keepToken) return;
    try {
      await ack.call(this.adapters.api, sendId);
    } catch (e) {
      this.logger.log('warn', 'ack_keep_token_failed', {
        bundle_id: bundleId,
        part_index: partIndex,
        error_code: (e as Error).message,
      });
    }
  }

  /**
   * Per FR-020 + post-condition §1.4: every FAILED sub-record's source voucher is "released"
   * (its bundle-level UI lock is cleared) before the bundle's outcome is surfaced. Idempotent —
   * tracks released voucherIds via a per-call set so repeated calls don't double-fire.
   */
  private async releaseFailedPartReservations(
    bundleId: string,
    parts: BundleSubSendRecord[]
  ): Promise<void> {
    const release = this.adapters.voucher.releaseBundleReservation;
    if (!release) return;
    const released = new Set<string>();
    for (const part of parts) {
      if (part.state !== 'FAILED') continue;
      if (!part.sourceVoucherId || released.has(part.sourceVoucherId)) continue;
      released.add(part.sourceVoucherId);
      try {
        await release.call(this.adapters.voucher, part.sourceVoucherId, bundleId);
      } catch (e) {
        // Release failures are non-fatal — log and proceed; the journal-state-driven
        // recovery on next reload will re-attempt.
        this.logger.log('warn', 'release_reservation_failed', {
          bundle_id: bundleId,
          part_index: part.partIndex,
          error_code: (e as Error).message,
        });
      }
    }
  }

  private toFreshSubRecord(part: BundlePartPlan): BundleSubSendRecord {
    return {
      partIndex: part.partIndex,
      partId: part.partId,
      sourceVoucherId: part.sourceVoucherId,
      sourceVoucherExpiresAt: part.sourceVoucherExpiresAt,
      partAmount: part.partAmount,
      idempotencyKey: part.idempotencyKey,
      state: 'PLANNED',
      sendId: null,
      deliveredAt: null,
      failedAt: null,
      errorCode: null,
      keepTokenFaceValue: null,
      keepTokenExpiresAt: null,
    };
  }

  /* ---------- Helpers ---------- */

  private sortByExpiryFirst(vouchers: Voucher[]): Voucher[] {
    return [...vouchers].sort((a, b) => {
      const ea = this.expiryMs(a);
      const eb = this.expiryMs(b);
      if (ea !== eb) return ea - eb;
      // Within same expiry: larger face value first (FR-003 tiebreak), then voucher_id stable.
      const fa = this.faceValueOf(a);
      const fb = this.faceValueOf(b);
      if (fa !== fb) return fb - fa;
      return String(a.voucher_id ?? '').localeCompare(String(b.voucher_id ?? ''));
    });
  }

  private expiryMs(v: Voucher): number {
    const e = (v as { expires_at?: string | number | null }).expires_at;
    if (e == null) return Number.MAX_SAFE_INTEGER;
    if (typeof e === 'number') return e > 1e12 ? e : e * 1000;
    const t = new Date(e).getTime();
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  }

  private expiresAtOf(v: Voucher): string | null {
    const e = (v as { expires_at?: string | number | null }).expires_at;
    if (e == null) return null;
    if (typeof e === 'string') return e;
    const ms = e > 1e12 ? e : e * 1000;
    return new Date(ms).toISOString();
  }

  private faceValueOf(v: Voucher): number {
    const fv = (v as { face_value?: number; faceValue?: number }).face_value
      ?? (v as { faceValue?: number }).faceValue
      ?? 0;
    return Number.isFinite(fv) ? fv : 0;
  }

  private merchantGroupKey(group: MerchantGroup): string {
    const g = group as unknown as { groupKey?: string; merchantId?: string; unit?: string; decimals?: number };
    if (g.groupKey) return g.groupKey;
    return [g.merchantId ?? 'unknown', g.unit ?? '', g.decimals ?? 0].join('-');
  }

  private firstIssuerId(selection: BundleCandidateSelection): string | null {
    const v = selection.vouchers[0] as { issuer_id?: string };
    return v?.issuer_id ?? selection.groupMetadata?.merchantId ?? null;
  }

  private resolveRecipientHex(recipient: string | { pubkeyHex?: string }): string | null {
    if (typeof recipient === 'string') {
      // Caller is expected to pass hex. The bridge resolves npub/nip05 upstream.
      return /^[0-9a-f]{64}$/i.test(recipient) ? recipient.toLowerCase() : null;
    }
    if (recipient && typeof recipient === 'object' && recipient.pubkeyHex) {
      return /^[0-9a-f]{64}$/i.test(recipient.pubkeyHex)
        ? recipient.pubkeyHex.toLowerCase()
        : null;
    }
    return null;
  }

  private toUnixSeconds(iso: string | null): number | null {
    if (iso == null) return null;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  private isTerminalSuccess(status: string): boolean {
    return status === 'COMPLETED';
  }

  private isTerminalAny(status: string): boolean {
    return ['COMPLETED', 'FAILED', 'EXPIRED', 'DM_ERROR', 'RECLAIM_READY', 'SPLIT_ERROR'].includes(status);
  }
}

/**
 * Factory matching the existing package convention (e.g. createVoucherSender).
 */
export function createBundleSender(config: BundleSenderConfig): BundleSender {
  return new BundleSender(config);
}

/**
 * Generate a 32-char lowercase hex bundle ID (Phase 0 R1). Default
 * implementation; tests inject deterministic IDs via BundleSendIdAdapter.
 */
export function defaultBundleIdGenerator(): BundleSendIdAdapter {
  return {
    newBundleId: () => {
      // Prefer crypto.getRandomValues; fall back to Math.random for environments without it.
      const cryptoLike = (globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
        .crypto;
      const buf = new Uint8Array(16);
      if (cryptoLike?.getRandomValues) {
        cryptoLike.getRandomValues(buf);
      } else {
        for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
      }
      let hex = '';
      for (let i = 0; i < 16; i++) {
        hex += buf[i].toString(16).padStart(2, '0');
      }
      return hex;
    },
  };
}
