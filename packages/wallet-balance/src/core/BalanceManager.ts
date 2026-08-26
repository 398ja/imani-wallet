/**
 * BalanceManager
 *
 * Main entry point for balance operations.
 * Integrates with VoucherStore for real-time balance tracking.
 */

import type {
  WalletBalance,
  CurrencyBalance,
  IssuerBalance,
  BalanceBreakdown,
  BalanceCalculationOptions,
  BalanceEventMap,
  BalanceUpdateTrigger,
} from '../types';
import type { SelectionRequest, SelectionResult, SelectableVoucher } from '../types/selection';
import { TypedEventEmitter } from '../utils/EventEmitter';
import { BalanceCalculator, type BalanceVoucher } from './BalanceCalculator';
import { SelectionOptimizer } from './SelectionOptimizer';
import { CurrencyAggregator } from './CurrencyAggregator';

/**
 * VoucherStore interface (minimal required interface)
 * Compatible with @imani/nostr-vouchers VoucherStore
 */
export interface VoucherStoreInterface {
  getAll(): Promise<BalanceVoucher[]>;
  on(event: string, handler: (data: unknown) => void): () => void;
}

/**
 * TransactionStore interface (optional)
 * Compatible with @imani/nostr-transactions TransactionStore
 */
export interface TransactionStoreInterface {
  getPending?(): Promise<Array<{ amount: number; currency: string; direction: string }>>;
  on?(event: string, handler: (data: unknown) => void): () => void;
}

/**
 * BalanceManager configuration
 */
export interface BalanceManagerConfig {
  /** VoucherStore instance */
  voucherStore: VoucherStoreInterface;
  /** Optional TransactionStore for pending tx awareness */
  transactionStore?: TransactionStoreInterface;
  /** Auto-refresh interval (ms), 0 to disable */
  refreshInterval?: number;
  /** Include pending transactions in balance */
  includePending?: boolean;
  /** Custom currency formatter */
  formatCurrency?: (amount: number, currency: string, decimals: number) => string;
  /** Debug logging */
  debug?: boolean;
  /** Days threshold for "expiring soon" */
  expiringWithinDays?: number;
}

/**
 * Internal config with defaults applied
 */
interface InternalConfig {
  voucherStore: VoucherStoreInterface;
  transactionStore?: TransactionStoreInterface;
  refreshInterval: number;
  includePending: boolean;
  formatCurrency: (amount: number, currency: string, decimals: number) => string;
  debug: boolean;
  expiringWithinDays: number;
}

/**
 * Balance Manager
 *
 * Manages wallet balance with real-time updates from VoucherStore.
 */
export class BalanceManager extends TypedEventEmitter<BalanceEventMap> {
  private config: InternalConfig;
  private voucherStore: VoucherStoreInterface;
  private transactionStore?: TransactionStoreInterface;
  private initialized = false;
  private cachedBalance: WalletBalance | null = null;
  private lastCalculated = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(config: BalanceManagerConfig) {
    super();

    this.voucherStore = config.voucherStore;
    this.transactionStore = config.transactionStore;

    this.config = {
      voucherStore: config.voucherStore,
      transactionStore: config.transactionStore,
      refreshInterval: config.refreshInterval ?? 0,
      includePending: config.includePending ?? false,
      formatCurrency: config.formatCurrency ?? CurrencyAggregator.format.bind(CurrencyAggregator),
      debug: config.debug ?? false,
      expiringWithinDays: config.expiringWithinDays ?? 7,
    };
  }

  /**
   * Initialize the manager
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.log('Initializing...');

    // Subscribe to voucher store events
    this.subscribeToVoucherStore();

    // Subscribe to transaction store events if available
    if (this.transactionStore?.on) {
      this.subscribeToTransactionStore();
    }

    // Calculate initial balance
    await this.refresh();

    // Setup auto-refresh if configured
    if (this.config.refreshInterval > 0) {
      this.refreshTimer = setInterval(() => {
        this.refresh().catch((err) => {
          this.emit('balance:error', {
            error: err,
            operation: 'auto-refresh',
          });
        });
      }, this.config.refreshInterval);
    }

    this.initialized = true;
    this.log('Initialized');
  }

  /**
   * Close and cleanup
   */
  async close(): Promise<void> {
    this.log('Closing...');

    // Clear refresh timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Unsubscribe from all events
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Clear cache
    this.cachedBalance = null;
    this.lastCalculated = 0;
    this.initialized = false;

    // Remove all listeners
    this.removeAllListeners();

    this.log('Closed');
  }

