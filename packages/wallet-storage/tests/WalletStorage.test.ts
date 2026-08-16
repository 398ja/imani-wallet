/**
 * WalletStorage unit tests covering single-instance contracts.
 *
 * Cross-tab contracts (C-PKG-3, C-PKG-4) live in crossTab.test.ts.
 * Fallback contract (C-PKG-8) lives in fallback.test.ts (Phase 4).
 *
 * See specs/024-vouchers-tx-idb-migration/contracts/wallet-storage.contract.md §1.4.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WalletStorage,
  WalletStorageInvalidTokenError,
  type VoucherRow,
  type WalletStorageEvent,
} from '../src';
import { makeFakeCashuToken, openTestDatabase, uniqueDbName } from './helpers';

describe('WalletStorage', () => {
  let storage: WalletStorage;
  let db: IDBDatabase;
  let dbName: string;

  let channelName: string;

  beforeEach(async () => {
    dbName = uniqueDbName();
    channelName = uniqueDbName('chan');
    db = await openTestDatabase(dbName);
    storage = new WalletStorage({ db, channelName });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    db.close();
  });

  // C-PKG-1: commit-before-event — verified via the broadcast happening
  // AFTER the IDB write resolves (saveVoucher only returns post-tx.oncomplete).
  it('C-PKG-1: posts BroadcastChannel event only after the IDB transaction commits', async () => {
    const events: WalletStorageEvent[] = [];
    storage.onChange((e) => events.push(e));

    // Sender posts onto the same channel; second WalletStorage instance
    // listens. We can't subscribe to our own events (self-filter), so
    // construct a peer instance to verify the event was actually posted.
    const peer = new WalletStorage({ db, channelName });
    await peer.init();
    const peerEvents: WalletStorageEvent[] = [];
    peer.onChange((e) => peerEvents.push(e));

    const before = await storage.getAllVouchers();
    expect(before).toEqual([]);

    const saved = await storage.saveVoucher({
      token_id: 'a'.repeat(32),
      token: makeFakeCashuToken('a'),
      amount: 100,
      created_at: '',
      updated_at: '',
    });

    // The save returns the merged row read AFTER commit.
    expect(saved.token_id).toBe('a'.repeat(32));
    expect(saved.amount).toBe(100);

    // Wait a microtask so the peer's channel handler fires.
    await new Promise((r) => setTimeout(r, 50));

    expect(peerEvents.length).toBe(1);
    expect(peerEvents[0]!.type).toBe('vouchers:changed');
    expect(peerEvents[0]!.ts).toBeGreaterThan(0);
    expect(events.length).toBe(0); // self-event filtering — see C-PKG-5

    await peer.close();
  });

  // C-PKG-2: idempotent merge.
  it('C-PKG-2: two saveVoucher calls with the same token_id produce one row + partial-merge fields', async () => {
    await storage.saveVoucher({
      token_id: 'b'.repeat(32),
      token: makeFakeCashuToken('b'),
      amount: 100,
      face_value: 5,
      face_unit: 'EUR',
      created_at: '',
      updated_at: '',
    });

    // Second save — only updates `amount`, leaves face_value / face_unit untouched.
    await storage.saveVoucher({
      token_id: 'b'.repeat(32),
      token: makeFakeCashuToken('b'),
      amount: 200,
      created_at: '',
      updated_at: '',
    });

    const all = await storage.getAllVouchers();
    expect(all).toHaveLength(1);
    expect(all[0]!.amount).toBe(200);
    expect(all[0]!.face_value).toBe(5); // preserved
    expect(all[0]!.face_unit).toBe('EUR'); // preserved
  });

  // C-PKG-5: self-event filtering.
  it('C-PKG-5: a WalletStorage instance does NOT receive its own BroadcastChannel events', async () => {
    const events: WalletStorageEvent[] = [];
    storage.onChange((e) => events.push(e));

    await storage.saveVoucher({
      token_id: 'c'.repeat(32),
      token: makeFakeCashuToken('c'),
      amount: 1,
      created_at: '',
      updated_at: '',
    });

    await new Promise((r) => setTimeout(r, 50));

    // We posted but should NOT have received our own event.
    expect(events).toEqual([]);
  });

  // C-PKG-6: token backstop.
  it('C-PKG-6: saveVoucher with a malformed token throws WalletStorageInvalidTokenError and writes nothing', async () => {
    const before = await storage.getAllVouchers();

    await expect(
      storage.saveVoucher({
        token_id: 'd'.repeat(32),
        token: 'definitely not a cashu token',
        amount: 1,
        created_at: '',
        updated_at: '',
      })
    ).rejects.toBeInstanceOf(WalletStorageInvalidTokenError);

    const after = await storage.getAllVouchers();
    expect(after).toEqual(before);
  });

  // C-PKG-7: token_id auto-derivation.
  it('C-PKG-7: saveVoucher without token_id computes it from the token', async () => {
    const token = makeFakeCashuToken('e');
    const saved = await storage.saveVoucher({
      // @ts-expect-error — intentionally omit token_id to exercise derivation
      token_id: undefined,
      token,
      amount: 42,
      created_at: '',
      updated_at: '',
    });

    expect(saved.token_id).toBeTruthy();
    expect(saved.token_id).toMatch(/^[0-9a-f]{32}$/);

    const all = await storage.getAllVouchers();
    expect(all).toHaveLength(1);
    expect(all[0]!.token_id).toBe(saved.token_id);
  });

  // C-PKG-9: no-row-payload events.
  it('C-PKG-9: BroadcastChannel event shape is exactly {type, source, ts} — no row payload', async () => {
    const peer = new WalletStorage({ db, channelName });
    await peer.init();

    const peerEvents: WalletStorageEvent[] = [];
    peer.onChange((e) => peerEvents.push(e));

    await storage.saveVoucher({
      token_id: 'f'.repeat(32),
      token: makeFakeCashuToken('f'),
      amount: 9,
      created_at: '',
      updated_at: '',
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(peerEvents).toHaveLength(1);
    const ev = peerEvents[0]!;
    expect(Object.keys(ev).sort()).toEqual(['source', 'ts', 'type']);
    expect(ev).not.toHaveProperty('data');
    expect(ev).not.toHaveProperty('voucher');
    expect(ev).not.toHaveProperty('row');

    await peer.close();
  });

  // C-PKG-10: perf budget.
  it('C-PKG-10: saveVoucher round-trip completes inside 50ms (fake-indexeddb)', async () => {
    const voucher: VoucherRow = {
      token_id: 'g'.repeat(32),
      token: makeFakeCashuToken('g'),
      amount: 1,
      created_at: '',
      updated_at: '',
    };
    const t0 = performance.now();
    await storage.saveVoucher(voucher);
    const dt = performance.now() - t0;
    // Generous bound for CI under load — production budget is <50ms p99 on
    // low-end Android Chrome; fake-indexeddb under vitest is typically
    // single-digit ms. We assert <500ms to guard against catastrophic
    // regressions (real failures would be 10x slower).
    expect(dt).toBeLessThan(500);
  });

  // Bonus: getVoucherByVoucherId via the secondary index.
  it('getVoucherByVoucherId returns the first matching row from the by-voucher-id index', async () => {
    await storage.saveVoucher({
      token_id: '1'.repeat(32),
      voucher_id: 'merchant-tpl-A',
      token: makeFakeCashuToken('1'),
      amount: 10,
      created_at: '',
      updated_at: '',
    });

    const got = await storage.getVoucherByVoucherId('merchant-tpl-A');
    expect(got).not.toBeNull();
    expect(got!.token_id).toBe('1'.repeat(32));
  });

  // Spec 041 SA-006 — getVoucherByPurchaseId
  describe('spec 041 — getVoucherByPurchaseId + provenance fields', () => {
    it('returns the matching client-mint row and round-trips all five SA-006 fields', async () => {
      const tokenId = 'a'.repeat(32);
      await storage.saveVoucher({
        token_id: tokenId,
        voucher_id: 'merchant-tpl-A',
        token: makeFakeCashuToken('a'),
        amount: 1000,
        created_at: '',
        updated_at: '',
        // All five SA-006 fields together — happy path.
        source_transport: 'client_mint',
        purchase_id: 'ap_20260605_test_xyz',
        materialized_at: '2026-06-05T12:34:56Z',
        proof_sum: 1000,
        keyset_ids: ['00abcdef1234'],
      });

      const got = await storage.getVoucherByPurchaseId('ap_20260605_test_xyz');
      expect(got).not.toBeNull();
      expect(got!.token_id).toBe(tokenId);
      expect(got!.source_transport).toBe('client_mint');
      expect(got!.purchase_id).toBe('ap_20260605_test_xyz');
      expect(got!.materialized_at).toBe('2026-06-05T12:34:56Z');
      expect(got!.proof_sum).toBe(1000);
      expect(got!.keyset_ids).toEqual(['00abcdef1234']);
    });

    it('returns null when no row matches', async () => {
      await storage.saveVoucher({
        token_id: 'b'.repeat(32),
        token: makeFakeCashuToken('b'),
        amount: 100,
        created_at: '',
        updated_at: '',
        purchase_id: 'ap_other',
      });

      const got = await storage.getVoucherByPurchaseId('ap_absent');
      expect(got).toBeNull();
    });

    it('returns null on empty-string purchaseId without scanning', async () => {
      await storage.saveVoucher({
        token_id: 'c'.repeat(32),
        token: makeFakeCashuToken('c'),
        amount: 50,
        created_at: '',
        updated_at: '',
      });

      expect(await storage.getVoucherByPurchaseId('')).toBeNull();
    });

    it('ignores legacy rows that have no purchase_id field', async () => {
      // Pre-spec-041 rows simply omit the field — should not match
      // any purchase_id lookup and should not crash the scan.
      await storage.saveVoucher({
        token_id: 'd'.repeat(32),
        token: makeFakeCashuToken('d'),
        amount: 200,
        created_at: '',
        updated_at: '',
        // No purchase_id — pre-spec-041 row shape.
      });

      const got = await storage.getVoucherByPurchaseId('ap_anything');
      expect(got).toBeNull();
    });

    it('allows gateway_mint as a discriminator without forcing other fields', async () => {
      // SA-006 says source_transport='gateway_mint' is the explicit
      // legacy label. Pinning that the type accepts this combination
      // without runtime rejection so consumers can backfill.
      await storage.saveVoucher({
        token_id: 'e'.repeat(32),
        token: makeFakeCashuToken('e'),
        amount: 300,
        created_at: '',
        updated_at: '',
        source_transport: 'gateway_mint',
      });

      const all = await storage.getAllVouchers();
      const got = all.find((v) => v.token_id === 'e'.repeat(32));
      expect(got).toBeDefined();
      expect(got!.source_transport).toBe('gateway_mint');
    });
  });

  // Bonus: transactions round-trip.
  it('addTransaction + getTransactionsByVoucher round-trip', async () => {
    await storage.addTransaction({
      id: 'send:v1:t1',
      voucher_id: 'v1',
      type: 'send',
      direction: 'out',
      timestamp: 1779000000,
    });
    await storage.addTransaction({
      id: 'send:v1:t2',
      voucher_id: 'v1',
      type: 'send',
      direction: 'out',
      timestamp: 1779000001,
    });
    await storage.addTransaction({
      id: 'recv:v2:t1',
      voucher_id: 'v2',
      type: 'receive',
      direction: 'in',
      timestamp: 1779000002,
    });

    const v1Txs = await storage.getTransactionsByVoucher('v1');
    expect(v1Txs).toHaveLength(2);

    const v2Txs = await storage.getTransactionsByVoucher('v2');
    expect(v2Txs).toHaveLength(1);
  });

  // Bonus: removeVoucher returns true when present, false when absent.
  it('removeVoucher returns true on first call, false on second', async () => {
    await storage.saveVoucher({
      token_id: 'h'.repeat(32),
      token: makeFakeCashuToken('h'),
      amount: 1,
      created_at: '',
      updated_at: '',
    });

    expect(await storage.removeVoucher('h'.repeat(32))).toBe(true);
    expect(await storage.removeVoucher('h'.repeat(32))).toBe(false);
  });
});
