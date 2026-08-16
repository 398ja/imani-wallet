/**
 * BundleReceiptStore unit tests for spec 012-multi-voucher-send US2.
 *
 * Coverage map (per tasks.md):
 *   - T026: decision tree for every branch in bundle-metadata-wire-format.md §4
 *   - T027: first-write-wins under disagreement (FR-018a)
 *   - T028: idempotency under same event_id redelivery (FR-017a)
 *   - T029: idempotency under different event_id same (bundle_id, part_index) (FR-017a, R4)
 *   - T030: author-mismatch rejection (R11)
 *   - T031: IN_FLIGHT → INCOMPLETE transition after 90s wait window (FR-016)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BundleReceiptStore,
  createBundleReceiptStore,
  type BundleReceiptStorageAdapter,
  type BundleReceiptRecord,
  type BundleReceiptIngestInput,
} from '../src/store/BundleReceiptStore';
import { TransactionStore } from '../src/store/TransactionStore';
import { TransactionType, TransactionDirection } from '../src/types';

const USER_ID = 'a'.repeat(64);
const SENDER_HEX = 'b'.repeat(64);
const OTHER_SENDER_HEX = 'c'.repeat(64);
const BUNDLE_ID = '7c3aedf9748f4a2b89e3c2a7d6b4f5e1';
const T0 = new Date('2026-05-02T12:00:00.000Z');

function fixedClock(d: Date) {
  return { now: () => d };
}

function inMemoryStorage(): BundleReceiptStorageAdapter & { records: Map<string, BundleReceiptRecord> } {
  const records = new Map<string, BundleReceiptRecord>();
  const key = (uid: string, bid: string) => `${uid}:${bid}`;
  return {
    records,
    async get(uid, bid) {
      return records.get(key(uid, bid)) ?? null;
    },
    async upsert(rec) {
      records.set(key(rec.userId, rec.bundleId), rec);
      return rec;
    },
    async listAll(uid) {
      return [...records.values()].filter((r) => r.userId === uid);
    },
  };
}

async function freshTransactionStore(): Promise<TransactionStore> {
  const store = new TransactionStore({ storage: 'memory' });
  await store.init();
  return store;
}

function ingestInput(
  partIndex: number,
  partAmount: number,
  overrides: Partial<BundleReceiptIngestInput> = {}
): BundleReceiptIngestInput {
  return {
    userId: USER_ID,
    receivedAt: overrides.receivedAt ?? T0,
    senderPubkeyHex: overrides.senderPubkeyHex ?? SENDER_HEX,
    giftWrapEventId: overrides.giftWrapEventId ?? `event-${partIndex}-${Date.now()}`,
    partAmount,
    bundle: overrides.bundle ?? {
      bundleId: BUNDLE_ID,
      bundleTotal: 100,
      bundlePartIndex: partIndex,
      bundlePartCount: 2,
      bundlePartId: `${BUNDLE_ID}:${partIndex}`,
      bundleAttempt: 0,
    },
    faceUnit: overrides.faceUnit ?? 'EUR',
    faceDecimals: overrides.faceDecimals ?? 2,
    senderDisplayName: overrides.senderDisplayName,
    issuerId: overrides.issuerId,
  };
}

/* =========================================================================
 * T026 — decision tree branches
 * =======================================================================*/

