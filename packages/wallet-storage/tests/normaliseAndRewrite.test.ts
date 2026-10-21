/**
 * #157 — the two hooks the wallet uses to keep `expires_at` in one format.
 *
 * `normaliseVoucher` runs inside every voucher writer, so no save point can
 * skip it. `rewriteVouchers` repairs rows already stored, and has to be safe
 * when two tabs open the wallet at once: run twice it changes nothing, and a
 * write that lands while it runs is neither lost nor overwritten.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletStorage, type VoucherRow } from '../src';
import { makeFakeCashuToken, openTestDatabase, uniqueDbName } from './helpers';

/** A stand-in normaliser: any string expiry becomes the number it spells. */
const toNumber = (row: VoucherRow): VoucherRow => {
  const raw = row.expires_at as unknown;
  return typeof raw === 'string' && /^\d+$/.test(raw)
    ? { ...row, expires_at: Number(raw) }
    : row;
};

const rewriteToNumber = (row: VoucherRow): VoucherRow | null => {
  const next = toNumber(row);
  return next.expires_at === row.expires_at ? null : next;
};

const row = (seed: string, expires_at: unknown): VoucherRow =>
  ({
    token: makeFakeCashuToken(seed),
    amount: 1,
    expires_at,
    created_at: '',
    updated_at: '',
  }) as unknown as VoucherRow;

describe('normaliseVoucher hook', () => {
  let db: IDBDatabase;
  let storage: WalletStorage;

  beforeEach(async () => {
    db = await openTestDatabase(uniqueDbName('norm'));
    storage = new WalletStorage({
      db,
      channelName: uniqueDbName('norm-chan'),
      normaliseVoucher: toNumber,
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    db.close();
  });

  it('applies on saveVoucher', async () => {
    const saved = await storage.saveVoucher(row('a', '1798588800'));
    expect(saved.expires_at).toBe(1798588800);
  });

  it('applies on atomicallyWrite', async () => {
    await storage.atomicallyWrite({ vouchers: [row('b', '1798588800')] });
    const [stored] = await storage.getAllVouchers();
    expect(stored?.expires_at).toBe(1798588800);
  });

  it('applies on clearAndReplaceAllVouchers', async () => {
    const replacement = { ...row('c', '1798588800'), token_id: 'c'.repeat(32) };
    await storage.clearAndReplaceAllVouchers([replacement]);
    const [stored] = await storage.getAllVouchers();
    expect(stored?.expires_at).toBe(1798588800);
  });
});

describe('rewriteVouchers', () => {
  let db: IDBDatabase;
  let dbName: string;
  let storage: WalletStorage;

  beforeEach(async () => {
    dbName = uniqueDbName('rewrite');
    db = await openTestDatabase(dbName);
    storage = new WalletStorage({ db, channelName: uniqueDbName('rewrite-chan') });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    db.close();
  });

  it('rewrites only the rows the function changes, and counts them', async () => {
    await storage.saveVoucher(row('a', '1798588800'));
    await storage.saveVoucher(row('b', 1798588800));

    expect(await storage.rewriteVouchers(rewriteToNumber)).toBe(1);
    const values = (await storage.getAllVouchers()).map((r) => r.expires_at);
    expect(values).toEqual([1798588800, 1798588800]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await storage.saveVoucher(row('a', '1798588800'));
    await storage.rewriteVouchers(rewriteToNumber);
    const before = await storage.getAllVouchers();

    expect(await storage.rewriteVouchers(rewriteToNumber)).toBe(0);
    expect(await storage.getAllVouchers()).toEqual(before);
  });

  it('two tabs running it at once converge, and only one does the work', async () => {
    for (const seed of ['a', 'b', 'c']) await storage.saveVoucher(row(seed, '1798588800'));
    const otherDb = await openTestDatabase(dbName);
    const otherTab = new WalletStorage({ db: otherDb, channelName: uniqueDbName('tab2') });
    await otherTab.init();

    const counts = await Promise.all([
      storage.rewriteVouchers(rewriteToNumber),
      otherTab.rewriteVouchers(rewriteToNumber),
    ]);

    // IndexedDB serialises readwrite transactions on one store: whichever
    // runs second reads the first one's result and has nothing to do.
    expect(counts.sort()).toEqual([0, 3]);
    expect((await storage.getAllVouchers()).every((r) => r.expires_at === 1798588800)).toBe(true);
    await otherTab.close();
    otherDb.close();
  });

  it('does not clobber a write that lands while it runs', async () => {
    const saved = await storage.saveVoucher(row('a', '1798588800'));
    const otherDb = await openTestDatabase(dbName);
    // The other tab is the same app, so its writers normalise too.
    const otherTab = new WalletStorage({
      db: otherDb,
      channelName: uniqueDbName('tab2'),
      normaliseVoucher: toNumber,
    });
    await otherTab.init();

    // Started together: the spend in the other tab and the repair in this one.
    await Promise.all([
      storage.rewriteVouchers(rewriteToNumber),
      otherTab.saveVoucher({ ...saved, status: 'spent' }),
    ]);

    const [stored] = await storage.getAllVouchers();
    expect(stored?.status).toBe('spent');
    expect(stored?.expires_at).toBe(1798588800);
    await otherTab.close();
    otherDb.close();
  });

  it('keeps the primary key whatever the function returns', async () => {
    const saved = await storage.saveVoucher(row('a', '1798588800'));
    await storage.rewriteVouchers((r) => ({ ...r, token_id: 'something-else', expires_at: 1 }));
    const all = await storage.getAllVouchers();
    expect(all.map((r) => r.token_id)).toEqual([saved.token_id]);
  });
});
