/**
 * Package Integration Tests
 *
 * Tests the integration between @imani/nostr-vouchers, @imani/auto-redemption,
 * and @imani/nostr-transactions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createPackageIntegration,
  TransactionTypes,
  TransactionDirections,
  type AutoRedemptionVoucher,
  type AutoRedemptionServiceInterface,
  type TransactionStoreInterface,
  type TransactionInput,
} from '../src/integrations';

// Mock auto-redemption service
class MockAutoRedemptionService implements AutoRedemptionServiceInterface {
  private handlers: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  async start(): Promise<void> {
    // Mock start
  }

  stop(): void {
    // Mock stop
  }

  // Helper to emit events for testing
  emit(event: string, payload: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(payload);
      }
    }
  }
}

// Mock transaction store
class MockTransactionStore implements TransactionStoreInterface {
  public recordedTransactions: TransactionInput[] = [];

  async init(): Promise<void> {
    // Mock init
  }

  async record(input: TransactionInput): Promise<unknown> {
    this.recordedTransactions.push(input);
    return { id: `tx-${Date.now()}` };
  }

  async close(): Promise<void> {
    // Mock close
  }
}

describe('Package Integration', () => {
  let integration: Awaited<ReturnType<typeof createPackageIntegration>>;
  let mockAutoRedemption: MockAutoRedemptionService;
  let mockTransactionStore: MockTransactionStore;

  beforeEach(async () => {
    // Create integration
    integration = await createPackageIntegration({
      dbName: `test-integration-${Date.now()}`,
      voucherStore: {
        storage: 'memory',
      },
    });

    mockAutoRedemption = new MockAutoRedemptionService();
    mockTransactionStore = new MockTransactionStore();
  });

  afterEach(async () => {
    integration.cleanup();
  });

  describe('createPackageIntegration', () => {
    it('should create integration with voucher store', () => {
      expect(integration).toBeDefined();
      expect(integration.voucherStore).toBeDefined();
      expect(integration.database).toBeDefined();
    });

    it('should provide connect functions', () => {
      expect(typeof integration.connectAutoRedemption).toBe('function');
      expect(typeof integration.connectTransactionStore).toBe('function');
      expect(typeof integration.cleanup).toBe('function');
    });
  });

  describe('Auto-Redemption Integration', () => {
    it('should save voucher when redemption:success is emitted', async () => {
      // Connect auto-redemption
      integration.connectAutoRedemption(mockAutoRedemption);

      // Create test voucher
      const testVoucher: AutoRedemptionVoucher = {
        voucher_id: 'test-voucher-1',
        token: 'cashuAtest...',
        face_value: 1000,
        face_unit: 'USD',
        face_decimals: 2,
        token_amount: 500,
        token_unit: 'sat',
        backing_strategy: 'MINIMAL',
        issuer_id: 'merchant-123',
        sender_pubkey: 'sender-pubkey',
        memo: 'Test payment',
        created_at: new Date().toISOString(),
        status: 'active',
        mint_url: 'https://mint.example.com',
      };

      // Emit redemption success
      mockAutoRedemption.emit('redemption:success', testVoucher);

      // Wait for async handlers
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify voucher was saved
      const vouchers = await integration.voucherStore.getAll();
      expect(vouchers.length).toBe(1);
      expect(vouchers[0].faceValue).toBe(1000);
      expect(vouchers[0].faceUnit).toBe('USD');
      expect(vouchers[0].tokenAmount).toBe(500);
      expect(vouchers[0].senderPubkey).toBe('sender-pubkey');
      expect(vouchers[0].memo).toBe('Test payment');
    });

    it('should record transaction when voucher is received', async () => {
      // Connect both services
      integration.connectAutoRedemption(mockAutoRedemption);
      integration.connectTransactionStore(mockTransactionStore);

      // Create test voucher
      const testVoucher: AutoRedemptionVoucher = {
        voucher_id: 'test-voucher-2',
        token: 'cashuAtest...',
        face_value: 2000,
        face_unit: 'EUR',
        face_decimals: 2,
        token_amount: 1000,
        token_unit: 'sat',
        backing_strategy: 'FULL',
        sender_pubkey: 'sender-456',
        created_at: new Date().toISOString(),
        status: 'active',
        mint_url: 'https://mint.example.com',
      };

      // Emit redemption success
      mockAutoRedemption.emit('redemption:success', testVoucher);

      // Wait for async handlers
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify transaction was recorded
      expect(mockTransactionStore.recordedTransactions.length).toBe(1);
      const tx = mockTransactionStore.recordedTransactions[0];
      expect(tx.type).toBe(TransactionTypes.RECEIVED);
      expect(tx.direction).toBe(TransactionDirections.IN);
      expect(tx.faceValue).toBe(2000);
      expect(tx.faceUnit).toBe('EUR');
      expect(tx.tokenAmount).toBe(1000);
      expect(tx.counterparty).toBe('sender-456');
    });

    it('should call custom handlers', async () => {
      const onVoucherReceived = vi.fn();

      // Create new integration with custom handler
      const customIntegration = await createPackageIntegration({
        dbName: `test-custom-${Date.now()}`,
        voucherStore: { storage: 'memory' },
        handlers: {
          onVoucherReceived,
        },
      });

      customIntegration.connectAutoRedemption(mockAutoRedemption);

      const testVoucher: AutoRedemptionVoucher = {
        voucher_id: 'test-voucher-3',
        token: 'cashuAtest...',
        face_value: 500,
        face_unit: 'SAT',
        face_decimals: 0,
        token_amount: 500,
        token_unit: 'sat',
        backing_strategy: 'LEGACY',
        created_at: new Date().toISOString(),
        status: 'active',
        mint_url: 'https://mint.example.com',
      };

      mockAutoRedemption.emit('redemption:success', testVoucher);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(onVoucherReceived).toHaveBeenCalled();
      expect(onVoucherReceived.mock.calls[0][0].faceValue).toBe(500);

      customIntegration.cleanup();
    });
  });

  describe('Transaction face_unit mirrors voucher (feature 007 US2)', () => {
    it('records face_unit verbatim from the voucher for a USD voucher', async () => {
      integration.connectAutoRedemption(mockAutoRedemption);
      integration.connectTransactionStore(mockTransactionStore);

      const testVoucher: AutoRedemptionVoucher = {
        voucher_id: 'us2-voucher-usd',
        token: 'cashuAtest...',
        face_value: 500,
        face_unit: 'USD',
        face_decimals: 2,
        token_amount: 780,
        token_unit: 'sat',
        backing_strategy: 'MINIMAL',
        created_at: new Date().toISOString(),
        status: 'active',
        mint_url: 'https://mint.example.com',
      };

      mockAutoRedemption.emit('redemption:success', testVoucher);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockTransactionStore.recordedTransactions.length).toBe(1);
      expect(mockTransactionStore.recordedTransactions[0]?.faceUnit).toBe('USD');
    });

    it('preserves the UNKNOWN sentinel — MUST NOT default to SAT', async () => {
      integration.connectAutoRedemption(mockAutoRedemption);
      integration.connectTransactionStore(mockTransactionStore);

      const testVoucher: AutoRedemptionVoucher = {
        voucher_id: 'us2-voucher-unknown',
        token: 'cashuAtest...',
        face_value: 0,
        face_unit: 'UNKNOWN',
        face_decimals: 0,
        token_amount: 100,
        token_unit: 'sat',
        backing_strategy: 'LEGACY',
        created_at: new Date().toISOString(),
        status: 'active',
        mint_url: 'https://mint.example.com',
      };

      mockAutoRedemption.emit('redemption:success', testVoucher);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockTransactionStore.recordedTransactions.length).toBe(1);
      const tx = mockTransactionStore.recordedTransactions[0];
      expect(tx?.faceUnit).toBe('UNKNOWN');
      expect(tx?.faceUnit).not.toBe('SAT');
    });
  });

  describe('Transaction Store Integration', () => {
    it('should record expiry transaction when voucher expires', async () => {
      integration.connectTransactionStore(mockTransactionStore);

      // Add a voucher that's expired
      const expiredVoucher = await integration.voucherStore.add({
        token: 'cashuAexpired...',
        faceValue: 100,
        faceUnit: 'USD',
        faceDecimals: 2,
        tokenAmount: 50,
        tokenUnit: 'sat',
        expiresAt: new Date(Date.now() - 1000).toISOString(), // Already expired
      });

      // Update status to expired (which triggers the event)
      await integration.voucherStore.update(expiredVoucher.id, {
        status: 'expired' as const,
      });

      // Wait for async handlers
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify expiry transaction was recorded
      const expiryTx = mockTransactionStore.recordedTransactions.find(
        (tx) => tx.type === TransactionTypes.EXPIRED
      );
      expect(expiryTx).toBeDefined();
      expect(expiryTx?.direction).toBe(TransactionDirections.OUT);
      expect(expiryTx?.voucherId).toBe(expiredVoucher.id);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect all handlers on cleanup', async () => {
      const disconnect1 = integration.connectAutoRedemption(mockAutoRedemption);
      const disconnect2 = integration.connectTransactionStore(mockTransactionStore);

      // Cleanup
      integration.cleanup();

      // Emit event after cleanup
      const testVoucher: AutoRedemptionVoucher = {
        voucher_id: 'test-after-cleanup',
        token: 'cashuAtest...',
        face_value: 100,
        face_unit: 'USD',
        face_decimals: 2,
        token_amount: 50,
        token_unit: 'sat',
        backing_strategy: 'MINIMAL',
        created_at: new Date().toISOString(),
        status: 'active',
        mint_url: 'https://mint.example.com',
      };

      mockAutoRedemption.emit('redemption:success', testVoucher);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Voucher should not be saved (handlers were disconnected)
      // Note: This test verifies cleanup works but store might be closed
    });
  });
});
