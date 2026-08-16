/**
 * Tests for EventBuilder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EventBuilder,
  createEventBuilder,
  NIP60_HISTORY_KIND,
  TransactionType,
  TransactionDirection,
  type Transaction,
  type NostrSigner,
  type NostrEvent,
} from '../../src';

describe('EventBuilder', () => {
  let mockSigner: NostrSigner;
  let builder: EventBuilder;

  beforeEach(() => {
    mockSigner = createMockSigner();
    builder = createEventBuilder({
      pubkey: 'test-pubkey',
      signer: mockSigner,
      walletDTag: 'test-wallet',
      encryption: false, // Disable encryption for easier testing
    });
  });

  describe('buildHistoryEvent()', () => {
    it('should build a valid NIP-60 history event', async () => {
      const tx = createTestTransaction();
      const event = await builder.buildHistoryEvent(tx);

      expect(event.kind).toBe(NIP60_HISTORY_KIND);
      expect(event.pubkey).toBe('test-pubkey');
      expect(event.content).toBeDefined();
      expect(event.sig).toBeDefined();
    });

    it('should include transaction ID in d tag', async () => {
      const tx = createTestTransaction({ id: 'tx-123' });
      const event = await builder.buildHistoryEvent(tx);

      const dTag = event.tags.find((t) => t[0] === 'd');
      expect(dTag).toEqual(['d', 'tx-123']);
    });

    it('should include wallet reference in a tag', async () => {
      const tx = createTestTransaction();
      const event = await builder.buildHistoryEvent(tx);

      const aTag = event.tags.find((t) => t[0] === 'a');
      expect(aTag).toEqual(['a', '37375:test-pubkey:test-wallet']);
    });

    it('should include type tag', async () => {
      const tx = createTestTransaction({ type: TransactionType.RECEIVED });
      const event = await builder.buildHistoryEvent(tx);

      const typeTag = event.tags.find((t) => t[0] === 'type');
      expect(typeTag).toEqual(['type', TransactionType.RECEIVED]);
    });

    it('should include direction tag', async () => {
      const tx = createTestTransaction({ direction: TransactionDirection.IN });
      const event = await builder.buildHistoryEvent(tx);

      const dirTag = event.tags.find((t) => t[0] === 'direction');
      expect(dirTag).toEqual(['direction', TransactionDirection.IN]);
    });

    it('should serialize transaction content', async () => {
      const tx = createTestTransaction({
        tokenAmount: 1000,
        faceValue: 5000,
        faceUnit: 'USD',
        memo: 'Test payment',
      });
      const event = await builder.buildHistoryEvent(tx);

      const content = JSON.parse(event.content);
      expect(content.amount).toBe(1000);
      expect(content.face_value).toBe(5000);
      expect(content.face_unit).toBe('USD');
      expect(content.memo).toBe('Test payment');
    });
  });

  describe('buildHistoryEvents()', () => {
    it('should build multiple events', async () => {
      const transactions = [
        createTestTransaction({ id: 'tx-1' }),
        createTestTransaction({ id: 'tx-2' }),
        createTestTransaction({ id: 'tx-3' }),
      ];

      const events = await builder.buildHistoryEvents(transactions);

      expect(events).toHaveLength(3);
      events.forEach((event) => {
        expect(event.kind).toBe(NIP60_HISTORY_KIND);
      });
    });
  });

  describe('parseHistoryEvent()', () => {
    it('should parse event back to content', async () => {
      const tx = createTestTransaction({
        tokenAmount: 1000,
        faceValue: 5000,
        memo: 'Test',
      });

      const event = await builder.buildHistoryEvent(tx);
      const content = await builder.parseHistoryEvent(event);

      expect(content).not.toBeNull();
      expect(content?.amount).toBe(1000);
      expect(content?.face_value).toBe(5000);
      expect(content?.memo).toBe('Test');
    });

    it('should return null for invalid content', async () => {
      const invalidEvent: NostrEvent = {
        id: 'test',
        pubkey: 'test-pubkey',
        created_at: Math.floor(Date.now() / 1000),
        kind: NIP60_HISTORY_KIND,
        tags: [],
        content: 'not-valid-json',
        sig: 'test-sig',
      };

      const content = await builder.parseHistoryEvent(invalidEvent);
      expect(content).toBeNull();
    });
  });

  describe('getTransactionIdFromEvent()', () => {
    it('should extract transaction ID from d tag', async () => {
      const tx = createTestTransaction({ id: 'tx-456' });
      const event = await builder.buildHistoryEvent(tx);

      const txId = builder.getTransactionIdFromEvent(event);
      expect(txId).toBe('tx-456');
    });

    it('should return null if no d tag', () => {
      const event: NostrEvent = {
        id: 'test',
        pubkey: 'test-pubkey',
        created_at: Math.floor(Date.now() / 1000),
        kind: NIP60_HISTORY_KIND,
        tags: [],
        content: '{}',
        sig: 'test-sig',
      };

      const txId = builder.getTransactionIdFromEvent(event);
      expect(txId).toBeNull();
    });
  });

  describe('getWalletDTagFromEvent()', () => {
    it('should extract wallet d-tag from a tag', async () => {
      const tx = createTestTransaction();
      const event = await builder.buildHistoryEvent(tx);

      const walletDTag = builder.getWalletDTagFromEvent(event);
      expect(walletDTag).toBe('test-wallet');
    });
  });

  describe('isValidHistoryEvent()', () => {
    it('should return true for valid event', async () => {
      const tx = createTestTransaction();
      const event = await builder.buildHistoryEvent(tx);

      expect(builder.isValidHistoryEvent(event)).toBe(true);
    });

    it('should return false for wrong kind', () => {
      const event: NostrEvent = {
        id: 'test',
        pubkey: 'test-pubkey',
        created_at: Math.floor(Date.now() / 1000),
        kind: 1, // Wrong kind
        tags: [],
        content: '{}',
        sig: 'test-sig',
      };

      expect(builder.isValidHistoryEvent(event)).toBe(false);
    });

    it('should return false for wrong pubkey', () => {
      const event: NostrEvent = {
        id: 'test',
        pubkey: 'other-pubkey', // Wrong pubkey
        created_at: Math.floor(Date.now() / 1000),
        kind: NIP60_HISTORY_KIND,
        tags: [],
        content: '{}',
        sig: 'test-sig',
      };

      expect(builder.isValidHistoryEvent(event)).toBe(false);
    });

    it('should return false for empty content', () => {
      const event: NostrEvent = {
        id: 'test',
        pubkey: 'test-pubkey',
        created_at: Math.floor(Date.now() / 1000),
        kind: NIP60_HISTORY_KIND,
        tags: [],
        content: '',
        sig: 'test-sig',
      };

      expect(builder.isValidHistoryEvent(event)).toBe(false);
    });
  });

  describe('encryption', () => {
    it('should encrypt content when enabled', async () => {
      const encryptedBuilder = createEventBuilder({
        pubkey: 'test-pubkey',
        signer: mockSigner,
        walletDTag: 'test-wallet',
        encryption: true,
      });

      const tx = createTestTransaction({ memo: 'secret' });
      const event = await encryptedBuilder.buildHistoryEvent(tx);

      // Content should be encrypted (mock returns 'encrypted:...')
      expect(event.content).toContain('encrypted:');
    });

    it('should decrypt content when parsing', async () => {
      const encryptedBuilder = createEventBuilder({
        pubkey: 'test-pubkey',
        signer: mockSigner,
        walletDTag: 'test-wallet',
        encryption: true,
      });

      const tx = createTestTransaction({ memo: 'secret' });
      const event = await encryptedBuilder.buildHistoryEvent(tx);
      const content = await encryptedBuilder.parseHistoryEvent(event);

      expect(content?.memo).toBe('secret');
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
      encrypt: vi.fn().mockImplementation(async (_pubkey, plaintext) => {
        return `encrypted:${Buffer.from(plaintext).toString('base64')}`;
      }),
      decrypt: vi.fn().mockImplementation(async (_pubkey, ciphertext) => {
        const base64 = ciphertext.replace('encrypted:', '');
        return Buffer.from(base64, 'base64').toString('utf-8');
      }),
    },
  };
}

function createTestTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-test',
    type: TransactionType.RECEIVED,
    direction: TransactionDirection.IN,
    tokenAmount: 1000,
    faceValue: 5000,
    faceUnit: 'USD',
    faceDecimals: 2,
    timestamp: Math.floor(Date.now() / 1000),
    synced: false,
    ...overrides,
  };
}
