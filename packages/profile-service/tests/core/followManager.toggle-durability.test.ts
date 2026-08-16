import { describe, it, expect } from 'vitest';
import { FollowManager, MemoryFollowAdapter } from '../../src/index.js';

/**
 * Spec 044 (T017 / US2): a follow/unfollow is optimistic + durable. The entry
 * is marked pending for the background publisher, and a fresh manager over the
 * same store re-hydrates the state (persistence across a "restart").
 */
describe('FollowManager toggle durability (spec 044)', () => {
  const pk = 'a'.repeat(64);

  it('follow marks the entry pending-publish', async () => {
    const manager = new FollowManager({ adapter: new MemoryFollowAdapter() });
    await manager.follow(pk);
    const entry = await manager.getEntry(pk);
    expect(entry?.syncState).toBe('pending-publish');
  });

  it('toggle returns true when now following, false when unfollowed', async () => {
    const manager = new FollowManager({ adapter: new MemoryFollowAdapter() });
    expect(await manager.toggle(pk)).toBe(true);
    expect(await manager.isFollowing(pk)).toBe(true);
    expect(await manager.toggle(pk)).toBe(false);
    expect(await manager.isFollowing(pk)).toBe(false);
  });

  it('persists across a restart (new manager over the same store)', async () => {
    const adapter = new MemoryFollowAdapter();
    const m1 = new FollowManager({ adapter });
    await m1.follow(pk);

    // Simulate an app restart: a brand-new manager over the same store.
    const m2 = new FollowManager({ adapter });
    expect(await m2.isFollowing(pk)).toBe(true);
    const entry = await m2.getEntry(pk);
    expect(entry?.pubkey).toBe(pk);
    expect(entry?.syncState).toBe('pending-publish');
  });

  it('never stores a self-follow when selfPubkey is configured', async () => {
    const manager = new FollowManager({ adapter: new MemoryFollowAdapter(), selfPubkey: pk });
    await manager.follow(pk);
    expect(await manager.isFollowing(pk)).toBe(false);
  });
});
