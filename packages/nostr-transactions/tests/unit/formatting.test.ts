/**
 * Tests for formatting utilities
 */

import { describe, it, expect } from 'vitest';
import {
  formatAmount,
  formatCurrency,
  formatTimestamp,
  formatPubkey,
  getTransactionTypeLabel,
  getDirectionIndicator,
  exportToCSV,
  exportToJSON,
  TransactionType,
  TransactionDirection,
  type Transaction,
} from '../../src';

describe('Formatting Utilities', () => {
  describe('formatAmount()', () => {
    it('should format amount with no decimals', () => {
      expect(formatAmount(1000, 0)).toBe('1,000');
    });

    it('should format amount with 2 decimals', () => {
      expect(formatAmount(5000, 2)).toBe('50.00');
    });

    it('should format amount with custom options', () => {
      expect(
        formatAmount(1000000, 2, { useGrouping: false })
      ).toBe('10000.00');
    });
  });

  describe('formatCurrency()', () => {
    it('should format USD currency', () => {
      const result = formatCurrency(5000, 'USD', 2);
      expect(result).toContain('50.00');
      expect(result).toMatch(/\$|USD/);
    });

    it('should format EUR currency', () => {
      const result = formatCurrency(5000, 'EUR', 2);
      expect(result).toContain('50.00');
    });

    it('should handle SAT specially', () => {
      const result = formatCurrency(1000, 'SAT', 0);
      expect(result).toBe('1,000 sats');
    });

    it('should handle sats (lowercase)', () => {
      const result = formatCurrency(1000, 'sats', 0);
      expect(result).toBe('1,000 sats');
    });

    it('should handle XAF currency', () => {
      const result = formatCurrency(5000, 'XAF', 0);
      expect(result).toContain('5,000');
      // XAF is recognized as CFA Franc (FCFA)
      expect(result.includes('XAF') || result.includes('FCFA') || result.includes('CFA')).toBe(true);
    });
  });

  describe('formatTimestamp()', () => {
    it('should format timestamp in seconds', () => {
      const result = formatTimestamp(1704067200);
      expect(result).toContain('2024');
    });

    it('should format timestamp in milliseconds', () => {
      const result = formatTimestamp(1704067200000);
      expect(result).toContain('2024');
    });

    it('should use custom options', () => {
      const result = formatTimestamp(1704067200, { dateStyle: 'short' });
      expect(result).toBeDefined();
    });
  });

  describe('formatPubkey()', () => {
    it('should truncate long pubkey', () => {
      const pubkey = 'abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';
      const result = formatPubkey(pubkey);
      expect(result).toBe('abcd1234...1234');
    });

    it('should return short pubkey unchanged', () => {
      const pubkey = 'short';
      const result = formatPubkey(pubkey);
      expect(result).toBe('short');
    });

    it('should allow custom lengths', () => {
      const pubkey = 'abcd1234567890abcd1234567890';
      const result = formatPubkey(pubkey, 4, 2);
      expect(result).toBe('abcd...90');
    });
  });

  describe('getTransactionTypeLabel()', () => {
    it('should return label for received', () => {
      expect(getTransactionTypeLabel('voucher_received')).toBe('Received');
    });

    it('should return label for sent', () => {
      expect(getTransactionTypeLabel('voucher_sent')).toBe('Sent');
    });

    it('should return label for purchased', () => {
      expect(getTransactionTypeLabel('voucher_purchased')).toBe('Purchased');
    });

    it('should return original for unknown type', () => {
      expect(getTransactionTypeLabel('unknown_type')).toBe('unknown_type');
    });
  });

  describe('getDirectionIndicator()', () => {
    it('should return + for in', () => {
      expect(getDirectionIndicator('in')).toBe('+');
    });

    it('should return - for out', () => {
      expect(getDirectionIndicator('out')).toBe('-');
    });

    it('should return ↔ for internal', () => {
      expect(getDirectionIndicator('internal')).toBe('↔');
    });

    it('should return empty for unknown', () => {
      expect(getDirectionIndicator('unknown')).toBe('');
    });
  });

  describe('exportToCSV()', () => {
    it('should export transactions to CSV', () => {
      const transactions = [createTestTransaction()];
      const csv = exportToCSV(transactions);

      expect(csv).toContain('id,type,direction');
      expect(csv).toContain(TransactionType.RECEIVED);
      expect(csv).toContain(TransactionDirection.IN);
    });

    it('should escape commas in values', () => {
      const transactions = [
        createTestTransaction({ memo: 'Hello, world' }),
      ];
      const csv = exportToCSV(transactions);

      expect(csv).toContain('"Hello, world"');
    });

    it('should escape quotes in values', () => {
      const transactions = [
        createTestTransaction({ memo: 'Say "hello"' }),
      ];
      const csv = exportToCSV(transactions);

      expect(csv).toContain('"Say ""hello"""');
    });

    it('should include metadata when requested', () => {
      const transactions = [
        createTestTransaction({ metadata: { custom: 'value' } }),
      ];
      const csv = exportToCSV(transactions, true);

      expect(csv).toContain('metadata');
      expect(csv).toContain('custom');
    });
  });

  describe('exportToJSON()', () => {
    it('should export transactions to JSON', () => {
      const transactions = [createTestTransaction()];
      const json = exportToJSON(transactions);
      const parsed = JSON.parse(json);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe(TransactionType.RECEIVED);
    });

    it('should exclude metadata when requested', () => {
      const transactions = [
        createTestTransaction({ metadata: { custom: 'value' } }),
      ];
      const json = exportToJSON(transactions, false);
      const parsed = JSON.parse(json);

      expect(parsed[0].metadata).toBeUndefined();
    });

    it('should include metadata by default', () => {
      const transactions = [
        createTestTransaction({ metadata: { custom: 'value' } }),
      ];
      const json = exportToJSON(transactions);
      const parsed = JSON.parse(json);

      expect(parsed[0].metadata).toEqual({ custom: 'value' });
    });
  });
});

// Helper function
function createTestTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-123',
    type: TransactionType.RECEIVED,
    direction: TransactionDirection.IN,
    tokenAmount: 1000,
    faceValue: 5000,
    faceUnit: 'USD',
    faceDecimals: 2,
    counterparty: 'alice-pubkey',
    counterpartyName: 'Alice',
    timestamp: 1704067200,
    synced: false,
    ...overrides,
  };
}
