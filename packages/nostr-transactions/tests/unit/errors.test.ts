/**
 * Tests for error classes
 */

import { describe, it, expect } from 'vitest';
import {
  TransactionError,
  StorageError,
  NotFoundError,
  ValidationError,
  QueryError,
  SyncError,
  SyncConflictError,
  ErrorCodes,
  isTransactionError,
  isErrorCode,
  isRetryableError,
} from '../../src';

describe('Error Classes', () => {
  describe('TransactionError', () => {
    it('should create error with message and code', () => {
      const error = new TransactionError('Test error', 'TEST_CODE');

      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('TransactionError');
    });

    it('should include cause', () => {
      const cause = new Error('Original error');
      const error = new TransactionError('Wrapped error', 'WRAPPED', cause);

      expect(error.cause).toBe(cause);
    });

    it('should be instanceof Error', () => {
      const error = new TransactionError('Test', 'CODE');
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('StorageError', () => {
    it('should create storage error', () => {
      const error = new StorageError('Storage failed');

      expect(error.name).toBe('StorageError');
      expect(error.code).toBe(ErrorCodes.STORAGE_WRITE_FAILED);
    });

    it('should accept custom code', () => {
      const error = new StorageError('Read failed', ErrorCodes.STORAGE_READ_FAILED);
      expect(error.code).toBe(ErrorCodes.STORAGE_READ_FAILED);
    });
  });

  describe('NotFoundError', () => {
    it('should create not found error with ID', () => {
      const error = new NotFoundError('tx-123');

      expect(error.name).toBe('NotFoundError');
      expect(error.code).toBe(ErrorCodes.TRANSACTION_NOT_FOUND);
      expect(error.transactionId).toBe('tx-123');
      expect(error.message).toContain('tx-123');
    });
  });

  describe('ValidationError', () => {
    it('should create validation error', () => {
      const error = new ValidationError('Invalid amount', 'amount', -100);

      expect(error.name).toBe('ValidationError');
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.field).toBe('amount');
      expect(error.value).toBe(-100);
    });
  });

  describe('QueryError', () => {
    it('should create query error with filter', () => {
      const filter = { type: 'invalid' };
      const error = new QueryError('Invalid filter', filter);

      expect(error.name).toBe('QueryError');
      expect(error.code).toBe(ErrorCodes.QUERY_FAILED);
      expect(error.filter).toEqual(filter);
    });
  });

  describe('SyncError', () => {
    it('should create sync error with direction', () => {
      const error = new SyncError('Sync failed', 'push');

      expect(error.name).toBe('SyncError');
      expect(error.code).toBe(ErrorCodes.SYNC_FAILED);
      expect(error.direction).toBe('push');
    });
  });

  describe('SyncConflictError', () => {
    it('should create conflict error with transactions', () => {
      const local = { id: '1', timestamp: 100 };
      const remote = { id: '1', timestamp: 200 };
      const error = new SyncConflictError('Conflict detected', local, remote);

      expect(error.name).toBe('SyncConflictError');
      expect(error.code).toBe(ErrorCodes.SYNC_CONFLICT);
      expect(error.localTransaction).toEqual(local);
      expect(error.remoteTransaction).toEqual(remote);
    });
  });

  describe('isTransactionError()', () => {
    it('should return true for TransactionError', () => {
      expect(isTransactionError(new TransactionError('Test', 'CODE'))).toBe(true);
    });

    it('should return true for subclasses', () => {
      expect(isTransactionError(new StorageError('Test'))).toBe(true);
      expect(isTransactionError(new NotFoundError('id'))).toBe(true);
      expect(isTransactionError(new ValidationError('Test'))).toBe(true);
    });

    it('should return false for regular Error', () => {
      expect(isTransactionError(new Error('Test'))).toBe(false);
    });

    it('should return false for non-errors', () => {
      expect(isTransactionError('error')).toBe(false);
      expect(isTransactionError(null)).toBe(false);
      expect(isTransactionError(undefined)).toBe(false);
    });
  });

  describe('isErrorCode()', () => {
    it('should return true for matching code', () => {
      const error = new NotFoundError('id');
      expect(isErrorCode(error, ErrorCodes.TRANSACTION_NOT_FOUND)).toBe(true);
    });

    it('should return false for non-matching code', () => {
      const error = new NotFoundError('id');
      expect(isErrorCode(error, ErrorCodes.VALIDATION_FAILED)).toBe(false);
    });

    it('should return false for non-TransactionError', () => {
      expect(isErrorCode(new Error('Test'), ErrorCodes.TRANSACTION_NOT_FOUND)).toBe(false);
    });
  });

  describe('isRetryableError()', () => {
    it('should return true for network errors', () => {
      const error = new TransactionError('Network failed', ErrorCodes.SYNC_NETWORK_ERROR);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for storage write errors', () => {
      const error = new StorageError('Write failed', ErrorCodes.STORAGE_WRITE_FAILED);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for storage read errors', () => {
      const error = new StorageError('Read failed', ErrorCodes.STORAGE_READ_FAILED);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for validation errors', () => {
      const error = new ValidationError('Invalid');
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for not found errors', () => {
      const error = new NotFoundError('id');
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for non-TransactionError', () => {
      expect(isRetryableError(new Error('Test'))).toBe(false);
    });
  });
});
