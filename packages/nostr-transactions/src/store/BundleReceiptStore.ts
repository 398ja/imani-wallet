/**
 * BundleReceiptStore — receiver-side per-bundle aggregation (spec 012 US2).
 *
 * Per `contracts/bundle-orchestrator-interface.md` §2 and `data-model.md`
 * "Receiver-side entities".
 *
 * Layered above the existing redemption pipeline. The host wires:
 *   1. dmPollIntegration.on('redemption:success', ev => store.ingest({...}))
 *   2. setInterval(10_000, () => store.reconcileExpired(userId, new Date()))
 *
 * Funds correctness lives at the mint layer (Cashu duplicate-proof rejection)
 * AND at the ingestion adapter (the host's existing tokenRedemption pipeline).
 * This store owns DISPLAY correctness:
 *   - dedup by (bundle_id, bundle_part_index)        FR-017a + R4
 *   - first-write-wins on declared metadata          FR-018a
 *   - 90s wait window → FINALIZED or INCOMPLETE     FR-013, FR-016
 *   - late-merge in place                            FR-017b, FR-022 corollary
 *   - author mismatch rejection                      R11
 *
 * Storage adapter shape mirrors today's pending_consolidations pattern: per-user
 * JSON arrays via the host's localStorage helpers. The TS class doesn't depend
 * on browser globals — the bridge in shared/bundleReceiptStore.js injects
 * adapter implementations.
 */

import type { TransactionStore } from './TransactionStore';
import { TransactionType, TransactionDirection } from '../types';

/* =========================================================================
 * Wire-format input — what the integration layer hands us.
 * =======================================================================*/

/**
 * Subset of the decrypted DM body relevant to the bundle aggregator.
 * Mirrors `TokenMetadata` from @imani/dm-poll plus the gift-wrap-derived sender pubkey.
 */
export interface BundleReceiptIngestInput {
  userId: string;
  /** Wall-clock at decrypt time (Phase 0 R5 — drives the 90s window). */
  receivedAt: Date;
  /** Verified sender pubkey from the gift-wrap inner-event author (R11). */
  senderPubkeyHex: string;
  /** The gift-wrap event ID (secondary dedup key per R4). */
  giftWrapEventId: string;
  /** Per-part token amount (face value in minor units of faceUnit). */
  partAmount: number;
  /** Bundle metadata extracted from the DM body. */
  bundle: {
    bundleId: string;
    bundleTotal: number;
    bundlePartIndex: number;
    bundlePartCount: number;
    bundlePartId: string;
    bundleAttempt?: number;
  };
  /** Currency / display units (first-write-wins; FR-018a). */
  faceUnit?: string;
  faceDecimals?: number;
  /** Optional sender display name (for "Receiving X of Y from <name>"). */
  senderDisplayName?: string;
  /** Issuer/merchant id, optional, used downstream for attribution. */
  issuerId?: string;
}

/* =========================================================================
 * Persistent record (stored in localStorage by the bridge).
 * =======================================================================*/

export type BundleReceiptState = 'IN_FLIGHT' | 'FINALIZED' | 'INCOMPLETE' | 'FINALIZED_PARTIAL';

/**
 * Per-part redemption status hydrated from the server-side `dm_token_inbox`
 * (Defense E-1, separate spec / repo). When E-1 is not yet deployed the
 * field stays undefined; callers MUST tolerate that.
 *
 * - CLAIMED          — recipient successfully redeemed the part.
 * - FAILED_PERMANENT — mint returned a permanent error (e.g. proof_already_used).
 * - FAILED_TRANSIENT — network or 5xx; will retry.
 * - PENDING          — delivered, not yet attempted (or attempt in flight).
 */
export type RedemptionStatus = 'CLAIMED' | 'FAILED_PERMANENT' | 'FAILED_TRANSIENT' | 'PENDING';

