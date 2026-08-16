import { describe, it, expect } from 'vitest';
import { calculateBackoff, calculateBackoffSequence, addJitter } from '../src/utils/backoff';

describe('calculateBackoff', () => {
  it('returns initial delay for first attempt', () => {
    expect(calculateBackoff(0, 100, 1.5, 1000)).toBe(100);
  });

  it('applies multiplier for subsequent attempts', () => {
    expect(calculateBackoff(1, 100, 1.5, 1000)).toBe(150);
    expect(calculateBackoff(2, 100, 1.5, 1000)).toBe(225);
  });

  it('caps at maxDelay', () => {
    expect(calculateBackoff(10, 100, 1.5, 1000)).toBe(1000);
    expect(calculateBackoff(20, 100, 2, 1000)).toBe(1000);
  });

  it('works with different initial delays', () => {
    expect(calculateBackoff(0, 50, 2, 500)).toBe(50);
    expect(calculateBackoff(1, 50, 2, 500)).toBe(100);
    expect(calculateBackoff(2, 50, 2, 500)).toBe(200);
    expect(calculateBackoff(3, 50, 2, 500)).toBe(400);
    expect(calculateBackoff(4, 50, 2, 500)).toBe(500); // capped
  });
});

describe('calculateBackoffSequence', () => {
  it('generates correct sequence for polling defaults', () => {
    // Backend defaults: 100ms start, 1.5x multiplier, 1000ms cap
    const sequence = calculateBackoffSequence(100, 1.5, 1000, 10);
    expect(sequence).toEqual(
      [
        100, // 100
        150, // 100 * 1.5
        225, // 150 * 1.5
        337.5, // 225 * 1.5
        506.25, // 337.5 * 1.5
        759.375,
        1000, // capped
        1000,
        1000,
        1000,
      ].map((n) => Math.min(n, 1000))
    );
  });

  it('generates correct sequence for SSE reconnect defaults', () => {
    // SSE defaults: 1000ms start, 2x multiplier, 4000ms cap
    const sequence = calculateBackoffSequence(1000, 2, 4000, 5);
    expect(sequence).toEqual([1000, 2000, 4000, 4000, 4000]);
  });

  it('returns empty array for count 0', () => {
    expect(calculateBackoffSequence(100, 1.5, 1000, 0)).toEqual([]);
  });
});

describe('addJitter', () => {
  it('returns value within jitter range', () => {
    const baseDelay = 1000;
    const jitterFactor = 0.1;

    // Run multiple times to test randomness
    for (let i = 0; i < 100; i++) {
      const result = addJitter(baseDelay, jitterFactor);
      // Should be within +/- 10% of base delay
      expect(result).toBeGreaterThanOrEqual(baseDelay * (1 - jitterFactor));
      expect(result).toBeLessThanOrEqual(baseDelay * (1 + jitterFactor));
    }
  });

  it('uses default jitter factor of 0.1', () => {
    const baseDelay = 1000;

    for (let i = 0; i < 100; i++) {
      const result = addJitter(baseDelay);
      expect(result).toBeGreaterThanOrEqual(900);
      expect(result).toBeLessThanOrEqual(1100);
    }
  });

  it('never returns negative values', () => {
    for (let i = 0; i < 100; i++) {
      const result = addJitter(10, 1.0); // 100% jitter on small value
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns rounded integer', () => {
    const result = addJitter(1000, 0.1);
    expect(Number.isInteger(result)).toBe(true);
  });
});
