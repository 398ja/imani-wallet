import { describe, it, expect } from 'vitest';
import { Money, toMinorUnits, toMajorUnits, formatMoney, splitAmount } from '../src/Money';

describe('Money.fromMinor', () => {
  it('creates from minor units', () => {
    const m = Money.fromMinor(1250, 'EUR');
    expect(m.amount).toBe(1250);
    expect(m.currency).toBe('EUR');
    expect(m.decimals).toBe(2);
  });

  it('rounds to integer', () => {
    const m = Money.fromMinor(12.7, 'EUR');
    expect(m.amount).toBe(13);
  });

  it('normalizes currency to uppercase', () => {
    expect(Money.fromMinor(100, 'eur').currency).toBe('EUR');
  });

  it('throws on non-finite amount', () => {
    expect(() => Money.fromMinor(Infinity, 'EUR')).toThrow();
    expect(() => Money.fromMinor(NaN, 'EUR')).toThrow();
  });
});

describe('Money.fromMajor', () => {
  it('converts EUR major to minor (12.50 → 1250)', () => {
    const m = Money.fromMajor(12.50, 'EUR');
    expect(m.amount).toBe(1250);
  });

  it('converts XAF major to minor (5000 → 5000, zero-decimal)', () => {
    const m = Money.fromMajor(5000, 'XAF');
    expect(m.amount).toBe(5000);
  });

  it('converts SAT major to minor (100000 → 100000)', () => {
    const m = Money.fromMajor(100000, 'SAT');
    expect(m.amount).toBe(100000);
  });

  it('handles BTC with 8 decimals', () => {
    const m = Money.fromMajor(0.00100000, 'BTC');
    expect(m.amount).toBe(100000); // 0.001 BTC = 100,000 satoshis
  });

  it('rounds correctly for 0.1 + 0.2 type errors', () => {
    // 19.99 EUR should be exactly 1999 cents, not 1998 or 2000
    const m = Money.fromMajor(19.99, 'EUR');
    expect(m.amount).toBe(1999);
  });
});

describe('Money.zero', () => {
  it('creates zero money', () => {
    const m = Money.zero('EUR');
    expect(m.amount).toBe(0);
    expect(m.isZero()).toBe(true);
  });
});

describe('toMajor / toMinor', () => {
  it('toMajor converts EUR cents to euros', () => {
    expect(Money.fromMinor(1250, 'EUR').toMajor()).toBe(12.5);
  });

  it('toMajor returns same value for zero-decimal', () => {
    expect(Money.fromMinor(5000, 'XAF').toMajor()).toBe(5000);
  });

  it('toMinor returns the amount as-is', () => {
    expect(Money.fromMinor(1250, 'EUR').toMinor()).toBe(1250);
  });
});

describe('arithmetic', () => {
  it('add', () => {
    const m = Money.fromMinor(1000, 'EUR').add(250);
    expect(m.amount).toBe(1250);
    expect(m.currency).toBe('EUR');
  });

  it('subtract', () => {
    const m = Money.fromMinor(1000, 'EUR').subtract(250);
    expect(m.amount).toBe(750);
  });

  it('multiply', () => {
    const m = Money.fromMinor(1000, 'EUR').multiply(1.5);
    expect(m.amount).toBe(1500);
  });

  it('multiply rounds correctly', () => {
    const m = Money.fromMinor(100, 'EUR').multiply(0.33);
    expect(m.amount).toBe(33);
  });

  it('does not mutate original', () => {
    const original = Money.fromMinor(1000, 'EUR');
    original.add(500);
    expect(original.amount).toBe(1000);
  });
});

