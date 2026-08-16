/**
 * Orchestrator Module Tests
 *
 * Integration tests for VoucherSender.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  VoucherSender,
  createVoucherSender,
} from '../src/orchestrator';
import type { ApiAdapter, StorageAdapter, NostrAdapter, Adapters } from '../src/adapters';
import type { Voucher, Recipient, SplitResult, SendEventMap } from '../src/types';
import { SendStages } from '../src/types';

// ============================================================================
// Mock Adapters
// ============================================================================

function createMockApiAdapter(): ApiAdapter {
  return {
    splitPreview: vi.fn().mockResolvedValue({
      canSplit: true,
      actualAmount: 500,
      roundingApplied: false,
      swapRequired: false,
    }),
    splitExecute: vi.fn().mockResolvedValue({
      sendToken: 'cashuAsend...',
      keepToken: 'cashuAkeep...',
      sendFaceValue: 500,
      keepFaceValue: 500,
      sendTokenAmount: 50,
      keepTokenAmount: 50,
      roundingApplied: false,
      issuerId: 'merchant123',
      faceUnit: 'KES',
      faceDecimals: 2,
      backingStrategy: 'USSD',
    }),
    sendTokenDm: vi.fn().mockResolvedValue({
      success: true,
      eventId: 'event123',
    }),
    getProfile: vi.fn().mockResolvedValue(null),
  } as unknown as ApiAdapter;
}

function createMockStorageAdapter(vouchers: Voucher[] = []): StorageAdapter {
  return {
    getVouchers: vi.fn().mockReturnValue(vouchers),
    getVoucher: vi.fn().mockImplementation((id: string) => {
      return vouchers.find((v) => v.voucher_id === id) || null;
    }),
    saveVoucher: vi.fn().mockResolvedValue(undefined),
    deleteVoucher: vi.fn().mockResolvedValue(undefined),
    addTransaction: vi.fn().mockResolvedValue(undefined),
    getTransactions: vi.fn().mockReturnValue([]),
  } as unknown as StorageAdapter;
}

function createMockNostrAdapter(): NostrAdapter {
  return {
    fetchNip05: vi.fn().mockResolvedValue({
      success: true,
      pubkey: 'abc123def456789012345678901234567890123456789012345678901234',
      relays: ['wss://relay.example'],
    }),
    queryRelayList: vi.fn().mockResolvedValue([]),
    fetchProfile: vi.fn().mockResolvedValue(null),
    publishChunkEvent: vi.fn().mockResolvedValue({ id: 'chunk1' }),
    publishProofs: vi.fn().mockResolvedValue(undefined),
  } as unknown as NostrAdapter;
}

function createMockAdapters(vouchers: Voucher[] = []): Adapters {
  return {
    api: createMockApiAdapter(),
    storage: createMockStorageAdapter(vouchers),
    nostr: createMockNostrAdapter(),
  };
}

// ============================================================================
// Test Fixtures
// ============================================================================

const mockVoucher: Voucher = {
  voucher_id: 'v1',
  token: 'cashuAtoken123...',
  face_value: 1000,
  face_unit: 'KES',
  face_decimals: 2,
  token_amount: 100,
  backing_strategy: 'USSD',
  issuer_id: 'merchant123',
  status: 'active',
  merchant_metadata: {
    merchant_name: 'Test Merchant',
  },
};

const mockRecipient: Recipient = {
  npub: 'npub1abc...',
  pubkeyHex: 'abc123def456789012345678901234567890123456789012345678901234',
  displayName: 'Test User',
  relays: ['wss://relay.example'],
};

// ============================================================================
// VoucherSender Tests
// ============================================================================

describe('VoucherSender', () => {
  let adapters: Adapters;
  let sender: VoucherSender;

  beforeEach(() => {
    adapters = createMockAdapters([mockVoucher]);
    sender = new VoucherSender({ adapters });
  });

  describe('constructor', () => {
    it('creates with minimal config', () => {
      const s = new VoucherSender({ adapters });
      expect(s).toBeDefined();
    });

    it('creates with full config', () => {
      const s = new VoucherSender({
        adapters,
        config: {
          chunking: { enabled: true, threshold: 50_000 },
          relay: { infraRelay: 'wss://infra.relay', defaultRelays: ['wss://default.relay'] },
          nip60: { enabled: true, relays: ['wss://nip60.relay'] },
          defaultNip05Domain: 'example.com',
          timeout: 60_000,
          debug: true,
        },
      });
      expect(s).toBeDefined();
    });
  });

  describe('createVoucherSender factory', () => {
    it('creates instance', () => {
      const s = createVoucherSender({ adapters });
      expect(s).toBeInstanceOf(VoucherSender);
    });
  });

  describe('event emitter', () => {
    it('allows subscribing to events', () => {
      const handler = vi.fn();
      const unsubscribe = sender.on('send:start', handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('allows unsubscribing from events', () => {
      const handler = vi.fn();
      sender.on('send:start', handler);
      sender.off('send:start', handler);
      // Should not throw
    });
  });

  describe('send', () => {
    it('completes full send flow with voucher object', async () => {
      const events: string[] = [];
      sender.on('send:start', () => events.push('start'));
      sender.on('send:progress', () => events.push('progress'));
      sender.on('send:complete', () => events.push('complete'));

      const result = await sender.send({
        voucher: mockVoucher,
        amount: 500,
        recipient: mockRecipient,
        memo: 'Test payment',
      });

      expect(result.success).toBe(true);
      expect(result.sentVoucher).toBeDefined();
      expect(result.recipient.pubkeyHex).toBe(mockRecipient.pubkeyHex);
      expect(result.dmResult).toBeDefined();
      expect(result.transaction).toBeDefined();
      expect(events).toContain('start');
      expect(events).toContain('complete');
    });

    it('completes send flow with voucher ID', async () => {
      const result = await sender.send({
        voucher: 'v1',
        amount: 500,
        recipient: mockRecipient,
      });

      expect(result.success).toBe(true);
      expect(adapters.storage.getVoucher).toHaveBeenCalledWith('v1');
    });

    it('completes send flow with merchant ID', async () => {
      const result = await sender.send({
        merchantId: 'merchant123',
        amount: 500,
        recipient: mockRecipient,
      });

      expect(result.success).toBe(true);
    });

    it('completes send flow with recipient string', async () => {
      const result = await sender.send({
        voucher: mockVoucher,
        amount: 500,
        recipient: 'test@example.com',
      });

      expect(result.success).toBe(true);
      expect(adapters.nostr.fetchNip05).toHaveBeenCalled();
    });

    it('emits progress events in correct order', async () => {
      const stages: string[] = [];
      sender.on('send:progress', ({ stage }) => stages.push(stage));

      await sender.send({
        voucher: mockVoucher,
        amount: 500,
        recipient: mockRecipient,
      });

      expect(stages).toContain(SendStages.VALIDATING);
      expect(stages).toContain(SendStages.SELECTING_VOUCHER);
      expect(stages).toContain(SendStages.SPLITTING);
      expect(stages).toContain(SendStages.RESOLVING_RECIPIENT);
      expect(stages).toContain(SendStages.SENDING_DM);
      expect(stages).toContain(SendStages.COMPLETE);
    });

    it('includes split result with keep voucher', async () => {
      const result = await sender.send({
        voucher: mockVoucher,
        amount: 500,
        recipient: mockRecipient,
      });

      expect(result.splitResult).toBeDefined();
      expect(result.keepVoucher).toBeDefined();
      expect(result.keepVoucher?.status).toBe('active');
    });

    it('records transaction', async () => {
      await sender.send({
        voucher: mockVoucher,
        amount: 500,
        recipient: mockRecipient,
        memo: 'Test memo',
      });

      expect(adapters.storage.addTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'voucher_sent',
          direction: 'out',
          faceValue: 500,
          memo: 'Test memo',
        })
      );
    });

    it('throws error for missing amount', async () => {
      await expect(
        sender.send({
          voucher: mockVoucher,
          amount: 0,
          recipient: mockRecipient,
        })
      ).rejects.toThrow('Amount must be greater than 0');
    });

    it('throws error for missing recipient', async () => {
      await expect(
        sender.send({
          voucher: mockVoucher,
          amount: 500,
          recipient: undefined as unknown as string,
        })
      ).rejects.toThrow('Recipient is required');
    });

    it('throws error for missing voucher/merchantId', async () => {
      await expect(
        sender.send({
          amount: 500,
          recipient: mockRecipient,
        })
      ).rejects.toThrow('Either voucher, merchantId, or paymentRequest is required');
    });

    it('throws error if voucher not found', async () => {
      await expect(
        sender.send({
          voucher: 'nonexistent',
          amount: 500,
          recipient: mockRecipient,
        })
      ).rejects.toThrow('Voucher not found');
    });

    it('emits error event on failure', async () => {
      const errorHandler = vi.fn();
      sender.on('send:error', errorHandler);

      await expect(
        sender.send({
          voucher: 'nonexistent',
          amount: 500,
          recipient: mockRecipient,
        })
      ).rejects.toThrow();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          stage: expect.any(String),
        })
      );
    });
  });

  describe('preview', () => {
    it('returns preview result for voucher object', async () => {
      const result = await sender.preview({
        voucher: mockVoucher,
        amount: 500,
      });

      expect(result.canSplit).toBe(true);
      expect(result.voucher).toBe(mockVoucher);
    });

    it('returns preview result for voucher ID', async () => {
      const result = await sender.preview({
        voucher: 'v1',
        amount: 500,
      });

      expect(result.canSplit).toBe(true);
      expect(result.voucher.voucher_id).toBe('v1');
    });

    it('includes merchant info', async () => {
      const result = await sender.preview({
        voucher: mockVoucher,
        amount: 500,
      });

      expect(result.merchant).toBeDefined();
      expect(result.merchant?.id).toBe('merchant123');
      expect(result.merchant?.name).toBe('Test Merchant');
    });

    it('throws error for voucher without token', async () => {
      const voucherNoToken: Voucher = { ...mockVoucher, token: undefined as unknown as string };
      vi.mocked(adapters.storage.getVoucher).mockReturnValue(voucherNoToken);

      await expect(
        sender.preview({ voucher: 'v1', amount: 500 })
      ).rejects.toThrow('Voucher has no token');
    });
  });

  describe('resolveRecipient', () => {
    it('resolves NIP-05 identifier', async () => {
      const recipient = await sender.resolveRecipient('user@example.com');

      expect(recipient.pubkeyHex).toBeDefined();
      expect(adapters.nostr.fetchNip05).toHaveBeenCalled();
    });

    it('emits resolve event', async () => {
      const handler = vi.fn();
      sender.on('recipient:resolve', handler);

      await sender.resolveRecipient('user@example.com');

      expect(handler).toHaveBeenCalledWith({ identifier: 'user@example.com' });
    });

    it('emits notfound event on failure', async () => {
      vi.mocked(adapters.nostr.fetchNip05).mockResolvedValue({
        success: false,
        error: 'Not found',
      });

      const handler = vi.fn();
      sender.on('recipient:notfound', handler);

      await expect(sender.resolveRecipient('invalid@example.com')).rejects.toThrow();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('getVoucherGroups', () => {
    it('returns grouped vouchers', async () => {
      const groups = await sender.getVoucherGroups();

      expect(Array.isArray(groups)).toBe(true);
    });
  });

  describe('selectVoucher', () => {
    it('selects voucher for amount', async () => {
      const result = await sender.selectVoucher('merchant123', 500);

      expect(result.voucher).toBeDefined();
      expect(result.needsConsolidation).toBe(false);
    });

    it('emits selection event', async () => {
      const handler = vi.fn();
      sender.on('selection:start', handler);

      await sender.selectVoucher('merchant123', 500);

      expect(handler).toHaveBeenCalledWith({ merchantId: 'merchant123', amount: 500 });
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
    it('returns chunk count for token', () => {
      const largeToken = 'a'.repeat(90_000);
      expect(sender.getChunkCount(largeToken)).toBe(3);
    });
  });

  describe('NIP-60 publishing', () => {
    it('publishes to NIP-60 when enabled', async () => {
      const senderWithNip60 = new VoucherSender({
        adapters,
        config: {
          nip60: { enabled: true, relays: ['wss://nip60.relay'] },
        },
      });

      const nip60Handler = vi.fn();
      senderWithNip60.on('nip60:published', nip60Handler);

      await senderWithNip60.send({
        voucher: mockVoucher,
        amount: 500,
        recipient: mockRecipient,
      });

      expect(nip60Handler).toHaveBeenCalled();
    });

    it('skips NIP-60 when disabled', async () => {
      const nip60Handler = vi.fn();
      sender.on('nip60:published', nip60Handler);

      await sender.send({
        voucher: mockVoucher,
        amount: 500,
        recipient: mockRecipient,
      });

      expect(nip60Handler).not.toHaveBeenCalled();
    });
  });

  describe('error scenarios', () => {
    it('handles split API error', async () => {
      vi.mocked(adapters.api.splitExecute).mockRejectedValue(new Error('Split failed'));

      await expect(
        sender.send({
          voucher: mockVoucher,
          amount: 500,
          recipient: mockRecipient,
        })
      ).rejects.toThrow();
    });

    it('handles DM send error', async () => {
      vi.mocked(adapters.api.sendTokenDm).mockRejectedValue(new Error('DM failed'));

      await expect(
        sender.send({
          voucher: mockVoucher,
          amount: 500,
          recipient: mockRecipient,
        })
      ).rejects.toThrow();
    });

    it('handles recipient resolution error', async () => {
      vi.mocked(adapters.nostr.fetchNip05).mockRejectedValue(new Error('Resolution failed'));

      await expect(
        sender.send({
          voucher: mockVoucher,
          amount: 500,
          recipient: 'user@example.com',
        })
      ).rejects.toThrow();
    });
  });
});
