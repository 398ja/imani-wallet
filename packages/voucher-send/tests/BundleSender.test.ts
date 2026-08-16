/**
 * BundleSender unit tests for spec 012-multi-voucher-send.
 *
 * Coverage map (per tasks.md):
 *   US1
 *   - T013: plan correctness (FR-002 earliest-expiry-first; FR-003 no-skipping-for-fewer-parts)
 *   - T014: change-expiry preservation (FR-009a / SC-008)
 *   - T015: insufficient-balance message names actual gap (FR-006)
 *   - T016: single-voucher short-circuit (SC-007 — no bundle metadata emitted)
 *   US3
 *   - T043: PARTIAL outcome with delivered + failed parts (FR-019)
 *   - T044: failed-part voucher locks released at PARTIAL (FR-020)
 *   - T045: retryRemainder reuses bundle_id, increments attempt, fresh part_index (FR-011a + FR-022 + R2)
 *   - T046: retryRemainder reselects from currently-eligible vouchers (FR-021)
 *   - T048: resumePending reconciles per-part saga state on reload (FR-024a + SC-011)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BundleSender,
  createBundleSender,
  type BundleSendAdapters,
  type BundleSendApiAdapter,
  type BundleSendVoucherAdapter,
  type BundleSendJournalAdapter,
  type BundleSendSelectionAdapter,
  type BundleSendTransactionAdapter,
  type BundleSendIdAdapter,
  type BundleSendClockAdapter,
  type BundleCandidateSelection,
  type AtomicSendInitiateParams,
  type AtomicSendInitialResult,
  type AtomicSendTerminalResult,
} from '../src/orchestrator';
import {
  BundleSendError,
  type BundleSendJournalEntry,
  type BundleSubSendRecord,
  type BundlePartialOutcome,
  type Voucher,
  type MerchantGroup,
  type BundleSendParams,
} from '../src/types';

/* ---------- helpers ---------- */

const RECIPIENT_HEX = 'a'.repeat(64);
const FIXED_BUNDLE_ID = '7c3aedf9748f4a2b89e3c2a7d6b4f5e1';
const FROZEN_NOW = new Date('2026-05-02T12:00:00.000Z');

function v(partial: Partial<Voucher> & { voucher_id: string; face_value: number; expires_at?: string | null }): Voucher {
  return {
    voucher_id: partial.voucher_id,
    token: `cashuB-${partial.voucher_id}`,
    face_value: partial.face_value,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: partial.face_value * 10,
    issuer_id: 'merchant-1',
    expires_at: partial.expires_at ?? null,
    status: 'active',
  } as unknown as Voucher;
}

function group(vouchers: Voucher[]): MerchantGroup {
  return {
    groupKey: 'merchant-1-EUR-2',
    merchantId: 'merchant-1',
    unit: 'EUR',
    decimals: 2,
    totalFaceValue: vouchers.reduce((s, x) => s + ((x as { face_value?: number }).face_value ?? 0), 0),
    totalTokenAmount: vouchers.reduce((s, x) => s + ((x as { token_amount?: number }).token_amount ?? 0), 0),
    vouchers,
  } as unknown as MerchantGroup;
}

function selection(vouchers: Voucher[], targetAmount: number, isValid = true): BundleCandidateSelection {
  const total = vouchers.reduce((s, x) => s + ((x as { face_value?: number }).face_value ?? 0), 0);
  return {
    vouchers,
    needsConsolidation: vouchers.length > 1,
    totalAvailable: total,
    isValid: isValid && total >= targetAmount,
    voucherIds: vouchers.map((x) => (x as { voucher_id?: string }).voucher_id ?? ''),
    groupMetadata: { merchantId: 'merchant-1', unit: 'EUR', decimals: 2 },
  };
}

interface MockApiCall {
  params: AtomicSendInitiateParams;
  idempotencyKey: string;
}

interface MockApiOpts {
  /** Per-part terminal status. Index = call sequence. */
  terminals?: Array<AtomicSendTerminalResult>;
  /** Per-part keep_token override (for change tracking). */
  keepTokens?: Array<{ token: string | null; faceValue: number | null } | null>;
  /** Pre-seed the in-memory journal store with these entries (for resumePending). */
  preSeedJournal?: BundleSendJournalEntry[];
  /** Status returned from getAtomicSendStatus, keyed by sendId (for resumePending). */
  saga?: Record<string, AtomicSendTerminalResult>;
}

interface MockHandles {
  adapters: BundleSendAdapters;
  apiCalls: MockApiCall[];
  voucherCalls: Array<{
    voucherId: string;
    partAmount: number;
    keepToken: string | null;
    keepFaceValue: number | null;
    sourceExpiresAt: string | null;
  }>;
  journalUpserts: BundleSendJournalEntry[];
  journalStore: Map<string, BundleSendJournalEntry>;
  txCalls: Array<{ bundleId: string; totalAmount: number; partsCount: number }>;
  /** Order-preserving log of releaseBundleReservation calls (FR-020). */
  releases: Array<{ voucherId: string; bundleId: string; at: number }>;
  /** Order-preserving log of selection adapter invocations (FR-021). */
  selectionCalls: Array<{ merchantGroupKey: string; amount: number }>;
  /** Order-preserving log of ackKeepToken calls (Spec 013 Layer 3). */
  ackCalls: string[];
}

