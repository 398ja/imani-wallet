/**
 * Spec 039 — reconcileQrShares() test contract.
 * Covers the 7 cases pinned in
 * `specs/039-reliable-qr-transfers/contracts/reconcile-trigger.md`.
 */

import { describe, expect, it, vi } from 'vitest';

import { reconcileQrShares } from '../src/reconcileQrShares';
import type {
  PendingQrShare,
  ProofRef,
  ProofStateMap,
  ReconcileQrSharesDeps,
  ReconcileTransactionRow,
  ReconcileVoucherRow,
} from '../src/types/qr-share';

interface Scenario {
  shares: PendingQrShare[];
  vouchers: Record<string, ReconcileVoucherRow>;
  proofStates: Record<string, ProofStateMap>;
  hasExistingSentRow?: Record<string, boolean>;
  now?: number;
  addTransactionThrows?: boolean;
  addTransactionDelayMs?: number;
}

function makeShare(overrides: Partial<PendingQrShare> = {}): PendingQrShare {
  return {
    share_id: 's1',
    voucher_id: 'v1',
    token_id: 't1',
    amount: 100,
    unit: 'EUR',
    issuer_id: 'ab12',
    created_at: '2026-06-02T10:00:00.000Z',
    updated_at: '2026-06-02T10:00:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

function makeVoucher(overrides: Partial<ReconcileVoucherRow> = {}): ReconcileVoucherRow {
  return {
    voucher_id: 'v1',
    token_id: 't1',
    amount: 100,
    unit: 'EUR',
    issuer_id: 'ab12',
    expires_at: '2027-12-31T23:59:59.000Z',
    proofs: [{ secret: 'p1', C: 'C1', amount: 100 }] as ReadonlyArray<ProofRef>,
    ...overrides,
  };
}

function buildDeps(scenario: Scenario): ReconcileQrSharesDeps & {
  _markSent: ReturnType<typeof vi.fn>;
  _closeWithReason: ReturnType<typeof vi.fn>;
  _addTransaction: ReturnType<typeof vi.fn>;
  _markSentTimes: number[];
} {
  const markSent = vi.fn(async () => undefined);
  const closeWithReason = vi.fn(async () => undefined);
  const markSentTimes: number[] = [];
  const addTransaction = vi.fn((row: ReconcileTransactionRow) => {
    if (scenario.addTransactionThrows) {
      throw new Error('forced addTransaction failure');
    }
    return {
      commitPromise: new Promise<ReconcileTransactionRow>((resolve) => {
        const delay = scenario.addTransactionDelayMs ?? 0;
        if (delay > 0) {
          setTimeout(() => resolve(row), delay);
        } else {
          Promise.resolve().then(() => resolve(row));
        }
      }),
    };
  });
  const wrappedMarkSent = vi.fn(async (shareId: string) => {
    markSentTimes.push(Date.now());
    await markSent(shareId);
  });
  return {
    getActivePendingShares: async () => [...scenario.shares],
    getVoucherByTokenId: async (tokenId) => scenario.vouchers[tokenId] ?? null,
    checkProofStates: async () => scenario.proofStates[Object.keys(scenario.proofStates)[0] ?? ''] ?? {},
    addTransaction,
    markSent: wrappedMarkSent,
    closeWithReason,
    hasExistingSentRow: scenario.hasExistingSentRow
      ? async (tokenId: string) => Boolean(scenario.hasExistingSentRow![tokenId])
      : undefined,
    now: () => scenario.now ?? Date.now(),
    logger: { info: () => undefined, warn: () => undefined },
    _markSent: markSent,
    _closeWithReason: closeWithReason,
    _addTransaction: addTransaction,
    _markSentTimes: markSentTimes,
  } as unknown as ReconcileQrSharesDeps & {
    _markSent: ReturnType<typeof vi.fn>;
    _closeWithReason: ReturnType<typeof vi.fn>;
    _addTransaction: ReturnType<typeof vi.fn>;
    _markSentTimes: number[];
  };
}

describe('reconcileQrShares', () => {
  it('happy path — all SPENT, no canonical row → transitions to sent', async () => {
    const share = makeShare();
    const voucher = makeVoucher();
    const deps = buildDeps({
      shares: [share],
      vouchers: { [share.token_id]: voucher },
      proofStates: { [share.token_id]: { p1: 'SPENT' } },
    });
    const summary = await reconcileQrShares(deps);
    expect(summary.sent).toBe(1);
    expect(summary.closedBySelfSpend).toBe(0);
    expect(deps._markSent).toHaveBeenCalledWith(share.share_id);
    expect(deps._addTransaction).toHaveBeenCalledTimes(1);
    const callArg = deps._addTransaction.mock.calls[0][0] as ReconcileTransactionRow;
    expect(callArg.id).toBe(`sent:${share.token_id}`);
    expect(callArg.direction).toBe('out');
  });

  it('self-spend — all SPENT but canonical sent row already exists → closed-by-self-spend', async () => {
    const share = makeShare();
    const voucher = makeVoucher();
    const deps = buildDeps({
      shares: [share],
      vouchers: { [share.token_id]: voucher },
      proofStates: { [share.token_id]: { p1: 'SPENT' } },
      hasExistingSentRow: { [share.token_id]: true },
    });
    const summary = await reconcileQrShares(deps);
    expect(summary.sent).toBe(0);
    expect(summary.closedBySelfSpend).toBe(1);
    expect(deps._markSent).not.toHaveBeenCalled();
    expect(deps._closeWithReason).toHaveBeenCalledWith(share.share_id, 'closed-by-self-spend');
  });

  it('expired — UNSPENT proofs + expires_at past → expired-without-claim', async () => {
    const share = makeShare();
    const voucher = makeVoucher({ expires_at: '2020-01-01T00:00:00.000Z' });
    const deps = buildDeps({
      shares: [share],
      vouchers: { [share.token_id]: voucher },
      proofStates: { [share.token_id]: { p1: 'UNSPENT' } },
      now: Date.parse('2026-06-02T10:00:00.000Z'),
    });
    const summary = await reconcileQrShares(deps);
    expect(summary.expiredWithoutClaim).toBe(1);
    expect(summary.sent).toBe(0);
    expect(deps._closeWithReason).toHaveBeenCalledWith(share.share_id, 'expired-without-claim');
  });

  it('deferred — UNSPENT + not expired → stays pending, no terminal calls', async () => {
    const share = makeShare();
    const voucher = makeVoucher();
    const deps = buildDeps({
      shares: [share],
      vouchers: { [share.token_id]: voucher },
      proofStates: { [share.token_id]: { p1: 'UNSPENT' } },
    });
    const summary = await reconcileQrShares(deps);
    expect(summary.deferred).toBe(1);
    expect(deps._markSent).not.toHaveBeenCalled();
    expect(deps._closeWithReason).not.toHaveBeenCalled();
  });

  it('mixed batch — per-share failures do not abort siblings', async () => {
    const s1 = makeShare({ share_id: 's1', token_id: 't1' });
    const s2 = makeShare({ share_id: 's2', token_id: 'missing' });
    const s3 = makeShare({ share_id: 's3', token_id: 't3' });
    const v1 = makeVoucher({ token_id: 't1' });
    const v3 = makeVoucher({ token_id: 't3' });
    const deps = buildDeps({
      shares: [s1, s2, s3],
      vouchers: { t1: v1, t3: v3 },
      proofStates: { t1: { p1: 'SPENT' }, t3: { p1: 'SPENT' } },
    });
    // Make checkProofStates return per-token correctly.
    (deps as unknown as { checkProofStates: (p: unknown) => Promise<ProofStateMap> }).checkProofStates =
      async () => ({ p1: 'SPENT' });
    const summary = await reconcileQrShares(deps);
    // s2 should be `failed` (orphan), s1 + s3 should be `sent`.
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(2);
    expect(summary.scanned).toBe(3);
  });

  it('idempotent re-run — empty active list returns {scanned: 0}', async () => {
    const deps = buildDeps({
      shares: [],
      vouchers: {},
      proofStates: {},
    });
    const summary = await reconcileQrShares(deps);
    expect(summary).toEqual({
      scanned: 0,
      sent: 0,
      closedBySelfSpend: 0,
      expiredWithoutClaim: 0,
      deferred: 0,
      failed: 0,
    });
    expect(deps._markSent).not.toHaveBeenCalled();
    expect(deps._addTransaction).not.toHaveBeenCalled();
  });

  it('commitPromise await — markSent NOT called until addTransaction commit resolves', async () => {
    const share = makeShare();
    const voucher = makeVoucher();
    let markSentCalledAt: number | null = null;
    let commitResolvedAt: number | null = null;
    const addTransaction = vi.fn((row: ReconcileTransactionRow) => ({
      commitPromise: new Promise<ReconcileTransactionRow>((resolve) => {
        // Resolve after 2 microtasks so we can probe ordering.
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => {
            commitResolvedAt = performance.now();
            resolve(row);
          });
      }),
    }));
    const markSent = vi.fn(async () => {
      markSentCalledAt = performance.now();
    });
    const deps: ReconcileQrSharesDeps = {
      getActivePendingShares: async () => [share],
      getVoucherByTokenId: async () => voucher,
      checkProofStates: async () => ({ p1: 'SPENT' }),
      addTransaction,
      markSent,
      closeWithReason: vi.fn(async () => undefined),
      now: () => Date.parse('2026-06-02T10:00:00.000Z'),
      logger: { info: () => undefined, warn: () => undefined },
    };
    await reconcileQrShares(deps);
    expect(addTransaction).toHaveBeenCalledTimes(1);
    expect(markSent).toHaveBeenCalledTimes(1);
    expect(commitResolvedAt).not.toBeNull();
    expect(markSentCalledAt).not.toBeNull();
    expect(markSentCalledAt!).toBeGreaterThanOrEqual(commitResolvedAt!);
  });
});