  // ==========================================
  // Core Balance Methods
  // ==========================================

  /**
   * Get current wallet balance
   */
  async getBalance(options?: BalanceCalculationOptions): Promise<WalletBalance> {
    // If no options and we have a recent cache, use it
    if (!options && this.cachedBalance && !this.isStale()) {
      return this.cachedBalance;
    }

    const vouchers = await this.voucherStore.getAll();
    let balance = BalanceCalculator.calculateTotal(vouchers, options);

    // Subtract pending outgoing if configured
    if (this.config.includePending && this.transactionStore?.getPending) {
      balance = await this.subtractPendingTransactions(balance);
    }

    // Cache if no options (default query)
    if (!options) {
      this.cachedBalance = balance;
      this.lastCalculated = Date.now();
    }

    return balance;
  }

  /**
   * Get full balance breakdown
   */
  async getBalanceBreakdown(): Promise<BalanceBreakdown> {
    const vouchers = await this.voucherStore.getAll();
    return BalanceCalculator.calculateBreakdown(
      vouchers,
      {},
      this.config.expiringWithinDays
    );
  }

  /**
   * Get balance for specific currency
   */
  async getBalanceByCurrency(currency: string): Promise<CurrencyBalance | null> {
    const vouchers = await this.voucherStore.getAll();
    return BalanceCalculator.calculateForCurrency(vouchers, currency);
  }

  /**
   * Get balance for specific issuer
   */
  async getBalanceByIssuer(issuerId: string): Promise<IssuerBalance | null> {
    const vouchers = await this.voucherStore.getAll();
    const issuerBalances = BalanceCalculator.calculateByIssuer(vouchers, {
      issuerId,
    });
    return issuerBalances.length > 0 ? issuerBalances[0] : null;
  }

  // ==========================================
  // Grouped Views
  // ==========================================

  /**
   * Get balances grouped by issuer
   */
  async getIssuerBalances(): Promise<IssuerBalance[]> {
    const vouchers = await this.voucherStore.getAll();
    return BalanceCalculator.calculateByIssuer(vouchers);
  }

  /**
   * Get balances grouped by currency
   */
  async getCurrencyBalances(): Promise<CurrencyBalance[]> {
    const balance = await this.getBalance();
    return Object.values(balance.currencies);
  }

  /**
   * Get top N issuers by balance
   */
  async getTopIssuers(limit: number = 3): Promise<IssuerBalance[]> {
    const issuers = await this.getIssuerBalances();
    return issuers.slice(0, limit);
  }

  // ==========================================
  // Selection
  // ==========================================

  /**
   * Select vouchers for a payment amount
   */
  async selectVouchersForAmount(request: SelectionRequest): Promise<SelectionResult> {
    const vouchers = await this.voucherStore.getAll();
    return SelectionOptimizer.selectForAmount(vouchers as SelectableVoucher[], request);
  }

  /**
   * Get total available for a currency
   */
  async getAvailableForCurrency(currency: string): Promise<number> {
    const vouchers = await this.voucherStore.getAll();
    return SelectionOptimizer.getTotalAvailable(vouchers as SelectableVoucher[], currency);
  }

  // ==========================================
  // Refresh
  // ==========================================

  /**
   * Refresh balance from store
   */
  async refresh(): Promise<WalletBalance> {
    this.emit('balance:refreshing', { timestamp: Date.now() });
    const startTime = Date.now();

    const previous = this.cachedBalance;
    const vouchers = await this.voucherStore.getAll();
    let balance = BalanceCalculator.calculateTotal(vouchers);

    // Subtract pending if configured
    if (this.config.includePending && this.transactionStore?.getPending) {
      balance = await this.subtractPendingTransactions(balance);
    }

    this.cachedBalance = balance;
    this.lastCalculated = Date.now();

    const duration = Date.now() - startTime;
    this.emit('balance:refreshed', { balance, duration });

    // Emit update if balance changed
    if (!previous || !BalanceCalculator.equals(previous, balance)) {
      this.emitBalanceUpdate(previous, balance, 'refresh');
    }

    return balance;
  }