function mockAdapters(opts: MockApiOpts = {}): MockHandles {
  const apiCalls: MockApiCall[] = [];
  const voucherCalls: Array<{
    voucherId: string;
    partAmount: number;
    keepToken: string | null;
    keepFaceValue: number | null;
    sourceExpiresAt: string | null;
  }> = [];
  const journalUpserts: BundleSendJournalEntry[] = [];
  const journalStore = new Map<string, BundleSendJournalEntry>();
  for (const entry of opts.preSeedJournal ?? []) {
    journalStore.set(entry.bundleId, entry);
  }
  const txCalls: Array<{ bundleId: string; totalAmount: number; partsCount: number }> = [];
  const releases: Array<{ voucherId: string; bundleId: string; at: number }> = [];
  const selectionCalls: Array<{ merchantGroupKey: string; amount: number }> = [];
  const ackCalls: string[] = [];
  let releaseSeq = 0;

  const api: BundleSendApiAdapter = {
    initiateAtomicSend: vi.fn(async (params, idempotencyKey) => {
      apiCalls.push({ params, idempotencyKey });
      const idx = apiCalls.length - 1;
      const keep = opts.keepTokens?.[idx];
      const initial: AtomicSendInitialResult = {
        send_id: `send-${idx}`,
        status: 'PENDING',
        keep_token: keep?.token ?? null,
      };
      return initial;
    }),
    awaitTerminal: vi.fn(async (sendId) => {
      const idx = parseInt(sendId.replace('send-', ''), 10);
      const terminal: AtomicSendTerminalResult =
        opts.terminals?.[idx] ?? {
          status: 'COMPLETED',
          keep_token: opts.keepTokens?.[idx]?.token ?? null,
          keep_face_value: opts.keepTokens?.[idx]?.faceValue ?? null,
        };
      return terminal;
    }),
    getAtomicSendStatus: vi.fn(async (sendId) => {
      return opts.saga?.[sendId] ?? { status: 'PENDING' };
    }),
    ackKeepToken: vi.fn(async (sendId) => {
      ackCalls.push(sendId);
    }),
  };

  const voucher: BundleSendVoucherAdapter = {
    applyKeepToken: vi.fn(async (voucherId, partAmount, keepToken, keepFaceValue, _ka, sourceExpiresAt) => {
      voucherCalls.push({ voucherId, partAmount, keepToken, keepFaceValue, sourceExpiresAt });
    }),
    releaseBundleReservation: vi.fn(async (voucherId, bundleId) => {
      releases.push({ voucherId, bundleId, at: ++releaseSeq });
    }),
  };

  const journal: BundleSendJournalAdapter = {
    begin: vi.fn(async (entry) => {
      journalStore.set(entry.bundleId, entry);
      journalUpserts.push(entry);
      return entry;
    }),
    upsert: vi.fn(async (entry) => {
      journalStore.set(entry.bundleId, entry);
      journalUpserts.push(entry);
      return entry;
    }),
    markTerminal: vi.fn(async (bundleId, state, errorCode) => {
      const existing = journalStore.get(bundleId);
      const next = {
        ...(existing ?? ({} as BundleSendJournalEntry)),
        bundleId,
        state,
        lastErrorCode: errorCode ?? null,
      };
      journalStore.set(bundleId, next as BundleSendJournalEntry);
      journalUpserts.push(next as BundleSendJournalEntry);
      return next as BundleSendJournalEntry;
    }),
    get: vi.fn(async (bundleId) => journalStore.get(bundleId) ?? null),
    listInflight: vi.fn(async () => {
      return [...journalStore.values()].filter(
        (e) => e.state === 'RESERVED' || e.state === 'EXECUTING' || e.state === 'PARTIAL'
      );
    }),
  };

  const transaction: BundleSendTransactionAdapter = {
    recordSentBundle: vi.fn(async (input) => {
      txCalls.push({
        bundleId: input.bundleId,
        totalAmount: input.totalAmount,
        partsCount: input.partsCount,
      });
      return { transactionId: `tx-${input.bundleId}` };
    }),
  };

  const ids: BundleSendIdAdapter = { newBundleId: () => FIXED_BUNDLE_ID };
  const clock: BundleSendClockAdapter = { now: () => FROZEN_NOW };
  const selection: BundleSendSelectionAdapter = {
    selectVouchersForAmount: vi.fn(async (merchantGroupKey, amount) => {
      selectionCalls.push({ merchantGroupKey, amount });
      // Default: return an invalid (empty) selection — tests override per-case.
      return {
        vouchers: [],
        needsConsolidation: false,
        totalAvailable: 0,
        isValid: false,
      };
    }),
  };

  return {
    adapters: { api, voucher, journal, transaction, ids, clock, selection },
    apiCalls,
    voucherCalls,
    journalUpserts,
    journalStore,
    txCalls,
    releases,
    selectionCalls,
    ackCalls,
  };
}

function paramsFor(merchantGroup: MerchantGroup, amount: number): BundleSendParams {
  return {
    userId: 'u'.repeat(64),
    recipient: RECIPIENT_HEX,
    merchantGroup,
    amount,
    callbacks: {},
  };
}

/* =========================================================================
 * T013 — Plan correctness (FR-002 earliest-expiry-first, FR-003 no skipping)
 * =======================================================================*/

