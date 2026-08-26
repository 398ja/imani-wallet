/**
 * Tests for Money.fromLocaleString — convenience wrapper over parseLocaleAmount.
 *
 * Verifies the 1:1 reason→error-class mapping from the spec-046 contract.
 */

import { describe, it, expect } from 'vitest';
import {
  Money,
  EmptyAmountError,
  IncompleteAmountError,
  InvalidAmountError,
  TooManyDecimalsError,
  OverflowError,
} from '../src/index.js';

const FR = 'fr-FR';
const EN = 'en-US';

describe('Money.fromLocaleString — happy path', () => {
  it('returns a Money instance for a valid fr-FR EUR amount', () => {
    const m = Money.fromLocaleString('5,50', 'EUR', { locale: FR });
    expect(m).toBeInstanceOf(Money);
    expect(m.toMinor()).toBe(550);
    expect(m.currency).toBe('EUR');
  });

  it('returns a Money instance for a valid en-US USD amount', () => {
    const m = Money.fromLocaleString('12.75', 'USD', { locale: EN });
    expect(m.toMinor()).toBe(1275);
    expect(m.currency).toBe('USD');
  });
});

describe('Money.fromLocaleString — error mapping (1:1 with parseLocaleAmount reasons)', () => {
  it('throws EmptyAmountError for empty input', () => {
    expect(() => Money.fromLocaleString('', 'EUR', { locale: FR }))
      .toThrowError(EmptyAmountError);
  });

  it('throws EmptyAmountError for whitespace-only input', () => {
    expect(() => Money.fromLocaleString('   ', 'EUR', { locale: FR }))
      .toThrowError(EmptyAmountError);
  });

  it('throws IncompleteAmountError for trailing fr-FR separator "5,"', () => {
    expect(() => Money.fromLocaleString('5,', 'EUR', { locale: FR }))
      .toThrowError(IncompleteAmountError);
  });

  it('throws IncompleteAmountError for trailing en-US separator "5."', () => {
    expect(() => Money.fromLocaleString('5.', 'EUR', { locale: EN }))
      .toThrowError(IncompleteAmountError);
  });

  it('throws InvalidAmountError for signed-prefix "-5,50" on fr-FR', () => {
    expect(() => Money.fromLocaleString('-5,50', 'EUR', { locale: FR }))
      .toThrowError(InvalidAmountError);
  });

  it('throws InvalidAmountError for signed-prefix "+5.50" on en-US', () => {
    expect(() => Money.fromLocaleString('+5.50', 'EUR', { locale: EN }))
      .toThrowError(InvalidAmountError);
  });

  it('throws InvalidAmountError for lone-comma on en-US "5,50"', () => {
    expect(() => Money.fromLocaleString('5,50', 'EUR', { locale: EN }))
      .toThrowError(InvalidAmountError);
  });

  it('throws TooManyDecimalsError for "5,555" on fr-FR EUR', () => {
    expect(() => Money.fromLocaleString('5,555', 'EUR', { locale: FR }))
      .toThrowError(TooManyDecimalsError);
  });

  it('throws OverflowError for a 17-digit integer past MAX_SAFE_INTEGER', () => {
    expect(() => Money.fromLocaleString('99999999999999999', 'EUR', { locale: EN }))
      .toThrowError(OverflowError);
  });
});

describe('Money.fromLocaleString — error name matches the class name (for `err.name` inspection)', () => {
  it('IncompleteAmountError.name is "IncompleteAmountError"', () => {
    try {
      Money.fromLocaleString('5,', 'EUR', { locale: FR });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).name).toBe('IncompleteAmountError');
    }
  });

  it('TooManyDecimalsError.name is "TooManyDecimalsError"', () => {
    try {
      Money.fromLocaleString('5,555', 'EUR', { locale: FR });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).name).toBe('TooManyDecimalsError');
    }
  });
});