describe('BundleReceiptStore T026 — wire-format §4 decision tree', () => {
  let storage: ReturnType<typeof inMemoryStorage>;
  let txs: TransactionStore;
  let store: BundleReceiptStore;

  beforeEach(async () => {
    storage = inMemoryStorage();
    txs = await freshTransactionStore();
    store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });
  });

  it('returns STANDALONE_RECEIVE when bundle_id is missing', async () => {
    // Construct the input directly so the helper's default-bundle fallback doesn't kick in.
    const directive = await store.ingest({
      userId: USER_ID,
      receivedAt: T0,
      senderPubkeyHex: SENDER_HEX,
      giftWrapEventId: 'event-no-bundle',
      partAmount: 50,
      bundle: undefined as unknown as BundleReceiptIngestInput['bundle'],
      faceUnit: 'EUR',
      faceDecimals: 2,
    });
    expect(directive.kind).toBe('STANDALONE_RECEIVE');
  });

  it('returns STANDALONE_RECEIVE when bundle_id format is invalid (not 32-char hex)', async () => {
    const directive = await store.ingest(
      ingestInput(0, 50, {
        bundle: {
          bundleId: 'not-hex',
          bundleTotal: 100,
          bundlePartIndex: 0,
          bundlePartCount: 2,
          bundlePartId: 'not-hex:0',
          bundleAttempt: 0,
        },
      })
    );
    expect(directive.kind).toBe('STANDALONE_RECEIVE');
  });

  it('returns STANDALONE_RECEIVE when bundle_part_id does not match derived form', async () => {
    const directive = await store.ingest(
      ingestInput(0, 50, {
        bundle: {
          bundleId: BUNDLE_ID,
          bundleTotal: 100,
          bundlePartIndex: 0,
          bundlePartCount: 2,
          bundlePartId: `${BUNDLE_ID}:9`, // mismatched index
          bundleAttempt: 0,
        },
      })
    );
    expect(directive.kind).toBe('STANDALONE_RECEIVE');
  });

  it('returns STANDALONE_RECEIVE when bundle_part_index is out-of-range negative', async () => {
    const directive = await store.ingest(
      ingestInput(-1, 50, {
        bundle: {
          bundleId: BUNDLE_ID,
          bundleTotal: 100,
          bundlePartIndex: -1,
          bundlePartCount: 2,
          bundlePartId: `${BUNDLE_ID}:-1`,
          bundleAttempt: 0,
        },
      })
    );
    expect(directive.kind).toBe('STANDALONE_RECEIVE');
  });

  it('happy path: first valid part returns BUNDLE_PART_INGESTED with state IN_FLIGHT', async () => {
    const d = await store.ingest(ingestInput(0, 50));
    expect(d.kind).toBe('BUNDLE_PART_INGESTED');
    if (d.kind !== 'BUNDLE_PART_INGESTED') throw new Error('unreachable');
    expect(d.bundleId).toBe(BUNDLE_ID);
    expect(d.newState).toBe('IN_FLIGHT');
    expect(d.receivedAmount).toBe(50);
    expect(d.declaredTotal).toBe(100);
    expect(d.declaredPartCount).toBe(2);
    expect(d.late).toBe(false);
  });

  it('finalizes immediately when one part already covers the declared total', async () => {
    const d = await store.ingest(
      ingestInput(0, 100, {
        bundle: {
          bundleId: BUNDLE_ID,
          bundleTotal: 100,
          bundlePartIndex: 0,
          bundlePartCount: 1,
          bundlePartId: `${BUNDLE_ID}:0`,
          bundleAttempt: 0,
        },
      })
    );
    if (d.kind !== 'BUNDLE_PART_INGESTED') throw new Error('expected ingested');
    expect(d.newState).toBe('FINALIZED');
    expect(d.receivedAmount).toBe(100);
  });
});

/* =========================================================================
 * T027 — first-write-wins under disagreement (FR-018a)
 * =======================================================================*/

describe('BundleReceiptStore T027 — first-write-wins on metadata disagreement (FR-018a)', () => {
  it('keeps the first part\'s declared_total / declared_part_count and logs disagreement', async () => {
    const storage = inMemoryStorage();
    const txs = await freshTransactionStore();
    const store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });

    // Part 0: declares total=100, part_count=2.
    await store.ingest(ingestInput(0, 50));

    // Part 1: declares DIFFERENT total=200, part_count=3 (a buggy or adversarial sender).
    await store.ingest(
      ingestInput(1, 50, {
        bundle: {
          bundleId: BUNDLE_ID,
          bundleTotal: 200,
          bundlePartIndex: 1,
          bundlePartCount: 3,
          bundlePartId: `${BUNDLE_ID}:1`,
          bundleAttempt: 0,
        },
      })
    );

    const rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec).toBeTruthy();
    if (!rec) return;
    // First-write-wins: declared values stay at the first part's values.
    expect(rec.declaredTotal).toBe(100);
    expect(rec.declaredPartCount).toBe(2);
    // Funds were ingested for both parts.
    expect(rec.receivedAmount).toBe(100);
    // Disagreements logged for both fields.
    expect(rec.disagreements.length).toBeGreaterThanOrEqual(2);
    const fields = rec.disagreements.map((d) => d.field).sort();
    expect(fields).toContain('declaredTotal');
    expect(fields).toContain('declaredPartCount');
  });
});

/* =========================================================================
 * T028 + T029 — idempotency under redelivery (FR-017a + R4)
 * =======================================================================*/