describe('BundleSender T013 — plan correctness (FR-002 + FR-003)', () => {
  it('consumes earlier-expiry vouchers first even when a single later voucher would suffice', async () => {
    // V1: 50 expires +7d, V2: 80 expires +30d, V3: 100 expires +60d.
    // Send 120: must consume V1 (50) fully + 70 from V2.
    // MUST NOT skip V1+V2 in favour of V3 alone (V3 = 100 < 120 anyway, but the
    // stronger invariant is: never skip an earlier-expiry eligible voucher).
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const v3 = v({ voucher_id: 'v3', face_value: 100, expires_at: '2026-07-01T00:00:00Z' });
    const g = group([v1, v2, v3]);

    const { adapters, apiCalls } = mockAdapters();
    const sender = createBundleSender({ adapters });
    await sender.send(paramsFor(g, 120), selection([v1, v2, v3], 120));

    // Two parts emitted, in order: V1 fully (50) then V2 partially (70).
    expect(apiCalls.length).toBe(2);
    expect(apiCalls[0].params.voucherId).toBe('v1');
    expect(apiCalls[0].params.amount).toBe(50);
    expect(apiCalls[1].params.voucherId).toBe('v2');
    expect(apiCalls[1].params.amount).toBe(70);
    // V3 must not be touched.
    expect(apiCalls.some((c) => c.params.voucherId === 'v3')).toBe(false);
  });

  it('emits bundle metadata on every part of a multi-source send', async () => {
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const { adapters, apiCalls } = mockAdapters();
    const sender = createBundleSender({ adapters });
    await sender.send(paramsFor(g, 100), selection([v1, v2], 100));

    expect(apiCalls.length).toBe(2);
    for (let i = 0; i < apiCalls.length; i++) {
      expect(apiCalls[i].params.bundleId).toBe(FIXED_BUNDLE_ID);
      expect(apiCalls[i].params.bundleTotal).toBe(100);
      expect(apiCalls[i].params.bundlePartCount).toBe(2);
      expect(apiCalls[i].params.bundlePartIndex).toBe(i);
      expect(apiCalls[i].params.bundlePartId).toBe(`${FIXED_BUNDLE_ID}:${i}`);
      expect(apiCalls[i].params.bundleAttempt).toBe(0);
      // Idempotency key shape per Phase 0 R6.
      expect(apiCalls[i].idempotencyKey).toBe(`bundle:${FIXED_BUNDLE_ID}:${i}:0`);
    }
  });
});

/* =========================================================================
 * T014 — Change-expiry preservation (FR-009a / SC-008)
 * =======================================================================*/

describe('BundleSender T014 — change-expiry preservation (FR-009a / SC-008)', () => {
  it('keeps V2 change voucher with V2 expiry, NOT the earliest expiry', async () => {
    // V1: 50 expires +7d, V2: 80 expires +30d. Send 100.
    // V1 fully consumed, V2 produces 30 of change.
    // The change MUST inherit V2's +30d expiry — never V1's +7d.
    const V1_EXPIRY = '2026-05-09T00:00:00.000Z';
    const V2_EXPIRY = '2026-06-01T00:00:00.000Z';
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: V1_EXPIRY });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: V2_EXPIRY });
    const g = group([v1, v2]);

    const { adapters, voucherCalls } = mockAdapters({
      keepTokens: [
        null,                                               // V1 fully consumed
        { token: 'cashuB-v2-change', faceValue: 30 },       // V2 produces 30 change
      ],
    });
    const sender = createBundleSender({ adapters });
    await sender.send(paramsFor(g, 100), selection([v1, v2], 100));

    expect(voucherCalls.length).toBe(2);
    // V1: drawn 50, no keep token (fully consumed), source expiry V1's.
    expect(voucherCalls[0].voucherId).toBe('v1');
    expect(voucherCalls[0].partAmount).toBe(50);
    expect(voucherCalls[0].keepToken).toBeNull();
    expect(voucherCalls[0].sourceExpiresAt).toBe(V1_EXPIRY);
    // V2: drawn 50, keep token of 30 face value, change MUST inherit V2's expiry.
    expect(voucherCalls[1].voucherId).toBe('v2');
    expect(voucherCalls[1].partAmount).toBe(50);
    expect(voucherCalls[1].keepToken).toBe('cashuB-v2-change');
    expect(voucherCalls[1].keepFaceValue).toBe(30);
    expect(voucherCalls[1].sourceExpiresAt).toBe(V2_EXPIRY);
    // The strong assertion: the change voucher's expiry parameter is V2's,
    // not the earliest expiry across the bundle.
    expect(voucherCalls[1].sourceExpiresAt).not.toBe(V1_EXPIRY);
  });
});

/* =========================================================================
 * T015 — Insufficient-balance message names actual gap (FR-006)
 * =======================================================================*/

describe('BundleSender T015 — insufficient-balance gap message (FR-006)', () => {
  it('throws INSUFFICIENT_BALANCE with a message that names the gap, not "no single voucher"', async () => {
    const v1 = v({ voucher_id: 'v1', face_value: 20, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 30, expires_at: '2026-05-09T00:00:00Z' });
    const g = group([v1, v2]);

    const { adapters, apiCalls } = mockAdapters();
    const sender = createBundleSender({ adapters });

    let caught: BundleSendError | null = null;
    try {
      await sender.send(paramsFor(g, 100), selection([v1, v2], 100, /*isValid*/ false));
    } catch (e) {
      caught = e as BundleSendError;
    }

    expect(caught).toBeInstanceOf(BundleSendError);
    expect(caught?.code).toBe('INSUFFICIENT_BALANCE');
    // Names the gap (requested vs. available); doesn't use the legacy phrasing.
    expect(caught?.message).toMatch(/100/);
    expect(caught?.message).toMatch(/50/);
    expect(caught?.message.toLowerCase()).not.toContain('no single voucher');
    // No side effects.
    expect(apiCalls.length).toBe(0);
  });
});

/* =========================================================================
 * T016 — Single-voucher short-circuit emits NO bundle metadata (SC-007)
 * =======================================================================*/