describe('split', () => {
  it('splits evenly', () => {
    const { keep, give } = Money.fromMinor(1000, 'EUR').split(0.5);
    expect(keep.amount).toBe(500);
    expect(give.amount).toBe(500);
    expect(keep.amount + give.amount).toBe(1000);
  });

  it('splits with remainder going to give', () => {
    const { keep, give } = Money.fromMinor(1001, 'EUR').split(0.5);
    expect(keep.amount + give.amount).toBe(1001);
    // 1001 * 0.5 = 500.5 → rounds to 501
    expect(keep.amount).toBe(501);
    expect(give.amount).toBe(500);
  });

  it('split(0) gives everything', () => {
    const { keep, give } = Money.fromMinor(1000, 'EUR').split(0);
    expect(keep.amount).toBe(0);
    expect(give.amount).toBe(1000);
  });

  it('split(1) keeps everything', () => {
    const { keep, give } = Money.fromMinor(1000, 'EUR').split(1);
    expect(keep.amount).toBe(1000);
    expect(give.amount).toBe(0);
  });

  it('always preserves total (no rounding loss)', () => {
    // Test many ratios
    for (let ratio = 0; ratio <= 1; ratio += 0.01) {
      const { keep, give } = Money.fromMinor(9999, 'EUR').split(ratio);
      expect(keep.amount + give.amount).toBe(9999);
    }
  });

  it('throws on ratio < 0', () => {
    expect(() => Money.fromMinor(100, 'EUR').split(-0.1)).toThrow();
  });

  it('throws on ratio > 1', () => {
    expect(() => Money.fromMinor(100, 'EUR').split(1.1)).toThrow();
  });
});

describe('format', () => {
  it('formats EUR with symbol before', () => {
    expect(Money.fromMinor(1250, 'EUR').format()).toBe('\u20AC12,50');
  });

  it('formats USD', () => {
    expect(Money.fromMinor(999, 'USD').format()).toBe('$9.99');
  });

  it('formats XAF with FCFA after', () => {
    expect(Money.fromMinor(5000, 'XAF').format()).toBe('5 000 FCFA');
  });

  it('formats SAT with sats after', () => {
    expect(Money.fromMinor(100000, 'SAT').format()).toBe('100,000 sats');
  });

  it('formats large EUR with thousands separator', () => {
    expect(Money.fromMinor(123456789, 'EUR').format()).toBe('\u20AC1 234 567,89');
  });

  it('formats zero', () => {
    expect(Money.fromMinor(0, 'EUR').format()).toBe('\u20AC0,00');
    expect(Money.fromMinor(0, 'XAF').format()).toBe('0 FCFA');
  });

  it('formatPlain omits symbol', () => {
    expect(Money.fromMinor(1250, 'EUR').formatPlain()).toBe('12,50');
  });
});

describe('predicates', () => {
  it('isZero', () => {
    expect(Money.fromMinor(0, 'EUR').isZero()).toBe(true);
    expect(Money.fromMinor(1, 'EUR').isZero()).toBe(false);
  });

  it('isPositive', () => {
    expect(Money.fromMinor(1, 'EUR').isPositive()).toBe(true);
    expect(Money.fromMinor(0, 'EUR').isPositive()).toBe(false);
    expect(Money.fromMinor(-1, 'EUR').isPositive()).toBe(false);
  });
});

describe('toString', () => {
  it('returns debug representation', () => {
    expect(Money.fromMinor(1250, 'EUR').toString()).toBe('Money(1250 EUR)');
  });
});

// ==========================================
// Standalone functions
// ==========================================

describe('toMinorUnits', () => {
  it('converts EUR major to minor', () => {
    expect(toMinorUnits(12.50, 'EUR')).toBe(1250);
  });

  it('no-op for zero-decimal currencies', () => {
    expect(toMinorUnits(5000, 'XAF')).toBe(5000);
    expect(toMinorUnits(100000, 'SAT')).toBe(100000);
  });

  it('handles floating-point edge cases', () => {
    expect(toMinorUnits(19.99, 'EUR')).toBe(1999);
    expect(toMinorUnits(0.1 + 0.2, 'EUR')).toBe(30); // 0.3 EUR = 30 cents
  });
});

describe('toMajorUnits', () => {
  it('converts EUR minor to major', () => {
    expect(toMajorUnits(1250, 'EUR')).toBe(12.5);
  });

  it('no-op for zero-decimal currencies', () => {
    expect(toMajorUnits(5000, 'XAF')).toBe(5000);
  });
});

describe('formatMoney', () => {
  it('formats minor units with currency', () => {
    expect(formatMoney(1250, 'EUR')).toBe('\u20AC12,50');
    expect(formatMoney(5000, 'XAF')).toBe('5 000 FCFA');
  });
});

describe('splitAmount', () => {
  it('splits and preserves total', () => {
    const [keep, give] = splitAmount(9999, 0.33);
    expect(keep + give).toBe(9999);
  });

  it('splits evenly', () => {
    const [keep, give] = splitAmount(1000, 0.5);
    expect(keep).toBe(500);
    expect(give).toBe(500);
  });
});
