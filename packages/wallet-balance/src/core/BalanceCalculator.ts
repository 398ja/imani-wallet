/**
 * BalanceCalculator
 *
 * Pure calculation functions for balance computation.
 * No side effects, fully testable.
 */

import type {
  WalletBalance,
  CurrencyBalance,
  IssuerBalance,
  BalanceBreakdown,
  BalanceCalculationOptions,
  BackingStrategy,
} from '../types';
import { CurrencyAggregator } from './CurrencyAggregator';

/**
 * Voucher interface for balance calculation
 * (compatible with @imani/nostr-vouchers Voucher type)
 */
export interface BalanceVoucher {
  id: string;
  faceValue: number;
  faceUnit: string;
  faceDecimals: number;
  tokenAmount: number;
  tokenUnit?: string;
  status: string;
  expiresAt?: string;
  issuerId?: string;
  issuerName?: string;
  backingStrategy?: string;
  issuanceRatio?: number;
}

/**
 * Check if a voucher is active
 */
function isActive(voucher: BalanceVoucher): boolean {
  return voucher.status === 'active';
}

/**
 * Check if a voucher is expired
 */
function isExpired(voucher: BalanceVoucher): boolean {
  if (!voucher.expiresAt) {
    return false;
  }
  try {
    const expiryDate = new Date(voucher.expiresAt);
    return expiryDate.getTime() < Date.now();
  } catch {
    return false;
  }
}

/**
 * Check if a voucher expires within N days
 */
function expiresWithinDays(voucher: BalanceVoucher, days: number): boolean {
  if (!voucher.expiresAt) {
    return false;
  }
  try {
    const expiryDate = new Date(voucher.expiresAt);
    const cutoff = Date.now() + days * 24 * 60 * 60 * 1000;
    return expiryDate.getTime() <= cutoff && expiryDate.getTime() > Date.now();
  } catch {
    return false;
  }
}

/**
 * Check if a voucher has value
 */
function hasValue(voucher: BalanceVoucher): boolean {
  return (
    (voucher.faceValue ?? 0) > 0 ||
    (voucher.tokenAmount ?? 0) > 0
  );
}

/**
 * Filter vouchers based on options
 */
function filterVouchers(
  vouchers: BalanceVoucher[],
  options: BalanceCalculationOptions = {}
): BalanceVoucher[] {
  const {
    activeOnly = true,
    excludeExpired = true,
    issuerId,
    currency,
    backingStrategy,
    expiringWithinDays,
  } = options;

  return vouchers.filter((v) => {
    // Must have value
    if (!hasValue(v)) return false;

    // Active only
    if (activeOnly && !isActive(v)) return false;

    // Exclude expired
    if (excludeExpired && isExpired(v)) return false;

    // Filter by issuer
    if (issuerId && v.issuerId !== issuerId) return false;

    // Filter by currency
    if (currency && v.faceUnit?.toUpperCase() !== currency.toUpperCase()) return false;

    // Filter by backing strategy
    if (backingStrategy && v.backingStrategy !== backingStrategy) return false;

    // Filter by expiring within days
    if (expiringWithinDays !== undefined) {
      if (!expiresWithinDays(v, expiringWithinDays)) return false;
    }

    return true;
  });
}

/**
 * Pure balance calculation utilities
 */
export class BalanceCalculator {
  /**
   * Calculate total balance from vouchers
   */
  static calculateTotal(
    vouchers: BalanceVoucher[],
    options: BalanceCalculationOptions = {}
  ): WalletBalance {
    const filtered = filterVouchers(vouchers, options);

    if (filtered.length === 0) {
      return {
        currencies: {},
        totalSatsBacking: 0,
        primaryCurrency: null,
        calculatedAt: Date.now(),
        includesPending: false,
      };
    }

    // Aggregate by currency.
    // Feature 007-fix-voucher-currency: never silently default to 'SAT'.
    // Null / empty / whitespace face_unit → 'UNKNOWN' sentinel, its own tile.
    const currencyMap = new Map<string, { amount: number; decimals: number; count: number }>();
    let totalSatsBacking = 0;

    for (const voucher of filtered) {
      const raw = voucher.faceUnit;
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      const currency = trimmed.length === 0 ? 'UNKNOWN' : trimmed.toUpperCase();
      const decimals = voucher.faceDecimals ?? 0;
      const amount = voucher.faceValue ?? voucher.tokenAmount ?? 0;

      // Sum face values by currency
      const existing = currencyMap.get(currency);
      if (existing) {
        existing.amount += amount;
        existing.count++;
        if (decimals > existing.decimals) {
          existing.decimals = decimals;
        }
      } else {
        currencyMap.set(currency, { amount, decimals, count: 1 });
      }

      // Sum sats backing
      totalSatsBacking += voucher.tokenAmount ?? 0;
    }

    // Build currencies record
    const currencies: Record<string, CurrencyBalance> = {};
    for (const [currency, data] of currencyMap) {
      currencies[currency] = CurrencyAggregator.createBalance(
        currency,
        data.amount,
        data.count,
        data.decimals
      );
    }

    // Find primary currency
    const balanceArray = Object.values(currencies);
    const primaryCurrency = CurrencyAggregator.findPrimary(balanceArray);

    return {
      currencies,
      totalSatsBacking,
      primaryCurrency,
      calculatedAt: Date.now(),
      includesPending: false,
    };
  }

