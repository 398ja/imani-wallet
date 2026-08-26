import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NostrFollowAdapter,
  createNostrFollowAdapter,
  type NostrPool,
  type NostrEvent,
  type NostrSigner,
  type NostrPublisher,
  type UnsignedNostrEvent,
} from '../../src/index.js';

describe('NostrFollowAdapter', () => {
  const validPubkey1 = 'a'.repeat(64);
  const validPubkey2 = 'b'.repeat(64);
  const userPubkey = 'c'.repeat(64);
  const relays = ['wss://relay1.example.com'];

  const createMockPool = (events: NostrEvent[] = []): NostrPool => ({
    querySync: vi.fn().mockResolvedValue(events),
    close: vi.fn(),
  });

  const createMockSigner = (): NostrSigner => ({
    getPublicKey: vi.fn().mockResolvedValue(userPubkey),
    signEvent: vi.fn().mockImplementation((event: UnsignedNostrEvent) => ({
      ...event,
      id: 'event-id',
      pubkey: userPubkey,
      sig: 'signature',
    })),
  });

  const createMockPublisher = (): NostrPublisher => ({
    publish: vi.fn().mockResolvedValue(undefined),
  });

  const createContactListEvent = (pubkeys: string[]): NostrEvent => ({
    id: 'contacts-event',
    pubkey: userPubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 3,
    tags: pubkeys.map((pk) => ['p', pk]),
    content: '',
    sig: 'signature',
  });

  describe('factory function', () => {
    it('should create an instance', () => {
      const pool = createMockPool();
      const signer = createMockSigner();
      const adapter = createNostrFollowAdapter({ relays, pool, signer });
      expect(adapter).toBeInstanceOf(NostrFollowAdapter);
    });
  });

  describe('list', () => {
    it('should return empty list when no contacts exist', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      const result = await adapter.list();
      expect(result).toEqual([]);
    });

    it('should return follows from contact list event', async () => {
      const contactEvent = createContactListEvent([validPubkey1, validPubkey2]);
      const pool = createMockPool([contactEvent]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      const result = await adapter.list();

      expect(result).toContain(validPubkey1);
      expect(result).toContain(validPubkey2);
    });

    it('should query with correct filter', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await adapter.list();

      expect(pool.querySync).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          kinds: [3],
          authors: [userPubkey],
          limit: 1,
        })
      );
    });

    it('should use latest event when multiple exist', async () => {
      const oldEvent = createContactListEvent([validPubkey1]);
      oldEvent.created_at = 1000;
      const newEvent = createContactListEvent([validPubkey1, validPubkey2]);
      newEvent.created_at = 2000;

      const pool = createMockPool([oldEvent, newEvent]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      const result = await adapter.list();

      expect(result).toHaveLength(2);
    });

    it('should only load once with multiple calls', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await adapter.list();
      await adapter.list();
      await adapter.list();

      expect(pool.querySync).toHaveBeenCalledTimes(1);
    });
  });

  describe('add', () => {
    it('should add a pubkey to follows', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const publisher = createMockPublisher();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, publisher, autoSync: true });

      await adapter.add(validPubkey1);
      const result = await adapter.list();

      expect(result).toContain(validPubkey1);
    });

    it('should throw for invalid pubkey', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await expect(adapter.add('invalid')).rejects.toThrow('Invalid pubkey');
    });

    it('should normalize pubkey', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await adapter.add(validPubkey1.toUpperCase());
      const result = await adapter.list();

      expect(result).toContain(validPubkey1);
    });

    it('should not duplicate follows', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await adapter.add(validPubkey1);
      await adapter.add(validPubkey1);
      const result = await adapter.list();

      expect(result.filter((p) => p === validPubkey1)).toHaveLength(1);
    });

    it('should publish when autoSync is enabled', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const publisher = createMockPublisher();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, publisher, autoSync: true });

      await adapter.add(validPubkey1);

      expect(publisher.publish).toHaveBeenCalled();
    });

    it('should not publish when autoSync is disabled', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const publisher = createMockPublisher();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, publisher, autoSync: false });

      await adapter.add(validPubkey1);

      expect(publisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should remove a pubkey from follows', async () => {
      const contactEvent = createContactListEvent([validPubkey1, validPubkey2]);
      const pool = createMockPool([contactEvent]);
      const signer = createMockSigner();
      const publisher = createMockPublisher();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, publisher, autoSync: true });

      await adapter.remove(validPubkey1);
      const result = await adapter.list();

      expect(result).not.toContain(validPubkey1);
      expect(result).toContain(validPubkey2);
    });

    it('should handle removing non-followed pubkey', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await expect(adapter.remove(validPubkey1)).resolves.not.toThrow();
    });

    it('should publish when autoSync is enabled', async () => {
      const contactEvent = createContactListEvent([validPubkey1]);
      const pool = createMockPool([contactEvent]);
      const signer = createMockSigner();
      const publisher = createMockPublisher();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, publisher, autoSync: true });

      await adapter.remove(validPubkey1);

      expect(publisher.publish).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should remove all follows', async () => {
      const contactEvent = createContactListEvent([validPubkey1, validPubkey2]);
      const pool = createMockPool([contactEvent]);
      const signer = createMockSigner();
      const publisher = createMockPublisher();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, publisher, autoSync: true });

      await adapter.clear();
      const result = await adapter.list();

      expect(result).toHaveLength(0);
    });

    it('should publish empty contact list', async () => {
      const contactEvent = createContactListEvent([validPubkey1]);
      const pool = createMockPool([contactEvent]);
      const signer = createMockSigner();
      const publisher = createMockPublisher();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, publisher, autoSync: true });

      await adapter.clear();

      expect(signer.signEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 3,
          tags: [],
        })
      );
    });
  });

  describe('has', () => {
    it('should return true for followed pubkey', async () => {
      const contactEvent = createContactListEvent([validPubkey1]);
      const pool = createMockPool([contactEvent]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      const result = await adapter.has(validPubkey1);
      expect(result).toBe(true);
    });

    it('should return false for non-followed pubkey', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      const result = await adapter.has(validPubkey1);
      expect(result).toBe(false);
    });

    it('should return false for invalid pubkey', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      const result = await adapter.has('invalid');
      expect(result).toBe(false);
    });
  });

  describe('refresh', () => {
    it('should reload from relays', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await adapter.list();
      await adapter.refresh();

      expect(pool.querySync).toHaveBeenCalledTimes(2);
    });
  });

  describe('sync', () => {
    it('should publish current follows', async () => {
      const contactEvent = createContactListEvent([validPubkey1]);
      const pool = createMockPool([contactEvent]);
      const signer = createMockSigner();
      const publisher = createMockPublisher();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, publisher, autoSync: false });

      // Load first
      await adapter.list();
      // Then sync
      await adapter.sync();

      expect(publisher.publish).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          kind: 3,
          tags: [['p', validPubkey1]],
        })
      );
    });

    it('should throw if no publisher configured', async () => {
      const pool = createMockPool([]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await adapter.list();
      await expect(adapter.sync()).rejects.toThrow('Publisher not configured');
    });
  });

  describe('close', () => {
    it('should clear state', async () => {
      const contactEvent = createContactListEvent([validPubkey1]);
      const pool = createMockPool([contactEvent]);
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false });

      await adapter.list();
      adapter.close();

      // After close, should reload on next list
      await adapter.list();
      expect(pool.querySync).toHaveBeenCalledTimes(2);
    });
  });

  describe('timeout handling', () => {
    it('should return empty on timeout', async () => {
      const pool: NostrPool = {
        querySync: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve([createContactListEvent([validPubkey1])]), 10000)
            )
        ),
      };
      const signer = createMockSigner();
      const adapter = new NostrFollowAdapter({ relays, pool, signer, autoSync: false, timeoutMs: 50 });

      const result = await adapter.list();
      expect(result).toEqual([]);
    });
  });
});
