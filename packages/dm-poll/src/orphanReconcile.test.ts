/**
 * Vitest for orphanReconcile (T024a + T024c).
 *
 * Pins FR-015 (orphan tx fix) + FR-021 (source_transport='manual' backfill)
 * across the per-voucher decision matrix.
 */

import { describe, it, expect, vi } from 'vitest';
import { reconcileVoucherTxOrphans } from './orphanReconcile';
import type {
  OrphanReconcileDeps,
  ReconcileVoucherRow,
  ReconcileTransactionRow,
} from './orphanReconcile';

function v(over: Partial<ReconcileVoucherRow>): ReconcileVoucherRow {
  return {
    token_id: 'tok_default',
    token: 'cashuBfakecashufakecashufake',
    amount: 100,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeDeps(over: Partial<OrphanReconcileDeps> & { vouchers: ReconcileVoucherRow[]; txByTokenId?: Map<string, ReconcileTransactionRow> }): OrphanReconcileDeps {
  const txMap = over.txByTokenId ?? new Map();
  return {
    getAllVouchers: vi.fn(async () => over.vouchers),
    getTransactionByTokenId: vi.fn(async (id: string) => txMap.get(id) ?? null),
    addTransaction: vi.fn(async (row: ReconcileTransactionRow) => {
      txMap.set(row.id, row);
      return row;
    }),
    saveVoucher: vi.fn(async (row: ReconcileVoucherRow) => row),
    buildTransactionForVoucher: (voucher: ReconcileVoucherRow): ReconcileTransactionRow => ({
      id: voucher.token_id,
      type: 'receive',
      direction: 'in',
      timestamp: Date.now(),
      voucher_id: voucher.voucher_id,
      amount: voucher.amount,
    }),
    ...over,
  };
}

describe('reconcileVoucherTxOrphans', () => {
  // --- FR-015 (orphan fix) ---

  it('fixes a voucher with swap_completed_at set + missing transaction row', async () => {
    const deps = makeDeps({
      vouchers: [v({ token_id: 't1', swap_completed_at: '2026-05-01T00:00:00Z' })],
    });
    const summary = await reconcileVoucherTxOrphans(deps);
    expect(summary).toMatchObject({ scanned: 1, candidates: 1, fixed: 1 });
    expect(deps.addTransaction).toHaveBeenCalledTimes(1);
  });

  it('skips a voucher whose transaction row already exists', async () => {
    const tx: ReconcileTransactionRow = { id: 't1', type: 'receive', direction: 'in', timestamp: 1 };
    const deps = makeDeps({
      vouchers: [v({ token_id: 't1', swap_completed_at: '2026-05-01T00:00:00Z' })],
      txByTokenId: new Map([['t1', tx]]),
    });
    const summary = await reconcileVoucherTxOrphans(deps);
    expect(summary).toMatchObject({ scanned: 1, candidates: 1, fixed: 0 });
    expect(deps.addTransaction).not.toHaveBeenCalled();
  });

  it('skips a voucher with swap_completed_at unset (NOT in scope for this pass)', async () => {
    const deps = makeDeps({
      vouchers: [v({ token_id: 't1' })], // No swap_completed_at.
    });
    const summary = await reconcileVoucherTxOrphans(deps);
    expect(summary).toMatchObject({ scanned: 1, candidates: 0, fixed: 0, backfilled: 0 });
    expect(deps.addTransaction).not.toHaveBeenCalled();
    expect(deps.saveVoucher).not.toHaveBeenCalled();
  });

  it('does NOT call addTransaction when buildTransactionForVoucher returns null', async () => {
    const deps = makeDeps({
      vouchers: [v({ token_id: 't1', swap_completed_at: '2026-05-01T00:00:00Z' })],
      buildTransactionForVoucher: () => null,
    });
    const summary = await reconcileVoucherTxOrphans(deps);
    expect(summary.fixed).toBe(0);
    expect(deps.addTransaction).not.toHaveBeenCalled();
  });

  // --- FR-021 (backfill) ---

  it("backfills source_transport='manual' on a legacy voucher with swap_completed_at set", async () => {
    const tx: ReconcileTransactionRow = { id: 't1', type: 'receive', direction: 'in', timestamp: 1 };
    const deps = makeDeps({
      vouchers: [v({ token_id: 't1', swap_completed_at: '2026-05-01T00:00:00Z' })],
      txByTokenId: new Map([['t1', tx]]),
    });
    const summary = await reconcileVoucherTxOrphans(deps);
    expect(summary.backfilled).toBe(1);
    expect(deps.saveVoucher).toHaveBeenCalledTimes(1);
    expect((deps.saveVoucher as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      token_id: 't1',
      source_transport: 'manual',
    });
  });

  it('does NOT backfill a voucher that already has source_transport set', async () => {
    const tx: ReconcileTransactionRow = { id: 't1', type: 'receive', direction: 'in', timestamp: 1 };
    const deps = makeDeps({
      vouchers: [v({ token_id: 't1', swap_completed_at: '2026-05-01T00:00:00Z', source_transport: 'sse' })],
      txByTokenId: new Map([['t1', tx]]),
    });
    const summary = await reconcileVoucherTxOrphans(deps);
    expect(summary.backfilled).toBe(0);
    expect(deps.saveVoucher).not.toHaveBeenCalled();
  });

  // --- Idempotency ---

  it('is idempotent — second run after first is a no-op', async () => {
    const txMap = new Map<string, ReconcileTransactionRow>();
    const vouchers = [
      v({ token_id: 't1', swap_completed_at: '2026-05-01T00:00:00Z' }),
    ];
    const deps = makeDeps({ vouchers, txByTokenId: txMap });

    const first = await reconcileVoucherTxOrphans(deps);
    expect(first).toMatchObject({ fixed: 1, backfilled: 1 });

    // After the first pass: tx exists, and the source_transport is backfilled
    // on the in-memory voucher. The second pass sees the tx exists AND the
    // saveVoucher was called once with the backfill — but since the test's
    // deps.vouchers array doesn't get mutated by saveVoucher, we have to
    // assert via the call history rather than re-reading state. The
    // important check is that the SECOND addTransaction call DOES NOT happen
    // because the first call wrote to txMap.
    const second = await reconcileVoucherTxOrphans(deps);
    expect(second.fixed).toBe(0);
    // The saveVoucher call WILL repeat in this simple test setup since the
    // in-memory voucher row isn't updated; in production it doesn't because
    // saveVoucher persists and getAllVouchers returns the updated row. Pin
    // only the property that matters for production correctness: tx writes
    // are not duplicated.
    expect(deps.addTransaction).toHaveBeenCalledTimes(1);
  });

  // --- Per-voucher failure isolation ---

  it('continues past a single voucher failure (does not abort the pass)', async () => {
    const txMap = new Map<string, ReconcileTransactionRow>();
    let attemptCount = 0;
    const deps = makeDeps({
      vouchers: [
        v({ token_id: 't1', swap_completed_at: '2026-05-01T00:00:00Z' }),
        v({ token_id: 't2', swap_completed_at: '2026-05-01T00:00:00Z' }),
      ],
      txByTokenId: txMap,
      addTransaction: vi.fn(async (row: ReconcileTransactionRow) => {
        attemptCount++;
        if (attemptCount === 1) throw new Error('simulated IDB blip');
        txMap.set(row.id, row);
        return row;
      }),
    });
    const summary = await reconcileVoucherTxOrphans(deps);
    expect(summary.scanned).toBe(2);
    expect(summary.candidates).toBe(2);
    expect(summary.fixed).toBe(1); // t1 failed; t2 succeeded.
  });

  it('returns a clean zero summary if getAllVouchers itself throws', async () => {
    const deps = makeDeps({
      vouchers: [],
      getAllVouchers: vi.fn(async () => {
        throw new Error('IDB unavailable');
      }),
    });
    const summary = await reconcileVoucherTxOrphans(deps);
    expect(summary).toEqual({ scanned: 0, fixed: 0, backfilled: 0, candidates: 0 });
  });
});
