/**
 * Formatting utilities for vouchers
 */

import type { Voucher, ExportOptions, ExportResult } from '../types';
import { BackingStrategy, VoucherStatus, getDefaultDecimals } from '../types';

/**
 * Currency symbols
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CHF: 'CHF',
  CAD: 'C$',
  AUD: 'A$',
  XAF: 'FCFA',
  XOF: 'CFA',
  SAT: '₿',
  SATS: '₿',
  BTC: '₿',
};

/**
 * Currency symbol position
 */
export const CURRENCY_SYMBOL_AFTER: string[] = ['XAF', 'XOF'];

/**
 * Format an amount with currency
 */
export function formatAmount(amount: number, unit: string, decimals?: number): string {
  const dec = decimals ?? getDefaultDecimals(unit);
  const divisor = Math.pow(10, dec);
  const value = amount / divisor;

  // Format with locale
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });

  return formatted;
}

/**
 * Format an amount with currency symbol
 */
export function formatCurrency(amount: number, unit: string, decimals?: number): string {
  const formatted = formatAmount(amount, unit, decimals);
  const symbol = CURRENCY_SYMBOLS[unit.toUpperCase()] ?? unit;

  if (CURRENCY_SYMBOL_AFTER.includes(unit.toUpperCase())) {
    return `${formatted} ${symbol}`;
  }

  return `${symbol}${formatted}`;
}

/**
 * Format a timestamp
 */
export function formatTimestamp(timestamp: string | number): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp * 1000);

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format relative time (e.g., "2 days ago", "in 3 hours")
 */
export function formatRelativeTime(timestamp: string | number): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHour = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHour / 24);

  const isFuture = diffMs > 0;
  const abs = (n: number) => Math.abs(n);

  if (abs(diffSec) < 60) {
    return isFuture ? 'in a few seconds' : 'just now';
  }

  if (abs(diffMin) < 60) {
    const mins = abs(diffMin);
    return isFuture ? `in ${mins} minute${mins > 1 ? 's' : ''}` : `${mins} minute${mins > 1 ? 's' : ''} ago`;
  }

  if (abs(diffHour) < 24) {
    const hours = abs(diffHour);
    return isFuture ? `in ${hours} hour${hours > 1 ? 's' : ''}` : `${hours} hour${hours > 1 ? 's' : ''} ago`;
  }

  if (abs(diffDay) < 30) {
    const days = abs(diffDay);
    return isFuture ? `in ${days} day${days > 1 ? 's' : ''}` : `${days} day${days > 1 ? 's' : ''} ago`;
  }

  // Fall back to date
  return date.toLocaleDateString();
}

/**
 * Format expiry date
 */