  /**
   * Calculate balance for specific currency
   */
  static calculateForCurrency(
    vouchers: BalanceVoucher[],
    currency: string,
    options: BalanceCalculationOptions = {}
  ): CurrencyBalance | null {
    const filtered = filterVouchers(vouchers, {
      ...options,
      currency,
    });

    if (filtered.length === 0) {
      return null;
    }

    let totalAmount = 0;
    let maxDecimals = 0;

    for (const voucher of filtered) {
      totalAmount += voucher.faceValue ?? voucher.tokenAmount ?? 0;
      const decimals = voucher.faceDecimals ?? 0;
      if (decimals > maxDecimals) {
        maxDecimals = decimals;
      }
    }

    return CurrencyAggregator.createBalance(
      currency,
      totalAmount,
      filtered.length,
      maxDecimals
    );
  }

  /**
   * Calculate balance grouped by issuer
   */
  static calculateByIssuer(
    vouchers: BalanceVoucher[],
    options: BalanceCalculationOptions = {}
  ): IssuerBalance[] {
    const filtered = filterVouchers(vouchers, options);

    if (filtered.length === 0) {
      return [];
    }

    // Group by issuer
    const issuerMap = new Map<
      string,
      {
        name: string;
        currencies: Map<string, { amount: number; decimals: number; count: number }>;
        totalSats: number;
        totalCount: number;
      }
    >();

    for (const voucher of filtered) {
      const issuerId = voucher.issuerId || 'unknown';
      const issuerName = voucher.issuerName || 'Unknown';
      // See feature 007-fix-voucher-currency: UNKNOWN sentinel, never SAT default.
      const rawUnit = voucher.faceUnit;
      const trimmedUnit = typeof rawUnit === 'string' ? rawUnit.trim() : '';
      const currency = trimmedUnit.length === 0 ? 'UNKNOWN' : trimmedUnit.toUpperCase();
      const decimals = voucher.faceDecimals ?? 0;
      const amount = voucher.faceValue ?? voucher.tokenAmount ?? 0;

      let issuer = issuerMap.get(issuerId);
      if (!issuer) {
        issuer = {
          name: issuerName,
          currencies: new Map(),
          totalSats: 0,
          totalCount: 0,
        };
        issuerMap.set(issuerId, issuer);
      }

      // Update issuer name if we have one
      if (voucher.issuerName && issuer.name === 'Unknown') {
        issuer.name = voucher.issuerName;
      }

      // Aggregate currency
      const currencyData = issuer.currencies.get(currency);
      if (currencyData) {
        currencyData.amount += amount;
        currencyData.count++;
        if (decimals > currencyData.decimals) {
          currencyData.decimals = decimals;
        }
      } else {
        issuer.currencies.set(currency, { amount, decimals, count: 1 });
      }

      issuer.totalSats += voucher.tokenAmount ?? 0;
      issuer.totalCount++;
    }

    // Convert to IssuerBalance array
    const result: IssuerBalance[] = [];
    for (const [issuerId, data] of issuerMap) {
      const currencies: Record<string, CurrencyBalance> = {};
      for (const [currency, currData] of data.currencies) {
        currencies[currency] = CurrencyAggregator.createBalance(
          currency,
          currData.amount,
          currData.count,
          currData.decimals
        );
      }

      result.push({
        issuerId,
        issuerName: data.name,
        currencies,
        totalSatsBacking: data.totalSats,
        voucherCount: data.totalCount,
      });
    }

    // Sort by total sats descending
    return result.sort((a, b) => b.totalSatsBacking - a.totalSatsBacking);
  }

  /**
   * Calculate balance grouped by backing strategy
   */
  static calculateByStrategy(
    vouchers: BalanceVoucher[],
    options: BalanceCalculationOptions = {}
  ): Record<BackingStrategy, WalletBalance> {
    const strategies: BackingStrategy[] = ['LEGACY', 'MINIMAL', 'FULL'];
    const result: Record<BackingStrategy, WalletBalance> = {} as Record<BackingStrategy, WalletBalance>;

    for (const strategy of strategies) {
      result[strategy] = this.calculateTotal(vouchers, {
        ...options,
        backingStrategy: strategy,
      });
    }

    return result;
  }