export interface ReceivedPartRecord {
  bundlePartId: string;
  bundlePartIndex: number;
  eventId: string;
  partAmount: number;
  receivedAt: string; // ISO 8601
  late: boolean;
  /** Hydrated from `dm_token_inbox` after finalize (Defense E-2). Optional until E-1 ships. */
  redemption_status?: RedemptionStatus;
  /** Permanent-error code (e.g. 'proof_already_used'); null on success or unknown. */
  redemption_error_code?: string | null;
  /** ISO 8601; when E-1 last reported this status. */
  redemption_observed_at?: string | null;
}

export interface MetadataDisagreement {
  bundlePartId: string;
  field: 'declaredTotal' | 'declaredPartCount' | 'faceUnit' | 'faceDecimals' | 'senderPubkey';
  claimedValue: string;
  recordedAt: string;
}

export interface BundleReceiptRecord {
  bundleId: string;
  userId: string;
  state: BundleReceiptState;
  /** Sender pubkey from the FIRST part's gift-wrap (forge-resistant). */
  senderPubkeyHex: string;
  declaredTotal: number;
  declaredPartCount: number;
  faceUnit?: string;
  faceDecimals?: number;
  /** ISO 8601; equals first-part receivedAt. */
  firstPartAt: string;
  /** ISO 8601; firstPartAt + 90s. */
  waitWindowExpiresAt: string;
  receivedParts: ReceivedPartRecord[];
  receivedAmount: number;
  disagreements: MetadataDisagreement[];
  createdAt: string;
  finalizedAt: string | null;
  /** TransactionStore record id this bundle's display row is bound to. */
  linkedTransactionId: string | null;
}

/* =========================================================================
 * Adapter contracts — what the bridge layer implements.
 * =======================================================================*/

export interface BundleReceiptStorageAdapter {
  get(userId: string, bundleId: string): Promise<BundleReceiptRecord | null>;
  upsert(record: BundleReceiptRecord): Promise<BundleReceiptRecord>;
  /** All records for the user. The bridge can filter by state in-memory. */
  listAll(userId: string): Promise<BundleReceiptRecord[]>;
}

export interface BundleReceiptClock {
  now(): Date;
}

/* =========================================================================
 * Directives returned by ingest() — the integration shim acts on these.
 * =======================================================================*/

export type BundleReceiptDirective =
  | { kind: 'STANDALONE_RECEIVE'; reason?: string }
  | {
      kind: 'BUNDLE_PART_INGESTED';
      bundleId: string;
      transactionId: string;
      newState: BundleReceiptState;
      receivedAmount: number;
      declaredTotal: number;
      declaredPartCount: number;
      late: boolean;
    }
  | { kind: 'BUNDLE_PART_DUPLICATE'; bundleId: string; partIndex: number }
  | { kind: 'BUNDLE_REJECTED_AUTHOR_MISMATCH'; bundleId: string };

export interface ReconciliationResult {
  bundleId: string;
  transition: 'IN_FLIGHT_TO_FINALIZED' | 'IN_FLIGHT_TO_INCOMPLETE';
  finalReceivedAmount: number;
  finalDeclaredTotal: number;
}

/* =========================================================================
 * Constants
 * =======================================================================*/

const WAIT_WINDOW_MS = 90 * 1000; // FR-013 (locked 90 seconds during clarification)
const BUNDLE_ID_RE = /^[0-9a-f]{32}$/;

/* =========================================================================
 * BundleReceiptStore
 * =======================================================================*/

export interface BundleReceiptStoreConfig {
  storage: BundleReceiptStorageAdapter;
  transactions: TransactionStore;
  clock?: BundleReceiptClock;
}

export class BundleReceiptStore {
  private readonly storage: BundleReceiptStorageAdapter;
  private readonly transactions: TransactionStore;
  private readonly clock: BundleReceiptClock;

  constructor(config: BundleReceiptStoreConfig) {
    this.storage = config.storage;
    this.transactions = config.transactions;
    this.clock = config.clock ?? { now: () => new Date() };
  }

