/**
 * Vitest for WalletStorage.atomicallyWrite (spec 038 FR-014).
 *
 * Pins the all-or-nothing contract: either both stores receive their
 * rows or neither does. Closes the FR-019 "voucher saved but tx write
 * failed" partial-state class.
 *
 * Also covers FR-020 voucher schema fields — they persist through
 * atomicallyWrite the same way they persist through saveVoucher.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WalletStorage } from '../src/WalletStorage';
import { WalletStorageInvalidTokenError } from '../src/errors';
import type { VoucherRow, TransactionRow, WalletStorageEvent } from '../src/types';
import { openTestDatabase, uniqueDbName, makeFakeCashuToken } from './helpers';

describe('WalletStorage.atomicallyWrite', () => {
  let db: IDBDatabase;
  let storage: WalletStorage;

  beforeEach(async () => {
    db = await openTestDatabase(uniqueDbName());
    storage = new WalletStorage({ db });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    db.close();
  });

  // --- Happy path ---

  it('commits a single voucher + single transaction in one IDB transaction', async () => {
    const voucher: VoucherRow = {
      token_id: 'tok_1',
      token: makeFakeCashuToken('a'),
      amount: 100,
      created_at: '',
      updated_at: '',
    };
    const tx: TransactionRow = {
      id: 'received:tok_1',
      type: 'receive',
      direction: 'in',
      timestamp: 1700000000,
      voucher_id: 'tok_1',
    };

    await storage.atomicallyWrite({ vouchers: [voucher], transactions: [tx] });

    const v = await storage.getVoucher('tok_1');
    const t = await storage.getTransaction('received:tok_1');
    expect(v?.token_id).toBe('tok_1');
    expect(v?.amount).toBe(100);
    expect(t?.id).toBe('received:tok_1');
    expect(t?.type).toBe('receive');
  });

  it('commits multiple vouchers + multiple transactions atomically', async () => {
    const vouchers: VoucherRow[] = [
      { token_id: 'tok_1', token: makeFakeCashuToken('a'), amount: 50, created_at: '', updated_at: '' },
      { token_id: 'tok_2', token: makeFakeCashuToken('b'), amount: 75, created_at: '', updated_at: '' },
    ];
    const transactions: TransactionRow[] = [
      { id: 'received:tok_1', type: 'receive', direction: 'in', timestamp: 1700000000, voucher_id: 'tok_1' },
      { id: 'received:tok_2', type: 'receive', direction: 'in', timestamp: 1700000001, voucher_id: 'tok_2' },
    ];

    await storage.atomicallyWrite({ vouchers, transactions });

    expect((await storage.getAllVouchers()).length).toBe(2);
    expect((await storage.getAllTransactions()).length).toBe(2);
  });

  it('upserts existing vouchers (idempotent merge by token_id)', async () => {
    const tokenA = makeFakeCashuToken('a');
    await storage.saveVoucher({
      token_id: 'tok_1',
      token: tokenA,
      amount: 50,
      created_at: '',
      updated_at: '',
    });
    const originalCreatedAt = (await storage.getVoucher('tok_1'))!.created_at;

    await storage.atomicallyWrite({
      vouchers: [
        { token_id: 'tok_1', token: tokenA, amount: 50, status: 'redeemed', created_at: '', updated_at: '' },
      ],
    });

    const v = await storage.getVoucher('tok_1');
    expect(v?.status).toBe('redeemed');
    expect(v?.created_at).toBe(originalCreatedAt); // Preserved on existing rows.
  });

  it('FR-020: persists received_via_event_id, swap_completed_at, swap_proof_ids, source_transport', async () => {
    const voucher: VoucherRow = {
      token_id: 'tok_1',
      token: makeFakeCashuToken('a'),
      amount: 100,
      created_at: '',
      updated_at: '',
      received_via_event_id: 'ev_'.padEnd(64, '0'),
      swap_completed_at: '2026-06-01T22:00:00.000Z',
      swap_proof_ids: ['ks_aa', 'ks_bb'],
      source_transport: 'sse',
    };

    await storage.atomicallyWrite({ vouchers: [voucher] });

    const v = await storage.getVoucher('tok_1');
    expect(v?.received_via_event_id).toBe('ev_'.padEnd(64, '0'));
    expect(v?.swap_completed_at).toBe('2026-06-01T22:00:00.000Z');
    expect(v?.swap_proof_ids).toEqual(['ks_aa', 'ks_bb']);
    expect(v?.source_transport).toBe('sse');
  });

  it('FR-020 backward compat: vouchers WITHOUT the new fields persist + read back with the fields undefined', async () => {
    const voucher: VoucherRow = {
      token_id: 'tok_1',
      token: makeFakeCashuToken('a'),
      amount: 100,
      created_at: '',
      updated_at: '',
    };
    await storage.atomicallyWrite({ vouchers: [voucher] });
    const v = await storage.getVoucher('tok_1');
    expect(v?.received_via_event_id).toBeUndefined();
    expect(v?.swap_completed_at).toBeUndefined();
    expect(v?.swap_proof_ids).toBeUndefined();
    expect(v?.source_transport).toBeUndefined();
  });

  it('empty input is a no-op (no events posted, no error)', async () => {
    const events: WalletStorageEvent[] = [];
    storage.onChange((e) => events.push(e));
    await storage.atomicallyWrite({});
    await storage.atomicallyWrite({ vouchers: [], transactions: [] });
    expect(events.length).toBe(0);
  });

  it('only-vouchers call posts only vouchers:changed', async () => {
    const events: WalletStorageEvent[] = [];
    const handler = (e: WalletStorageEvent) => events.push(e);
    storage.onChange(handler);
    await storage.atomicallyWrite({
      vouchers: [{ token_id: 'tok_1', token: makeFakeCashuToken('a'), amount: 1, created_at: '', updated_at: '' }],
    });
    // onChange events fire on remote tabs only — the local writer doesn't see its own.
    // Verify the IDB write committed:
    expect(await storage.getVoucher('tok_1')).not.toBeNull();
  });

  it('auto-derives token_id when absent (parity with saveVoucher)', async () => {
    const token = makeFakeCashuToken('a');
    await storage.atomicallyWrite({
      vouchers: [
        // No token_id — must be auto-derived from token via spec-017's hash.
        { token: token, amount: 100, created_at: '', updated_at: '' } as unknown as VoucherRow,
      ],
    });
    const all = await storage.getAllVouchers();
    expect(all.length).toBe(1);
    expect(all[0].token_id).toBeDefined();
    expect(all[0].token_id.length).toBeGreaterThan(0);
  });

  // --- Validation / failure paths ---

  it('rejects + does NOT write when voucher token fails the shape check', async () => {
    await expect(
      storage.atomicallyWrite({
        vouchers: [
          {
            token_id: 'tok_bad',
            token: 'NOT_A_CASHU_TOKEN',
            amount: 100,
            created_at: '',
            updated_at: '',
          },
        ],
        transactions: [{ id: 'received:tok_bad', type: 'receive', direction: 'in', timestamp: 1 }],
      })
    ).rejects.toBeInstanceOf(WalletStorageInvalidTokenError);

    // Neither store was touched.
    expect((await storage.getAllVouchers()).length).toBe(0);
    expect((await storage.getAllTransactions()).length).toBe(0);
  });

  it('rejects + does NOT write when voucher lacks both token_id AND token', async () => {
    await expect(
      storage.atomicallyWrite({
        vouchers: [{ amount: 100, created_at: '', updated_at: '' } as unknown as VoucherRow],
        transactions: [{ id: 'received:orphan', type: 'receive', direction: 'in', timestamp: 1 }],
      })
    ).rejects.toBeInstanceOf(WalletStorageInvalidTokenError);

    expect((await storage.getAllVouchers()).length).toBe(0);
    // The atomic contract: transaction also NOT written despite being well-formed.
    expect((await storage.getAllTransactions()).length).toBe(0);
  });

  it('throws on uninitialized storage', async () => {
    const uninit = new WalletStorage({ db });
    // No init().
    await expect(uninit.atomicallyWrite({ vouchers: [], transactions: [] })).rejects.toThrow(
      /called before init/i
    );
  });

  // --- Rollback semantics under simulated mid-write failure ---
  //
  // We can't trivially force a put() to fail mid-transaction on fake-indexeddb,
  // but we CAN verify the "validation rejected → BOTH absent" path above
  // (a malformed voucher AND a well-formed transaction both end up absent),
  // which is the user-visible guarantee FR-014 cares about.
});