  /**
   * Calculate full balance breakdown
   */
  static calculateBreakdown(
    vouchers: BalanceVoucher[],
    options: BalanceCalculationOptions = {},
    expiringWithinDays: number = 7
  ): BalanceBreakdown {
    return {
      total: this.calculateTotal(vouchers, options),
      byIssuer: this.calculateByIssuer(vouchers, options),
      byStrategy: this.calculateByStrategy(vouchers, options),
      expiringSoon: this.calculateTotal(vouchers, {
        ...options,
        expiringWithinDays,
      }),
      expiringWithinDays,
    };
  }

  /**
   * Merge multiple wallet balances
   */
  static mergeBalances(...balances: WalletBalance[]): WalletBalance {
    if (balances.length === 0) {
      return {
        currencies: {},
        totalSatsBacking: 0,
        primaryCurrency: null,
        calculatedAt: Date.now(),
        includesPending: false,
      };
    }

    const currencyMap = new Map<string, CurrencyBalance>();
    let totalSatsBacking = 0;
    let includesPending = false;

    for (const balance of balances) {
      for (const [currency, currBalance] of Object.entries(balance.currencies)) {
        const existing = currencyMap.get(currency);
        if (existing) {
          currencyMap.set(currency, {
            currency,
            amount: existing.amount + currBalance.amount,
            decimals: Math.max(existing.decimals, currBalance.decimals),
            formatted: '', // Will update below
            voucherCount: existing.voucherCount + currBalance.voucherCount,
          });
        } else {
          currencyMap.set(currency, { ...currBalance });
        }
      }

      totalSatsBacking += balance.totalSatsBacking;
      if (balance.includesPending) includesPending = true;
    }

    // Update formatted strings
    const currencies: Record<string, CurrencyBalance> = {};
    for (const [currency, balance] of currencyMap) {
      currencies[currency] = {
        ...balance,
        formatted: CurrencyAggregator.format(balance.amount, currency, balance.decimals),
      };
    }

    const balanceArray = Object.values(currencies);
    const primaryCurrency = CurrencyAggregator.findPrimary(balanceArray);

    return {
      currencies,
      totalSatsBacking,
      primaryCurrency,
      calculatedAt: Date.now(),
      includesPending,
    };
  }

  /**
   * Subtract an amount from a wallet balance
   */
  static subtractFromBalance(
    balance: WalletBalance,
    currency: string,
    amount: number
  ): WalletBalance {
    const normalizedCurrency = currency.toUpperCase();
    const existing = balance.currencies[normalizedCurrency];

    if (!existing) {
      // Currency doesn't exist, return unchanged
      return balance;
    }

    const newAmount = Math.max(0, existing.amount - amount);
    const newCurrencies = { ...balance.currencies };

    if (newAmount === 0) {
      // Remove currency if zero
      delete newCurrencies[normalizedCurrency];
    } else {
      newCurrencies[normalizedCurrency] = {
        ...existing,
        amount: newAmount,
        formatted: CurrencyAggregator.format(newAmount, normalizedCurrency, existing.decimals),
      };
    }

    const balanceArray = Object.values(newCurrencies);
    const primaryCurrency = CurrencyAggregator.findPrimary(balanceArray);

    // Recalculate sats (approximate - proportional reduction)
    const ratio = existing.amount > 0 ? newAmount / existing.amount : 0;
    const satReduction = balance.totalSatsBacking * (1 - ratio) / Object.keys(balance.currencies).length;

    return {
      currencies: newCurrencies,
      totalSatsBacking: Math.max(0, balance.totalSatsBacking - satReduction),
      primaryCurrency,
      calculatedAt: Date.now(),
      includesPending: balance.includesPending,
    };
  }

  /**
   * Check if balance has any value
   */
  static hasBalance(balance: WalletBalance): boolean {
    return Object.values(balance.currencies).some((c) => c.amount > 0);
  }

  /**
   * Check if balance has specific currency
   */
  static hasCurrency(balance: WalletBalance, currency: string): boolean {
    const normalizedCurrency = currency.toUpperCase();
    const currBalance = balance.currencies[normalizedCurrency];
    return currBalance !== undefined && currBalance.amount > 0;
  }

  /**
   * Get balance amount for currency (0 if not present)
   */
  static getAmount(balance: WalletBalance, currency: string): number {
    const normalizedCurrency = currency.toUpperCase();
    return balance.currencies[normalizedCurrency]?.amount ?? 0;
  }

  /**
   * Compare two balances for equality
   */
  static equals(a: WalletBalance, b: WalletBalance): boolean {
    const currenciesA = Object.keys(a.currencies).sort();
    const currenciesB = Object.keys(b.currencies).sort();

    if (currenciesA.length !== currenciesB.length) {
      return false;
    }

    for (let i = 0; i < currenciesA.length; i++) {
      if (currenciesA[i] !== currenciesB[i]) {
        return false;
      }
      if (a.currencies[currenciesA[i]].amount !== b.currencies[currenciesB[i]].amount) {
        return false;
      }
    }

    return true;
  }
}
