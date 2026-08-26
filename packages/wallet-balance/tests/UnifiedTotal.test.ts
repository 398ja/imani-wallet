/**
 * Spec 040 — Unified Balance Display
 *
 * Package matrix (SC-002): 10 scenarios pinning the contract in
 * specs/040-unified-balance-display/contracts/wallet-balance-extensions.md
 * lines 80–100.
 *
 * Deterministic adapter — no host imports, no network. The aggregator's
 * "no partial total" decision is the load-bearing FR-007 guarantee:
 * any `null` from the adapter MUST collapse the headline to `null`.
 */

import { describe, it, expect } from 'vitest';
import type { ExchangeRateAdapter } from '../src/adapters/ExchangeRateAdapter';
import {
  computeUnifiedTotal,
  resolveDefaultDisplayCurrency,
} from '../src/core/UnifiedTotal';

// Test-only adapter: scripted return values per (from, to) pair.
function makeAdapter(opts: {
  rates: Record<string, number | null>;
  supported?: string[];
}): ExchangeRateAdapter {
  const supported = opts.supported ?? ['eur', 'usd', 'xaf', 'xof', 'sat'];
  return {
    toDisplay(amountMinor, fromCurrency, fromDecimals, toCurrency, toDecimals) {
      const from = fromCurrency.toLowerCase();
      const to = toCurrency.toLowerCase();
      if (from === to) return amountMinor;
      if (!supported.includes(from) || !supported.includes(to)) return null;
      const key = `${from}->${to}`;
      const rate = opts.rates[key];
      if (rate === null || rate === undefined) return null;
      // amountMinor is in minor units of `from`. Convert via:
      //   majorFrom = amountMinor / 10^fromDecimals
      //   majorTo   = majorFrom * rate
      //   minorTo   = round(majorTo * 10^toDecimals)
      const majorFrom = amountMinor / Math.pow(10, fromDecimals);
      const majorTo = majorFrom * rate;
      return Math.round(majorTo * Math.pow(10, toDecimals));
    },
    supports(from, to) {
      const f = from.toLowerCase();
      const t = to.toLowerCase();
      if (f === t) return supported.includes(f);
      return supported.includes(f) && supported.includes(t);
    },
    supportedTargets() {
      return [...supported];
    },
    async refresh() { /* no-op for tests */ },
  };
}