describe('BundleSender T016 — single-voucher short-circuit (SC-007)', () => {
  it('emits exactly one atomic-send call and NO bundle metadata when one voucher covers the amount', async () => {
    const only = v({ voucher_id: 'v-only', face_value: 200, expires_at: '2026-05-09T00:00:00Z' });
    const g = group([only]);

    const { adapters, apiCalls, journalUpserts } = mockAdapters({
      keepTokens: [{ token: 'cashuB-v-change', faceValue: 150 }],
    });
    const sender = createBundleSender({ adapters });
    await sender.send(paramsFor(g, 50), selection([only], 50));

    expect(apiCalls.length).toBe(1);
    const sent = apiCalls[0].params;
    // Standalone send identical to today's path: NONE of the bundle_* params.
    expect(sent.bundleId).toBeUndefined();
    expect(sent.bundleTotal).toBeUndefined();
    expect(sent.bundlePartIndex).toBeUndefined();
    expect(sent.bundlePartCount).toBeUndefined();
    expect(sent.bundlePartId).toBeUndefined();
    expect(sent.bundleAttempt).toBeUndefined();
    expect(sent.amount).toBe(50);
    expect(sent.voucherId).toBe('v-only');

    // Single-voucher short-circuit must NOT journal the bundle.
    expect(journalUpserts.length).toBe(0);
  });
});

/* =========================================================================
 * Sanity: BundleSender constructible via the factory.
 * =======================================================================*/

describe('BundleSender — construction', () => {
  it('is constructible via createBundleSender and via class', () => {
    const { adapters } = mockAdapters();
    expect(createBundleSender({ adapters })).toBeInstanceOf(BundleSender);
    expect(new BundleSender({ adapters })).toBeInstanceOf(BundleSender);
  });
});

/* =========================================================================
 * T043 — PARTIAL outcome with delivered + failed parts (FR-019)
 * =======================================================================*/

describe('BundleSender T043 — PARTIAL outcome surfaces delivered + remaining (FR-019)', () => {
  it('emits onPartialOutcome with delivered=50, remaining=50, failedPartCount=1 when one of two parts fails terminally', async () => {
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const { adapters, journalStore, txCalls } = mockAdapters({
      terminals: [
        { status: 'COMPLETED', keep_token: null, keep_face_value: null },
        { status: 'FAILED', error_code: 'verify_proof_already_used_error' },
      ],
    });

    let partialOutcome: BundlePartialOutcome | null = null;
    const sender = createBundleSender({ adapters });
    const result = await sender.send(
      {
        ...paramsFor(g, 100),
        callbacks: { onPartialOutcome: (o) => { partialOutcome = o; } },
      },
      selection([v1, v2], 100)
    );

    expect(partialOutcome).toBeTruthy();
    expect(partialOutcome!.bundleId).toBe(FIXED_BUNDLE_ID);
    expect(partialOutcome!.totalAmount).toBe(100);
    expect(partialOutcome!.deliveredAmount).toBe(50);
    expect(partialOutcome!.remainingAmount).toBe(50);
    expect(partialOutcome!.failedPartCount).toBe(1);

    // Returned value mirrors the partial outcome, NOT a thrown error.
    const partialResult = result as BundlePartialOutcome;
    expect(partialResult.deliveredAmount).toBe(50);

    // Journal lands in PARTIAL (NOT terminal DELIVERED / FAILED / ABANDONED).
    const persisted = journalStore.get(FIXED_BUNDLE_ID);
    expect(persisted?.state).toBe('PARTIAL');

    // Sender-side does NOT record a transaction for PARTIAL bundles
    // — the receiver-side BundleReceiptStore owns the display row.
    expect(txCalls.length).toBe(0);
  });
});

/* =========================================================================
 * T044 — Failed-part voucher locks released at PARTIAL (FR-020)
 * =======================================================================*/

describe('BundleSender T044 — failed-part voucher locks released before onPartialOutcome (FR-020)', () => {
  it('calls releaseBundleReservation for each failed part’s source voucher before onPartialOutcome fires', async () => {
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const { adapters, releases } = mockAdapters({
      terminals: [
        { status: 'COMPLETED', keep_token: null, keep_face_value: null },
        { status: 'FAILED', error_code: 'spent' },
      ],
    });

    let releasesAtPartial: string[] = [];
    const sender = createBundleSender({ adapters });
    await sender.send(
      {
        ...paramsFor(g, 100),
        callbacks: {
          onPartialOutcome: () => {
            releasesAtPartial = releases.map((r) => r.voucherId);
          },
        },
      },
      selection([v1, v2], 100)
    );

    // The failed part's voucher MUST be released.
    expect(releases.some((r) => r.voucherId === 'v2' && r.bundleId === FIXED_BUNDLE_ID)).toBe(true);
    // The delivered part's voucher MUST NOT be released — its lock is consumed by the keep-token application,
    // not by a "release" call (releasing it would imply the funds were never spent, which is wrong).
    expect(releases.some((r) => r.voucherId === 'v1')).toBe(false);
    // Order: release happens at-or-before onPartialOutcome.
    expect(releasesAtPartial).toContain('v2');
  });
});

/* =========================================================================
 * T045 — retryRemainder reuses bundle_id, increments attempt, fresh part_index
 * (FR-011a + FR-022 + R2)
 * =======================================================================*/

