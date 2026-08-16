/**
 * Balance Types
 *
 * Core types for balance representation and calculation.
 */

/**
 * Currency configuration for formatting
 */
export interface CurrencyConfig {
  /** Currency code (EUR, USD, SAT) */
  code: string;
  /** Currency symbol */
  symbol: string;
  /** Decimal places */
  decimals: number;
  /** Symbol position in formatted output */
  symbolPosition: 'before' | 'after';
  /** Thousands separator */
  thousandsSeparator: string;
  /** Decimal separator */
  decimalSeparator: string;
}

/**
 * Balance amount with currency metadata
 */
export interface CurrencyBalance {
  /** Currency code (EUR, USD, SAT, XAF) */
  currency: string;
  /** Amount in minor units (cents, satoshis) */
  amount: number;
  /** Decimal places for display */
  decimals: number;
  /** Formatted display string */
  formatted: string;
  /** Number of vouchers contributing to this balance */
  voucherCount: number;
}

/**
 * Complete wallet balance snapshot
 */
export interface WalletBalance {
  /** Balance by currency code */
  currencies: Record<string, CurrencyBalance>;
  /** Total backing in satoshis (across all currencies) */
  totalSatsBacking: number;
  /** Primary currency (highest value or most vouchers) */
  primaryCurrency: string | null;
  /** Timestamp of calculation */
  calculatedAt: number;
  /** Whether balance includes pending transactions */
  includesPending: boolean;
}

/**
 * Balance grouped by issuer/merchant
 */
export interface IssuerBalance {
  /** Issuer ID (pubkey or merchant ID) */
  issuerId: string;
  /** Issuer display name */
  issuerName: string;
  /** Balances by currency for this issuer */
  currencies: Record<string, CurrencyBalance>;
  /** Total sats backing from this issuer */
  totalSatsBacking: number;
  /** Total voucher count from this issuer */
  voucherCount: number;
}

/**
 * Backing strategy enum (matches nostr-vouchers)
 */
export type BackingStrategy = 'LEGACY' | 'MINIMAL' | 'FULL';

/**
 * Balance grouped by backing strategy
 */
export interface StrategyBalance {
  /** Backing strategy */
  strategy: BackingStrategy;
  /** Balance for this strategy */
  balance: WalletBalance;
}

/**
 * Detailed balance breakdown
 */
export interface BalanceBreakdown {
  /** Total wallet balance */
  total: WalletBalance;
  /** Balance by issuer */
  byIssuer: IssuerBalance[];
  /** Balance by backing strategy */
  byStrategy: Record<BackingStrategy, WalletBalance>;
  /** Expiring soon (next 7 days) */
  expiringSoon: WalletBalance;
  /** Expiring within days */
  expiringWithinDays: number;
}

/**
 * Balance calculation options
 */
export interface BalanceCalculationOptions {
  /** Include only active vouchers (default: true) */
  activeOnly?: boolean;
  /** Exclude expired vouchers (default: true) */
  excludeExpired?: boolean;
  /** Filter by issuer ID */
  issuerId?: string;
  /** Filter by currency */
  currency?: string;
  /** Filter by backing strategy */
  backingStrategy?: BackingStrategy;
  /** Include expiring within N days */
  expiringWithinDays?: number;
}

/**
 * Empty balance constant
 */
export const EMPTY_WALLET_BALANCE: WalletBalance = {
  currencies: {},
  totalSatsBacking: 0,
  primaryCurrency: null,
  calculatedAt: 0,
  includesPending: false,
};

/**
 * Create an empty currency balance
 */
export function createEmptyCurrencyBalance(
  currency: string,
  decimals: number = 2
): CurrencyBalance {
  return {
    currency,
    amount: 0,
    decimals,
    formatted: '',
    voucherCount: 0,
  };
}