describe('BundleReceiptStore T028 — same event_id redelivery is idempotent', () => {
  it('a duplicate (bundle_id, part_index) returns BUNDLE_PART_DUPLICATE and does not double-credit', async () => {
    const storage = inMemoryStorage();
    const txs = await freshTransactionStore();
    const store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });

    const sameEventId = 'event-replay-1';
    const first = await store.ingest(ingestInput(0, 50, { giftWrapEventId: sameEventId }));
    expect(first.kind).toBe('BUNDLE_PART_INGESTED');

    const replay = await store.ingest(ingestInput(0, 50, { giftWrapEventId: sameEventId }));
    expect(replay.kind).toBe('BUNDLE_PART_DUPLICATE');

    const rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec).toBeTruthy();
    if (!rec) return;
    expect(rec.receivedAmount).toBe(50); // NOT 100
    expect(rec.receivedParts.length).toBe(1);
  });
});

describe('BundleReceiptStore T029 — different event_id same logical part is idempotent (R4)', () => {
  it('same (bundle_id, part_index) under a NEW event_id still returns BUNDLE_PART_DUPLICATE', async () => {
    const storage = inMemoryStorage();
    const txs = await freshTransactionStore();
    const store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });

    await store.ingest(ingestInput(0, 50, { giftWrapEventId: 'event-A' }));
    const replay = await store.ingest(ingestInput(0, 50, { giftWrapEventId: 'event-B' }));
    expect(replay.kind).toBe('BUNDLE_PART_DUPLICATE');

    const rec = await store.get(USER_ID, BUNDLE_ID);
    if (!rec) throw new Error('record missing');
    expect(rec.receivedAmount).toBe(50);
    expect(rec.receivedParts.length).toBe(1);
  });
});

/* =========================================================================
 * T030 — author-mismatch rejection (R11)
 * =======================================================================*/

describe('BundleReceiptStore T030 — author-mismatch rejection (R11)', () => {
  it('a part with a different sender pubkey returns BUNDLE_REJECTED_AUTHOR_MISMATCH and is NOT added to the bundle', async () => {
    const storage = inMemoryStorage();
    const txs = await freshTransactionStore();
    const store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });

    // Part 0 from SENDER_HEX establishes the bundle.
    await store.ingest(ingestInput(0, 50, { senderPubkeyHex: SENDER_HEX }));

    // Part 1 claims same bundle_id but is signed by a different sender.
    const directive = await store.ingest(ingestInput(1, 50, { senderPubkeyHex: OTHER_SENDER_HEX }));
    expect(directive.kind).toBe('BUNDLE_REJECTED_AUTHOR_MISMATCH');

    const rec = await store.get(USER_ID, BUNDLE_ID);
    if (!rec) throw new Error('record missing');
    // Bundle is unchanged (still 1 part, sender unchanged).
    expect(rec.receivedAmount).toBe(50);
    expect(rec.receivedParts.length).toBe(1);
    expect(rec.senderPubkeyHex).toBe(SENDER_HEX);
    // Disagreement logged.
    expect(rec.disagreements.some((d) => d.field === 'senderPubkey')).toBe(true);
  });
});

/* =========================================================================
 * T031 — IN_FLIGHT → INCOMPLETE after 90s wait window (FR-016)
 * =======================================================================*/

describe('BundleReceiptStore T031 — wait-window expiry transitions to INCOMPLETE (FR-016)', () => {
  it('after 91 seconds with one part missing, reconcileExpired transitions IN_FLIGHT → INCOMPLETE', async () => {
    const storage = inMemoryStorage();
    const txs = await freshTransactionStore();
    const store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });

    // Ingest part 0 only (of 2). Bundle stays IN_FLIGHT.
    await store.ingest(ingestInput(0, 50));
    let rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec?.state).toBe('IN_FLIGHT');

    // Advance 91 seconds.
    const later = new Date(T0.getTime() + 91 * 1000);
    const results = await store.reconcileExpired(USER_ID, later);
    expect(results.length).toBe(1);
    expect(results[0].transition).toBe('IN_FLIGHT_TO_INCOMPLETE');
    expect(results[0].finalReceivedAmount).toBe(50);
    expect(results[0].finalDeclaredTotal).toBe(100);

    rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec?.state).toBe('INCOMPLETE');
    expect(rec?.finalizedAt).toBeTruthy();
  });

  it('reconcileExpired is a no-op for receipts whose window has not yet elapsed', async () => {
    const storage = inMemoryStorage();
    const txs = await freshTransactionStore();
    const store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });

    await store.ingest(ingestInput(0, 50));
    const tooEarly = new Date(T0.getTime() + 30 * 1000);
    const results = await store.reconcileExpired(USER_ID, tooEarly);
    expect(results.length).toBe(0);
    const rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec?.state).toBe('IN_FLIGHT');
  });

  it('FR-017b late-merge: a late part transitions INCOMPLETE → FINALIZED in place', async () => {
    const storage = inMemoryStorage();
    const txs = await freshTransactionStore();
    const store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });

    // First part arrives, window expires while part 2 is missing → INCOMPLETE.
    await store.ingest(ingestInput(0, 50));
    await store.reconcileExpired(USER_ID, new Date(T0.getTime() + 91_000));
    let rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec?.state).toBe('INCOMPLETE');
    expect(rec?.linkedTransactionId).toBeTruthy();
    const txIdBefore = rec!.linkedTransactionId!;

    // Late part 2 arrives much later. It MUST update in place and may flip back to FINALIZED.
    await store.ingest(
      ingestInput(1, 50, { receivedAt: new Date(T0.getTime() + 200_000) })
    );
    rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec?.state).toBe('FINALIZED');
    expect(rec?.receivedAmount).toBe(100);
    // Same transaction row is updated in place — NO second history entry.
    expect(rec?.linkedTransactionId).toBe(txIdBefore);
    const tx = await txs.get(txIdBefore);
    expect(tx?.bundleReceivedAmount).toBe(100);
    expect(tx?.bundleState).toBe('FINALIZED');
  });
});