describe('BundleSender T045 — retryRemainder reuses original bundleId and allocates fresh part_index (R2)', () => {
  it('retry call carries bundle_id=original, bundle_attempt=1, bundle_part_index=2', async () => {
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const handles = mockAdapters({
      terminals: [
        { status: 'COMPLETED' }, // call 0: v1 part 0 delivers
        { status: 'FAILED', error_code: 'spent' }, // call 1: v2 part 1 fails → PARTIAL
        { status: 'COMPLETED' }, // call 2: retry succeeds
      ],
    });
    // Reselection at retry time: a different voucher of size >= 50 from the same merchant group.
    const v_retry = v({ voucher_id: 'v-retry', face_value: 60, expires_at: '2026-07-01T00:00:00Z' });
    (handles.adapters.selection!.selectVouchersForAmount as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string, amount: number) => {
        handles.selectionCalls.push({ merchantGroupKey: key, amount });
        return selection([v_retry], amount);
      }
    );

    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.send(paramsFor(g, 100), selection([v1, v2], 100));
    await sender.retryRemainder(FIXED_BUNDLE_ID);

    expect(handles.apiCalls.length).toBe(3);
    const retryCall = handles.apiCalls[2];
    // Same bundle_id (FR-011a + FR-022) — the receiver updates its existing entry in place.
    expect(retryCall.params.bundleId).toBe(FIXED_BUNDLE_ID);
    // attempt incremented (FR-011a / R6).
    expect(retryCall.params.bundleAttempt).toBe(1);
    // part_index allocated FRESH at original.bundle_part_count (R2). Original had 2 parts → retry starts at 2.
    expect(retryCall.params.bundlePartIndex).toBe(2);
    expect(retryCall.params.bundlePartId).toBe(`${FIXED_BUNDLE_ID}:2`);
    // Idempotency key shape: bundle:${bundle_id}:${part_index}:${attempt} → R6.
    expect(retryCall.idempotencyKey).toBe(`bundle:${FIXED_BUNDLE_ID}:2:1`);
    // bundle_part_count on the wire is the retry's own part count (1), NOT the original 2 — per R2 the
    // receiver computes finalized state from the per-part_index sum, not from any single declared count.
    expect(retryCall.params.bundlePartCount).toBe(1);

    // Selection adapter was invoked for the remaining 50.
    expect(handles.selectionCalls.length).toBe(1);
    expect(handles.selectionCalls[0].amount).toBe(50);

    // Journal end state: DELIVERED after retry succeeds. The retry's parent_bundle_id points to the original.
    const persisted = handles.journalStore.get(FIXED_BUNDLE_ID);
    expect(persisted?.state).toBe('DELIVERED');
  });
});

/* =========================================================================
 * T046 — retryRemainder reselects from currently-eligible vouchers (FR-021)
 * =======================================================================*/

describe('BundleSender T046 — retryRemainder reselects current vouchers (FR-021)', () => {
  it('calls selection adapter at retry time and uses its result, NOT the original failed voucher', async () => {
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const handles = mockAdapters({
      terminals: [
        { status: 'COMPLETED' },
        { status: 'FAILED', error_code: 'spent' },
        { status: 'COMPLETED' },
      ],
    });
    const v3 = v({ voucher_id: 'v3', face_value: 70, expires_at: '2026-07-01T00:00:00Z' });
    (handles.adapters.selection!.selectVouchersForAmount as ReturnType<typeof vi.fn>).mockImplementation(
      async (_key: string, amount: number) => selection([v3], amount)
    );

    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.send(paramsFor(g, 100), selection([v1, v2], 100));
    await sender.retryRemainder(FIXED_BUNDLE_ID);

    // Retry MUST source from v3 (current eligible), not v2 (the original failed voucher).
    expect(handles.apiCalls[2].params.voucherId).toBe('v3');
    expect(handles.apiCalls[2].params.amount).toBe(50);
  });

  it('throws INSUFFICIENT_BALANCE_RETRY when the remainder can no longer be covered', async () => {
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const handles = mockAdapters({
      terminals: [
        { status: 'COMPLETED' },
        { status: 'FAILED', error_code: 'spent' },
      ],
    });
    // Reselection: not enough.
    (handles.adapters.selection!.selectVouchersForAmount as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        vouchers: [],
        needsConsolidation: false,
        totalAvailable: 10,
        isValid: false,
      })
    );

    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.send(paramsFor(g, 100), selection([v1, v2], 100));

    let caught: BundleSendError | null = null;
    try {
      await sender.retryRemainder(FIXED_BUNDLE_ID);
    } catch (e) {
      caught = e as BundleSendError;
    }
    expect(caught).toBeInstanceOf(BundleSendError);
    expect(caught?.code).toBe('INSUFFICIENT_BALANCE_RETRY');
  });
});

/* =========================================================================
 * T048 — resumePending reconciles per-part saga state on reload (FR-024a / SC-011)
 * =======================================================================*/

