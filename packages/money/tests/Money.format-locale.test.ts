/**
 * Tests for Money.format({locale}) + formatMoney(amount, currency, {locale}).
 *
 * Verifies the FR-004 display widening: when a locale is passed, Intl.NumberFormat
 * drives separators/grouping; otherwise the currency's bundled separators apply.
 */

import { describe, it, expect } from 'vitest';
import { Money, formatMoney } from '../src/index.js';

describe('Money.format() — no locale arg keeps existing behaviour (snapshot safety)', () => {
  it('EUR 1250 → "€12,50" (currency-bundled separators)', () => {
    expect(Money.fromMinor(1250, 'EUR').format()).toBe('€12,50');
  });

  it('XAF 5000 → "5 000 FCFA" (zero decimals, space grouping)', () => {
    expect(Money.fromMinor(5000, 'XAF').format()).toBe('5 000 FCFA');
  });

  it('SAT 100000 → "100,000 sats"', () => {
    expect(Money.fromMinor(100000, 'SAT').format()).toBe('100,000 sats');
  });
});

describe('Money.format({locale}) — locale override (FR-004)', () => {
  it('EUR 1250 with locale=en-US → "€1,250.00" (en-US separators + grouping)', () => {
    const s = Money.fromMinor(125000, 'EUR').format({ locale: 'en-US' });
    expect(s).toBe('€1,250.00');
  });

  it('EUR 1250 with locale=fr-FR → "€12,50" (comma decimal, no grouping needed under 1000)', () => {
    const s = Money.fromMinor(1250, 'EUR').format({ locale: 'fr-FR' });
    // fr-FR formatter outputs "12,50"; the symbol always comes from the registry
    expect(s).toBe('€12,50');
  });

  it('USD 1275 with locale=fr-FR → "$12,75" (symbol from registry, fr-FR decimal)', () => {
    const s = Money.fromMinor(1275, 'USD').format({ locale: 'fr-FR' });
    expect(s).toBe('$12,75');
  });

  it('XAF 5000 with locale=en-US → "5,000 FCFA" (en-US grouping, zero decimals)', () => {
    const s = Money.fromMinor(5000, 'XAF').format({ locale: 'en-US' });
    expect(s).toBe('5,000 FCFA');
  });
});

describe('formatMoney standalone helper — same widening', () => {
  it('formatMoney(1250, "EUR") → "€12,50"', () => {
    expect(formatMoney(1250, 'EUR')).toBe('€12,50');
  });

  it('formatMoney(1250, "EUR", {locale: "en-US"}) → "€12.50"', () => {
    expect(formatMoney(1250, 'EUR', { locale: 'en-US' })).toBe('€12.50');
  });

  it('formatMoney(5000, "XAF", {locale: "fr-FR"}) → "5 000 FCFA" (fr-FR space grouping)', () => {
    // fr-FR Intl groups thousands with U+00A0 NBSP (not ASCII space)
    const s = formatMoney(5000, 'XAF', { locale: 'fr-FR' });
    // Accept any of the locale-space variants — modern Node may emit NBSP or NNBSP.
    expect(s).toMatch(/^5[\s  ]000\sFCFA$/);
  });
});