describe('computeUnifiedTotal — 10-scenario package matrix (spec 040 SC-002)', () => {
  // The XAF↔EUR peg is 655.957. So 1 XAF = 1/655.957 EUR ≈ 0.001524 EUR.
  // 5000 XAF (zero-decimals) = 5000 XAF major-units = 5000/655.957 ≈ 7.6224 EUR
  //                          ≈ 762 EUR-cents.
  // 1000 EUR-cents = 10.00 EUR.
  // Sum ≈ 1762 EUR-cents ≈ 17.62 EUR.
  const PEG_XAF_PER_EUR = 655.957;
  const RATE_XAF_TO_EUR = 1 / PEG_XAF_PER_EUR;

  it('Scenario 1: 5_000 XAF + 1_000 EUR-cents → ~1762 EUR-cents, no unconvertible', () => {
    const adapter = makeAdapter({
      rates: { 'xaf->eur': RATE_XAF_TO_EUR },
    });
    const out = computeUnifiedTotal({
      buckets: [
        { currency: 'xaf', amount: 5_000, decimals: 0 },
        { currency: 'eur', amount: 1_000, decimals: 2 },
      ],
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    });
    expect(out.total).not.toBeNull();
    // Within ±1 minor unit of 1762 EUR-cents (accounts for rounding).
    expect(out.total!).toBeGreaterThanOrEqual(1761);
    expect(out.total!).toBeLessThanOrEqual(1763);
    expect(out.unconvertible).toEqual([]);
    expect(out.displayCurrency).toBe('eur');
    expect(out.decimals).toBe(2);
  });

  it('Scenario 2: 5_000 XAF only → ~762 EUR-cents', () => {
    const adapter = makeAdapter({
      rates: { 'xaf->eur': RATE_XAF_TO_EUR },
    });
    const out = computeUnifiedTotal({
      buckets: [{ currency: 'xaf', amount: 5_000, decimals: 0 }],
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    });
    expect(out.total).not.toBeNull();
    expect(out.total!).toBeGreaterThanOrEqual(761);
    expect(out.total!).toBeLessThanOrEqual(763);
    expect(out.unconvertible).toEqual([]);
  });

  it('Scenario 3: 1_000 EUR-cents only, display=EUR → 1000 (no conversion)', () => {
    const adapter = makeAdapter({ rates: {} });
    const out = computeUnifiedTotal({
      buckets: [{ currency: 'eur', amount: 1_000, decimals: 2 }],
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    });
    expect(out.total).toBe(1_000);
    expect(out.unconvertible).toEqual([]);
  });

  it('Scenario 4: 5_000 XAF + 1_000 EUR-cents, XAF→EUR returns null → total=null, unconvertible=["xaf"]', () => {
    const adapter = makeAdapter({
      rates: { 'xaf->eur': null },
    });
    const out = computeUnifiedTotal({
      buckets: [
        { currency: 'xaf', amount: 5_000, decimals: 0 },
        { currency: 'eur', amount: 1_000, decimals: 2 },
      ],
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    });
    expect(out.total).toBeNull();
    expect(out.unconvertible).toEqual(['xaf']);
  });

  it('Scenario 5: displayCurrency = "" throws TypeError (host short-circuits, never reaches aggregator)', () => {
    const adapter = makeAdapter({ rates: {} });
    expect(() => computeUnifiedTotal({
      buckets: [{ currency: 'eur', amount: 1_000, decimals: 2 }],
      displayCurrency: '',
      displayDecimals: 2,
      rateLookup: adapter,
    })).toThrow(TypeError);
  });

  it('Scenario 6: empty buckets → total=0, unconvertible=[]', () => {
    const adapter = makeAdapter({ rates: {} });
    const out = computeUnifiedTotal({
      buckets: [],
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    });
    expect(out.total).toBe(0);
    expect(out.unconvertible).toEqual([]);
  });

  it('Scenario 7: zero-amount foreign bucket → contributes zero, no abort', () => {
    // Host filters zero-amount buckets before calling, but the aggregator
    // MUST also cope. Verify it adds 0 rather than failing.
    const adapter = makeAdapter({
      rates: { 'xaf->eur': RATE_XAF_TO_EUR },
    });
    const out = computeUnifiedTotal({
      buckets: [
        { currency: 'eur', amount: 1_000, decimals: 2 },
        { currency: 'xaf', amount: 0, decimals: 0 },
      ],
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    });
    expect(out.total).toBe(1_000);
    expect(out.unconvertible).toEqual([]);
  });

  it('Scenario 8: zero-decimal display currency (XAF), 1_000 EUR-cents → whole XAF, integer-clean', () => {
    // 10 EUR at peg ≈ 6562 XAF (integer because XAF has zero decimals).
    const adapter = makeAdapter({
      rates: { 'eur->xaf': PEG_XAF_PER_EUR },
    });
    const out = computeUnifiedTotal({
      buckets: [{ currency: 'eur', amount: 1_000, decimals: 2 }],
      displayCurrency: 'xaf',
      displayDecimals: 0,
      rateLookup: adapter,
    });
    expect(out.total).not.toBeNull();
    // 10.00 EUR × 655.957 ≈ 6559.57 XAF → round to 6560 (zero-decimals).
    expect(out.total!).toBeGreaterThanOrEqual(6_559);
    expect(out.total!).toBeLessThanOrEqual(6_561);
    expect(out.decimals).toBe(0);
  });

  it('Scenario 9a: idempotent — calling twice returns deep-equal output', () => {
    const adapter = makeAdapter({
      rates: { 'xaf->eur': RATE_XAF_TO_EUR },
    });
    const input = {
      buckets: [
        { currency: 'xaf', amount: 5_000, decimals: 0 },
        { currency: 'eur', amount: 1_000, decimals: 2 },
      ],
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    };
    const out1 = computeUnifiedTotal(input);
    const out2 = computeUnifiedTotal(input);
    expect(out2).toEqual(out1);
  });

  it('Scenario 9b: input immutability — frozen input does not throw', () => {
    const adapter = makeAdapter({
      rates: { 'xaf->eur': RATE_XAF_TO_EUR },
    });
    const buckets = Object.freeze([
      Object.freeze({ currency: 'xaf', amount: 5_000, decimals: 0 }),
      Object.freeze({ currency: 'eur', amount: 1_000, decimals: 2 }),
    ]);
    const input = Object.freeze({
      buckets,
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    });
    expect(() => computeUnifiedTotal(input as any)).not.toThrow();
  });

  it('Scenario 10: TRY not in supportedTargets, adapter returns null → total=null, unconvertible=["try"]', () => {
    // The TEST adapter explicitly excludes 'try' from supportedTargets,
    // so toDisplay('try'…) returns null. Pins the spec.md FR-002
    // whitelist-before-delegate guard at the aggregator boundary.
    const adapter = makeAdapter({
      rates: {},
      supported: ['eur', 'usd', 'xaf', 'xof', 'sat'],
    });
    const out = computeUnifiedTotal({
      buckets: [
        { currency: 'eur', amount: 1_000, decimals: 2 },
        { currency: 'try', amount: 100, decimals: 2 },
      ],
      displayCurrency: 'eur',
      displayDecimals: 2,
      rateLookup: adapter,
    });
    expect(out.total).toBeNull();
    expect(out.unconvertible).toEqual(['try']);
  });
});

