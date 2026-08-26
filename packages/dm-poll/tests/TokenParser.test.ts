/**
 * Tests for TokenParser
 */

import { describe, it, expect } from 'vitest';
import {
  TokenParser,
  extractToken,
  hasToken,
  parseTokenTransferMessage,
  getTokenFingerprint,
  isValidToken,
  getTokenVersion,
} from '../src/processing/TokenParser';

describe('TokenParser', () => {
  describe('extractToken', () => {
    it('should extract cashuA token', () => {
      const content = 'Here is your token: cashuABCDEF123456789abcdef';
      const token = extractToken(content);
      expect(token).toBe('cashuABCDEF123456789abcdef');
    });

    it('should extract cashuB token', () => {
      const content = 'Here is your token: cashuBXYZ987654321fedcba';
      const token = extractToken(content);
      expect(token).toBe('cashuBXYZ987654321fedcba');
    });

    it('should prefer cashuB over cashuA when both present', () => {
      const content = 'cashuA111 and cashuB222';
      const token = extractToken(content);
      expect(token).toBe('cashuB222');
    });

    it('should return null when no token found', () => {
      const content = 'No token here';
      const token = extractToken(content);
      expect(token).toBeNull();
    });

    it('should handle token at start of content', () => {
      const content = 'cashuAtoken123 is the token';
      const token = extractToken(content);
      expect(token).toBe('cashuAtoken123');
    });

    it('should handle token at end of content', () => {
      const content = 'The token is cashuAtoken123';
      const token = extractToken(content);
      expect(token).toBe('cashuAtoken123');
    });
  });

  describe('hasToken', () => {
    it('should return true for content with cashuA token', () => {
      expect(hasToken('cashuAtoken123')).toBe(true);
    });

    it('should return true for content with cashuB token', () => {
      expect(hasToken('cashuBtoken123')).toBe(true);
    });

    it('should return false for content without token', () => {
      expect(hasToken('no token here')).toBe(false);
    });
  });

  describe('parseTokenTransferMessage', () => {
    it('should parse formatted token transfer message', () => {
      const content = `🎁 Token Transfer: 1.50 USD
Backing: MINIMAL | Amount: 100 sats
Memo: Thanks for the coffee!

cashuAtoken123`;

      const metadata = parseTokenTransferMessage(content);

      expect(metadata).not.toBeNull();
      expect(metadata?.faceValue).toBe(1.5);
      expect(metadata?.faceUnit).toBe('USD');
      expect(metadata?.backingStrategy).toBe('MINIMAL');
      expect(metadata?.tokenAmount).toBe(100);
      expect(metadata?.memo).toBe('Thanks for the coffee!');
    });

    it('should parse message with FULL backing', () => {
      const content = '🎁 Token Transfer: 5.00 EUR\nBacking: FULL';
      const metadata = parseTokenTransferMessage(content);

      expect(metadata?.backingStrategy).toBe('FULL');
    });

    it('should parse message with LEGACY backing', () => {
      const content = '🎁 Token Transfer: 10 BTC\nBacking: LEGACY';
      const metadata = parseTokenTransferMessage(content);

      expect(metadata?.backingStrategy).toBe('LEGACY');
    });

    it('should handle unformatted message with just token', () => {
      const content = 'cashuAtoken123';
      const metadata = parseTokenTransferMessage(content);

      expect(metadata).toBeNull();
    });

    it('should extract memo from unformatted message', () => {
      const content = 'Here is some ecash for you cashuAtoken123';
      const metadata = parseTokenTransferMessage(content);

      expect(metadata).not.toBeNull();
      expect(metadata?.memo).toContain('Here is some ecash for you');
    });

    it('should handle decimal face values', () => {
      const content = '🎁 Token Transfer: 0.99 USD';
      const metadata = parseTokenTransferMessage(content);

      expect(metadata?.faceValue).toBe(0.99);
      expect(metadata?.faceDecimals).toBe(2);
    });
  });

  describe('getTokenFingerprint', () => {
    it('should return fingerprint for cashuA token', () => {
      const token = 'cashuABCDEF12345678901234';
      const fingerprint = getTokenFingerprint(token);

      expect(fingerprint).toBe('BCDEF12345678901');
      expect(fingerprint.length).toBe(16);
    });

    it('should return fingerprint for cashuB token', () => {
      const token = 'cashuBXYZ0987654321abcdef';
      const fingerprint = getTokenFingerprint(token);

      expect(fingerprint).toBe('XYZ0987654321abc');
      expect(fingerprint.length).toBe(16);
    });
  });

  describe('isValidToken', () => {
    it('should validate cashuA token', () => {
      expect(isValidToken('cashuABCDEF123456')).toBe(true);
    });

    it('should validate cashuB token', () => {
      expect(isValidToken('cashuBXYZ987654')).toBe(true);
    });

    it('should reject invalid prefix', () => {
      expect(isValidToken('cashuCinvalid')).toBe(false);
    });

    it('should reject empty token', () => {
      expect(isValidToken('cashuA')).toBe(false);
    });

    it('should reject non-token strings', () => {
      expect(isValidToken('not a token')).toBe(false);
    });
  });

  describe('getTokenVersion', () => {
    it('should return A for cashuA token', () => {
      expect(getTokenVersion('cashuAtoken123')).toBe('A');
    });

    it('should return B for cashuB token', () => {
      expect(getTokenVersion('cashuBtoken123')).toBe('B');
    });

    it('should return null for invalid token', () => {
      expect(getTokenVersion('invalid')).toBeNull();
    });
  });
});
