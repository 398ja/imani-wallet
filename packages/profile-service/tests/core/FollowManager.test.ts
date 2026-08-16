import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FollowManager,
  createFollowManager,
  MemoryFollowAdapter,
  SimpleEventEmitter,
  type ProfileEvent,
} from '../../src/index.js';

describe('FollowManager', () => {
  let adapter: MemoryFollowAdapter;
  let manager: FollowManager;

  const validPubkey1 = 'a'.repeat(64);
  const validPubkey2 = 'b'.repeat(64);
  const validPubkey3 = 'c'.repeat(64);

  beforeEach(() => {
    adapter = new MemoryFollowAdapter();
    manager = createFollowManager({ adapter });
  });

  describe('basic operations', () => {
    it('should create with factory function', () => {
      const mgr = createFollowManager({ adapter });
      expect(mgr).toBeInstanceOf(FollowManager);
    });

    it('should start with empty follow list', async () => {
      const list = await manager.list();
      expect(list).toEqual([]);
    });

    it('should follow a pubkey', async () => {
      await manager.follow(validPubkey1);
      const list = await manager.list();
      expect(list).toContain(validPubkey1);
    });

    it('should unfollow a pubkey', async () => {
      await manager.follow(validPubkey1);
      await manager.unfollow(validPubkey1);
      const list = await manager.list();
      expect(list).not.toContain(validPubkey1);
    });

    it('should check if following', async () => {
      expect(await manager.isFollowing(validPubkey1)).toBe(false);
      await manager.follow(validPubkey1);
      expect(await manager.isFollowing(validPubkey1)).toBe(true);
    });

    it('should handle following same pubkey twice', async () => {
      await manager.follow(validPubkey1);
      await manager.follow(validPubkey1);
      const list = await manager.list();
      expect(list.filter((p) => p === validPubkey1)).toHaveLength(1);
    });

    it('should handle unfollowing non-followed pubkey', async () => {
      await expect(manager.unfollow(validPubkey1)).resolves.not.toThrow();
    });

    it('should return false for invalid pubkey', async () => {
      expect(await manager.isFollowing('invalid')).toBe(false);
    });
  });

  describe('toggle', () => {
    it('should follow when not following', async () => {
      const result = await manager.toggle(validPubkey1);
      expect(result).toBe(true);
      expect(await manager.isFollowing(validPubkey1)).toBe(true);
    });

    it('should unfollow when following', async () => {
      await manager.follow(validPubkey1);
      const result = await manager.toggle(validPubkey1);
      expect(result).toBe(false);
      expect(await manager.isFollowing(validPubkey1)).toBe(false);
    });

    it('should apply options when toggling on', async () => {
      await manager.toggle(validPubkey1, { labels: ['merchant'] });
      const entries = await manager.listEntries();
      const entry = entries.find((e) => e.pubkey === validPubkey1);
      expect(entry?.labels).toContain('merchant');
    });
  });

  describe('labels', () => {
    it('should follow with labels', async () => {
      await manager.follow(validPubkey1, { labels: ['merchant', 'favorite'] });
      const entries = await manager.listEntries();
      const entry = entries.find((e) => e.pubkey === validPubkey1);
      expect(entry?.labels).toEqual(['merchant', 'favorite']);
    });

    it('should add labels to existing follow', async () => {
      await manager.follow(validPubkey1);
      await manager.addLabels(validPubkey1, ['merchant']);
      const entries = await manager.listEntries();
      const entry = entries.find((e) => e.pubkey === validPubkey1);
      expect(entry?.labels).toContain('merchant');
    });

    it('should not duplicate labels', async () => {
      await manager.follow(validPubkey1, { labels: ['merchant'] });
      await manager.addLabels(validPubkey1, ['merchant', 'favorite']);
      const entries = await manager.listEntries();
      const entry = entries.find((e) => e.pubkey === validPubkey1);
      expect(entry?.labels?.filter((l) => l === 'merchant')).toHaveLength(1);
    });

    it('should remove labels', async () => {
      await manager.follow(validPubkey1, { labels: ['merchant', 'favorite'] });
      await manager.removeLabels(validPubkey1, ['merchant']);
      const entries = await manager.listEntries();
      const entry = entries.find((e) => e.pubkey === validPubkey1);
      expect(entry?.labels).not.toContain('merchant');
      expect(entry?.labels).toContain('favorite');
    });

    it('should throw when adding labels to non-followed pubkey', async () => {
      await expect(manager.addLabels(validPubkey1, ['merchant'])).rejects.toThrow();
    });

    it('should throw when removing labels from non-followed pubkey', async () => {
      await expect(manager.removeLabels(validPubkey1, ['merchant'])).rejects.toThrow();
    });

    it('should get follows by label', async () => {
      await manager.follow(validPubkey1, { labels: ['merchant'] });
      await manager.follow(validPubkey2, { labels: ['merchant', 'favorite'] });
      await manager.follow(validPubkey3, { labels: ['friend'] });

      const merchants = await manager.getByLabel('merchant');
      expect(merchants).toHaveLength(2);
      expect(merchants.map((e) => e.pubkey)).toContain(validPubkey1);
      expect(merchants.map((e) => e.pubkey)).toContain(validPubkey2);
    });

    it('should update labels on re-follow', async () => {
      await manager.follow(validPubkey1, { labels: ['old'] });
      await manager.follow(validPubkey1, { labels: ['new'] });
      const entries = await manager.listEntries();
      const entry = entries.find((e) => e.pubkey === validPubkey1);
      expect(entry?.labels).toEqual(['new']);
    });
  });

  describe('listEntries', () => {
    it('should return full follow entries', async () => {
      await manager.follow(validPubkey1, { labels: ['merchant'] });
      const entries = await manager.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        pubkey: validPubkey1,
        labels: ['merchant'],
        source: 'local',
      });
      expect(entries[0].createdAt).toBeDefined();
    });

    it('should preserve source option', async () => {
      await manager.follow(validPubkey1, { source: 'relay' });
      const entries = await manager.listEntries();
      expect(entries[0].source).toBe('relay');
    });
  });

  describe('getFollowList', () => {
    it('should return follow list metadata', async () => {
      await manager.follow(validPubkey1);
      const followList = await manager.getFollowList();
      expect(followList.follows).toHaveLength(1);
      expect(followList.lastSyncedAt).toBeDefined();
      expect(followList.hasPendingSync).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all follows', async () => {
      await manager.follow(validPubkey1);
      await manager.follow(validPubkey2);
      await manager.clear();
      const list = await manager.list();
      expect(list).toHaveLength(0);
    });
  });

  describe('events', () => {
    it('should emit followAdded event', async () => {
      const events: ProfileEvent[] = [];
      manager.on((event) => events.push(event));

      await manager.follow(validPubkey1, { labels: ['merchant'] });

      const addedEvent = events.find((e) => e.type === 'followAdded');
      expect(addedEvent).toBeDefined();
      expect(addedEvent?.type === 'followAdded' && addedEvent.pubkey).toBe(validPubkey1);
    });

    it('should emit followRemoved event', async () => {
      const events: ProfileEvent[] = [];
      await manager.follow(validPubkey1);

      manager.on((event) => events.push(event));
      await manager.unfollow(validPubkey1);

      const removedEvent = events.find((e) => e.type === 'followRemoved');
      expect(removedEvent).toBeDefined();
      expect(removedEvent?.type === 'followRemoved' && removedEvent.pubkey).toBe(validPubkey1);
    });

    it('should emit events on clear', async () => {
      await manager.follow(validPubkey1);
      await manager.follow(validPubkey2);

      const events: ProfileEvent[] = [];
      manager.on((event) => events.push(event));
      await manager.clear();

      const removedEvents = events.filter((e) => e.type === 'followRemoved');
      expect(removedEvents).toHaveLength(2);
    });

    it('should allow unsubscribing', async () => {
      const events: ProfileEvent[] = [];
      const unsubscribe = manager.on((event) => events.push(event));

      await manager.follow(validPubkey1);
      unsubscribe();
      await manager.follow(validPubkey2);

      expect(events.filter((e) => e.type === 'followAdded')).toHaveLength(1);
    });
  });

  describe('optimistic updates', () => {
    it('should apply optimistic updates by default', async () => {
      const eventEmitter = new SimpleEventEmitter();
      const events: ProfileEvent[] = [];
      eventEmitter.on((event) => events.push(event));

      const mgr = createFollowManager({ adapter, eventEmitter });
      await mgr.follow(validPubkey1);

      // Event should be emitted immediately (before persistence completes)
      expect(events.find((e) => e.type === 'followAdded')).toBeDefined();
    });

    it('should rollback on adapter failure', async () => {
      const failingAdapter = {
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockRejectedValue(new Error('Storage failed')),
        remove: vi.fn().mockResolvedValue(undefined),
        has: vi.fn().mockResolvedValue(false),
      };

      const events: ProfileEvent[] = [];
      const eventEmitter = new SimpleEventEmitter();
      eventEmitter.on((event) => events.push(event));

      const mgr = createFollowManager({
        adapter: failingAdapter,
        eventEmitter,
        retryOnFailure: false,
      });

      await expect(mgr.follow(validPubkey1)).rejects.toThrow('Storage failed');

      // Should have added then removed (rollback)
      const addedEvents = events.filter((e) => e.type === 'followAdded');
      const removedEvents = events.filter((e) => e.type === 'followRemoved');
      expect(addedEvents).toHaveLength(1);
      expect(removedEvents).toHaveLength(1);

      // Should not be in follow list
      expect(await mgr.isFollowing(validPubkey1)).toBe(false);
    });

    it('should disable optimistic updates when configured', async () => {
      const slowAdapter = {
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50))),
        remove: vi.fn().mockResolvedValue(undefined),
        has: vi.fn().mockResolvedValue(false),
      };

      const events: ProfileEvent[] = [];
      const eventEmitter = new SimpleEventEmitter();
      eventEmitter.on((event) => events.push(event));

      const mgr = createFollowManager({
        adapter: slowAdapter,
        eventEmitter,
        optimisticUpdates: false,
      });

      const followPromise = mgr.follow(validPubkey1);

      // Event should NOT be emitted yet
      expect(events.find((e) => e.type === 'followAdded')).toBeUndefined();

      await followPromise;

      // Event should be emitted after persistence
      expect(events.find((e) => e.type === 'followAdded')).toBeDefined();
    });
  });

  describe('retry logic', () => {
    it('should retry on failure', async () => {
      let attempts = 0;
      const flakyAdapter = {
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockImplementation(() => {
          attempts++;
          if (attempts < 3) {
            return Promise.reject(new Error('Temporary failure'));
          }
          return Promise.resolve();
        }),
        remove: vi.fn().mockResolvedValue(undefined),
        has: vi.fn().mockResolvedValue(false),
      };

      const mgr = createFollowManager({
        adapter: flakyAdapter,
        retryOnFailure: true,
        maxRetries: 3,
      });

      await expect(mgr.follow(validPubkey1)).resolves.not.toThrow();
      expect(attempts).toBe(3);
    });

    it('should give up after max retries', async () => {
      const alwaysFailAdapter = {
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockRejectedValue(new Error('Permanent failure')),
        remove: vi.fn().mockResolvedValue(undefined),
        has: vi.fn().mockResolvedValue(false),
      };

      const mgr = createFollowManager({
        adapter: alwaysFailAdapter,
        retryOnFailure: true,
        maxRetries: 3,
      });

      await expect(mgr.follow(validPubkey1)).rejects.toThrow('Permanent failure');
      expect(alwaysFailAdapter.add).toHaveBeenCalledTimes(3);
    });

    it('should disable retry when configured', async () => {
      const failingAdapter = {
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockRejectedValue(new Error('Failure')),
        remove: vi.fn().mockResolvedValue(undefined),
        has: vi.fn().mockResolvedValue(false),
      };

      const mgr = createFollowManager({
        adapter: failingAdapter,
        retryOnFailure: false,
      });

      await expect(mgr.follow(validPubkey1)).rejects.toThrow('Failure');
      expect(failingAdapter.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('sync status', () => {
    it('should track sync status', async () => {
      const status = manager.getSyncStatus();
      expect(status.syncing).toBe(false);
      expect(status.pendingChanges).toBe(0);
    });

    it('should update lastSyncedAt on successful operation', async () => {
      const before = Date.now();
      await manager.follow(validPubkey1);
      const status = manager.getSyncStatus();
      expect(status.lastSyncedAt).toBeGreaterThanOrEqual(before);
    });

    it('should track errors on failure', async () => {
      const failingAdapter = {
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockRejectedValue(new Error('Storage error')),
        remove: vi.fn().mockResolvedValue(undefined),
        has: vi.fn().mockResolvedValue(false),
      };

      const mgr = createFollowManager({
        adapter: failingAdapter,
        retryOnFailure: false,
      });

      try {
        await mgr.follow(validPubkey1);
      } catch {
        // Expected
      }

      const status = mgr.getSyncStatus();
      expect(status.lastError).toContain('follow failed');
    });

    it('should emit sync error event', async () => {
      const failingAdapter = {
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockRejectedValue(new Error('Storage error')),
        remove: vi.fn().mockResolvedValue(undefined),
        has: vi.fn().mockResolvedValue(false),
      };

      const events: ProfileEvent[] = [];
      const eventEmitter = new SimpleEventEmitter();
      eventEmitter.on((event) => events.push(event));

      const mgr = createFollowManager({
        adapter: failingAdapter,
        eventEmitter,
        retryOnFailure: false,
      });

      try {
        await mgr.follow(validPubkey1);
      } catch {
        // Expected
      }

      const syncErrorEvent = events.find((e) => e.type === 'followSyncError');
      expect(syncErrorEvent).toBeDefined();
    });
  });

  describe('load behavior', () => {
    it('should load from adapter on first access', async () => {
      await adapter.add(validPubkey1);
      await adapter.add(validPubkey2);

      const newManager = createFollowManager({ adapter });
      const list = await newManager.list();

      expect(list).toContain(validPubkey1);
      expect(list).toContain(validPubkey2);
    });

    it('should only load once', async () => {
      // load() hydrates full entries via listEntries() when available (spec 044);
      // the caching invariant is "the adapter is read exactly once".
      const listSpy = vi.spyOn(adapter, 'listEntries');

      await manager.list();
      await manager.list();
      await manager.list();

      expect(listSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('pubkey normalization', () => {
    it('should normalize uppercase pubkeys', async () => {
      const uppercasePubkey = validPubkey1.toUpperCase();
      await manager.follow(uppercasePubkey);

      expect(await manager.isFollowing(validPubkey1)).toBe(true);
      expect(await manager.isFollowing(uppercasePubkey)).toBe(true);
    });

    it('should not duplicate normalized pubkeys', async () => {
      await manager.follow(validPubkey1);
      await manager.follow(validPubkey1.toUpperCase());

      const list = await manager.list();
      expect(list).toHaveLength(1);
    });
  });
});