  // ==========================================
  // Status
  // ==========================================

  /**
   * Get last calculation timestamp
   */
  getLastCalculated(): number {
    return this.lastCalculated;
  }

  /**
   * Check if cached balance is stale
   */
  isStale(maxAge: number = 30000): boolean {
    if (!this.cachedBalance) return true;
    return Date.now() - this.lastCalculated > maxAge;
  }

  /**
   * Check if manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ==========================================
  // Private Methods
  // ==========================================

  /**
   * Subscribe to voucher store events
   */
  private subscribeToVoucherStore(): void {
    const events = [
      'voucher:added',
      'voucher:updated',
      'voucher:removed',
      'voucher:expired',
      'voucher:spent',
    ];

    for (const event of events) {
      const unsub = this.voucherStore.on(event, () => {
        this.handleVoucherEvent(event as BalanceUpdateTrigger);
      });
      this.unsubscribers.push(unsub);
    }
  }

  /**
   * Subscribe to transaction store events
   */
  private subscribeToTransactionStore(): void {
    if (!this.transactionStore?.on) return;

    const unsub = this.transactionStore.on('transaction:added', () => {
      this.handleTransactionEvent();
    });
    this.unsubscribers.push(unsub);
  }

  /**
   * Handle voucher store event
   */
  private async handleVoucherEvent(trigger: BalanceUpdateTrigger): Promise<void> {
    this.log('Voucher event:', trigger);

    try {
      const previous = this.cachedBalance;
      const balance = await this.refresh();

      // Detect currency-level changes
      if (previous) {
        this.detectCurrencyChanges(previous, balance);
      }
    } catch (error) {
      this.emit('balance:error', {
        error: error as Error,
        operation: 'voucher-event-handler',
        context: { trigger },
      });
    }
  }

  /**
   * Handle transaction store event
   */
  private async handleTransactionEvent(): Promise<void> {
    this.log('Transaction event');

    try {
      await this.refresh();
    } catch (error) {
      this.emit('balance:error', {
        error: error as Error,
        operation: 'transaction-event-handler',
      });
    }
  }

  /**
   * Subtract pending outgoing transactions from balance
   */
  private async subtractPendingTransactions(balance: WalletBalance): Promise<WalletBalance> {
    if (!this.transactionStore?.getPending) {
      return balance;
    }

    const pending = await this.transactionStore.getPending();
    let result = balance;

    for (const tx of pending) {
      if (tx.direction === 'out') {
        result = BalanceCalculator.subtractFromBalance(result, tx.currency, tx.amount);
      }
    }

    result.includesPending = true;
    return result;
  }

  /**
   * Detect and emit currency-level changes
   */
  private detectCurrencyChanges(previous: WalletBalance, current: WalletBalance): void {
    const allCurrencies = new Set([
      ...Object.keys(previous.currencies),
      ...Object.keys(current.currencies),
    ]);

    for (const currency of allCurrencies) {
      const prev = previous.currencies[currency] ?? null;
      const curr = current.currencies[currency] ?? null;

      const prevAmount = prev?.amount ?? 0;
      const currAmount = curr?.amount ?? 0;

      if (prevAmount !== currAmount) {
        this.emit('balance:currency-changed', {
          currency,
          previous: prev,
          current: curr,
          difference: currAmount - prevAmount,
        });
      }
    }
  }

  /**
   * Emit balance update event
   */
  private emitBalanceUpdate(
    previous: WalletBalance | null,
    current: WalletBalance,
    trigger: BalanceUpdateTrigger
  ): void {
    this.emit('balance:updated', {
      previous,
      current,
      trigger,
      timestamp: Date.now(),
    });
  }

  /**
   * Debug logging
   */
  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[BalanceManager]', ...args);
    }
  }
}

/**
 * Create a BalanceManager instance
 */
export function createBalanceManager(config: BalanceManagerConfig): BalanceManager {
  return new BalanceManager(config);
}
