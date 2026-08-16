/**
 * Formatting utilities for transactions
 */

import type { Transaction } from '../types';

/**
 * Format a transaction amount with proper decimals
 */
export function formatAmount(
  value: number,
  decimals: number = 0,
  options?: Intl.NumberFormatOptions
): string {
  const divisor = Math.pow(10, decimals);
  const amount = value / divisor;

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    ...options,
  }).format(amount);
}

/**
 * Format a transaction amount with currency
 */
export function formatCurrency(
  value: number,
  unit: string,
  decimals: number = 0,
  locale: string = 'en-US'
): string {
  const divisor = Math.pow(10, decimals);
  const amount = value / divisor;

  // Handle special cases
  if (unit === 'SAT' || unit === 'sats') {
    return `${formatAmount(value, 0)} sats`;
  }

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: unit,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    // Fallback for unknown currencies
    return `${formatAmount(value, decimals)} ${unit}`;
  }
}

/**
 * Format a timestamp to a human-readable date/time
 */
export function formatTimestamp(
  timestamp: number,
  options?: Intl.DateTimeFormatOptions,
  locale: string = 'en-US'
): string {
  // Convert seconds to milliseconds if needed
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const date = new Date(ms);

  const defaultOptions: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };

  return new Intl.DateTimeFormat(locale, {
    ...defaultOptions,
    ...options,
  }).format(date);
}

/**
 * Format a timestamp to a relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(
  timestamp: number,
  locale: string = 'en-US'
): string {
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const now = Date.now();
  const diff = now - ms;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (years > 0) return rtf.format(-years, 'year');
  if (months > 0) return rtf.format(-months, 'month');
  if (weeks > 0) return rtf.format(-weeks, 'week');
  if (days > 0) return rtf.format(-days, 'day');
  if (hours > 0) return rtf.format(-hours, 'hour');
  if (minutes > 0) return rtf.format(-minutes, 'minute');
  return rtf.format(-seconds, 'second');
}

/**
 * Format a pubkey for display (truncated)
 */
export function formatPubkey(pubkey: string, prefixLen: number = 8, suffixLen: number = 4): string {
  if (!pubkey || pubkey.length <= prefixLen + suffixLen + 3) {
    return pubkey;
  }
  return `${pubkey.slice(0, prefixLen)}...${pubkey.slice(-suffixLen)}`;
}

/**
 * Get a display name for a transaction
 */
export function getTransactionDisplayName(tx: Transaction): string {
  // Use counterparty name if available
  if (tx.counterpartyName) {
    return tx.counterpartyName;
  }

  // Use issuer name if available
  if (tx.issuerName) {
    return tx.issuerName;
  }

  // Use truncated counterparty pubkey
  if (tx.counterparty) {
    return formatPubkey(tx.counterparty);
  }

  // Use truncated issuer pubkey
  if (tx.issuerId) {
    return formatPubkey(tx.issuerId);
  }

  // Fallback based on type
  return getTransactionTypeLabel(tx.type);
}

/**
 * Get a human-readable label for a transaction type
 */
export function getTransactionTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    voucher_received: 'Received',
    voucher_sent: 'Sent',
    voucher_purchased: 'Purchased',
    voucher_redeemed: 'Redeemed',
    voucher_split: 'Split',
    voucher_expired: 'Expired',
  };
  return labels[type] ?? type;
}

/**
 * Get a direction indicator for a transaction
 */
export function getDirectionIndicator(direction: string): string {
  switch (direction) {
    case 'in':
      return '+';
    case 'out':
      return '-';
    case 'internal':
      return '↔';
    default:
      return '';
  }
}

/**
 * Format a transaction for display as a single line
 */
export function formatTransactionLine(tx: Transaction): string {
  const indicator = getDirectionIndicator(tx.direction);
  const amount = formatCurrency(tx.faceValue, tx.faceUnit, tx.faceDecimals);
  const name = getTransactionDisplayName(tx);
  const time = formatRelativeTime(tx.timestamp);

  return `${indicator}${amount} ${name} (${time})`;
}

/**
 * Export transactions to CSV format
 */
export function exportToCSV(transactions: Transaction[], includeMetadata: boolean = false): string {
  const headers = [
    'id',
    'type',
    'direction',
    'tokenAmount',
    'faceValue',
    'faceUnit',
    'faceDecimals',
    'counterparty',
    'counterpartyName',
    'issuerId',
    'issuerName',
    'voucherId',
    'memo',
    'timestamp',
    'walletId',
    'mintUrl',
    'synced',
    'syncedAt',
    'eventId',
  ];

  if (includeMetadata) {
    headers.push('metadata');
  }

  const rows = transactions.map((tx) => {
    const values = headers.map((header) => {
      if (header === 'metadata') {
        return tx.metadata ? JSON.stringify(tx.metadata) : '';
      }
      const value = tx[header as keyof Transaction];
      if (value === undefined || value === null) {
        return '';
      }
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return String(value);
    });
    return values.join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Export transactions to JSON format
 */
export function exportToJSON(transactions: Transaction[], includeMetadata: boolean = true): string {
  if (!includeMetadata) {
    transactions = transactions.map((tx) => {
      const { metadata, ...rest } = tx;
      return rest as Transaction;
    });
  }
  return JSON.stringify(transactions, null, 2);
}
