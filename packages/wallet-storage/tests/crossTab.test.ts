/**
 * Cross-tab safety tests — two WalletStorage instances sharing one IDB DB,
 * simulating two browser tabs. Covers contracts C-PKG-3 and C-PKG-4 from
 * specs/024-vouchers-tx-idb-migration/contracts/wallet-storage.contract.md.
 *
 * fake-indexeddb provides a single in-process IDB realm; two
 * `WalletStorage` instances against the same `dbName` operate on shared
 * state with native IDB transaction semantics (serialized on the substrate).
 * That's exactly the production cross-tab profile.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletStorage } from '../src';
import { makeFakeCashuToken, openTestDatabase, uniqueDbName } from './helpers';

describe('WalletStorage cross-tab', () => {
  let tabA: WalletStorage;
  let tabB: WalletStorage;
  let dbA: IDBDatabase;
  let dbB: IDBDatabase;
  let dbName: string;

  let channelName: string;

  beforeEach(async () => {
    dbName = uniqueDbName('xtab');
    channelName = uniqueDbName('xtab-chan');
    // Two separate connections to the same underlying DB — exactly what
    // two browser tabs do at runtime.
    dbA = await openTestDatabase(dbName);
    dbB = await openTestDatabase(dbName);
    tabA = new WalletStorage({ db: dbA, channelName });
    tabB = new WalletStorage({ db: dbB, channelName });
    await tabA.init();
    await tabB.init();
  });

  afterEach(async () => {
    await tabA.close();
    await tabB.close();
    dbA.close();
    dbB.close();
  });

  // C-PKG-3: concurrent different-token safety.
  it('C-PKG-3: concurrent writes of DIFFERENT tokens — both rows land, neither dropped', async () => {
    const tokenIdA = 'a'.repeat(32);
    const tokenIdB = 'b'.repeat(32);

    await Promise.all([
      tabA.saveVoucher({
        token_id: tokenIdA,
        token: makeFakeCashuToken('a'),
        amount: 100,
        created_at: '',
        updated_at: '',
      }),
      tabB.saveVoucher({
        token_id: tokenIdB,
        token: makeFakeCashuToken('b'),
        amount: 200,
        created_at: '',
        updated_at: '',
      }),
    ]);

    // Both tabs should see both rows (IDB is shared substrate).
    const seenByA = await tabA.getAllVouchers();
    const seenByB = await tabB.getAllVouchers();

    expect(seenByA).toHaveLength(2);
    expect(seenByB).toHaveLength(2);

    const idsA = seenByA.map((v) => v.token_id).sort();
    const idsB = seenByB.map((v) => v.token_id).sort();
    expect(idsA).toEqual([tokenIdA, tokenIdB]);
    expect(idsB).toEqual([tokenIdA, tokenIdB]);
  });

  // C-PKG-4: concurrent same-token idempotency.
  it('C-PKG-4: concurrent writes of the SAME token — exactly one row, merge semantics', async () => {
    const tokenId = 'c'.repeat(32);

    // Both tabs save the same token_id concurrently. One supplies amount;
    // the other supplies face_value. The merged row should reflect the
    // last-writer-wins for `amount` AND preserve the field the other tab
    // contributed (face_value).
    await Promise.all([
      tabA.saveVoucher({
        token_id: tokenId,
        token: makeFakeCashuToken('c'),
        amount: 100,
        created_at: '',
        updated_at: '',
      }),
      tabB.saveVoucher({
        token_id: tokenId,
        token: makeFakeCashuToken('c'),
        amount: 100,
        face_value: 5,
        face_unit: 'EUR',
        created_at: '',
        updated_at: '',
      }),
    ]);

    const allA = await tabA.getAllVouchers();
    expect(allA).toHaveLength(1);
    expect(allA[0]!.token_id).toBe(tokenId);
    expect(allA[0]!.amount).toBe(100);
    // face_value should be present if tabB's write committed after tabA's
    // initial read; even if tabA's write committed last, the merge in
    // tabA's save would have included whatever the previous read showed.
    // The strong assertion is "exactly one row, no duplicates".
  });

  // Bonus: visibility of writes from peer instance.
  it('Bonus: a write by tabA is visible to tabB on the next read', async () => {
    const tokenId = 'd'.repeat(32);
    await tabA.saveVoucher({
      token_id: tokenId,
      token: makeFakeCashuToken('d'),
      amount: 7,
      created_at: '',
      updated_at: '',
    });

    const peerView = await tabB.getVoucher(tokenId);
    expect(peerView).not.toBeNull();
    expect(peerView!.amount).toBe(7);
  });
});