export function formatExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return 'No expiry';

  const date = new Date(expiresAt);
  const now = new Date();

  if (date <= now) {
    return 'Expired';
  }

  // Check if within 7 days
  const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 7) {
    return `Expires in ${diffDays} day${diffDays > 1 ? 's' : ''}`;
  }

  // Show month and year
  return `Expires ${date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
}

/**
 * Format a pubkey (truncated)
 */
export function formatPubkey(pubkey: string, length: number = 8): string {
  if (!pubkey) return '';
  if (pubkey.length <= length * 2) return pubkey;
  return `${pubkey.slice(0, length)}...${pubkey.slice(-length)}`;
}

/**
 * Get voucher display info
 */
export interface VoucherDisplayInfo {
  /** Primary value display (e.g., "$50.00") */
  primary: string;
  /** Secondary info (e.g., "Backed by 1,000 ₿") */
  secondary?: string;
  /** Status badge */
  badge: string;
  /** Expiry info */
  expiry: string;
  /** Merchant name */
  merchant: string;
  /** Status text */
  status: string;
}

/**
 * Get display info for a voucher
 */
export function getVoucherDisplayInfo(voucher: Voucher): VoucherDisplayInfo {
  // Primary display - face value
  const primary =
    voucher.backingStrategy === BackingStrategy.LEGACY
      ? formatCurrency(voucher.tokenAmount, 'SAT', 0)
      : formatCurrency(voucher.faceValue, voucher.faceUnit, voucher.faceDecimals);

  // Secondary display - backing info for non-legacy
  let secondary: string | undefined;
  if (voucher.backingStrategy !== BackingStrategy.LEGACY) {
    secondary = `Backed by ${formatCurrency(voucher.tokenAmount, 'SAT', 0)} · ${voucher.backingStrategy}`;
  }

  // Badge
  const badge = voucher.backingStrategy;

  // Expiry
  const expiry = formatExpiry(voucher.expiresAt);

  // Merchant
  const merchant = voucher.issuerName ?? formatPubkey(voucher.issuerId ?? '', 8) ?? 'Unknown';

  // Status
  let status: string;
  switch (voucher.status) {
    case VoucherStatus.ACTIVE:
      status = 'Active';
      break;
    case VoucherStatus.SPENT:
      status = 'Spent';
      break;
    case VoucherStatus.EXPIRED:
      status = 'Expired';
      break;
    default:
      status = voucher.status;
  }

  return { primary, secondary, badge, expiry, merchant, status };
}

/**
 * Get status label
 */
export function getStatusLabel(status: VoucherStatus): string {
  switch (status) {
    case VoucherStatus.ACTIVE:
      return 'Active';
    case VoucherStatus.SPENT:
      return 'Spent';
    case VoucherStatus.EXPIRED:
      return 'Expired';
    default:
      return status;
  }
}

/**
 * Get backing strategy label
 */
export function getBackingStrategyLabel(strategy: BackingStrategy): string {
  switch (strategy) {
    case BackingStrategy.LEGACY:
      return 'Legacy';
    case BackingStrategy.MINIMAL:
      return 'Minimal Backing';
    case BackingStrategy.FULL:
      return 'Full Backing';
    default:
      return strategy;
  }
}

// ==========================================
// Export Functions
// ==========================================

/**
 * Export vouchers to CSV
 */
export function exportToCSV(vouchers: Voucher[], options?: Partial<ExportOptions>): string {
  const includeToken = options?.includeToken ?? false;

  // Default fields (excluding token for security)
  const defaultFields: (keyof Voucher)[] = [
    'id',
    'faceValue',
    'faceUnit',
    'faceDecimals',
    'tokenAmount',
    'backingStrategy',
    'status',
    'issuerId',
    'issuerName',
    'createdAt',
    'expiresAt',
    'memo',
  ];

  const fields = options?.fields ?? defaultFields;

  // Add token if explicitly requested
  const finalFields = includeToken && !fields.includes('token') ? ['token', ...fields] : fields;

  // Header row
  const header = finalFields.join(',');

  // Data rows
  const rows = vouchers.map((voucher) => {
    return finalFields
      .map((field) => {
        const value = (voucher as unknown as Record<string, unknown>)[field];
        if (value === undefined || value === null) return '';
        if (typeof value === 'string') {
          // Escape quotes and wrap in quotes
          return `"${value.replace(/"/g, '""')}"`;
        }
        if (typeof value === 'object') {
          return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
        }
        return String(value);
      })
      .join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Export vouchers to JSON
 */
export function exportToJSON(vouchers: Voucher[], options?: Partial<ExportOptions>): string {
  const includeToken = options?.includeToken ?? false;

  const exportData = vouchers.map((voucher) => {
    if (includeToken) {
      return voucher;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { token, ...rest } = voucher;
    return rest;
  });

  return JSON.stringify(exportData, null, 2);
}

/**
 * Export vouchers with full options
 */
export function exportVouchers(vouchers: Voucher[], options: ExportOptions): ExportResult {
  const format = options.format;
  const data = format === 'csv' ? exportToCSV(vouchers, options) : exportToJSON(vouchers, options);

  return {
    data,
    count: vouchers.length,
    format,
    timestamp: new Date().toISOString(),
  };
}