describe('BundleSender T048 — resumePending reconciles per-part saga state on reload', () => {
  const USER_ID = 'u'.repeat(64);

  function preSeededEntry(parts: Array<Partial<BundleSubSendRecord> & { partIndex: number }>): BundleSendJournalEntry {
    return {
      bundleId: FIXED_BUNDLE_ID,
      userId: USER_ID,
      state: 'EXECUTING',
      recipientPubkeyHex: RECIPIENT_HEX,
      merchantGroupKey: 'merchant-1-EUR-2',
      totalAmount: 150,
      deliveredAmount: 0,
      faceUnit: 'EUR',
      faceDecimals: 2,
      parts: parts.map((p) => ({
        partIndex: p.partIndex,
        partId: p.partId ?? `${FIXED_BUNDLE_ID}:${p.partIndex}`,
        sourceVoucherId: p.sourceVoucherId ?? `v${p.partIndex + 1}`,
        sourceVoucherExpiresAt: p.sourceVoucherExpiresAt ?? '2026-06-01T00:00:00.000Z',
        partAmount: p.partAmount ?? 50,
        idempotencyKey: p.idempotencyKey ?? `bundle:${FIXED_BUNDLE_ID}:${p.partIndex}:0`,
        state: p.state ?? 'PLANNED',
        sendId: p.sendId ?? null,
        deliveredAt: p.deliveredAt ?? null,
        failedAt: p.failedAt ?? null,
        errorCode: p.errorCode ?? null,
        keepTokenFaceValue: p.keepTokenFaceValue ?? null,
        keepTokenExpiresAt: p.keepTokenExpiresAt ?? null,
      })),
      attempt: 0,
      parentBundleId: null,
      createdAt: '2026-05-02T11:00:00.000Z',
      updatedAt: '2026-05-02T11:00:00.000Z',
      lastErrorCode: null,
      cutoverOrigin: null,
    };
  }

  it('reconciles EXECUTING parts with a known sendId via getAtomicSendStatus and re-issues RESERVED parts using the same Idempotency-Key', async () => {
    // 3-part bundle: part 0 already DELIVERED, part 1 EXECUTING with sendId, part 2 still RESERVED with no sendId.
    const seeded = preSeededEntry([
      { partIndex: 0, state: 'DELIVERED', sendId: 'send-pre-0', deliveredAt: '...', partAmount: 50 },
      { partIndex: 1, state: 'EXECUTING', sendId: 'send-pre-1', partAmount: 50 },
      { partIndex: 2, state: 'RESERVED', sendId: null, partAmount: 50 },
    ]);

    const handles = mockAdapters({
      preSeedJournal: [seeded],
      saga: {
        // The EXECUTING part already reached COMPLETED on the backend before the crash.
        'send-pre-1': { status: 'COMPLETED', keep_token: null, keep_face_value: null },
      },
      // The RESERVED part's re-issue (call 0) returns COMPLETED.
      terminals: [{ status: 'COMPLETED' }],
    });

    const sender = createBundleSender({ adapters: handles.adapters });
    const results = await sender.resumePending(USER_ID);

    // getAtomicSendStatus consulted for EXECUTING part with known sendId.
    expect(handles.adapters.api.getAtomicSendStatus).toHaveBeenCalledWith('send-pre-1');
    // Exactly one re-issue (for the RESERVED part_index=2). The DELIVERED and reconciled parts MUST NOT re-issue.
    expect(handles.apiCalls.length).toBe(1);
    expect(handles.apiCalls[0].params.bundlePartIndex).toBe(2);
    // The re-issue uses the ORIGINAL idempotency key (R6 — backend dedups via key, so re-issue is safe).
    expect(handles.apiCalls[0].idempotencyKey).toBe(`bundle:${FIXED_BUNDLE_ID}:2:0`);

    // Result reports recovery for the bundle.
    expect(results.length).toBe(1);
    expect(results[0].bundleId).toBe(FIXED_BUNDLE_ID);
    expect(results[0].outcome).toBe('DELIVERED');

    // Journal terminal state is DELIVERED.
    const persisted = handles.journalStore.get(FIXED_BUNDLE_ID);
    expect(persisted?.state).toBe('DELIVERED');
  });

  it('transitions to PARTIAL when one part recovers DELIVERED but another saga is FAILED', async () => {
    const seeded = preSeededEntry([
      { partIndex: 0, state: 'DELIVERED', sendId: 'send-pre-0', deliveredAt: '...', partAmount: 50 },
      { partIndex: 1, state: 'EXECUTING', sendId: 'send-pre-1', partAmount: 50 },
    ]);

    const handles = mockAdapters({
      preSeedJournal: [seeded],
      saga: {
        'send-pre-1': { status: 'FAILED', error_code: 'verify_proof_already_used_error' },
      },
    });

    const sender = createBundleSender({ adapters: handles.adapters });
    const results = await sender.resumePending(USER_ID);

    // No new initiate calls — both parts had a sendId so reconciliation drove the outcome.
    expect(handles.apiCalls.length).toBe(0);
    expect(results[0].outcome).toBe('PARTIAL');

    // Failed-part reservation released (FR-020) — same invariant resumePending must respect.
    expect(handles.releases.some((r) => r.voucherId === 'v2' && r.bundleId === FIXED_BUNDLE_ID)).toBe(true);

    const persisted = handles.journalStore.get(FIXED_BUNDLE_ID);
    expect(persisted?.state).toBe('PARTIAL');
  });

  it('returns an empty array when there are no in-flight bundles', async () => {
    const { adapters } = mockAdapters();
    const sender = createBundleSender({ adapters });
    const results = await sender.resumePending(USER_ID);
    expect(results).toEqual([]);
  });
});

/* =========================================================================
 * Spec 013 Layer 3 — ack-driven retention of keep_token
 *
 * After the orchestrator successfully applies a partial-draw keep_token
 * locally (via voucher.applyKeepToken), it must call api.ackKeepToken(sendId)
 * so the backend can clear the bearer material from voucher_send. Mirrors the
 * single-voucher path's behavior (voucher/js/send.js::handleKeepToken).
 * =======================================================================*/

