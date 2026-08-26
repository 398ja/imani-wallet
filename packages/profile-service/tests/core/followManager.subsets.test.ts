import { describe, it, expect, beforeEach } from 'vitest';
import { FollowManager, MemoryFollowAdapter } from '../../src/index.js';

/**
 * Spec 044 (T009 / US1): listCustomers() / listMerchants() derive the subsets
 * from the stored merchant discriminator with no network. `unknown` is treated
 * as a customer (fail-open).
 */
describe('FollowManager subsets (spec 044)', () => {
  let manager: FollowManager;
  const merchantPk = 'a'.repeat(64);
  const customerPk = 'b'.repeat(64);
  const unknownPk = 'c'.repeat(64);

  beforeEach(async () => {
    manager = new FollowManager({ adapter: new MemoryFollowAdapter() });
    await manager.follow(merchantPk);
    await manager.follow(customerPk);
    await manager.follow(unknownPk);
    await manager.setMerchant(merchantPk, 'merchant');
    await manager.setMerchant(customerPk, 'customer');
    // unknownPk left as 'unknown'
  });

  it('listCustomers returns customers AND unknowns (fail-open), not merchants', async () => {
    const customers = (await manager.listCustomers()).map((e) => e.pubkey);
    expect(customers).toContain(customerPk);
    expect(customers).toContain(unknownPk);
    expect(customers).not.toContain(merchantPk);
  });

  it('listMerchants returns only confirmed merchants', async () => {
    const merchants = (await manager.listMerchants()).map((e) => e.pubkey);
    expect(merchants).toEqual([merchantPk]);
  });

  it('subsets partition the follow list', async () => {
    const total = (await manager.list()).length;
    const customers = await manager.listCustomers();
    const merchants = await manager.listMerchants();
    expect(customers.length + merchants.length).toBe(total);
  });

  it('getEntry reflects the merchant flag', async () => {
    const entry = await manager.getEntry(merchantPk);
    expect(entry?.merchant).toBe('merchant');
    expect(typeof entry?.merchantCheckedAt).toBe('number');
  });
});
