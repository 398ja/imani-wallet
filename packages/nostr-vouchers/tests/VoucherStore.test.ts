/**
 * VoucherStore tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  VoucherStore,
  createVoucherStore,
  VoucherStatus,
  BackingStrategy,
  type VoucherInput,
} from '../src';

describe('VoucherStore', () => {
  let store: VoucherStore;

  const createTestVoucher = (overrides: Partial<VoucherInput> = {}): VoucherInput => ({
    faceValue: 100,
    faceUnit: 'USD',
    tokenAmount: 10000,
    backingStrategy: BackingStrategy.FULL,
    issuerId: 'issuer-pubkey-123',
    mintUrl: 'https://mint.example.com',
    ...overrides,
  });

  beforeEach(async () => {
    store = createVoucherStore({
      storage: 'memory',
      expiryCheckInterval: 0, // Disable auto-check
    });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('Initialization', () => {
    it('should initialize successfully', () => {
      expect(store.isInitialized()).toBe(true);
    });

    it('should not re-initialize', async () => {
      await store.init();
      expect(store.isInitialized()).toBe(true);
    });

    it('should emit store:opened event on init', async () => {
      const newStore = createVoucherStore({ storage: 'memory', expiryCheckInterval: 0 });
      const handler = vi.fn();
      newStore.on('store:opened', handler);

      await newStore.init();

      expect(handler).toHaveBeenCalledWith({
        dbName: 'imani-vouchers',
        isShared: false,
      });

      await newStore.close();
    });
  });

  describe('CRUD Operations', () => {
    describe('add', () => {
      it('should add a voucher', async () => {
        const input = createTestVoucher();
        const voucher = await store.add(input);

        expect(voucher).toBeDefined();
        expect(voucher.id).toBeDefined();
        expect(voucher.faceValue).toBe(100);
        expect(voucher.faceUnit).toBe('USD');
        expect(voucher.tokenAmount).toBe(10000);
        expect(voucher.backingStrategy).toBe(BackingStrategy.FULL);
        expect(voucher.status).toBe(VoucherStatus.ACTIVE);
        expect(voucher.createdAt).toBeDefined();
      });

      it('should emit voucher:added event', async () => {
        const handler = vi.fn();
        store.on('voucher:added', handler);

        const input = createTestVoucher();
        const voucher = await store.add(input);

        expect(handler).toHaveBeenCalledWith({
          voucher,
          source: 'local',
        });
      });

      it('should calculate issuance ratio for FULL backing', async () => {
        const input = createTestVoucher({
          backingStrategy: BackingStrategy.FULL,
          faceValue: 100,
          tokenAmount: 10000, // 10000 sats = ~$10 at 100 sats/$
        });
        const voucher = await store.add(input);

        // issuanceRatio = faceValue / tokenAmount = 100 / 10000 = 0.01
        expect(voucher.issuanceRatio).toBeCloseTo(0.01);
      });
    });

    describe('addBatch', () => {
      it('should add multiple vouchers', async () => {
        const inputs = [
          createTestVoucher({ faceValue: 100 }),
          createTestVoucher({ faceValue: 200 }),
          createTestVoucher({ faceValue: 300 }),
        ];

        const vouchers = await store.addBatch(inputs);

        expect(vouchers).toHaveLength(3);
        expect(vouchers[0].faceValue).toBe(100);
        expect(vouchers[1].faceValue).toBe(200);
        expect(vouchers[2].faceValue).toBe(300);
      });

      it('should emit voucher:batch-added event', async () => {
        const handler = vi.fn();
        store.on('voucher:batch-added', handler);

        const inputs = [
          createTestVoucher({ faceValue: 100 }),
          createTestVoucher({ faceValue: 200 }),
        ];
        const vouchers = await store.addBatch(inputs);

        expect(handler).toHaveBeenCalledWith({
          vouchers,
          count: 2,
          source: 'local',
        });
      });
    });

    describe('get', () => {
      it('should get a voucher by ID', async () => {
        const input = createTestVoucher();
        const added = await store.add(input);

        const retrieved = await store.get(added.id);

        expect(retrieved).toEqual(added);
      });

      it('should return null for non-existent ID', async () => {
        const retrieved = await store.get('non-existent-id');
        expect(retrieved).toBeNull();
      });
    });

    describe('getByEventId', () => {
      it('should get a voucher by event ID', async () => {
        const input = createTestVoucher();
        const added = await store.add(input);

        // Mark as synced with an event ID
        await store.markSynced([added.id], ['event-123']);

        const retrieved = await store.getByEventId('event-123');

        expect(retrieved).toBeDefined();
        expect(retrieved?.id).toBe(added.id);
      });
    });

    describe('update', () => {
      it('should update a voucher', async () => {
        const input = createTestVoucher();
        const added = await store.add(input);

        const updated = await store.update(added.id, {
          faceValue: 200,
          memo: 'Updated memo',
        });

        expect(updated.faceValue).toBe(200);
        expect(updated.memo).toBe('Updated memo');
        expect(updated.updatedAt).toBeDefined();
      });

      it('should emit voucher:updated event', async () => {
        const handler = vi.fn();
        store.on('voucher:updated', handler);

        const input = createTestVoucher();
        const added = await store.add(input);

        await store.update(added.id, { faceValue: 200 });

        expect(handler).toHaveBeenCalled();
        const call = handler.mock.calls[0][0];
        expect(call.voucher.faceValue).toBe(200);
        expect(call.changes).toContain('faceValue');
      });

      it('should emit voucher:spent event when status changes to SPENT', async () => {
        const spentHandler = vi.fn();
        store.on('voucher:spent', spentHandler);

        const input = createTestVoucher();
        const added = await store.add(input);

        await store.update(added.id, { status: VoucherStatus.SPENT });

        expect(spentHandler).toHaveBeenCalled();
        expect(spentHandler.mock.calls[0][0].voucher.status).toBe(VoucherStatus.SPENT);
      });
    });

    describe('delete', () => {
      it('should delete a voucher', async () => {
        const input = createTestVoucher();
        const added = await store.add(input);

        const deleted = await store.delete(added.id);

        expect(deleted).toBe(true);

        const retrieved = await store.get(added.id);
        expect(retrieved).toBeNull();
      });

      it('should emit voucher:deleted event', async () => {
        const handler = vi.fn();
        store.on('voucher:deleted', handler);

        const input = createTestVoucher();
        const added = await store.add(input);

        await store.delete(added.id);

        expect(handler).toHaveBeenCalledWith({
          voucherId: added.id,
          voucher: added,
        });
      });

      it('should return false for non-existent ID', async () => {
        const deleted = await store.delete('non-existent-id');
        expect(deleted).toBe(false);
      });
    });
  });

  describe('Query Operations', () => {
    beforeEach(async () => {
      // Add test vouchers
      await store.addBatch([
        createTestVoucher({ faceValue: 100, faceUnit: 'USD', issuerId: 'issuer-1' }),
        createTestVoucher({ faceValue: 200, faceUnit: 'USD', issuerId: 'issuer-2' }),
        createTestVoucher({ faceValue: 300, faceUnit: 'EUR', issuerId: 'issuer-1' }),
      ]);
    });

    describe('query', () => {
      it('should query vouchers with filter', async () => {
        const result = await store.query({ faceUnit: 'USD' });

        expect(result.vouchers).toHaveLength(2);
        expect(result.total).toBe(2);
      });

      it('should support pagination', async () => {
        const result = await store.query({ limit: 2, offset: 0 });

        expect(result.vouchers).toHaveLength(2);
        expect(result.hasMore).toBe(true);
      });
    });

    describe('getAll', () => {
      it('should return all vouchers', async () => {
        const vouchers = await store.getAll();
        expect(vouchers).toHaveLength(3);
      });
    });

    describe('count', () => {
      it('should count all vouchers', async () => {
        const count = await store.count();
        expect(count).toBe(3);
      });

      it('should count with filter', async () => {
        const count = await store.count({ faceUnit: 'USD' });
        expect(count).toBe(2);
      });
    });

    describe('exists', () => {
      it('should return true for existing voucher', async () => {
        const vouchers = await store.getAll();
        const exists = await store.exists(vouchers[0].id);
        expect(exists).toBe(true);
      });

      it('should return false for non-existent voucher', async () => {
        const exists = await store.exists('non-existent-id');
        expect(exists).toBe(false);
      });
    });

    describe('clear', () => {
      it('should remove all vouchers', async () => {
        await store.clear();
        const count = await store.count();
        expect(count).toBe(0);
      });
    });
  });

  describe('Specialized Queries', () => {
    beforeEach(async () => {
      const now = new Date();
      const inThreeDays = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const inTenDays = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

      await store.addBatch([
        createTestVoucher({
          faceValue: 100,
          issuerId: 'merchant-1',
          expiresAt: inThreeDays.toISOString(),
        }),
        createTestVoucher({
          faceValue: 200,
          issuerId: 'merchant-1',
          expiresAt: inTenDays.toISOString(),
        }),
        createTestVoucher({
          faceValue: 300,
          issuerId: 'merchant-2',
        }),
      ]);
    });

    describe('getActive', () => {
      it('should return only active vouchers', async () => {
        const vouchers = await store.getAll();
        await store.update(vouchers[0].id, { status: VoucherStatus.SPENT });

        const active = await store.getActive();
        expect(active).toHaveLength(2);
      });
    });

    describe('getExpiringSoon', () => {
      it('should return vouchers expiring within N days', async () => {
        const expiring = await store.getExpiringSoon(7);
        expect(expiring).toHaveLength(1);
        expect(expiring[0].faceValue).toBe(100);
      });
    });

    describe('getByMerchant', () => {
      it('should return vouchers by merchant', async () => {
        const vouchers = await store.getByMerchant('merchant-1');
        expect(vouchers).toHaveLength(2);
      });
    });

    describe('getByCurrency', () => {
      it('should return vouchers by currency', async () => {
        const vouchers = await store.getByCurrency('USD');
        expect(vouchers).toHaveLength(3);
      });
    });
  });

  describe('Sync Operations', () => {
    it('should track unsynced vouchers', async () => {
      const input = createTestVoucher();
      await store.add(input);

      const unsynced = await store.getUnsynced();
      expect(unsynced).toHaveLength(1);
    });

    it('should mark vouchers as synced', async () => {
      const input = createTestVoucher();
      const voucher = await store.add(input);

      await store.markSynced([voucher.id], ['event-123']);

      const unsynced = await store.getUnsynced();
      expect(unsynced).toHaveLength(0);

      const updated = await store.get(voucher.id);
      expect(updated?.synced).toBe(true);
      expect(updated?.eventId).toBe('event-123');
    });

    it('should return sync status', async () => {
      await store.add(createTestVoucher());
      await store.add(createTestVoucher());

      const status = await store.getSyncStatus();

      expect(status.pendingCount).toBe(2);
      expect(status.isSyncing).toBe(false);
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      await store.addBatch([
        createTestVoucher({ faceValue: 100, faceUnit: 'USD', tokenAmount: 10000 }),
        createTestVoucher({ faceValue: 200, faceUnit: 'USD', tokenAmount: 20000 }),
        createTestVoucher({ faceValue: 300, faceUnit: 'EUR', tokenAmount: 30000 }),
      ]);
    });

    it('should calculate statistics', async () => {
      const stats = await store.getStats();

      expect(stats.totalVouchers).toBe(3);
      expect(stats.totalFaceValue).toEqual({ USD: 300, EUR: 300 });
      expect(stats.totalTokenAmount).toBe(60000);
      expect(stats.merchantCount).toBe(1);
    });

    it('should calculate statistics with filter', async () => {
      const stats = await store.getStats({ filter: { faceUnit: 'USD' } });

      expect(stats.totalVouchers).toBe(2);
      expect(stats.totalFaceValue).toEqual({ USD: 300 });
    });
  });

  describe('Event Subscription', () => {
    it('should allow subscribing to events', async () => {
      const handler = vi.fn();
      const unsubscribe = store.on('voucher:added', handler);

      await store.add(createTestVoucher());

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      await store.add(createTestVoucher());

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should support once subscription', async () => {
      const handler = vi.fn();
      store.once('voucher:added', handler);

      await store.add(createTestVoucher());
      await store.add(createTestVoucher());

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should allow unsubscribing with off', async () => {
      const handler = vi.fn();
      store.on('voucher:added', handler);

      await store.add(createTestVoucher());
      expect(handler).toHaveBeenCalledTimes(1);

      store.off('voucher:added', handler);

      await store.add(createTestVoucher());
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