  /**
   * Hand a freshly-decrypted incoming bundle part to the receiver pipeline.
   * Returns a directive describing what the integration layer should do next.
   */
  async ingest(input: BundleReceiptIngestInput): Promise<BundleReceiptDirective> {
    // Validate bundle metadata format (wire-format §4 decision tree).
    const { bundle } = input;
    if (!bundle || !bundle.bundleId) {
      return { kind: 'STANDALONE_RECEIVE', reason: 'no_bundle_id' };
    }
    if (!BUNDLE_ID_RE.test(bundle.bundleId)) {
      return { kind: 'STANDALONE_RECEIVE', reason: 'bundle_id_format' };
    }
    if (
      typeof bundle.bundleTotal !== 'number' ||
      bundle.bundleTotal < 0 ||
      typeof bundle.bundlePartIndex !== 'number' ||
      bundle.bundlePartIndex < 0 ||
      typeof bundle.bundlePartCount !== 'number' ||
      bundle.bundlePartCount < 1
    ) {
      return { kind: 'STANDALONE_RECEIVE', reason: 'bundle_field_range' };
    }
    if (bundle.bundlePartId !== `${bundle.bundleId}:${bundle.bundlePartIndex}`) {
      return { kind: 'STANDALONE_RECEIVE', reason: 'bundle_part_id_mismatch' };
    }

    // Look up existing record for (userId, bundleId).
    const existing = await this.storage.get(input.userId, bundle.bundleId);

    if (!existing) {
      return await this.handleFirstPart(input);
    }

    // Author check (R11) — gift-wrap-derived pubkey must match the bundle's first sender.
    if (existing.senderPubkeyHex !== input.senderPubkeyHex) {
      // Log disagreement, do not add this part to the bundle. Funds are still
      // ingested (caller falls through to STANDALONE_RECEIVE for funds).
      existing.disagreements.push({
        bundlePartId: bundle.bundlePartId,
        field: 'senderPubkey',
        claimedValue: input.senderPubkeyHex.slice(0, 16),
        recordedAt: this.clock.now().toISOString(),
      });
      await this.storage.upsert(existing);
      return { kind: 'BUNDLE_REJECTED_AUTHOR_MISMATCH', bundleId: bundle.bundleId };
    }

    // Dedup (R4) — (bundle_id, bundle_part_index).
    const dup = existing.receivedParts.find((p) => p.bundlePartIndex === bundle.bundlePartIndex);
    if (dup) {
      return { kind: 'BUNDLE_PART_DUPLICATE', bundleId: bundle.bundleId, partIndex: bundle.bundlePartIndex };
    }

    // First-write-wins on declared metadata (FR-018a). Disagreements logged but
    // ignored for display.
    this.recordDisagreementsIfAny(existing, input);

    return await this.handleSubsequentPart(existing, input);
  }

  /** Read-only lookup. */
  async get(userId: string, bundleId: string): Promise<BundleReceiptRecord | null> {
    return this.storage.get(userId, bundleId);
  }

  /**
   * Drive the IN_FLIGHT → INCOMPLETE transition for any receipts whose 90s
   * window has elapsed. Called by the integration shim on a 10-second interval.
   */
  async reconcileExpired(userId: string, now: Date): Promise<ReconciliationResult[]> {
    const all = await this.storage.listAll(userId);
    const results: ReconciliationResult[] = [];
    for (const rec of all) {
      if (rec.state !== 'IN_FLIGHT') continue;
      const expiresAt = Date.parse(rec.waitWindowExpiresAt);
      if (Number.isFinite(expiresAt) && now.getTime() >= expiresAt) {
        const reachedTotal = rec.receivedAmount >= rec.declaredTotal;
        const allPartsArrived = rec.receivedParts.length >= rec.declaredPartCount;
        const newState: BundleReceiptState = reachedTotal || allPartsArrived ? 'FINALIZED' : 'INCOMPLETE';
        rec.state = newState;
        rec.finalizedAt = now.toISOString();
        await this.storage.upsert(rec);
        await this.refreshTransactionRow(rec);
        results.push({
          bundleId: rec.bundleId,
          transition: newState === 'FINALIZED' ? 'IN_FLIGHT_TO_FINALIZED' : 'IN_FLIGHT_TO_INCOMPLETE',
          finalReceivedAmount: rec.receivedAmount,
          finalDeclaredTotal: rec.declaredTotal,
        });
      }
    }
    return results;
  }

