/**
 * BalanceManager Tests
 *
 * Tests the stateful balance manager: initialization, caching,
 * event subscriptions, refresh, pending transactions, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BalanceManager,
  createBalanceManager,
  type VoucherStoreInterface,
  type TransactionStoreInterface,
  type BalanceManagerConfig,
} from '../src/core/BalanceManager';
import type { BalanceVoucher } from '../src/core/BalanceCalculator';
import type { WalletBalance } from '../src/types/balance';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function createVoucher(overrides: Partial<BalanceVoucher> = {}): BalanceVoucher {
  return {
    id: `voucher-${Math.random().toString(36).slice(2)}`,
    faceValue: 1000,
    faceUnit: 'EUR',
    faceDecimals: 2,
    tokenAmount: 100,
    tokenUnit: 'sat',
    status: 'active',
    ...overrides,
  };
}

/**
 * Create a mock VoucherStore with controllable voucher list and event handlers.
 */
function createMockVoucherStore(vouchers: BalanceVoucher[] = []): VoucherStoreInterface & {
  _vouchers: BalanceVoucher[];
  _handlers: Map<string, Set<(data: unknown) => void>>;
  _emit: (event: string, data?: unknown) => void;
} {
  const handlers = new Map<string, Set<(data: unknown) => void>>();

  return {
    _vouchers: vouchers,
    _handlers: handlers,
    _emit(event: string, data?: unknown) {
      const set = handlers.get(event);
      if (set) {
        for (const handler of set) handler(data);
      }
    },
    async getAll() {
      return this._vouchers;
    },
    on(event: string, handler: (data: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => { handlers.get(event)?.delete(handler); };
    },
  };
}

/**
 * Create a mock TransactionStore.
 */
function createMockTransactionStore(
  pending: Array<{ amount: number; currency: string; direction: string }> = []
): TransactionStoreInterface & {
  _pending: Array<{ amount: number; currency: string; direction: string }>;
  _handlers: Map<string, Set<(data: unknown) => void>>;
  _emit: (event: string, data?: unknown) => void;
} {
  const handlers = new Map<string, Set<(data: unknown) => void>>();

  return {
    _pending: pending,
    _handlers: handlers,
    _emit(event: string, data?: unknown) {
      const set = handlers.get(event);
      if (set) {
        for (const handler of set) handler(data);
      }
    },
    async getPending() {
      return this._pending;
    },
    on(event: string, handler: (data: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => { handlers.get(event)?.delete(handler); };
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BalanceManager', () => {
  let store: ReturnType<typeof createMockVoucherStore>;
  let manager: BalanceManager;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createMockVoucherStore([
      createVoucher({ id: 'v1', faceValue: 1000, faceUnit: 'EUR', tokenAmount: 100 }),
      createVoucher({ id: 'v2', faceValue: 2000, faceUnit: 'EUR', tokenAmount: 200 }),
      createVoucher({ id: 'v3', faceValue: 500, faceUnit: 'USD', tokenAmount: 50 }),
    ]);
    manager = new BalanceManager({ voucherStore: store });
  });

  afterEach(async () => {
    await manager.close();
    vi.useRealTimers();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────────────────────

  describe('init', () => {
    it('should calculate initial balance on init', async () => {
      await manager.init();

      const balance = await manager.getBalance();
      expect(balance.currencies.EUR.amount).toBe(3000);
      expect(balance.currencies.USD.amount).toBe(500);
      expect(balance.totalSatsBacking).toBe(350);
    });

    it('should set initialized flag', async () => {
      expect(manager.isInitialized()).toBe(false);
      await manager.init();
      expect(manager.isInitialized()).toBe(true);
    });

    it('should be idempotent (multiple init calls)', async () => {
      const getAllSpy = vi.spyOn(store, 'getAll');

      await manager.init();
      await manager.init();
      await manager.init();

      // Should only have fetched once during init (not three times)
      expect(getAllSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit balance:updated on first init', async () => {
      const listener = vi.fn();
      manager.on('balance:updated', listener);

      await manager.init();

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].previous).toBeNull();
      expect(listener.mock.calls[0][0].current.currencies.EUR.amount).toBe(3000);
      expect(listener.mock.calls[0][0].trigger).toBe('refresh');
    });

    it('should emit balance:refreshing and balance:refreshed on init', async () => {
      const refreshingListener = vi.fn();
      const refreshedListener = vi.fn();

      manager.on('balance:refreshing', refreshingListener);
      manager.on('balance:refreshed', refreshedListener);

      await manager.init();

      expect(refreshingListener).toHaveBeenCalledOnce();
      expect(refreshedListener).toHaveBeenCalledOnce();
      expect(refreshedListener.mock.calls[0][0].balance.currencies.EUR.amount).toBe(3000);
      expect(refreshedListener.mock.calls[0][0].duration).toBeGreaterThanOrEqual(0);
    });

    it('should subscribe to voucher store events', async () => {
      await manager.init();

      const expectedEvents = [
        'voucher:added',
        'voucher:updated',
        'voucher:removed',
        'voucher:expired',
        'voucher:spent',
      ];

      for (const event of expectedEvents) {
        expect(store._handlers.has(event)).toBe(true);
        expect(store._handlers.get(event)!.size).toBeGreaterThan(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // createBalanceManager factory
  // ──────────────────────────────────────────────────────────────────────

  describe('createBalanceManager', () => {
    it('should return a BalanceManager instance', () => {
      const mgr = createBalanceManager({ voucherStore: store });
      expect(mgr).toBeInstanceOf(BalanceManager);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Caching
  // ──────────────────────────────────────────────────────────────────────

  describe('caching', () => {
    it('should return cached balance on subsequent getBalance calls', async () => {
      await manager.init();
      const getAllSpy = vi.spyOn(store, 'getAll');

      await manager.getBalance();
      await manager.getBalance();

      // Should not re-fetch since cache is fresh
      expect(getAllSpy).not.toHaveBeenCalled();
    });

    it('should re-fetch when cache is stale', async () => {
      await manager.init();
      const getAllSpy = vi.spyOn(store, 'getAll');

      // Advance past staleness threshold (30s default)
      vi.advanceTimersByTime(31000);

      await manager.getBalance();
      expect(getAllSpy).toHaveBeenCalledOnce();
    });

    it('should bypass cache when options are provided', async () => {
      await manager.init();
      const getAllSpy = vi.spyOn(store, 'getAll');

      await manager.getBalance({ currency: 'EUR' });
      expect(getAllSpy).toHaveBeenCalledOnce();
    });

    it('should not cache results when options are provided', async () => {
      await manager.init();
      const getAllSpy = vi.spyOn(store, 'getAll');

      await manager.getBalance({ currency: 'EUR' });
      await manager.getBalance({ currency: 'EUR' });

      // Both calls fetch fresh data
      expect(getAllSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Staleness
  // ──────────────────────────────────────────────────────────────────────

  describe('isStale', () => {
    it('should be stale with no cached balance', () => {
      expect(manager.isStale()).toBe(true);
    });

    it('should not be stale right after init', async () => {
      await manager.init();
      expect(manager.isStale()).toBe(false);
    });

    it('should be stale after maxAge expires', async () => {
      await manager.init();
      vi.advanceTimersByTime(31000);
      expect(manager.isStale()).toBe(true);
    });

    it('should respect custom maxAge', async () => {
      await manager.init();
      vi.advanceTimersByTime(5000);
      expect(manager.isStale(10000)).toBe(false);
      expect(manager.isStale(3000)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // getLastCalculated
  // ──────────────────────────────────────────────────────────────────────

  describe('getLastCalculated', () => {
    it('should be 0 before init', () => {
      expect(manager.getLastCalculated()).toBe(0);
    });

    it('should be set after init', async () => {
      const before = Date.now();
      await manager.init();
      expect(manager.getLastCalculated()).toBeGreaterThanOrEqual(before);
    });

    it('should update after refresh', async () => {
      await manager.init();
      const afterInit = manager.getLastCalculated();

      vi.advanceTimersByTime(1000);
      await manager.refresh();

      expect(manager.getLastCalculated()).toBeGreaterThan(afterInit);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Core balance methods
  // ──────────────────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('should return balance with correct currencies', async () => {
      await manager.init();
      const balance = await manager.getBalance();

      expect(balance.currencies).toHaveProperty('EUR');
      expect(balance.currencies).toHaveProperty('USD');
      expect(balance.primaryCurrency).toBe('EUR');
    });

    it('should return filtered balance when options given', async () => {
      await manager.init();
      const balance = await manager.getBalance({ currency: 'USD' });

      expect(balance.currencies).toHaveProperty('USD');
      expect(balance.currencies).not.toHaveProperty('EUR');
    });

    it('should return empty balance for empty store', async () => {
      store._vouchers = [];
      await manager.init();
      const balance = await manager.getBalance();

      expect(Object.keys(balance.currencies)).toHaveLength(0);
      expect(balance.totalSatsBacking).toBe(0);
      expect(balance.primaryCurrency).toBeNull();
    });
  });

  describe('getBalanceByCurrency', () => {
    it('should return balance for existing currency', async () => {
      await manager.init();
      const eurBalance = await manager.getBalanceByCurrency('EUR');

      expect(eurBalance).not.toBeNull();
      expect(eurBalance!.currency).toBe('EUR');
      expect(eurBalance!.amount).toBe(3000);
      expect(eurBalance!.voucherCount).toBe(2);
    });

    it('should return null for non-existent currency', async () => {
      await manager.init();
      const result = await manager.getBalanceByCurrency('GBP');
      expect(result).toBeNull();
    });
  });

  describe('getBalanceByIssuer', () => {
    it('should return balance for specific issuer', async () => {
      store._vouchers = [
        createVoucher({ id: 'v1', faceValue: 1000, issuerId: 'issuer-a', issuerName: 'Merchant A' }),
        createVoucher({ id: 'v2', faceValue: 2000, issuerId: 'issuer-b', issuerName: 'Merchant B' }),
      ];
      await manager.init();

      const issuerBalance = await manager.getBalanceByIssuer('issuer-a');
      expect(issuerBalance).not.toBeNull();
      expect(issuerBalance!.issuerId).toBe('issuer-a');
      expect(issuerBalance!.voucherCount).toBe(1);
    });

    it('should return null for non-existent issuer', async () => {
      await manager.init();
      const result = await manager.getBalanceByIssuer('no-such-issuer');
      expect(result).toBeNull();
    });
  });

  describe('getBalanceBreakdown', () => {
    it('should return full breakdown', async () => {
      await manager.init();
      const breakdown = await manager.getBalanceBreakdown();

      expect(breakdown.total).toBeDefined();
      expect(breakdown.total.currencies.EUR.amount).toBe(3000);
      expect(breakdown.byIssuer).toBeDefined();
      expect(breakdown.byStrategy).toBeDefined();
      expect(breakdown.expiringSoon).toBeDefined();
    });

    it('should use configured expiringWithinDays', async () => {
      store._vouchers = [
        createVoucher({
          id: 'v-expiring',
          faceValue: 500,
          expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        createVoucher({
          id: 'v-not-expiring',
          faceValue: 1000,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ];

      const mgr = new BalanceManager({ voucherStore: store, expiringWithinDays: 5 });
      await mgr.init();

      const breakdown = await mgr.getBalanceBreakdown();
      expect(breakdown.expiringWithinDays).toBe(5);

      await mgr.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Grouped views
  // ──────────────────────────────────────────────────────────────────────

  describe('getIssuerBalances', () => {
    it('should return balances grouped by issuer', async () => {
      store._vouchers = [
        createVoucher({ issuerId: 'i1', issuerName: 'One' }),
        createVoucher({ issuerId: 'i1', issuerName: 'One' }),
        createVoucher({ issuerId: 'i2', issuerName: 'Two' }),
      ];
      await manager.init();

      const issuers = await manager.getIssuerBalances();
      expect(issuers.length).toBe(2);
    });
  });

  describe('getCurrencyBalances', () => {
    it('should return array of currency balances', async () => {
      await manager.init();
      const currencies = await manager.getCurrencyBalances();

      expect(currencies.length).toBe(2);
      const codes = currencies.map((c) => c.currency);
      expect(codes).toContain('EUR');
      expect(codes).toContain('USD');
    });
  });

  describe('getTopIssuers', () => {
    it('should return top N issuers', async () => {
      store._vouchers = [
        createVoucher({ issuerId: 'i1', issuerName: 'A', faceValue: 5000 }),
        createVoucher({ issuerId: 'i2', issuerName: 'B', faceValue: 3000 }),
        createVoucher({ issuerId: 'i3', issuerName: 'C', faceValue: 1000 }),
        createVoucher({ issuerId: 'i4', issuerName: 'D', faceValue: 500 }),
      ];
      await manager.init();

      const top2 = await manager.getTopIssuers(2);
      expect(top2.length).toBe(2);
    });

    it('should default to 3', async () => {
      store._vouchers = [
        createVoucher({ issuerId: 'i1', issuerName: 'A' }),
        createVoucher({ issuerId: 'i2', issuerName: 'B' }),
        createVoucher({ issuerId: 'i3', issuerName: 'C' }),
        createVoucher({ issuerId: 'i4', issuerName: 'D' }),
      ];
      await manager.init();

      const top = await manager.getTopIssuers();
      expect(top.length).toBe(3);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Selection
  // ──────────────────────────────────────────────────────────────────────

  describe('selectVouchersForAmount', () => {
    it('should select vouchers covering the requested amount', async () => {
      await manager.init();
      const result = await manager.selectVouchersForAmount({
        amount: 1500,
        currency: 'EUR',
      });

      expect(result.sufficient).toBe(true);
      expect(result.totalAmount).toBeGreaterThanOrEqual(1500);
    });

    it('should return insufficient when not enough balance', async () => {
      await manager.init();
      const result = await manager.selectVouchersForAmount({
        amount: 999999,
        currency: 'EUR',
      });

      expect(result.sufficient).toBe(false);
      expect(result.shortfall).toBeGreaterThan(0);
    });
  });

  describe('getAvailableForCurrency', () => {
    it('should return total available for EUR', async () => {
      await manager.init();
      const available = await manager.getAvailableForCurrency('EUR');
      expect(available).toBe(3000);
    });

    it('should return 0 for currency with no vouchers', async () => {
      await manager.init();
      const available = await manager.getAvailableForCurrency('GBP');
      expect(available).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Refresh
  // ──────────────────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('should recalculate balance from store', async () => {
      await manager.init();

      // Add a voucher to the store
      store._vouchers.push(
        createVoucher({ id: 'v-new', faceValue: 5000, faceUnit: 'EUR', tokenAmount: 500 })
      );

      const balance = await manager.refresh();
      expect(balance.currencies.EUR.amount).toBe(8000);
    });

    it('should emit balance:updated when balance changes', async () => {
      await manager.init();
      const listener = vi.fn();
      manager.on('balance:updated', listener);

      store._vouchers.push(
        createVoucher({ id: 'v-new', faceValue: 5000, faceUnit: 'EUR', tokenAmount: 500 })
      );

      await manager.refresh();
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].trigger).toBe('refresh');
    });

    it('should not emit balance:updated when balance is unchanged', async () => {
      await manager.init();
      const listener = vi.fn();
      manager.on('balance:updated', listener);

      // Refresh with same vouchers
      await manager.refresh();
      expect(listener).not.toHaveBeenCalled();
    });

    it('should emit refreshing and refreshed events', async () => {
      await manager.init();
      const refreshing = vi.fn();
      const refreshed = vi.fn();

      manager.on('balance:refreshing', refreshing);
      manager.on('balance:refreshed', refreshed);

      await manager.refresh();

      expect(refreshing).toHaveBeenCalledOnce();
      expect(refreshed).toHaveBeenCalledOnce();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Auto-refresh
  // ──────────────────────────────────────────────────────────────────────

  describe('auto-refresh', () => {
    it('should auto-refresh at configured interval', async () => {
      const mgr = new BalanceManager({
        voucherStore: store,
        refreshInterval: 5000,
      });
      await mgr.init();

      const getAllSpy = vi.spyOn(store, 'getAll');

      // Advance past one interval tick and flush the resulting promise
      vi.advanceTimersByTime(5001);
      await vi.advanceTimersByTimeAsync(0);

      expect(getAllSpy).toHaveBeenCalled();

      await mgr.close();
    });

    it('should not auto-refresh when interval is 0', async () => {
      const mgr = new BalanceManager({
        voucherStore: store,
        refreshInterval: 0,
      });
      await mgr.init();

      const getAllSpy = vi.spyOn(store, 'getAll');

      vi.advanceTimersByTime(60000);
      await vi.runAllTimersAsync();

      expect(getAllSpy).not.toHaveBeenCalled();

      await mgr.close();
    });

    it('should emit balance:error if auto-refresh fails', async () => {
      const failingStore = createMockVoucherStore([]);
      let callCount = 0;
      failingStore.getAll = async () => {
        callCount++;
        if (callCount > 1) throw new Error('store down');
        return [];
      };

      const mgr = new BalanceManager({
        voucherStore: failingStore,
        refreshInterval: 1000,
      });

      const errorListener = vi.fn();
      mgr.on('balance:error', errorListener);

      await mgr.init();
      // Advance past one interval tick and flush the resulting promise
      vi.advanceTimersByTime(1001);
      await vi.advanceTimersByTimeAsync(0);

      expect(errorListener).toHaveBeenCalled();
      expect(errorListener.mock.calls[0][0].operation).toBe('auto-refresh');

      await mgr.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Voucher store event handling
  // ──────────────────────────────────────────────────────────────────────

  describe('voucher store events', () => {
    it('should refresh when voucher:added fires', async () => {
      await manager.init();

      store._vouchers.push(
        createVoucher({ id: 'v-added', faceValue: 7000, faceUnit: 'EUR', tokenAmount: 700 })
      );

      const listener = vi.fn();
      manager.on('balance:updated', listener);

      store._emit('voucher:added', { id: 'v-added' });
      await vi.runAllTimersAsync();

      expect(listener).toHaveBeenCalled();
    });

    it('should refresh when voucher:removed fires', async () => {
      await manager.init();

      // Remove a voucher
      store._vouchers = store._vouchers.filter((v) => v.id !== 'v1');

      const listener = vi.fn();
      manager.on('balance:updated', listener);

      store._emit('voucher:removed', { id: 'v1' });
      await vi.runAllTimersAsync();

      expect(listener).toHaveBeenCalled();
      const updated = listener.mock.calls[0][0].current as WalletBalance;
      expect(updated.currencies.EUR.amount).toBe(2000);
    });

    it('should refresh when voucher:spent fires', async () => {
      await manager.init();
      const refreshedListener = vi.fn();
      manager.on('balance:refreshed', refreshedListener);

      store._emit('voucher:spent', { id: 'v2' });
      await vi.runAllTimersAsync();

      expect(refreshedListener).toHaveBeenCalled();
    });

    it('should refresh when voucher:expired fires', async () => {
      await manager.init();
      const refreshedListener = vi.fn();
      manager.on('balance:refreshed', refreshedListener);

      store._emit('voucher:expired', { id: 'v1' });
      await vi.runAllTimersAsync();

      expect(refreshedListener).toHaveBeenCalled();
    });

    it('should refresh when voucher:updated fires', async () => {
      await manager.init();
      const refreshedListener = vi.fn();
      manager.on('balance:refreshed', refreshedListener);

      store._emit('voucher:updated', { id: 'v1' });
      await vi.runAllTimersAsync();

      expect(refreshedListener).toHaveBeenCalled();
    });

    it('should emit balance:error if voucher event handler fails', async () => {
      await manager.init();
      vi.spyOn(store, 'getAll').mockRejectedValueOnce(new Error('fetch failed'));

      const errorListener = vi.fn();
      manager.on('balance:error', errorListener);

      store._emit('voucher:added', {});
      await vi.runAllTimersAsync();

      expect(errorListener).toHaveBeenCalled();
      expect(errorListener.mock.calls[0][0].operation).toBe('voucher-event-handler');
      expect(errorListener.mock.calls[0][0].context).toHaveProperty('trigger');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Currency change detection
  // ──────────────────────────────────────────────────────────────────────

  describe('currency change detection', () => {
    it('should emit balance:currency-changed when a currency amount changes', async () => {
      await manager.init();
      const listener = vi.fn();
      manager.on('balance:currency-changed', listener);

      // Increase EUR balance
      store._vouchers.push(
        createVoucher({ id: 'v-more', faceValue: 500, faceUnit: 'EUR', tokenAmount: 50 })
      );

      store._emit('voucher:added', { id: 'v-more' });
      await vi.runAllTimersAsync();

      const eurEvent = listener.mock.calls.find(
        (call: any[]) => call[0].currency === 'EUR'
      );
      expect(eurEvent).toBeDefined();
      expect(eurEvent![0].difference).toBe(500);
    });

    it('should emit balance:currency-changed when a currency is removed', async () => {
      await manager.init();
      const listener = vi.fn();
      manager.on('balance:currency-changed', listener);

      // Remove all USD vouchers
      store._vouchers = store._vouchers.filter((v) => v.faceUnit !== 'USD');

      store._emit('voucher:removed', {});
      await vi.runAllTimersAsync();

      const usdEvent = listener.mock.calls.find(
        (call: any[]) => call[0].currency === 'USD'
      );
      expect(usdEvent).toBeDefined();
      expect(usdEvent![0].current).toBeNull();
      expect(usdEvent![0].difference).toBe(-500);
    });

    it('should emit balance:currency-changed when a new currency appears', async () => {
      await manager.init();
      const listener = vi.fn();
      manager.on('balance:currency-changed', listener);

      store._vouchers.push(
        createVoucher({ id: 'v-gbp', faceValue: 2000, faceUnit: 'GBP', tokenAmount: 200 })
      );

      store._emit('voucher:added', { id: 'v-gbp' });
      await vi.runAllTimersAsync();

      const gbpEvent = listener.mock.calls.find(
        (call: any[]) => call[0].currency === 'GBP'
      );
      expect(gbpEvent).toBeDefined();
      expect(gbpEvent![0].previous).toBeNull();
      expect(gbpEvent![0].difference).toBe(2000);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Pending transactions
  // ──────────────────────────────────────────────────────────────────────

  describe('pending transactions', () => {
    it('should subtract pending outgoing transactions from balance', async () => {
      const txStore = createMockTransactionStore([
        { amount: 500, currency: 'EUR', direction: 'out' },
      ]);

      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: true,
      });

      await mgr.init();
      const balance = await mgr.getBalance();

      expect(balance.currencies.EUR.amount).toBe(2500); // 3000 - 500
      expect(balance.includesPending).toBe(true);

      await mgr.close();
    });

    it('should not subtract incoming pending transactions', async () => {
      const txStore = createMockTransactionStore([
        { amount: 500, currency: 'EUR', direction: 'in' },
      ]);

      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: true,
      });

      await mgr.init();
      const balance = await mgr.getBalance();

      expect(balance.currencies.EUR.amount).toBe(3000); // Unchanged
      expect(balance.includesPending).toBe(true);

      await mgr.close();
    });

    it('should not subtract pending when includePending is false', async () => {
      const txStore = createMockTransactionStore([
        { amount: 500, currency: 'EUR', direction: 'out' },
      ]);

      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: false,
      });

      await mgr.init();
      const balance = await mgr.getBalance();

      expect(balance.currencies.EUR.amount).toBe(3000);

      await mgr.close();
    });

    it('should handle multiple pending transactions', async () => {
      const txStore = createMockTransactionStore([
        { amount: 200, currency: 'EUR', direction: 'out' },
        { amount: 300, currency: 'EUR', direction: 'out' },
        { amount: 100, currency: 'USD', direction: 'out' },
      ]);

      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: true,
      });

      await mgr.init();
      const balance = await mgr.getBalance();

      expect(balance.currencies.EUR.amount).toBe(2500); // 3000 - 500
      expect(balance.currencies.USD.amount).toBe(400);  // 500 - 100

      await mgr.close();
    });

    it('should not go below zero when pending exceeds balance', async () => {
      const txStore = createMockTransactionStore([
        { amount: 99999, currency: 'EUR', direction: 'out' },
      ]);

      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: true,
      });

      await mgr.init();
      const balance = await mgr.getBalance();

      // EUR should be removed entirely (subtractFromBalance removes zero-amount currencies)
      expect(balance.currencies.EUR).toBeUndefined();

      await mgr.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Transaction store events
  // ──────────────────────────────────────────────────────────────────────

  describe('transaction store events', () => {
    it('should subscribe to transaction:added events', async () => {
      const txStore = createMockTransactionStore();
      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: true,
      });

      await mgr.init();

      expect(txStore._handlers.has('transaction:added')).toBe(true);
      expect(txStore._handlers.get('transaction:added')!.size).toBeGreaterThan(0);

      await mgr.close();
    });

    it('should refresh when transaction:added fires', async () => {
      const txStore = createMockTransactionStore();
      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: true,
      });

      await mgr.init();
      const refreshedListener = vi.fn();
      mgr.on('balance:refreshed', refreshedListener);

      txStore._emit('transaction:added', {});
      await vi.runAllTimersAsync();

      expect(refreshedListener).toHaveBeenCalled();

      await mgr.close();
    });

    it('should emit balance:error if transaction event handler fails', async () => {
      const txStore = createMockTransactionStore();
      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: true,
      });

      await mgr.init();
      vi.spyOn(store, 'getAll').mockRejectedValueOnce(new Error('boom'));

      const errorListener = vi.fn();
      mgr.on('balance:error', errorListener);

      txStore._emit('transaction:added', {});
      await vi.runAllTimersAsync();

      expect(errorListener).toHaveBeenCalled();
      expect(errorListener.mock.calls[0][0].operation).toBe('transaction-event-handler');

      await mgr.close();
    });

    it('should not subscribe to transaction store without on method', async () => {
      const txStore: TransactionStoreInterface = {
        async getPending() { return []; },
        // No `on` method
      };

      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        includePending: true,
      });

      // Should not throw
      await mgr.init();
      await mgr.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Close / cleanup
  // ──────────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('should clear cached balance', async () => {
      await manager.init();
      expect(manager.isStale()).toBe(false);

      await manager.close();
      expect(manager.isStale()).toBe(true);
      expect(manager.getLastCalculated()).toBe(0);
    });

    it('should reset initialized flag', async () => {
      await manager.init();
      expect(manager.isInitialized()).toBe(true);

      await manager.close();
      expect(manager.isInitialized()).toBe(false);
    });

    it('should stop auto-refresh timer', async () => {
      const mgr = new BalanceManager({
        voucherStore: store,
        refreshInterval: 1000,
      });
      await mgr.init();

      await mgr.close();

      const getAllSpy = vi.spyOn(store, 'getAll');
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      // No auto-refresh calls after close
      expect(getAllSpy).not.toHaveBeenCalled();
    });

    it('should unsubscribe from voucher store events', async () => {
      await manager.init();
      expect(store._handlers.get('voucher:added')!.size).toBeGreaterThan(0);

      await manager.close();

      // All handlers should have been removed
      for (const [, handlers] of store._handlers) {
        expect(handlers.size).toBe(0);
      }
    });

    it('should remove all event listeners', async () => {
      await manager.init();
      manager.on('balance:updated', () => {});
      manager.on('balance:refreshed', () => {});

      expect(manager.listenerCount('balance:updated')).toBeGreaterThan(0);

      await manager.close();

      expect(manager.listenerCount('balance:updated')).toBe(0);
      expect(manager.listenerCount('balance:refreshed')).toBe(0);
    });

    it('should allow re-init after close', async () => {
      await manager.init();
      await manager.close();

      // Should be able to re-init
      await manager.init();
      expect(manager.isInitialized()).toBe(true);

      const balance = await manager.getBalance();
      expect(balance.currencies.EUR.amount).toBe(3000);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Debug logging
  // ──────────────────────────────────────────────────────────────────────

  describe('debug logging', () => {
    it('should log when debug is enabled', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mgr = new BalanceManager({
        voucherStore: store,
        debug: true,
      });
      await mgr.init();

      expect(logSpy).toHaveBeenCalled();
      const calls = logSpy.mock.calls.filter((c) => c[0] === '[BalanceManager]');
      expect(calls.length).toBeGreaterThan(0);

      logSpy.mockRestore();
      await mgr.close();
    });

    it('should not log when debug is disabled', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mgr = new BalanceManager({
        voucherStore: store,
        debug: false,
      });
      await mgr.init();

      const calls = logSpy.mock.calls.filter((c) => c[0] === '[BalanceManager]');
      expect(calls.length).toBe(0);

      logSpy.mockRestore();
      await mgr.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Config defaults
  // ──────────────────────────────────────────────────────────────────────

  describe('config defaults', () => {
    it('should default refreshInterval to 0', async () => {
      // Manager without explicit refreshInterval shouldn't auto-refresh
      await manager.init();
      const getAllSpy = vi.spyOn(store, 'getAll');

      vi.advanceTimersByTime(60000);
      await vi.runAllTimersAsync();

      expect(getAllSpy).not.toHaveBeenCalled();
    });

    it('should default includePending to false', async () => {
      const txStore = createMockTransactionStore([
        { amount: 500, currency: 'EUR', direction: 'out' },
      ]);

      const mgr = new BalanceManager({
        voucherStore: store,
        transactionStore: txStore,
        // includePending not set (defaults to false)
      });

      await mgr.init();
      const balance = await mgr.getBalance();
      expect(balance.currencies.EUR.amount).toBe(3000); // Not subtracted

      await mgr.close();
    });

    it('should default expiringWithinDays to 7', async () => {
      await manager.init();
      const breakdown = await manager.getBalanceBreakdown();
      expect(breakdown.expiringWithinDays).toBe(7);
    });
  });
});