describe('BundleSender Spec 013 Layer 3 — ackKeepToken called per delivered partial part', () => {
  it('acks the keep_token on each delivered partial-draw part', async () => {
    // V1 fully consumed (no keep_token, no ack), V2 partially drawn (keep_token, ack).
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const handles = mockAdapters({
      keepTokens: [
        null,                                              // V1 fully consumed (full draw → no keep_token)
        { token: 'cashuB-v2-change', faceValue: 30 },      // V2 partial → keep_token returned
      ],
    });

    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.send(paramsFor(g, 100), selection([v1, v2], 100));

    // Two atomic-send calls fired (send-0 = V1, send-1 = V2). Only V2 should be acked.
    expect(handles.apiCalls.length).toBe(2);
    expect(handles.ackCalls).toEqual(['send-1']);
    expect(handles.adapters.api.ackKeepToken).toHaveBeenCalledTimes(1);
    expect(handles.adapters.api.ackKeepToken).toHaveBeenCalledWith('send-1');
  });

  it('does NOT ack on full-draw parts (no keep_token to clear)', async () => {
    // Both vouchers fully consumed — no keep_token returned for either.
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 50, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const handles = mockAdapters({
      keepTokens: [null, null],
    });

    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.send(paramsFor(g, 100), selection([v1, v2], 100));

    // Both delivered, but neither acked (nothing to clear).
    expect(handles.apiCalls.length).toBe(2);
    expect(handles.ackCalls).toEqual([]);
    expect(handles.adapters.api.ackKeepToken).not.toHaveBeenCalled();
  });

  it('ack failure is non-fatal — bundle still reports DELIVERED', async () => {
    // V1 fully consumed, V2 partial (keep_token returned). Mock ack to throw.
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const handles = mockAdapters({
      keepTokens: [null, { token: 'cashuB-v2-change', faceValue: 30 }],
    });
    (handles.adapters.api.ackKeepToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('network blew up')
    );

    let completeCalled = false;
    let errorCalled = false;
    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.send(
      {
        ...paramsFor(g, 100),
        callbacks: {
          onComplete: () => { completeCalled = true; },
          onError: () => { errorCalled = true; },
        },
      },
      selection([v1, v2], 100)
    );

    // Ack failure must not surface as a bundle-level error or block the
    // success outcome — the customer's change is already in local storage by
    // this point. The 48h backend cleanup is the fallback.
    expect(completeCalled).toBe(true);
    expect(errorCalled).toBe(false);
    // Ack was attempted (the mock recorded the call) even though it threw.
    expect(handles.adapters.api.ackKeepToken).toHaveBeenCalledTimes(1);
    expect(handles.adapters.api.ackKeepToken).toHaveBeenCalledWith('send-1');
  });

  it('does not call ack when the api adapter omits ackKeepToken (host opted out)', async () => {
    // Bridges that haven't shipped Layer 3 yet may not expose ackKeepToken —
    // the orchestrator must no-op cleanly rather than throwing.
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const handles = mockAdapters({
      keepTokens: [null, { token: 'cashuB-v2-change', faceValue: 30 }],
    });
    // Simulate a pre-Layer-3 host by removing the optional adapter method.
    delete handles.adapters.api.ackKeepToken;

    let completeCalled = false;
    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.send(
      {
        ...paramsFor(g, 100),
        callbacks: { onComplete: () => { completeCalled = true; } },
      },
      selection([v1, v2], 100)
    );

    expect(completeCalled).toBe(true);
    // ackCalls captured nothing (no ack adapter to invoke).
    expect(handles.ackCalls).toEqual([]);
  });
});

/* =======================================================================
 * Spec 013 high-2 — local-apply failure must block ack
 *
 * applyKeepToken throwing (storage error, validation mismatch, missing
 * source voucher) means the local wallet is NOT in the terminal state.
 * The keep_token MUST stay live on the backend so a future retry can
 * complete the local mutation — calling ackKeepToken here would clear
 * the bearer material and prevent recovery.
 * =======================================================================*/

describe('BundleSender Spec 013 high-2 — local-apply failure must block ackKeepToken', () => {
  it('does NOT ack when applyKeepToken throws on the partial-draw part', async () => {
    const v1 = v({ voucher_id: 'v1', face_value: 50, expires_at: '2026-05-09T00:00:00Z' });
    const v2 = v({ voucher_id: 'v2', face_value: 80, expires_at: '2026-06-01T00:00:00Z' });
    const g = group([v1, v2]);

    const handles = mockAdapters({
      keepTokens: [null, { token: 'cashuB-v2-change', faceValue: 30 }],
    });
    // Force the partial-draw part's local apply to fail (e.g. storage error,
    // keep_face_value mismatch). Mock returns the V1 success then throws on V2.
    let applyCount = 0;
    (handles.adapters.voucher.applyKeepToken as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        applyCount += 1;
        if (applyCount === 2) {
          throw new Error('keep_face_value_mismatch expected=50 got=900');
        }
      }
    );

    const partProgress: Array<{ partIndex: number; state: string; error?: string }> = [];
    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.send(
      {
        ...paramsFor(g, 100),
        callbacks: {
          onPartProgress: (p) => partProgress.push({
            partIndex: p.partIndex,
            state: p.state,
            ...(p.error ? { error: p.error } : {}),
          }),
        },
      },
      selection([v1, v2], 100)
    );

    // V1's full-draw apply succeeded → no ack needed (no keep_token).
    // V2's partial-draw apply threw → ack MUST NOT have been called.
    expect(handles.ackCalls).toEqual([]);
    expect(handles.adapters.api.ackKeepToken).not.toHaveBeenCalled();

    // The DELIVERED_LOCAL_ERROR signal must surface to the caller so the
    // success UI can warn (sender wallet may show inflated balance until
    // next sync — recipient still got the funds via DM).
    const v2Progress = partProgress.find((p) => p.partIndex === 1 && p.state === 'DELIVERED_LOCAL_ERROR');
    expect(v2Progress).toBeDefined();
    expect(v2Progress!.error).toMatch(/keep_face_value_mismatch/);
  });
});