  /* ---------- Private helpers ---------- */

  private async handleFirstPart(input: BundleReceiptIngestInput): Promise<BundleReceiptDirective> {
    const { bundle } = input;
    const firstPartAtMs = input.receivedAt.getTime();
    const part: ReceivedPartRecord = {
      bundlePartId: bundle.bundlePartId,
      bundlePartIndex: bundle.bundlePartIndex,
      eventId: input.giftWrapEventId,
      partAmount: input.partAmount,
      receivedAt: input.receivedAt.toISOString(),
      late: false,
    };

    const reachedTotal = part.partAmount >= bundle.bundleTotal;
    const allPartsArrived = bundle.bundlePartCount === 1; // first part is the only part
    const initialState: BundleReceiptState = reachedTotal || allPartsArrived ? 'FINALIZED' : 'IN_FLIGHT';

    const record: BundleReceiptRecord = {
      bundleId: bundle.bundleId,
      userId: input.userId,
      state: initialState,
      senderPubkeyHex: input.senderPubkeyHex,
      declaredTotal: bundle.bundleTotal,
      declaredPartCount: bundle.bundlePartCount,
      faceUnit: input.faceUnit,
      faceDecimals: input.faceDecimals,
      firstPartAt: input.receivedAt.toISOString(),
      waitWindowExpiresAt: new Date(firstPartAtMs + WAIT_WINDOW_MS).toISOString(),
      receivedParts: [part],
      receivedAmount: part.partAmount,
      disagreements: [],
      createdAt: input.receivedAt.toISOString(),
      finalizedAt: initialState === 'FINALIZED' ? input.receivedAt.toISOString() : null,
      linkedTransactionId: null,
    };

    const tx = await this.upsertTransactionRow(record, input);
    record.linkedTransactionId = tx.id;
    await this.storage.upsert(record);

    return {
      kind: 'BUNDLE_PART_INGESTED',
      bundleId: record.bundleId,
      transactionId: tx.id,
      newState: record.state,
      receivedAmount: record.receivedAmount,
      declaredTotal: record.declaredTotal,
      declaredPartCount: record.declaredPartCount,
      late: false,
    };
  }

  private async handleSubsequentPart(
    existing: BundleReceiptRecord,
    input: BundleReceiptIngestInput
  ): Promise<BundleReceiptDirective> {
    const { bundle } = input;
    // FR-017b: a part arriving AFTER waitWindowExpiresAt is "late". Late parts
    // still ingest and update the linked TransactionStore row in place.
    const isLate = input.receivedAt.getTime() > Date.parse(existing.waitWindowExpiresAt);

    const part: ReceivedPartRecord = {
      bundlePartId: bundle.bundlePartId,
      bundlePartIndex: bundle.bundlePartIndex,
      eventId: input.giftWrapEventId,
      partAmount: input.partAmount,
      receivedAt: input.receivedAt.toISOString(),
      late: isLate,
    };
    existing.receivedParts.push(part);
    existing.receivedAmount += part.partAmount;

    // Recompute terminal state.
    const reachedTotal = existing.receivedAmount >= existing.declaredTotal;
    const allInitialPartsArrived = existing.receivedParts.length >= existing.declaredPartCount;

    if (existing.state === 'IN_FLIGHT') {
      if (reachedTotal || allInitialPartsArrived) {
        existing.state = 'FINALIZED';
        existing.finalizedAt = input.receivedAt.toISOString();
      }
    } else {
      // Already FINALIZED or INCOMPLETE — late-merge updates in place. If the
      // late part pushes the sum to declared_total, transition INCOMPLETE → FINALIZED.
      if (existing.state === 'INCOMPLETE' && reachedTotal) {
        existing.state = 'FINALIZED';
      }
    }

    const tx = await this.upsertTransactionRow(existing, input);
    existing.linkedTransactionId = tx.id;
    await this.storage.upsert(existing);

    return {
      kind: 'BUNDLE_PART_INGESTED',
      bundleId: existing.bundleId,
      transactionId: tx.id,
      newState: existing.state,
      receivedAmount: existing.receivedAmount,
      declaredTotal: existing.declaredTotal,
      declaredPartCount: existing.declaredPartCount,
      late: isLate,
    };
  }

