import { describe, it, expect } from 'vitest';
import {
  ProfileError,
  ProfileErrorCode,
  networkError,
  relayTimeoutError,
  invalidPubkeyError,
  nip05ResolutionError,
  profileNotFoundError,
  cacheError,
  followSyncError,
  rateLimitError,
  validationError,
  storageError,
} from '../../src/types/errors.js';

describe('ProfileError', () => {
  it('should create error with code and message', () => {
    const error = new ProfileError(ProfileErrorCode.NETWORK_ERROR, 'Network failed');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProfileError);
    expect(error.name).toBe('ProfileError');
    expect(error.code).toBe(ProfileErrorCode.NETWORK_ERROR);
    expect(error.message).toBe('Network failed');
  });

  it('should include cause when provided', () => {
    const cause = new Error('Original error');
    const error = new ProfileError(ProfileErrorCode.NETWORK_ERROR, 'Network failed', { cause });

    expect(error.cause).toBe(cause);
  });

  it('should set retryable based on error code by default', () => {
    const retryableError = new ProfileError(ProfileErrorCode.NETWORK_ERROR, 'Network failed');
    const nonRetryableError = new ProfileError(ProfileErrorCode.INVALID_PUBKEY, 'Invalid pubkey');

    expect(retryableError.retryable).toBe(true);
    expect(nonRetryableError.retryable).toBe(false);
  });

  it('should allow override of retryable', () => {
    const error = new ProfileError(ProfileErrorCode.NETWORK_ERROR, 'Network failed', {
      retryable: false,
    });

    expect(error.retryable).toBe(false);
  });
});

describe('Error factory functions', () => {
  describe('networkError', () => {
    it('should create network error', () => {
      const error = networkError('Connection refused');

      expect(error.code).toBe(ProfileErrorCode.NETWORK_ERROR);
      expect(error.message).toBe('Connection refused');
      expect(error.retryable).toBe(true);
    });

    it('should include cause', () => {
      const cause = new Error('Original');
      const error = networkError('Connection refused', cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe('relayTimeoutError', () => {
    it('should create relay timeout error', () => {
      const error = relayTimeoutError('wss://relay.example.com');

      expect(error.code).toBe(ProfileErrorCode.RELAY_TIMEOUT);
      expect(error.message).toContain('wss://relay.example.com');
      expect(error.retryable).toBe(true);
    });
  });

  describe('invalidPubkeyError', () => {
    it('should create invalid pubkey error', () => {
      const error = invalidPubkeyError('not-a-pubkey');

      expect(error.code).toBe(ProfileErrorCode.INVALID_PUBKEY);
      expect(error.message).toContain('not-a-pubkey');
      expect(error.retryable).toBe(false);
    });
  });

  describe('nip05ResolutionError', () => {
    it('should create NIP-05 resolution error', () => {
      const error = nip05ResolutionError('user@example.com');

      expect(error.code).toBe(ProfileErrorCode.NIP05_RESOLUTION_FAILED);
      expect(error.message).toContain('user@example.com');
      expect(error.retryable).toBe(true);
    });
  });

  describe('profileNotFoundError', () => {
    it('should create profile not found error', () => {
      const pubkey = 'a'.repeat(64);
      const error = profileNotFoundError(pubkey);

      expect(error.code).toBe(ProfileErrorCode.PROFILE_NOT_FOUND);
      expect(error.message).toContain(pubkey);
      expect(error.retryable).toBe(false);
    });
  });

  describe('cacheError', () => {
    it('should create cache error', () => {
      const error = cacheError('Cache corrupted');

      expect(error.code).toBe(ProfileErrorCode.CACHE_ERROR);
      expect(error.message).toBe('Cache corrupted');
      expect(error.retryable).toBe(false);
    });
  });

  describe('followSyncError', () => {
    it('should create follow sync error', () => {
      const error = followSyncError('Sync failed');

      expect(error.code).toBe(ProfileErrorCode.FOLLOW_SYNC_FAILED);
      expect(error.message).toBe('Sync failed');
      expect(error.retryable).toBe(true);
    });
  });

  describe('rateLimitError', () => {
    it('should create rate limit error without retry time', () => {
      const error = rateLimitError();

      expect(error.code).toBe(ProfileErrorCode.RATE_LIMITED);
      expect(error.message).toBe('Rate limited');
      expect(error.retryable).toBe(true);
    });

    it('should create rate limit error with retry time', () => {
      const error = rateLimitError(5000);

      expect(error.message).toContain('5000');
    });
  });

  describe('validationError', () => {
    it('should create validation error', () => {
      const error = validationError('Invalid input');

      expect(error.code).toBe(ProfileErrorCode.VALIDATION_ERROR);
      expect(error.message).toBe('Invalid input');
      expect(error.retryable).toBe(false);
    });
  });

  describe('storageError', () => {
    it('should create storage error', () => {
      const error = storageError('IndexedDB unavailable');

      expect(error.code).toBe(ProfileErrorCode.STORAGE_ERROR);
      expect(error.message).toBe('IndexedDB unavailable');
      expect(error.retryable).toBe(false);
    });
  });
});

describe('Error code retryable defaults', () => {
  const retryableCodes = [
    ProfileErrorCode.NETWORK_ERROR,
    ProfileErrorCode.RELAY_TIMEOUT,
    ProfileErrorCode.RATE_LIMITED,
  ];

  const nonRetryableCodes = [
    ProfileErrorCode.INVALID_PUBKEY,
    ProfileErrorCode.PROFILE_NOT_FOUND,
    ProfileErrorCode.VALIDATION_ERROR,
    ProfileErrorCode.CACHE_ERROR,
    ProfileErrorCode.STORAGE_ERROR,
  ];

  retryableCodes.forEach((code) => {
    it(`should mark ${code} as retryable by default`, () => {
      const error = new ProfileError(code, 'Test');
      expect(error.retryable).toBe(true);
    });
  });

  nonRetryableCodes.forEach((code) => {
    it(`should mark ${code} as non-retryable by default`, () => {
      const error = new ProfileError(code, 'Test');
      expect(error.retryable).toBe(false);
    });
  });
});
