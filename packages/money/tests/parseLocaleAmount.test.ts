/**
 * Tests for parseLocaleAmount — locale-aware amount parser.
 *
 * Matrix: 4 locales × 4 currencies × scenarios from the contract example table.
 * Spec: 046-locale-decimal-separator.
 */

import { describe, it, expect } from 'vitest';
import { parseLocaleAmount } from '../src/parseLocaleAmount.js';

const FR = 'fr-FR';
const EN = 'en-US';
const DE = 'de-DE';
const ES = 'es-ES';

describe('parseLocaleAmount — happy paths per locale (FR-001)', () => {
  it('accepts "5,50" on fr-FR EUR as 550 minor units', () => {
    const r = parseLocaleAmount('5,50', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: true, minorUnits: 550, major: 5.5, currency: 'EUR' });
  });

  it('accepts "12,75" on de-DE EUR as 1275 minor units', () => {
    const r = parseLocaleAmount('12,75', 'EUR', { locale: DE });
    expect(r).toMatchObject({ ok: true, minorUnits: 1275, currency: 'EUR' });
  });

  it('accepts "12,75" on es-ES EUR as 1275 minor units', () => {
    const r = parseLocaleAmount('12,75', 'EUR', { locale: ES });
    expect(r).toMatchObject({ ok: true, minorUnits: 1275, currency: 'EUR' });
  });

  it('accepts "12.75" on en-US EUR as 1275 minor units (no regression)', () => {
    const r = parseLocaleAmount('12.75', 'EUR', { locale: EN });
    expect(r).toMatchObject({ ok: true, minorUnits: 1275, currency: 'EUR' });
  });

  it('accepts a bare integer "5" on fr-FR EUR as 500 minor units', () => {
    const r = parseLocaleAmount('5', 'EUR', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 500, major: 5 });
  });
});

describe('parseLocaleAmount — one-fractional-digit normalisation (FR-006)', () => {
  it('right-zero-pads "5,5" on fr-FR EUR to 550 minor units', () => {
    const r = parseLocaleAmount('5,5', 'EUR', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 550, major: 5.5 });
  });

  it('right-zero-pads "5.5" on en-US EUR to 550 minor units', () => {
    const r = parseLocaleAmount('5.5', 'EUR', { locale: EN });
    expect(r).toMatchObject({ ok: true, minorUnits: 550, major: 5.5 });
  });

  it('right-zero-pads "12,7" on de-DE EUR to 1270 minor units', () => {
    const r = parseLocaleAmount('12,7', 'EUR', { locale: DE });
    expect(r).toMatchObject({ ok: true, minorUnits: 1270 });
  });
});