/* =========================================================================
 * T047 — retry late-merge: an out-of-range part_index from a sender retry
 * (FR-017b + FR-022 corollary) updates the linked transaction row in place.
 *
 * Sender behavior: retry parts allocate fresh part_index >= original.bundle_part_count
 * (per Phase 0 R2). For an original 2-part bundle, the retry's first part has
 * part_index = 2. The receiver MUST treat that as a same-bundle late-merge,
 * NOT as a metadata disagreement, NOT as a new bundle.
 * =======================================================================*/

describe('BundleReceiptStore T047 — retry part (out-of-range index) merges in place (FR-017b + FR-022)', () => {
  it('part 0 + (failed part 1) → INCOMPLETE; retry part_index=2 same bundle_id flips to FINALIZED in place', async () => {
    const storage = inMemoryStorage();
    const txs = await freshTransactionStore();
    const store = createBundleReceiptStore({ storage, transactions: txs, clock: fixedClock(T0) });

    // Original bundle declared 2 parts of 50 each, total 100. Only part 0 ever arrives.
    await store.ingest(ingestInput(0, 50));
    let rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec?.state).toBe('IN_FLIGHT');
    expect(rec?.declaredPartCount).toBe(2);

    // 91s pass without part 1 arriving → INCOMPLETE. The transaction row reads "received 50 of 100".
    await store.reconcileExpired(USER_ID, new Date(T0.getTime() + 91_000));
    rec = await store.get(USER_ID, BUNDLE_ID);
    expect(rec?.state).toBe('INCOMPLETE');
    expect(rec?.linkedTransactionId).toBeTruthy();
    const txIdBefore = rec!.linkedTransactionId!;
    const txBefore = await txs.get(txIdBefore);
    expect(txBefore?.bundleReceivedAmount).toBe(50);
    expect(txBefore?.bundleState).toBe('INCOMPLETE');

    // The sender retries the remaining 50. Per R2, the retry part's part_index >= original part_count → 2.
    // Per FR-022, the retry uses the SAME bundle_id so the receiver updates in place.
    // The retry's wire bundle_part_count is 1 (its own count); first-write-wins keeps the original 2 on the
    // record, but the OUT-OF-RANGE part_index is the explicit signal that this is a retry — NOT a disagreement.
    await store.ingest(
      ingestInput(2, 50, {
        receivedAt: new Date(T0.getTime() + 200_000),
        bundle: {
          bundleId: BUNDLE_ID,
          bundleTotal: 100, // matches original — keep total stable
          bundlePartIndex: 2, // OUT OF RANGE compared to declaredPartCount=2 — the retry signal
          bundlePartCount: 1, // retry's own part count (different from original)
          bundlePartId: `${BUNDLE_ID}:2`,
          bundleAttempt: 1,
        },
      })
    );

    rec = await store.get(USER_ID, BUNDLE_ID);
    if (!rec) throw new Error('record missing');
    // Late-merge: state flips to FINALIZED in place.
    expect(rec.state).toBe('FINALIZED');
    expect(rec.receivedAmount).toBe(100);
    // Receipt has 2 received parts (partIndex 0 and 2).
    expect(rec.receivedParts.length).toBe(2);
    expect(rec.receivedParts.map((p) => p.bundlePartIndex).sort()).toEqual([0, 2]);
    // Out-of-range part_index from a retry is NOT a disagreement (per BundleReceiptStore.recordDisagreementsIfAny logic).
    expect(rec.disagreements.some((d) => d.field === 'declaredPartCount')).toBe(false);

    // Same transaction row updated in place — NO second history entry.
    expect(rec.linkedTransactionId).toBe(txIdBefore);
    const all = (await txs.query({})).transactions;
    const matching = all.filter((t) => t.bundleId === BUNDLE_ID);
    expect(matching.length).toBe(1);
    expect(matching[0].bundleReceivedAmount).toBe(100);
    expect(matching[0].bundleState).toBe('FINALIZED');
  });
});

