import { describe, it, expect } from 'vitest';
import {
  validatePubkey,
  isValidPubkey,
  validateNip05,
  isValidNip05,
  normalizePubkey,
  validateLocation,
} from '../../src/utils/validate.js';
import { ProfileError, ProfileErrorCode } from '../../src/types/errors.js';

describe('validatePubkey', () => {
  const validPubkey = 'a'.repeat(64);

  it('should accept valid 64-char hex pubkey', () => {
    expect(() => validatePubkey(validPubkey)).not.toThrow();
  });

  it('should accept lowercase hex', () => {
    expect(() => validatePubkey('abcdef1234567890'.repeat(4))).not.toThrow();
  });

  it('should accept uppercase hex', () => {
    expect(() => validatePubkey('ABCDEF1234567890'.repeat(4))).not.toThrow();
  });

  it('should accept mixed case hex', () => {
    expect(() => validatePubkey('AbCdEf1234567890'.repeat(4))).not.toThrow();
  });

  it('should reject empty string', () => {
    expect(() => validatePubkey('')).toThrow(ProfileError);
  });

  it('should reject null/undefined', () => {
    expect(() => validatePubkey(null as unknown as string)).toThrow(ProfileError);
    expect(() => validatePubkey(undefined as unknown as string)).toThrow(ProfileError);
  });

  it('should reject pubkey with wrong length', () => {
    expect(() => validatePubkey('a'.repeat(63))).toThrow(ProfileError);
    expect(() => validatePubkey('a'.repeat(65))).toThrow(ProfileError);
  });

  it('should reject non-hex characters', () => {
    expect(() => validatePubkey('g'.repeat(64))).toThrow(ProfileError);
    expect(() => validatePubkey('!' + 'a'.repeat(63))).toThrow(ProfileError);
  });

  it('should have INVALID_PUBKEY error code', () => {
    try {
      validatePubkey('invalid');
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileError);
      expect((error as ProfileError).code).toBe(ProfileErrorCode.INVALID_PUBKEY);
    }
  });
});

describe('isValidPubkey', () => {
  it('should return true for valid pubkey', () => {
    expect(isValidPubkey('a'.repeat(64))).toBe(true);
  });

  it('should return false for invalid pubkey', () => {
    expect(isValidPubkey('')).toBe(false);
    expect(isValidPubkey('invalid')).toBe(false);
    expect(isValidPubkey('a'.repeat(63))).toBe(false);
  });
});

describe('normalizePubkey', () => {
  it('should lowercase pubkey', () => {
    const input = 'ABCDEF1234567890'.repeat(4);
    const expected = 'abcdef1234567890'.repeat(4);
    expect(normalizePubkey(input)).toBe(expected);
  });

  it('should throw for invalid pubkey', () => {
    expect(() => normalizePubkey('invalid')).toThrow(ProfileError);
  });
});

describe('validateNip05', () => {
  it('should accept valid NIP-05 identifier', () => {
    expect(() => validateNip05('user@domain.com')).not.toThrow();
    expect(() => validateNip05('alice@nostr.example.org')).not.toThrow();
    expect(() => validateNip05('_@example.com')).not.toThrow();
  });

  it('should reject empty string', () => {
    expect(() => validateNip05('')).toThrow(ProfileError);
  });

  it('should reject identifier without @', () => {
    expect(() => validateNip05('userdomain.com')).toThrow(ProfileError);
  });

  it('should reject identifier with multiple @', () => {
    expect(() => validateNip05('user@domain@com')).toThrow(ProfileError);
  });

  it('should reject empty name part', () => {
    expect(() => validateNip05('@domain.com')).toThrow(ProfileError);
  });

  it('should reject empty domain part', () => {
    expect(() => validateNip05('user@')).toThrow(ProfileError);
  });

  it('should reject invalid domain', () => {
    expect(() => validateNip05('user@notadomain')).toThrow(ProfileError);
    expect(() => validateNip05('user@-invalid.com')).toThrow(ProfileError);
  });

  it('should have VALIDATION_ERROR error code', () => {
    try {
      validateNip05('invalid');
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileError);
      expect((error as ProfileError).code).toBe(ProfileErrorCode.VALIDATION_ERROR);
    }
  });
});

describe('isValidNip05', () => {
  it('should return true for valid NIP-05', () => {
    expect(isValidNip05('user@domain.com')).toBe(true);
  });

  it('should return false for invalid NIP-05', () => {
    expect(isValidNip05('')).toBe(false);
    expect(isValidNip05('invalid')).toBe(false);
    expect(isValidNip05('user@')).toBe(false);
  });
});

describe('validateLocation', () => {
  it('should accept valid coordinates', () => {
    expect(() => validateLocation(0, 0)).not.toThrow();
    expect(() => validateLocation(45.5, -122.6)).not.toThrow();
    expect(() => validateLocation(-90, -180)).not.toThrow();
    expect(() => validateLocation(90, 180)).not.toThrow();
  });

  it('should reject latitude out of range', () => {
    expect(() => validateLocation(-91, 0)).toThrow(ProfileError);
    expect(() => validateLocation(91, 0)).toThrow(ProfileError);
  });

  it('should reject longitude out of range', () => {
    expect(() => validateLocation(0, -181)).toThrow(ProfileError);
    expect(() => validateLocation(0, 181)).toThrow(ProfileError);
  });

  it('should reject NaN values', () => {
    expect(() => validateLocation(NaN, 0)).toThrow(ProfileError);
    expect(() => validateLocation(0, NaN)).toThrow(ProfileError);
  });

  it('should reject non-number values', () => {
    expect(() => validateLocation('45' as unknown as number, 0)).toThrow(ProfileError);
  });
});
