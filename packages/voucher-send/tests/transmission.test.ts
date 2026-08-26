/**
 * Transmission Module Tests
 *
 * Tests for PayloadBuilder, TokenChunker, DmSender, and Nip60Publisher.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PayloadBuilder,
  createPayloadBuilder,
  TokenChunker,
  createTokenChunker,
  CHUNK_THRESHOLD,
  CHUNK_SIZE,
  DmSender,
  createDmSender,
  Nip60Publisher,
  createNip60Publisher,
} from '../src/transmission';
import type { ApiAdapter, NostrAdapter } from '../src/adapters';
import type { Voucher, Recipient } from '../src/types';

// ============================================================================
// PayloadBuilder Tests
// ============================================================================

describe('PayloadBuilder', () => {
  let builder: PayloadBuilder;

  beforeEach(() => {
    builder = new PayloadBuilder();
  });

  describe('constructor', () => {
    it('creates with default config', () => {
      const b = new PayloadBuilder();
      expect(b).toBeDefined();
    });

    it('creates with custom config', () => {
      const b = new PayloadBuilder({
        defaultBackingStrategy: 'USSD',
        defaultFaceDecimals: 0,
      });
      expect(b).toBeDefined();
    });
  });

  describe('createPayloadBuilder factory', () => {
    it('creates instance without config', () => {
      const b = createPayloadBuilder();
      expect(b).toBeInstanceOf(PayloadBuilder);
    });

    it('creates instance with config', () => {
      const b = createPayloadBuilder({ defaultFaceDecimals: 4 });
      expect(b).toBeInstanceOf(PayloadBuilder);
    });
  });

  describe('buildFromVoucher', () => {
    const mockVoucher: Voucher = {
      voucher_id: 'v1',
      face_value: 1000,
      face_unit: 'KES',
      face_decimals: 2,
      token_amount: 100,
      backing_strategy: 'USSD',
      issuer_id: 'merchant123',
      memo: 'Test voucher',
      status: 'ACTIVE',
    };

    it('builds payload from voucher', () => {
      const payload = builder.buildFromVoucher(mockVoucher);

      expect(payload.faceValue).toBe(1000);
      expect(payload.faceUnit).toBe('KES');
      expect(payload.faceDecimals).toBe(2);
      expect(payload.tokenAmount).toBe(100);
      expect(payload.backingStrategy).toBe('USSD');
      expect(payload.issuerId).toBe('merchant123');
      expect(payload.memo).toBe('Test voucher');
    });

    it('allows overriding memo', () => {
      const payload = builder.buildFromVoucher(mockVoucher, { memo: 'Custom memo' });
      expect(payload.memo).toBe('Custom memo');
    });

    it('allows adding relay URLs', () => {
      const payload = builder.buildFromVoucher(mockVoucher, {
        relayUrls: ['wss://relay1.com', 'wss://relay2.com'],
      });
      expect(payload.relayUrls).toEqual(['wss://relay1.com', 'wss://relay2.com']);
    });

    it('allows overriding issuer ID', () => {
      const payload = builder.buildFromVoucher(mockVoucher, { issuerId: 'newIssuer' });
      expect(payload.issuerId).toBe('newIssuer');
    });

    it('refuses to build when face_unit is missing (feature 007)', () => {
      // S-INV-1: sender must not dispatch a voucher without a known face_unit.
      const minimalVoucher: Voucher = {
        voucher_id: 'v2',
        status: 'ACTIVE',
      };

      expect(() => builder.buildFromVoucher(minimalVoucher)).toThrow(
        /face_unit/i
      );
    });
  });

  describe('build', () => {
    it('builds payload from raw values', () => {
      const payload = builder.build({
        faceValue: 500,
        faceUnit: 'USD',
        tokenAmount: 50,
        memo: 'Payment',
      });

      expect(payload.faceValue).toBe(500);
      expect(payload.faceUnit).toBe('USD');
      expect(payload.tokenAmount).toBe(50);
      expect(payload.memo).toBe('Payment');
      expect(payload.faceDecimals).toBe(2);
      expect(payload.backingStrategy).toBe('LEGACY');
    });

    it('allows custom backing strategy', () => {
      const payload = builder.build({
        faceValue: 100,
        faceUnit: 'SAT',
        tokenAmount: 100,
        backingStrategy: 'USSD',
      });
      expect(payload.backingStrategy).toBe('USSD');
    });
  });

  describe('buildChunkReference', () => {
    it('builds chunk reference payload', () => {
      const ref = builder.buildChunkReference({
        eventId: 'event123',
        author: 'pubkey456',
        relays: ['wss://relay1.com'],
        chunkCount: 3,
      });

      expect(ref.type).toBe('cashu:chunk');
      expect(ref.eventId).toBe('event123');
      expect(ref.author).toBe('pubkey456');
      expect(ref.relays).toEqual(['wss://relay1.com']);
      expect(ref.chunkCount).toBe(3);
    });

    it('includes optional display metadata', () => {
      const ref = builder.buildChunkReference({
        eventId: 'e1',
        relays: [],
        chunkCount: 2,
        memo: 'Large token',
        faceValue: 10000,
        faceUnit: 'KES',
      });

      expect(ref.memo).toBe('Large token');
      expect(ref.faceValue).toBe(10000);
      expect(ref.faceUnit).toBe('KES');
    });
  });

  describe('serializeChunkReference', () => {
    it('serializes chunk reference to JSON', () => {
      const ref = builder.buildChunkReference({
        eventId: 'e1',
        relays: ['wss://r.com'],
        chunkCount: 2,
      });

      const json = builder.serializeChunkReference(ref);
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe('cashu:chunk');
      expect(parsed.eventId).toBe('e1');
    });
  });

  describe('isChunkReference', () => {
    it('returns true for valid chunk reference', () => {
      const json = JSON.stringify({
        type: 'cashu:chunk',
        eventId: 'e123',
        relays: [],
        chunkCount: 1,
      });

      expect(builder.isChunkReference(json)).toBe(true);
    });

    it('returns false for invalid JSON', () => {
      expect(builder.isChunkReference('not json')).toBe(false);
    });

    it('returns false for wrong type', () => {
      expect(builder.isChunkReference(JSON.stringify({ type: 'other' }))).toBe(false);
    });

    it('returns false for missing eventId', () => {
      expect(builder.isChunkReference(JSON.stringify({ type: 'cashu:chunk' }))).toBe(false);
    });

    it('returns false for non-string eventId', () => {
      expect(
        builder.isChunkReference(JSON.stringify({ type: 'cashu:chunk', eventId: 123 }))
      ).toBe(false);
    });
  });

  describe('parseChunkReference', () => {
    it('parses valid chunk reference', () => {
      const json = JSON.stringify({
        type: 'cashu:chunk',
        eventId: 'e123',
        relays: ['wss://r.com'],
        chunkCount: 3,
      });

      const ref = builder.parseChunkReference(json);
      expect(ref).not.toBeNull();
      expect(ref!.eventId).toBe('e123');
      expect(ref!.chunkCount).toBe(3);
    });

    it('returns null for invalid JSON', () => {
      expect(builder.parseChunkReference('not json')).toBeNull();
    });

    it('returns null for invalid reference', () => {
      expect(builder.parseChunkReference(JSON.stringify({ foo: 'bar' }))).toBeNull();
    });
  });
});

// ============================================================================
// TokenChunker Tests
// ============================================================================

describe('TokenChunker', () => {
  let chunker: TokenChunker;

  beforeEach(() => {
    chunker = new TokenChunker();
  });

  describe('constants', () => {
    it('exports CHUNK_THRESHOLD', () => {
      expect(CHUNK_THRESHOLD).toBe(40_000);
    });

    it('exports CHUNK_SIZE', () => {
      expect(CHUNK_SIZE).toBe(30_000);
    });
  });

  describe('constructor', () => {
    it('creates with default config', () => {
      const c = new TokenChunker();
      expect(c).toBeDefined();
    });

    it('creates with custom config', () => {
      const c = new TokenChunker(undefined, {
        chunkThreshold: 50_000,
        chunkSize: 40_000,
        encryptionOverhead: 1.5,
      });
      expect(c).toBeDefined();
    });
  });

  describe('createTokenChunker factory', () => {
    it('creates instance without adapter', () => {
      const c = createTokenChunker();
      expect(c).toBeInstanceOf(TokenChunker);
    });

    it('creates instance with config', () => {
      const c = createTokenChunker(undefined, { chunkSize: 25_000 });
      expect(c).toBeInstanceOf(TokenChunker);
    });
  });

  describe('needsChunking', () => {
    it('returns false for small tokens', () => {
      const smallToken = 'a'.repeat(20_000);
      expect(chunker.needsChunking(smallToken)).toBe(false);
    });

    it('returns true for large tokens', () => {
      // 40KB token * 1.4 overhead = 56KB > 40KB threshold
      const largeToken = 'a'.repeat(40_000);
      expect(chunker.needsChunking(largeToken)).toBe(true);
    });

    it('considers encryption overhead', () => {
      // 30KB * 1.4 = 42KB > 40KB threshold
      const token = 'a'.repeat(30_000);
      expect(chunker.needsChunking(token)).toBe(true);
    });
  });

  describe('getEstimatedSize', () => {
    it('estimates size with encryption overhead', () => {
      const token = 'a'.repeat(10_000);
      const estimated = chunker.getEstimatedSize(token);
      expect(estimated).toBe(14_000); // 10000 * 1.4
    });
  });

  describe('getChunkCount', () => {
    it('returns 1 for small tokens', () => {
      const smallToken = 'a'.repeat(10_000);
      expect(chunker.getChunkCount(smallToken)).toBe(1);
    });

    it('calculates chunk count for large tokens', () => {
      // 90KB token -> 90000 / 30000 = 3 chunks
      const largeToken = 'a'.repeat(90_000);
      expect(chunker.getChunkCount(largeToken)).toBe(3);
    });

    it('rounds up chunk count', () => {
      // 50KB token -> 50000 / 30000 = 1.67 -> 2 chunks
      const token = 'a'.repeat(50_000);
      expect(chunker.getChunkCount(token)).toBe(2);
    });
  });

  describe('createChunks', () => {
    it('creates single chunk for small tokens', () => {
      const token = 'a'.repeat(25_000);
      const chunks = chunker.createChunks(token);

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.index).toBe(0);
      expect(chunks[0]!.total).toBe(1);
      expect(chunks[0]!.data).toBe(token);
    });

    it('creates multiple chunks for large tokens', () => {
      const token = 'a'.repeat(75_000);
      const chunks = chunker.createChunks(token);

      expect(chunks.length).toBe(3);

      // Verify chunk metadata
      expect(chunks[0]!.index).toBe(0);
      expect(chunks[0]!.total).toBe(3);
      expect(chunks[1]!.index).toBe(1);
      expect(chunks[2]!.index).toBe(2);

      // Verify chunk sizes
      expect(chunks[0]!.data.length).toBe(30_000);
      expect(chunks[1]!.data.length).toBe(30_000);
      expect(chunks[2]!.data.length).toBe(15_000);
    });

    it('preserves data across chunks', () => {
      const token = 'abc'.repeat(20_000); // 60KB
      const chunks = chunker.createChunks(token);
      const reassembled = chunks.map((c) => c.data).join('');
      expect(reassembled).toBe(token);
    });
  });

  describe('reassemble', () => {
    it('reassembles chunks in order', () => {
      const original = 'a'.repeat(60_000);
      const chunks = chunker.createChunks(original);
      const reassembled = chunker.reassemble(chunks);
      expect(reassembled).toBe(original);
    });

    it('handles out-of-order chunks', () => {
      const original = 'abc'.repeat(30_000); // 90KB = 3 chunks
      const chunks = chunker.createChunks(original);
      expect(chunks.length).toBe(3);
      const shuffled = [chunks[2]!, chunks[0]!, chunks[1]!];
      const reassembled = chunker.reassemble(shuffled);
      expect(reassembled).toBe(original);
    });

    it('throws for empty chunks array', () => {
      expect(() => chunker.reassemble([])).toThrow('No chunks provided');
    });

    it('throws for missing chunks', () => {
      const chunks = [
        { index: 0, total: 3, data: 'a' },
        { index: 2, total: 3, data: 'c' },
      ];
      expect(() => chunker.reassemble(chunks)).toThrow('Missing chunks');
    });

    it('throws for wrong index sequence', () => {
      const chunks = [
        { index: 0, total: 2, data: 'a' },
        { index: 2, total: 2, data: 'b' },
      ];
      expect(() => chunker.reassemble(chunks)).toThrow('Missing chunk at index');
    });
  });

  describe('publishChunked', () => {
    it('throws without NostrAdapter', async () => {
      await expect(
        chunker.publishChunked('token', 'recipient', ['wss://relay.com'])
      ).rejects.toThrow('NostrAdapter does not support chunk publishing');
    });

    it('publishes chunks via adapter', async () => {
      const publishChunkEvent = vi.fn().mockResolvedValue({ id: 'event1' });
      const mockAdapter: Partial<NostrAdapter> = { publishChunkEvent };

      const chunkerWithAdapter = new TokenChunker(mockAdapter as NostrAdapter);
      const token = 'a'.repeat(60_000); // 2 chunks

      const result = await chunkerWithAdapter.publishChunked(token, 'recipient123', [
        'wss://r.com',
      ]);

      expect(publishChunkEvent).toHaveBeenCalledTimes(2);
      expect(result.type).toBe('cashu:chunk');
      expect(result.eventId).toBe('event1');
      expect(result.chunkCount).toBe(2);
      expect(result.relays).toEqual(['wss://r.com']);
    });

    it('reports progress via callback', async () => {
      const publishChunkEvent = vi.fn().mockResolvedValue({ id: 'e1' });
      const mockAdapter: Partial<NostrAdapter> = { publishChunkEvent };
      const chunkerWithAdapter = new TokenChunker(mockAdapter as NostrAdapter);

      const onProgress = vi.fn();
      const token = 'a'.repeat(90_000); // 3 chunks

      await chunkerWithAdapter.publishChunked(token, 'r', ['wss://r.com'], { onProgress });

      expect(onProgress).toHaveBeenCalledTimes(3);
      expect(onProgress).toHaveBeenNthCalledWith(1, { published: 1, total: 3 });
      expect(onProgress).toHaveBeenNthCalledWith(2, { published: 2, total: 3 });
      expect(onProgress).toHaveBeenNthCalledWith(3, { published: 3, total: 3 });
    });

    it('includes sender pubkey in result', async () => {
      const publishChunkEvent = vi.fn().mockResolvedValue({ id: 'e1' });
      const mockAdapter: Partial<NostrAdapter> = { publishChunkEvent };
      const chunkerWithAdapter = new TokenChunker(mockAdapter as NostrAdapter);

      const result = await chunkerWithAdapter.publishChunked('a'.repeat(60_000), 'r', [], {
        senderPubkey: 'sender123',
      });

      expect(result.author).toBe('sender123');
    });
  });
});

// ============================================================================
// DmSender Tests
// ============================================================================

describe('DmSender', () => {
  let mockApiAdapter: ApiAdapter;
  let mockNostrAdapter: NostrAdapter;
  let sender: DmSender;

  const mockRecipient: Recipient = {
    pubkeyHex: 'abc123def456',
    npub: 'npub1...',
  };

  beforeEach(() => {
    mockApiAdapter = {
      sendTokenDm: vi.fn().mockResolvedValue({ success: true, eventId: 'dm1' }),
      getSplitPreview: vi.fn(),
      executeSplit: vi.fn(),
      getVouchers: vi.fn(),
    } as unknown as ApiAdapter;

    mockNostrAdapter = {
      publishChunkEvent: vi.fn().mockResolvedValue({ id: 'chunk1' }),
      getRelays: vi.fn().mockResolvedValue([]),
      fetchProfile: vi.fn().mockResolvedValue(null),
    } as unknown as NostrAdapter;

    sender = new DmSender(mockApiAdapter, mockNostrAdapter, {
      infraRelay: 'wss://infra.relay',
    });
  });

  describe('constructor', () => {
    it('creates with minimal config', () => {
      const s = new DmSender(mockApiAdapter);
      expect(s).toBeDefined();
    });

    it('creates with full config', () => {
      const s = new DmSender(mockApiAdapter, mockNostrAdapter, {
        infraRelay: 'wss://relay.com',
        chunking: { enabled: true, chunkSize: 25_000 },
        relay: { cacheMaxAge: 60000 },
      });
      expect(s).toBeDefined();
    });
  });

  describe('createDmSender factory', () => {
    it('creates instance', () => {
      const s = createDmSender(mockApiAdapter);
      expect(s).toBeInstanceOf(DmSender);
    });
  });

  describe('needsChunking', () => {
    it('returns false for small tokens', () => {
      expect(sender.needsChunking('small token')).toBe(false);
    });

    it('returns true for large tokens', () => {
      const largeToken = 'a'.repeat(50_000);
      expect(sender.needsChunking(largeToken)).toBe(true);
    });
  });

  describe('getChunkCount', () => {
    it('returns chunk count', () => {
      const token = 'a'.repeat(90_000);
      expect(sender.getChunkCount(token)).toBe(3);
    });
  });

  describe('send', () => {
    it('sends small token directly', async () => {
      const result = await sender.send('small_token', mockRecipient);

      expect(result.wasChunked).toBe(false);
      expect(result.dmResult.success).toBe(true);
      expect(mockApiAdapter.sendTokenDm).toHaveBeenCalledWith(
        'small_token',
        'abc123def456',
        expect.any(Object)
      );
    });

    it('includes options in DM send', async () => {
      await sender.send('token', mockRecipient, {
        memo: 'Test memo',
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 50,
        senderPubkey: 'sender123',
      });

      expect(mockApiAdapter.sendTokenDm).toHaveBeenCalledWith(
        'token',
        'abc123def456',
        expect.objectContaining({
          memo: 'Test memo',
          faceValue: 100,
          faceUnit: 'USD',
          tokenAmount: 50,
          senderPubkey: 'sender123',
        })
      );
    });

    it('uses custom relay URLs', async () => {
      await sender.send('token', mockRecipient, {
        relayUrls: ['wss://custom.relay'],
      });

      expect(mockApiAdapter.sendTokenDm).toHaveBeenCalledWith(
        'token',
        'abc123def456',
        expect.objectContaining({
          relayUrls: expect.arrayContaining(['wss://custom.relay']),
        })
      );
    });

    it('chunks large tokens', async () => {
      const largeToken = 'a'.repeat(60_000);
      const result = await sender.send(largeToken, mockRecipient);

      expect(result.wasChunked).toBe(true);
      expect(result.chunkReference).toBeDefined();
      expect(result.chunkReference!.type).toBe('cashu:chunk');
      expect(mockNostrAdapter.publishChunkEvent).toHaveBeenCalled();
    });

    it('falls back to direct send if chunking unavailable', async () => {
      const senderNoChunking = new DmSender(mockApiAdapter, undefined, {
        chunking: { enabled: true },
      });

      const largeToken = 'a'.repeat(60_000);
      const result = await senderNoChunking.send(largeToken, mockRecipient);

      expect(result.wasChunked).toBe(false);
      expect(mockApiAdapter.sendTokenDm).toHaveBeenCalled();
    });

    it('can disable chunking', async () => {
      const senderNoChunk = new DmSender(mockApiAdapter, mockNostrAdapter, {
        chunking: { enabled: false },
      });

      const largeToken = 'a'.repeat(60_000);
      const result = await senderNoChunk.send(largeToken, mockRecipient);

      expect(result.wasChunked).toBe(false);
      expect(mockNostrAdapter.publishChunkEvent).not.toHaveBeenCalled();
    });

    it('reports chunk progress', async () => {
      const onChunkProgress = vi.fn();
      const largeToken = 'a'.repeat(60_000);

      await sender.send(largeToken, mockRecipient, { onChunkProgress });

      expect(onChunkProgress).toHaveBeenCalled();
    });
  });

  describe('sendVoucher', () => {
    const mockVoucher: Voucher = {
      voucher_id: 'v1',
      token: 'cashuAtoken123',
      face_value: 1000,
      face_unit: 'KES',
      face_decimals: 2,
      token_amount: 100,
      backing_strategy: 'USSD',
      issuer_id: 'merchant1',
      memo: 'Voucher memo',
      status: 'ACTIVE',
    };

    it('sends voucher with token', async () => {
      const result = await sender.sendVoucher(mockVoucher, mockRecipient);

      expect(result.dmResult.success).toBe(true);
      expect(mockApiAdapter.sendTokenDm).toHaveBeenCalledWith(
        'cashuAtoken123',
        'abc123def456',
        expect.objectContaining({
          faceValue: 1000,
          faceUnit: 'KES',
          tokenAmount: 100,
          backingStrategy: 'USSD',
          issuerId: 'merchant1',
          memo: 'Voucher memo',
        })
      );
    });

    it('throws if voucher has no token', async () => {
      const voucherNoToken: Voucher = {
        voucher_id: 'v2',
        face_value: 100,
        status: 'ACTIVE',
      };

      await expect(sender.sendVoucher(voucherNoToken, mockRecipient)).rejects.toThrow(
        'Voucher has no token'
      );
    });

    it('allows overriding memo', async () => {
      await sender.sendVoucher(mockVoucher, mockRecipient, { memo: 'Custom memo' });

      expect(mockApiAdapter.sendTokenDm).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ memo: 'Custom memo' })
      );
    });

    // =========================================================================
    // Feature 007-fix-voucher-currency — US2: outgoing send forwards the
    // voucher's face_unit verbatim, does not recompute it.
    // =========================================================================
    it('forwards voucher.face_unit verbatim to apiAdapter.sendTokenDm (US2)', async () => {
      const usdVoucher: Voucher = {
        voucher_id: 'v-usd',
        token: 'cashuAtokenUSD',
        face_value: 500,
        face_unit: 'USD',
        face_decimals: 2,
        token_amount: 780,
        backing_strategy: 'MINIMAL',
        status: 'ACTIVE',
      };

      await sender.sendVoucher(usdVoucher, mockRecipient);

      expect(mockApiAdapter.sendTokenDm).toHaveBeenCalledWith(
        'cashuAtokenUSD',
        expect.any(String),
        expect.objectContaining({ faceUnit: 'USD', faceValue: 500 })
      );
    });

    it('uppercases a lowercase face_unit before dispatch (TS-4)', async () => {
      const satVoucher: Voucher = {
        voucher_id: 'v-sat',
        token: 'cashuAtokenSAT',
        face_value: 100,
        face_unit: 'sat',
        face_decimals: 0,
        token_amount: 100,
        backing_strategy: 'LEGACY',
        status: 'ACTIVE',
      };

      await sender.sendVoucher(satVoucher, mockRecipient);

      expect(mockApiAdapter.sendTokenDm).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ faceUnit: 'SAT' })
      );
    });

    it('refuses to dispatch when voucher.face_unit is UNKNOWN (TS-2 / S-INV-1)', async () => {
      const unknownVoucher: Voucher = {
        voucher_id: 'v-unk',
        token: 'cashuAtokenUNK',
        face_value: 0,
        face_unit: 'UNKNOWN',
        face_decimals: 0,
        token_amount: 100,
        backing_strategy: 'LEGACY',
        status: 'ACTIVE',
      };

      await expect(sender.sendVoucher(unknownVoucher, mockRecipient)).rejects.toThrow(
        /face_unit/i
      );
      expect(mockApiAdapter.sendTokenDm).not.toHaveBeenCalled();
    });
  });

  describe('setInfraRelay', () => {
    it('updates infrastructure relay', () => {
      sender.setInfraRelay('wss://new.relay');
      // Verify it doesn't throw
      expect(true).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws VoucherSendError on DM failure', async () => {
      vi.mocked(mockApiAdapter.sendTokenDm).mockRejectedValue(new Error('Network error'));

      await expect(sender.send('token', mockRecipient)).rejects.toThrow('Failed to send DM');
    });

    it('throws VoucherSendError on chunk failure', async () => {
      vi.mocked(mockNostrAdapter.publishChunkEvent).mockRejectedValue(
        new Error('Relay error')
      );

      const largeToken = 'a'.repeat(60_000);
      await expect(sender.send(largeToken, mockRecipient)).rejects.toThrow(
        'Chunked send failed'
      );
    });
  });
});

// ============================================================================
// Nip60Publisher Tests
// ============================================================================

describe('Nip60Publisher', () => {
  let publisher: Nip60Publisher;
  let mockNostrAdapter: NostrAdapter;

  beforeEach(() => {
    mockNostrAdapter = {
      publishProofs: vi.fn().mockResolvedValue(undefined),
      getRelays: vi.fn().mockResolvedValue([]),
      fetchProfile: vi.fn().mockResolvedValue(null),
    } as unknown as NostrAdapter;

    publisher = new Nip60Publisher(mockNostrAdapter, {
      relays: ['wss://nip60.relay'],
      defaultWalletDTag: 'test-wallet',
    });
  });

  describe('constructor', () => {
    it('creates with default config', () => {
      const p = new Nip60Publisher();
      expect(p).toBeDefined();
    });

    it('creates with full config', () => {
      const p = new Nip60Publisher(mockNostrAdapter, {
        relays: ['wss://r1.com', 'wss://r2.com'],
        defaultWalletDTag: 'my-wallet',
      });
      expect(p).toBeDefined();
    });
  });

  describe('createNip60Publisher factory', () => {
    it('creates instance', () => {
      const p = createNip60Publisher();
      expect(p).toBeInstanceOf(Nip60Publisher);
    });

    it('creates instance with config', () => {
      const p = createNip60Publisher(mockNostrAdapter, { relays: ['wss://r.com'] });
      expect(p).toBeInstanceOf(Nip60Publisher);
    });
  });

  describe('isAvailable', () => {
    it('returns true when adapter and relays configured', () => {
      expect(publisher.isAvailable()).toBe(true);
    });

    it('returns false without adapter', () => {
      const p = new Nip60Publisher(undefined, { relays: ['wss://r.com'] });
      expect(p.isAvailable()).toBe(false);
    });

    it('returns false without relays', () => {
      const p = new Nip60Publisher(mockNostrAdapter, { relays: [] });
      expect(p.isAvailable()).toBe(false);
    });
  });

  describe('setRelays', () => {
    it('updates relay list', () => {
      const p = new Nip60Publisher(mockNostrAdapter);
      expect(p.isAvailable()).toBe(false);

      p.setRelays(['wss://new.relay']);
      expect(p.isAvailable()).toBe(true);
    });
  });

  describe('publishProofsForRecipient', () => {
    const mockProofs = [
      { amount: 1, id: 'id1', secret: 's1', C: 'c1' },
      { amount: 2, id: 'id2', secret: 's2', C: 'c2' },
    ];

    it('publishes proofs successfully', async () => {
      const result = await publisher.publishProofsForRecipient(
        {
          mintUrl: 'https://mint.example',
          proofs: mockProofs,
        },
        'recipient123'
      );

      expect(result.success).toBe(true);
      expect(result.proofCount).toBe(2);
      expect(mockNostrAdapter.publishProofs).toHaveBeenCalledWith(
        expect.objectContaining({
          proofs: mockProofs,
          mintUrl: 'https://mint.example',
        }),
        'recipient123'
      );
    });

    it('returns error when not available', async () => {
      const p = new Nip60Publisher();
      const result = await p.publishProofsForRecipient(
        { mintUrl: 'https://mint', proofs: mockProofs },
        'recipient'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('NIP-60 publishing not available');
    });

    it('returns error for empty proofs', async () => {
      const result = await publisher.publishProofsForRecipient(
        { mintUrl: 'https://mint', proofs: [] },
        'recipient'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('No proofs to publish');
    });

    it('handles publish errors gracefully', async () => {
      vi.mocked(mockNostrAdapter.publishProofs).mockRejectedValue(
        new Error('Publish failed')
      );

      const result = await publisher.publishProofsForRecipient(
        { mintUrl: 'https://mint', proofs: mockProofs },
        'recipient'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Publish failed');
    });

    it('includes event ID reference', async () => {
      await publisher.publishProofsForRecipient(
        { mintUrl: 'https://mint', proofs: mockProofs, eventId: 'event123' },
        'recipient'
      );

      expect(mockNostrAdapter.publishProofs).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'event123' }),
        'recipient'
      );
    });
  });

  describe('publishFromDecodedToken', () => {
    it('publishes from decoded token', async () => {
      const decodedToken = {
        token: [
          {
            mint: 'https://mint.example',
            proofs: [{ amount: 10, id: 'id1', secret: 's1', C: 'c1' }],
          },
        ],
      };

      const result = await publisher.publishFromDecodedToken(decodedToken, 'recipient');

      expect(result.success).toBe(true);
      expect(mockNostrAdapter.publishProofs).toHaveBeenCalled();
    });

    it('returns error for empty token', async () => {
      const result = await publisher.publishFromDecodedToken(
        { token: [] },
        'recipient'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token has no entries');
    });

    it('handles undefined token array', async () => {
      const result = await publisher.publishFromDecodedToken(
        { token: undefined as unknown as [] },
        'recipient'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token has no entries');
    });
  });

  describe('extractProofsFromToken', () => {
    it('extracts proofs from cashuA token', () => {
      // Create a simple cashuA token (base64url encoded JSON)
      const tokenData = {
        token: [
          {
            mint: 'https://mint.test',
            proofs: [{ amount: 5, id: 'id1', secret: 's1', C: 'c1' }],
          },
        ],
      };
      const base64 = btoa(JSON.stringify(tokenData))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const token = 'cashuA' + base64;

      const result = publisher.extractProofsFromToken(token);

      expect(result).not.toBeNull();
      expect(result!.mintUrl).toBe('https://mint.test');
      expect(result!.proofs).toHaveLength(1);
    });

    it('returns null for cashuB tokens (unsupported)', () => {
      const result = publisher.extractProofsFromToken('cashuBsomedata');
      expect(result).toBeNull();
    });

    it('returns null for invalid token format', () => {
      expect(publisher.extractProofsFromToken('invalid')).toBeNull();
      expect(publisher.extractProofsFromToken('')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      const badBase64 = btoa('not json')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const result = publisher.extractProofsFromToken('cashuA' + badBase64);
      expect(result).toBeNull();
    });

    it('handles token with empty entries', () => {
      const tokenData = { token: [] };
      const base64 = btoa(JSON.stringify(tokenData))
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const result = publisher.extractProofsFromToken('cashuA' + base64);
      expect(result).toBeNull();
    });
  });

  describe('publishFromToken', () => {
    it('publishes from token string', async () => {
      const tokenData = {
        token: [
          {
            mint: 'https://mint.test',
            proofs: [{ amount: 10, id: 'id1', secret: 's1', C: 'c1' }],
          },
        ],
      };
      const base64 = btoa(JSON.stringify(tokenData))
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const token = 'cashuA' + base64;

      const result = await publisher.publishFromToken(token, 'recipient');

      expect(result.success).toBe(true);
    });

    it('returns error for unparseable token', async () => {
      const result = await publisher.publishFromToken('invalid_token', 'recipient');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Could not extract proofs from token');
    });
  });
});