describe('resolveDefaultDisplayCurrency — insertion-order resolver', () => {
  const supportedTargets = ['eur', 'usd', 'xaf', 'xof', 'sat'];

  it('Step 1: localCurrencySetting wins when supported', () => {
    const out = resolveDefaultDisplayCurrency({
      localCurrencySetting: 'xaf',
      buckets: [{ currency: 'eur', amount: 1, decimals: 2 }],
      supportedTargets,
      fallbackCurrency: 'eur',
    });
    expect(out).toBe('xaf');
  });

  it('Step 2a: first supported held currency by insertion order (XAF first)', () => {
    const out = resolveDefaultDisplayCurrency({
      buckets: [
        { currency: 'xaf', amount: 5_000, decimals: 0 },
        { currency: 'eur', amount: 1_000, decimals: 2 },
      ],
      supportedTargets,
      fallbackCurrency: 'eur',
    });
    expect(out).toBe('xaf');
  });

  it('Step 2b: first supported held currency by insertion order (EUR first)', () => {
    const out = resolveDefaultDisplayCurrency({
      buckets: [
        { currency: 'eur', amount: 1_000, decimals: 2 },
        { currency: 'xaf', amount: 5_000, decimals: 0 },
      ],
      supportedTargets,
      fallbackCurrency: 'eur',
    });
    expect(out).toBe('eur');
  });

  it('Step 3: empty buckets → fallbackCurrency', () => {
    const out = resolveDefaultDisplayCurrency({
      buckets: [],
      supportedTargets,
      fallbackCurrency: 'eur',
    });
    expect(out).toBe('eur');
  });

  it('Step 1 fallthrough: unsupported localCurrency → skip to step 2/3', () => {
    const out = resolveDefaultDisplayCurrency({
      localCurrencySetting: 'try',
      supportedTargets,
      buckets: [],
      fallbackCurrency: 'eur',
    });
    expect(out).toBe('eur');
  });

  it('Step 2 filter: first bucket unsupported → skip to fallback', () => {
    const out = resolveDefaultDisplayCurrency({
      buckets: [{ currency: 'try', amount: 100, decimals: 2 }],
      supportedTargets,
      fallbackCurrency: 'eur',
    });
    expect(out).toBe('eur');
  });
});