  private recordDisagreementsIfAny(existing: BundleReceiptRecord, input: BundleReceiptIngestInput): void {
    const now = this.clock.now().toISOString();
    const partId = input.bundle.bundlePartId;

    if (existing.declaredTotal !== input.bundle.bundleTotal) {
      existing.disagreements.push({
        bundlePartId: partId,
        field: 'declaredTotal',
        claimedValue: String(input.bundle.bundleTotal).slice(0, 64),
        recordedAt: now,
      });
    }
    if (existing.declaredPartCount !== input.bundle.bundlePartCount) {
      // Out-of-range part_index from a retry is the explicit signal — NOT a
      // disagreement (per wire-format §3 retry parts).
      const isRetryPart = input.bundle.bundlePartIndex >= existing.declaredPartCount;
      if (!isRetryPart) {
        existing.disagreements.push({
          bundlePartId: partId,
          field: 'declaredPartCount',
          claimedValue: String(input.bundle.bundlePartCount).slice(0, 64),
          recordedAt: now,
        });
      }
    }
    if (input.faceUnit && existing.faceUnit && existing.faceUnit !== input.faceUnit) {
      existing.disagreements.push({
        bundlePartId: partId,
        field: 'faceUnit',
        claimedValue: input.faceUnit.slice(0, 64),
        recordedAt: now,
      });
    }
    if (
      input.faceDecimals !== undefined &&
      existing.faceDecimals !== undefined &&
      existing.faceDecimals !== input.faceDecimals
    ) {
      existing.disagreements.push({
        bundlePartId: partId,
        field: 'faceDecimals',
        claimedValue: String(input.faceDecimals).slice(0, 64),
        recordedAt: now,
      });
    }
  }

  private async upsertTransactionRow(
    record: BundleReceiptRecord,
    input: BundleReceiptIngestInput
  ) {
    const stateForDisplay = record.state;
    return this.transactions.upsertBundleRecord({
      type: TransactionType.RECEIVED,
      direction: TransactionDirection.IN,
      tokenAmount: 0, // Per-part token amount lives at the redemption layer; the bundle row carries face-value totals.
      faceValue: record.receivedAmount,
      faceUnit: input.faceUnit ?? record.faceUnit ?? 'SAT',
      faceDecimals: input.faceDecimals ?? record.faceDecimals ?? 0,
      counterparty: record.senderPubkeyHex,
      counterpartyName: input.senderDisplayName,
      issuerId: input.issuerId,
      timestamp: Math.floor(Date.parse(record.firstPartAt) / 1000),
      bundleId: record.bundleId,
      bundlePartCount: record.declaredPartCount,
      bundleDeclaredTotal: record.declaredTotal,
      bundleReceivedAmount: record.receivedAmount,
      bundleState: stateForDisplay,
      bundleFirstPartAt: Math.floor(Date.parse(record.firstPartAt) / 1000),
    });
  }

  /**
   * On a state transition driven by reconcileExpired (no new ingest input),
   * push the updated bundle counters into the linked transaction row so the
   * display flips from "Receiving X of Y" to "Received X of Y (incomplete)".
   */
  private async refreshTransactionRow(record: BundleReceiptRecord) {
    if (!record.linkedTransactionId) return;
    await this.transactions.update(record.linkedTransactionId, {
      bundleReceivedAmount: record.receivedAmount,
      bundleState: record.state,
      bundleDeclaredTotal: record.declaredTotal,
      bundlePartCount: record.declaredPartCount,
    });
  }
}

export function createBundleReceiptStore(config: BundleReceiptStoreConfig): BundleReceiptStore {
  return new BundleReceiptStore(config);
}
