import { describe, it, expect, beforeEach } from 'vitest';
import { FollowManager, MemoryFollowAdapter } from '../../src/index.js';

/**
 * Spec 044 (#2): denormalized kind-0 profile snapshot on the follow entry, so the
 * followed list renders from the local store without a server hit. setProfile
 * records the snapshot + a refresh timestamp; a re-add (e.g. a sync re-import)
 * must NOT wipe the cached snapshot or the resolved merchant flag.
 */
describe('FollowManager profile snapshot (spec 044 #2)', () => {
  let adapter: MemoryFollowAdapter;
  let manager: FollowManager;
  const pk = 'a'.repeat(64);

  beforeEach(async () => {
    adapter = new MemoryFollowAdapter();
    manager = new FollowManager({ adapter });
    await manager.follow(pk);
  });

  it('a fresh follow has no profile snapshot', async () => {
    const e = await manager.getEntry(pk);
    expect(e!.displayName ?? null).toBeNull();
    expect(e!.picture ?? null).toBeNull();
    expect(e!.profileUpdatedAt ?? null).toBeNull();
  });

  it('setProfile records displayName / picture / nip05 + a refresh timestamp', async () => {
    await manager.setProfile(pk, { displayName: 'Alice', picture: 'https://img/a.png', nip05: 'alice@imani.casa' }, 1700000000000);
    const e = await manager.getEntry(pk);
    expect(e!.displayName).toBe('Alice');
    expect(e!.picture).toBe('https://img/a.png');
    expect(e!.nip05).toBe('alice@imani.casa');
    expect(e!.profileUpdatedAt).toBe(1700000000000);
  });

  it('setProfile only updates provided fields', async () => {
    await manager.setProfile(pk, { displayName: 'Alice', picture: 'https://img/a.png' }, 1);
    await manager.setProfile(pk, { displayName: 'Alice Updated' }, 2);
    const e = await manager.getEntry(pk);
    expect(e!.displayName).toBe('Alice Updated');
    expect(e!.picture).toBe('https://img/a.png'); // preserved
    expect(e!.profileUpdatedAt).toBe(2);
  });

  it('a re-add (sync re-import) preserves the cached snapshot AND merchant flag', async () => {
    await manager.setProfile(pk, { displayName: 'Alice', picture: 'https://img/a.png' }, 1700000000000);
    await manager.setMerchant(pk, 'merchant', 1700000000000);

    // Re-add the same pubkey (no profile/merchant in opts) — must not wipe them.
    await adapter.add(pk, { source: 'nostr', order: 42 });

    const e = await adapter.getEntry(pk);
    expect(e!.displayName).toBe('Alice');
    expect(e!.picture).toBe('https://img/a.png');
    expect(e!.merchant).toBe('merchant');
    expect(e!.order).toBe(42); // explicit opt still applied
  });

  it('setProfile on an unfollowed pubkey is a no-op', async () => {
    const other = 'b'.repeat(64);
    await manager.setProfile(other, { displayName: 'Ghost' });
    expect(await manager.getEntry(other)).toBeNull();
  });
});
