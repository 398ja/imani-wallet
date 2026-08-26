import { describe, it, expect } from 'vitest';
import {
  getCurrency,
  getDecimals,
  isZeroDecimal,
  isSat,
  registerCurrency,
  getAllCurrencyCodes,
} from '../src/currencies';

describe('getCurrency', () => {
  it('returns EUR config with 2 decimals', () => {
    const eur = getCurrency('EUR');
    expect(eur.code).toBe('EUR');
    expect(eur.symbol).toBe('\u20AC');
    expect(eur.decimals).toBe(2);
    expect(eur.symbolPosition).toBe('before');
  });

  it('returns XAF config with 0 decimals', () => {
    const xaf = getCurrency('XAF');
    expect(xaf.code).toBe('XAF');
    expect(xaf.symbol).toBe('FCFA');
    expect(xaf.decimals).toBe(0);
    expect(xaf.symbolPosition).toBe('after');
  });

  it('returns SAT config with 0 decimals', () => {
    const sat = getCurrency('SAT');
    expect(sat.decimals).toBe(0);
    expect(sat.symbol).toBe('sats');
    expect(sat.symbolPosition).toBe('after');
  });

  it('normalizes to uppercase', () => {
    expect(getCurrency('eur').code).toBe('EUR');
    expect(getCurrency('xaf').decimals).toBe(0);
    expect(getCurrency('sat').symbol).toBe('sats');
  });

  it('returns default config for unknown currencies', () => {
    const unknown = getCurrency('ZZZ');
    expect(unknown.code).toBe('ZZZ');
    expect(unknown.symbol).toBe('ZZZ');
    expect(unknown.decimals).toBe(2);
  });

  it('includes all CFA variants', () => {
    expect(getCurrency('CFA').decimals).toBe(0);
    expect(getCurrency('FCFA').decimals).toBe(0);
    expect(getCurrency('XOF').decimals).toBe(0);
  });
});

describe('getDecimals', () => {
  it('returns 2 for EUR', () => expect(getDecimals('EUR')).toBe(2));
  it('returns 0 for XAF', () => expect(getDecimals('XAF')).toBe(0));
  it('returns 0 for SAT', () => expect(getDecimals('SAT')).toBe(0));
  it('returns 0 for JPY', () => expect(getDecimals('JPY')).toBe(0));
  it('returns 0 for KRW', () => expect(getDecimals('KRW')).toBe(0));
  it('returns 0 for VND', () => expect(getDecimals('VND')).toBe(0));
  it('returns 8 for BTC', () => expect(getDecimals('BTC')).toBe(8));
  it('returns 2 for unknown', () => expect(getDecimals('ZZZ')).toBe(2));
});

describe('isZeroDecimal', () => {
  const zeroDecimals = ['SAT', 'SATS', 'XAF', 'XOF', 'CFA', 'FCFA', 'JPY', 'KRW', 'VND', 'UGX', 'TZS'];
  const nonZeroDecimals = ['EUR', 'USD', 'GBP', 'NGN', 'KES', 'BTC'];

  for (const code of zeroDecimals) {
    it(`returns true for ${code}`, () => expect(isZeroDecimal(code)).toBe(true));
  }
  for (const code of nonZeroDecimals) {
    it(`returns false for ${code}`, () => expect(isZeroDecimal(code)).toBe(false));
  }
  it('is case-insensitive', () => expect(isZeroDecimal('xaf')).toBe(true));
});

describe('isSat', () => {
  it('returns true for SAT', () => expect(isSat('SAT')).toBe(true));
  it('returns true for SATS', () => expect(isSat('SATS')).toBe(true));
  it('returns true for lowercase', () => expect(isSat('sat')).toBe(true));
  it('returns false for EUR', () => expect(isSat('EUR')).toBe(false));
  it('returns false for BTC', () => expect(isSat('BTC')).toBe(false));
});

describe('registerCurrency', () => {
  it('registers a custom currency', () => {
    registerCurrency('TEST', { symbol: 'T$', decimals: 3 });
    const config = getCurrency('TEST');
    expect(config.code).toBe('TEST');
    expect(config.symbol).toBe('T$');
    expect(config.decimals).toBe(3);
  });

  it('custom currency overrides built-in lookup', () => {
    registerCurrency('CUSTOM', { symbol: 'C', decimals: 0 });
    expect(isZeroDecimal('CUSTOM')).toBe(true);
  });
});

describe('getAllCurrencyCodes', () => {
  it('includes built-in currencies', () => {
    const codes = getAllCurrencyCodes();
    expect(codes).toContain('EUR');
    expect(codes).toContain('SAT');
    expect(codes).toContain('XAF');
  });

  it('includes custom currencies', () => {
    registerCurrency('MYCOIN', { symbol: 'MC', decimals: 4 });
    expect(getAllCurrencyCodes()).toContain('MYCOIN');
  });
});
