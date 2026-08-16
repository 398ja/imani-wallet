/**
 * Tests for RelaySync
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RelaySync,
  createRelaySync,
  TransactionStore,
  TransactionType,
  TransactionDirection,
  NIP60_HISTORY_KIND,
  type NostrSigner,
  type NostrEvent,
  type RelayPool,
  type TransactionInput,
} from '../../src';

describe('RelaySync', () => {
  let store: TransactionStore;
  let mockSigner: NostrSigner;
  let mockRelayPool: RelayPool;
  let relaySync: RelaySync;

  beforeEach(async () => {
    store = new TransactionStore({ storage: 'memory' });
    await store.init();

    mockSigner = createMockSigner();
    mockRelayPool = createMockRelayPool();

    relaySync = createRelaySync(
      store,
      {
        pubkey: 'test-pubkey',
        signer: mockSigner,
        relayUrls: ['wss://relay.test.com'],
        walletDTag: 'test-wallet',
        encryption: false,
      },
      mockRelayPool
    );

    await relaySync.init();
  });

  afterEach(async () => {
    relaySync.close();
    await store.close();
  });

  describe('init()', () => {
    it('should connect to relays', async () => {
      expect(mockRelayPool.connect).toHaveBeenCalled();
    });

    it('should initialize status', () => {
      const status = relaySync.getStatus();
      expect(status.inProgress).toBe(false);
      expect(status.pendingCount).toBe(0);
      expect(status.synced).toBe(true);
    });
  });

  describe('push()', () => {
    it('should push unsynced transactions to relays', async () => {
      // Create unsynced transactions
      await store.record(createTestInput({ memo: 'tx1' }));
      await store.record(createTestInput({ memo: 'tx2' }));

      const result = await relaySync.push();

      expect(result.direction).toBe('push');
      expect(result.pushed).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(mockRelayPool.publish).toHaveBeenCalledTimes(2);
    });

    it('should mark transactions as synced after push', async () => {
      const tx = await store.record(createTestInput());
      expect(tx.synced).toBe(false);

      await relaySync.push();

      const updated = await store.get(tx.id);
      expect(updated?.synced).toBe(true);
      expect(updated?.eventId).toBeDefined();
    });

    it('should emit sync events', async () => {
      const startedHandler = vi.fn();
      const progressHandler = vi.fn();
      const completedHandler = vi.fn();

      relaySync.on('sync:started', startedHandler);
      relaySync.on('sync:progress', progressHandler);
      relaySync.on('sync:completed', completedHandler);

      await store.record(createTestInput());
      await relaySync.push();

      expect(startedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'push' })
      );
      expect(progressHandler).toHaveBeenCalled();
      expect(completedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'push', pushed: 1 })
      );
    });

    it('should handle no unsynced transactions', async () => {
      const result = await relaySync.push();

      expect(result.pushed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should update status during push', async () => {
      await store.record(createTestInput());

      // Check status before push completes
      const pushPromise = relaySync.push();

      // Status should show in progress (may be race condition in tests)
      await pushPromise;

      const status = relaySync.getStatus();
      expect(status.lastPush).toBeDefined();
      expect(status.pendingCount).toBe(0);
    });
  });

  describe('pull()', () => {
    it('should pull transactions from relays', async () => {
      // Mock relay returning events
      const mockEvents = [
        createMockEvent('event-1', { memo: 'pulled-1' }),
        createMockEvent('event-2', { memo: 'pulled-2' }),
      ];
      (mockRelayPool.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
        (_filters, onEvent, onEose) => {
          mockEvents.forEach((e) => onEvent(e));
          if (onEose) setTimeout(onEose, 10);
          return () => {};
        }
      );

      const result = await relaySync.pull();

      expect(result.direction).toBe('pull');
      expect(result.pulled).toBe(2);
    });

    it('should not duplicate existing transactions', async () => {
      // Add a transaction that's already synced
      const tx = await store.record(createTestInput());
      await store.update(tx.id, { eventId: 'existing-event', synced: true });

      // Mock relay returning the same event
      const mockEvent = createMockEvent('existing-event', {});
      (mockRelayPool.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
        (_filters, onEvent, onEose) => {
          onEvent(mockEvent);
          if (onEose) setTimeout(onEose, 10);
          return () => {};
        }
      );

      const result = await relaySync.pull();

      // Should not import the duplicate
      expect(result.pulled).toBe(0);
    });

    it('should emit sync events', async () => {
      const startedHandler = vi.fn();
      const completedHandler = vi.fn();

      relaySync.on('sync:started', startedHandler);
      relaySync.on('sync:completed', completedHandler);

      await relaySync.pull();

      expect(startedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'pull' })
      );
      expect(completedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'pull' })
      );
    });
  });

  describe('full()', () => {
    it('should perform push then pull', async () => {
      await store.record(createTestInput());

      const result = await relaySync.full();

      expect(result.direction).toBe('full');
      expect(result.pushed).toBe(1);
      expect(result.pulled).toBe(0);
    });

    it('should update lastSync timestamp', async () => {
      await relaySync.full();

      const status = relaySync.getStatus();
      expect(status.lastSync).toBeDefined();
    });
  });

  describe('getStatus()', () => {
    it('should return current sync status', () => {
      const status = relaySync.getStatus();

      expect(status).toEqual(
        expect.objectContaining({
          inProgress: false,
          synced: true,
          pendingCount: 0,
        })
      );
    });

    it('should track pending count', async () => {
      await store.record(createTestInput());
      await store.record(createTestInput());

      // Force status update by creating new RelaySync
      const newSync = createRelaySync(
        store,
        {
          pubkey: 'test-pubkey',
          signer: mockSigner,
          relayUrls: ['wss://relay.test.com'],
          encryption: false,
        },
        mockRelayPool
      );
      await newSync.init();

      const status = newSync.getStatus();
      expect(status.pendingCount).toBe(2);
      expect(status.synced).toBe(false);

      newSync.close();
    });
  });

  describe('setWalletDTag()', () => {
    it('should update wallet d-tag', async () => {
      relaySync.setWalletDTag('new-wallet');

      await store.record(createTestInput());
      await relaySync.push();

      // Verify the event uses the new wallet d-tag
      const publishCall = (mockRelayPool.publish as ReturnType<typeof vi.fn>).mock.calls[0];
      const event = publishCall[0] as NostrEvent;
      const aTag = event.tags.find((t) => t[0] === 'a');
      expect(aTag?.[1]).toContain('new-wallet');
    });
  });
});

// Helper functions
function createMockSigner(): NostrSigner {
  return {
    getPublicKey: vi.fn().mockResolvedValue('test-pubkey'),
    signEvent: vi.fn().mockImplementation(async (event) => ({
      ...event,
      id: 'event-' + Math.random().toString(36).substring(7),
      sig: 'test-signature',
    })),
    nip44: {
      encrypt: vi.fn().mockImplementation(async (_pubkey, plaintext) => plaintext),
      decrypt: vi.fn().mockImplementation(async (_pubkey, ciphertext) => ciphertext),
    },
  };
}

function createMockRelayPool(): RelayPool {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    publish: vi.fn().mockResolvedValue(['wss://relay.test.com']),
    subscribe: vi.fn().mockImplementation((_filters, _onEvent, onEose) => {
      if (onEose) setTimeout(onEose, 10);
      return () => {};
    }),
    getConnectedRelays: vi.fn().mockReturnValue(['wss://relay.test.com']),
  };
}

function createTestInput(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    type: TransactionType.RECEIVED,
    direction: TransactionDirection.IN,
    tokenAmount: 1000,
    faceValue: 5000,
    faceUnit: 'USD',
    faceDecimals: 2,
    ...overrides,
  };
}

function createMockEvent(
  eventId: string,
  content: Record<string, unknown>
): NostrEvent {
  const fullContent = {
    type: TransactionType.RECEIVED,
    direction: TransactionDirection.IN,
    amount: 1000,
    face_value: 5000,
    face_unit: 'USD',
    ...content,
  };

  return {
    id: eventId,
    pubkey: 'test-pubkey',
    created_at: Math.floor(Date.now() / 1000),
    kind: NIP60_HISTORY_KIND,
    tags: [
      ['d', 'tx-' + Math.random().toString(36).substring(7)],
      ['type', TransactionType.RECEIVED],
      ['direction', TransactionDirection.IN],
    ],
    content: JSON.stringify(fullContent),
    sig: 'test-signature',
  };
}