describe('parseLocaleAmount — trailing separator returns `incomplete` (M3, edge case)', () => {
  it('"5," on fr-FR EUR returns reason `incomplete` (not `invalid`)', () => {
    const r = parseLocaleAmount('5,', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('"5." on en-US EUR returns reason `incomplete`', () => {
    const r = parseLocaleAmount('5.', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('"5." on fr-FR EUR (period-fallback path) returns reason `incomplete`', () => {
    const r = parseLocaleAmount('5.', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'incomplete' });
  });
});

describe('parseLocaleAmount — signed prefixes rejected (FR-011 / H4)', () => {
  it('leading `-` on fr-FR EUR rejected as `invalid`', () => {
    const r = parseLocaleAmount('-5,50', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('leading `+` on fr-FR EUR rejected as `invalid`', () => {
    const r = parseLocaleAmount('+5,50', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('leading `-` on en-US EUR rejected as `invalid`', () => {
    const r = parseLocaleAmount('-5.50', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('leading `+` on en-US EUR rejected as `invalid`', () => {
    const r = parseLocaleAmount('+5.50', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('parseLocaleAmount — scientific notation rejected (FR-003)', () => {
  it('"1e10" on en-US EUR rejected as `invalid`', () => {
    const r = parseLocaleAmount('1e10', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('"1E5" on fr-FR EUR rejected as `invalid`', () => {
    const r = parseLocaleAmount('1E5', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('parseLocaleAmount — lone-comma-on-en-US rejected (SC-004 / H2)', () => {
  it('"5,50" on en-US EUR is rejected as `invalid` (no comma fallback for English)', () => {
    const r = parseLocaleAmount('5,50', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('"5,5" on en-US EUR is rejected as `invalid` (no 3-digit group, no comma fallback)', () => {
    const r = parseLocaleAmount('5,5', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('parseLocaleAmount — mixed-separator off-locale strings rejected (H3, no heuristic)', () => {
  it('"1.234,56" on fr-FR EUR (en-US-style string in fr-FR context) is `invalid`', () => {
    const r = parseLocaleAmount('1.234,56', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('"1.234,56" on en-US EUR is `invalid` (en-US has no `,` decimal)', () => {
    const r = parseLocaleAmount('1.234,56', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('parseLocaleAmount — period-fallback (FR-002, one-way)', () => {
  it('"5.50" on fr-FR EUR is accepted via period fallback as 550', () => {
    const r = parseLocaleAmount('5.50', 'EUR', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 550, currency: 'EUR' });
  });

  it('period fallback is disabled when acceptPeriodFallback=false', () => {
    const r = parseLocaleAmount('5.50', 'EUR', { locale: FR, acceptPeriodFallback: false });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('parseLocaleAmount — grouped thousands across locales', () => {
  it('"1,234.56" on en-US EUR is 123456 minor units (comma group + period decimal)', () => {
    const r = parseLocaleAmount('1,234.56', 'EUR', { locale: EN });
    expect(r).toMatchObject({ ok: true, minorUnits: 123456 });
  });

  it('"1 234,56" on fr-FR EUR with U+0020 SPACE is accepted as 123456 minor units (mobile-keyboard substitution)', () => {
    const r = parseLocaleAmount('1 234,56', 'EUR', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 123456 });
  });

  it('"1 234,56" on fr-FR EUR with U+00A0 NBSP is accepted as 123456 minor units (browser-native)', () => {
    const r = parseLocaleAmount('1 234,56', 'EUR', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 123456 });
  });

  it('"1 234,56" on fr-FR EUR with U+202F NNBSP is accepted as 123456 minor units (modern fr-FR)', () => {
    const r = parseLocaleAmount('1 234,56', 'EUR', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 123456 });
  });
});

describe('parseLocaleAmount — too_many_decimals (FR-006)', () => {
  it('"5,555" on fr-FR EUR returns `too_many_decimals` (3 > 2 cap)', () => {
    const r = parseLocaleAmount('5,555', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'too_many_decimals' });
  });

  it('"5.555" on en-US EUR returns `too_many_decimals`', () => {
    const r = parseLocaleAmount('5.555', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'too_many_decimals' });
  });
});

describe('parseLocaleAmount — integer-only currencies reject any separator (FR-005 / SC-005)', () => {
  it('"5,5" on fr-FR XAF is `invalid` (XAF has zero decimals — SC-005)', () => {
    const r = parseLocaleAmount('5,5', 'XAF', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('"5,50" on fr-FR XAF is `invalid` (SC-005)', () => {
    const r = parseLocaleAmount('5,50', 'XAF', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('"5.50" on en-US SAT is `invalid` (SC-005)', () => {
    const r = parseLocaleAmount('5.50', 'SAT', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('"5,5" on de-DE XOF is `invalid` (SC-005)', () => {
    const r = parseLocaleAmount('5,5', 'XOF', { locale: DE });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('"100000" on en-US SAT is accepted as 100000 (integer happy path)', () => {
    const r = parseLocaleAmount('100000', 'SAT', { locale: EN });
    expect(r).toMatchObject({ ok: true, minorUnits: 100000, currency: 'SAT' });
  });

  it('"5000" on fr-FR XAF is accepted as 5000', () => {
    const r = parseLocaleAmount('5000', 'XAF', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 5000, currency: 'XAF' });
  });
});

describe('parseLocaleAmount — empty / whitespace input', () => {
  it('empty string returns `empty`', () => {
    const r = parseLocaleAmount('', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'empty' });
  });

  it('whitespace-only returns `empty`', () => {
    const r = parseLocaleAmount('   ', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'empty' });
  });

  it('trims leading/trailing whitespace on a happy value', () => {
    const r = parseLocaleAmount('  5,50  ', 'EUR', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 550 });
  });
});

describe('parseLocaleAmount — overflow', () => {
  it('a 17-digit integer past MAX_SAFE_INTEGER returns `overflow`', () => {
    // Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991 (16 digits)
    const r = parseLocaleAmount('99999999999999999', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'overflow' });
  });
});

describe('parseLocaleAmount — locale defaults and other USD test', () => {
  it('USD on en-US accepts "12.75" → 1275 minor units', () => {
    const r = parseLocaleAmount('12.75', 'USD', { locale: EN });
    expect(r).toMatchObject({ ok: true, minorUnits: 1275, currency: 'USD' });
  });

  it('USD on fr-FR accepts "12,75" → 1275 minor units (USD still has 2 decimals)', () => {
    const r = parseLocaleAmount('12,75', 'USD', { locale: FR });
    expect(r).toMatchObject({ ok: true, minorUnits: 1275, currency: 'USD' });
  });

  it('returns currency uppercase even when passed lowercase', () => {
    const r = parseLocaleAmount('5,50', 'eur', { locale: FR });
    expect(r).toMatchObject({ ok: true, currency: 'EUR' });
  });

  it('default locale is en-US when options.locale is omitted', () => {
    const r = parseLocaleAmount('5.50', 'EUR');
    expect(r).toMatchObject({ ok: true, minorUnits: 550 });
  });
});

describe('parseLocaleAmount — abc / garbage', () => {
  it('"abc" on fr-FR EUR is `invalid`', () => {
    const r = parseLocaleAmount('abc', 'EUR', { locale: FR });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('mixed digits and letters on en-US EUR is `invalid`', () => {
    const r = parseLocaleAmount('5x50', 'EUR', { locale: EN });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});
