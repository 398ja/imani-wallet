import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { LocalFollowAdapter } from '../../src/index.js';

/**
 * Spec 044 (T043 / US4): the durable local follow store is user-scoped and
 * survives logout.
 *
 * The host scopes the IndexedDB database per user (the `imani-wallet-{userId}`
 * convention); the adapter expresses that via its `dbName`. Two scoped stores
 * must be isolated (SC-009 / FR-010), and an ordinary logout — which only stops
 * the sync coordinator, never deletes the scoped DB — must leave the follows
 * readable when the same user re-opens their store offline (FR-020).
 */
describe('LocalFollowAdapter user-scoping + logout durability (spec 044)', () => {
  const userA = 'a'.repeat(64);
  const userB = 'b'.repeat(64);
  const follow1 = 'c'.repeat(64);
  const follow2 = 'd'.repeat(64);

  it("user A's follows are not visible from user B's scoped store", async () => {
    const a = new LocalFollowAdapter({ dbName: 'imani-follows-userA' });
    const b = new LocalFollowAdapter({ dbName: 'imani-follows-userB' });

    await a.add(follow1);
    await a.add(follow2);

    expect((await a.list()).sort()).toEqual([follow1, follow2].sort());
    // B is a different scoped DB — it must not see A's follows.
    expect(await b.list()).toEqual([]);
    expect(await b.has(follow1)).toBe(false);

    a.close();
    b.close();
  });

  it('re-opening the same scoped store after logout still returns the follows (no delete on stop)', async () => {
    // Session 1: user A follows someone.
    const session1 = new LocalFollowAdapter({ dbName: 'imani-follows-durability' });
    await session1.add(follow1, { merchant: 'customer', merchantCheckedAt: 1700000000000 });
    expect(await session1.has(follow1)).toBe(true);
    // Logout only drops in-memory sync state — the adapter is closed, NOT cleared.
    session1.close();

    // Session 2: same user re-opens the SAME scoped DB offline.
    const session2 = new LocalFollowAdapter({ dbName: 'imani-follows-durability' });
    expect(await session2.has(follow1)).toBe(true);
    const entry = await session2.getEntry(follow1);
    expect(entry).not.toBeNull();
    expect(entry!.merchant).toBe('customer');
    expect(entry!.merchantCheckedAt).toBe(1700000000000);
    session2.close();
  });

  it('distinct users do not collide when following the same pubkey', async () => {
    const a = new LocalFollowAdapter({ dbName: 'imani-follows-collideA' });
    const b = new LocalFollowAdapter({ dbName: 'imani-follows-collideB' });
    void userA; void userB; // scoping is by dbName; user ids shown for intent

    await a.add(follow1);
    await b.add(follow1);
    await b.remove(follow1);

    // A still has the follow even though B removed its own copy.
    expect(await a.has(follow1)).toBe(true);
    expect(await b.has(follow1)).toBe(false);

    a.close();
    b.close();
  });
});
