import { describe, it, expect, beforeEach } from 'vitest';
import { FollowManager, MemoryFollowAdapter } from '../../src/index.js';

/**
 * Spec 044 (T022 / US3): the merchant discriminator write semantics.
 *
 * `setMerchant` records BOTH the flag and the `merchantCheckedAt` timestamp so
 * the host bridge (`refreshFollowMerchants`) can apply its 24h TTL + fail-open
 * policy. The subset partition itself (listCustomers/listMerchants, fail-open on
 * `unknown`) is covered by followManager.subsets.test.ts; this file pins the
 * lower-level flag/timestamp contract those subsets read from.
 */
describe('FollowManager merchant discriminator (spec 044)', () => {
  let manager: FollowManager;
  const pk = 'a'.repeat(64);

  beforeEach(async () => {
    manager = new FollowManager({ adapter: new MemoryFollowAdapter() });
    await manager.follow(pk);
  });

  it('a fresh follow defaults to merchant:unknown with no checkedAt', async () => {
    const entry = await manager.getEntry(pk);
    expect(entry).not.toBeNull();
    expect(entry!.merchant ?? 'unknown').toBe('unknown');
    expect(entry!.merchantCheckedAt ?? null).toBeNull();
  });

  it('unknown follows are treated as customers until resolved (fail-open)', async () => {
    const customers = (await manager.listCustomers()).map((e) => e.pubkey);
    expect(customers).toContain(pk);
    const merchants = (await manager.listMerchants()).map((e) => e.pubkey);
    expect(merchants).not.toContain(pk);
  });

  it('setMerchant records BOTH the flag and the checkedAt timestamp', async () => {
    await manager.setMerchant(pk, 'merchant', 1700000000000);
    const entry = await manager.getEntry(pk);
    expect(entry!.merchant).toBe('merchant');
    expect(entry!.merchantCheckedAt).toBe(1700000000000);
  });

  it('resolving as merchant moves the entry out of customers into merchants', async () => {
    await manager.setMerchant(pk, 'merchant', 1700000000000);
    expect((await manager.listCustomers()).map((e) => e.pubkey)).not.toContain(pk);
    expect((await manager.listMerchants()).map((e) => e.pubkey)).toContain(pk);
  });

  it('resolving as customer keeps the entry in customers with a recorded checkedAt', async () => {
    await manager.setMerchant(pk, 'customer', 1700000000000);
    const entry = await manager.getEntry(pk);
    expect(entry!.merchant).toBe('customer');
    expect(entry!.merchantCheckedAt).toBe(1700000000000);
    expect((await manager.listCustomers()).map((e) => e.pubkey)).toContain(pk);
    expect((await manager.listMerchants()).map((e) => e.pubkey)).not.toContain(pk);
  });

  it('setMerchant on an unknown pubkey is a no-op (does not create a follow)', async () => {
    const other = 'b'.repeat(64);
    await manager.setMerchant(other, 'merchant', 1700000000000);
    expect(await manager.getEntry(other)).toBeNull();
    expect(await manager.isFollowing(other)).toBe(false);
  });
});