/* =======================================================================
 * Spec 013 high-1 — resumePending must apply keep_token before marking delivered
 *
 * On resume, a part whose backend status is COMPLETED with a non-null
 * keep_token MUST trigger applyKeepToken locally. Without it, a crash
 * between backend completion and local mutation leaves the source voucher
 * at full face_value while the mint considers it spent — displayed-balance
 * inflation + later double-spend attempts.
 *
 * The applyKeepToken call MUST happen BEFORE ackKeepToken (the ack is
 * gated on apply success per high-2).
 * =======================================================================*/

describe('BundleSender Spec 013 high-1 — resumePending applies keep_token then acks', () => {
  const RES_USER_ID = 'r'.repeat(64);

  function resumeEntry(opts: {
    sendId: string;
    sourceVoucherId?: string;
    sourceVoucherExpiresAt?: string;
    partAmount?: number;
  }): BundleSendJournalEntry {
    return {
      bundleId: FIXED_BUNDLE_ID,
      userId: RES_USER_ID,
      state: 'EXECUTING',
      recipientPubkeyHex: RECIPIENT_HEX,
      merchantGroupKey: 'merchant-1-EUR-2',
      totalAmount: opts.partAmount ?? 50,
      deliveredAmount: 0,
      faceUnit: 'EUR',
      faceDecimals: 2,
      parts: [{
        partIndex: 0,
        partId: `${FIXED_BUNDLE_ID}:0`,
        sourceVoucherId: opts.sourceVoucherId ?? 'v2',
        sourceVoucherExpiresAt: opts.sourceVoucherExpiresAt ?? '2026-06-01T00:00:00.000Z',
        partAmount: opts.partAmount ?? 50,
        idempotencyKey: `bundle:${FIXED_BUNDLE_ID}:0:0`,
        state: 'EXECUTING',
        sendId: opts.sendId,
        deliveredAt: null,
        failedAt: null,
        errorCode: null,
        keepTokenFaceValue: null,
        keepTokenExpiresAt: null,
      }],
      attempt: 0,
      parentBundleId: null,
      createdAt: '2026-05-02T11:00:00.000Z',
      updatedAt: '2026-05-02T11:00:00.000Z',
      lastErrorCode: null,
      cutoverOrigin: null,
    };
  }

  it('calls applyKeepToken before ackKeepToken on resume of a COMPLETED partial-draw part', async () => {
    const seeded = resumeEntry({
      sendId: 'send-resume-0',
      sourceVoucherId: 'v2',
      sourceVoucherExpiresAt: '2026-06-01T00:00:00.000Z',
      partAmount: 50,
    });

    const handles = mockAdapters({
      preSeedJournal: [seeded],
      // Backend reports the part is already COMPLETED with a residual
      // (50 sent against an 80-face source → 30 keep_face_value).
      saga: {
        'send-resume-0': {
          status: 'COMPLETED',
          keep_token: 'cashuB-v2-resume-change',
          keep_face_value: 30,
        },
      },
    });

    const sender = createBundleSender({ adapters: handles.adapters });
    const results = await sender.resumePending(RES_USER_ID);

    expect(results.length).toBe(1);
    expect(results[0].outcome).toBe('DELIVERED');

    // Ordering invariant: applyKeepToken MUST fire before ackKeepToken so a
    // failure inside applyKeepToken can short-circuit the ack.
    const applyMock = handles.adapters.voucher.applyKeepToken as ReturnType<typeof vi.fn>;
    const ackMock = handles.adapters.api.ackKeepToken as ReturnType<typeof vi.fn>;
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(
      'v2', 50, 'cashuB-v2-resume-change', 30, null, '2026-06-01T00:00:00.000Z'
    );
    expect(ackMock).toHaveBeenCalledTimes(1);
    expect(ackMock).toHaveBeenCalledWith('send-resume-0');

    const applyOrder = (applyMock.mock.invocationCallOrder ?? [])[0];
    const ackOrder = (ackMock.mock.invocationCallOrder ?? [])[0];
    expect(applyOrder).toBeLessThan(ackOrder);
  });

  it('does NOT ack on resume when applyKeepToken throws (e.g. local state corrupted)', async () => {
    const seeded = resumeEntry({
      sendId: 'send-resume-2',
      sourceVoucherId: 'v-corrupted',
      sourceVoucherExpiresAt: '2026-06-01T00:00:00.000Z',
      partAmount: 50,
    });

    const handles = mockAdapters({
      preSeedJournal: [seeded],
      saga: {
        'send-resume-2': {
          status: 'COMPLETED',
          keep_token: 'cashuB-v-corrupted-change',
          keep_face_value: 30,
        },
      },
    });

    // Simulate corrupted local state — applyKeepToken refuses to mutate.
    (handles.adapters.voucher.applyKeepToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('source_voucher_missing_for_partial_draw')
    );

    const sender = createBundleSender({ adapters: handles.adapters });
    await sender.resumePending(RES_USER_ID);

    // applyKeepToken was attempted (one call), but ack must NOT have run.
    // The backend's 48h fallback retains the keep_token for a future retry
    // once the local state is repaired.
    expect(handles.adapters.voucher.applyKeepToken).toHaveBeenCalledTimes(1);
    expect(handles.adapters.api.ackKeepToken).not.toHaveBeenCalled();
    expect(handles.ackCalls).toEqual([]);
  });
});