/* =========================================================================
 * T032 — TransactionStore.upsertBundleRecord idempotency
 * =======================================================================*/

describe('TransactionStore T032 — upsertBundleRecord is idempotent on (direction, bundle_id)', () => {
  it('two upserts with the same (direction=IN, bundle_id) update in place; one row remains', async () => {
    const txs = await freshTransactionStore();
    const bundleId = BUNDLE_ID;

    const first = await txs.upsertBundleRecord({
      type: TransactionType.RECEIVED,
      direction: TransactionDirection.IN,
      tokenAmount: 0,
      faceValue: 50,
      faceUnit: 'EUR',
      faceDecimals: 2,
      bundleId,
      bundleDeclaredTotal: 100,
      bundlePartCount: 2,
      bundleReceivedAmount: 50,
      bundleState: 'IN_FLIGHT',
    });

    const second = await txs.upsertBundleRecord({
      type: TransactionType.RECEIVED,
      direction: TransactionDirection.IN,
      tokenAmount: 0,
      faceValue: 100,
      faceUnit: 'EUR',
      faceDecimals: 2,
      bundleId,
      bundleDeclaredTotal: 100,
      bundlePartCount: 2,
      bundleReceivedAmount: 100,
      bundleState: 'FINALIZED',
    });

    expect(second.id).toBe(first.id); // same record, updated in place

    const all = (await txs.query({})).transactions;
    const matching = all.filter((t) => t.bundleId === bundleId && t.direction === TransactionDirection.IN);
    expect(matching.length).toBe(1);
    expect(matching[0].bundleReceivedAmount).toBe(100);
    expect(matching[0].bundleState).toBe('FINALIZED');
    // First-write-wins on declared values: even though both calls passed the same
    // declared values, the upsert's "preserve if existing" path was exercised.
    expect(matching[0].bundleDeclaredTotal).toBe(100);
    expect(matching[0].bundlePartCount).toBe(2);
  });

  it('throws when called without bundle_id', async () => {
    const txs = await freshTransactionStore();
    await expect(
      txs.upsertBundleRecord({
        type: TransactionType.RECEIVED,
        direction: TransactionDirection.IN,
        tokenAmount: 0,
        faceValue: 50,
        faceUnit: 'EUR',
      })
    ).rejects.toThrow();
  });
});

/* =========================================================================
 * Spec 015 Defense E-2 — type/shape extensions
 * =======================================================================*/

describe('BundleReceiptStore E-2 — RedemptionStatus + FINALIZED_PARTIAL shape', () => {
  it('accepts FINALIZED_PARTIAL as a valid BundleReceiptState', () => {
    // Type-level invariant: assigning the new state to a typed slot must
    // compile. The runtime check just validates the value is recognised by
    // any `BundleReceiptState`-typed variable.
    const state: import('../src/store/BundleReceiptStore').BundleReceiptState = 'FINALIZED_PARTIAL';
    expect(state).toBe('FINALIZED_PARTIAL');
  });

  it('accepts redemption_status on a part record', () => {
    const part: import('../src/store/BundleReceiptStore').ReceivedPartRecord = {
      bundlePartId: `${BUNDLE_ID}:0`,
      bundlePartIndex: 0,
      eventId: 'event-0',
      partAmount: 50,
      receivedAt: T0.toISOString(),
      late: false,
      redemption_status: 'FAILED_PERMANENT',
      redemption_error_code: 'proof_already_used',
      redemption_observed_at: T0.toISOString(),
    };
    expect(part.redemption_status).toBe('FAILED_PERMANENT');
    expect(part.redemption_error_code).toBe('proof_already_used');
  });

  it('typed RedemptionStatus union includes all four documented values', () => {
    const claimed: import('../src/store/BundleReceiptStore').RedemptionStatus = 'CLAIMED';
    const failedPerm: import('../src/store/BundleReceiptStore').RedemptionStatus = 'FAILED_PERMANENT';
    const failedTrans: import('../src/store/BundleReceiptStore').RedemptionStatus = 'FAILED_TRANSIENT';
    const pending: import('../src/store/BundleReceiptStore').RedemptionStatus = 'PENDING';
    expect([claimed, failedPerm, failedTrans, pending].length).toBe(4);
  });
});
