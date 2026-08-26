/**
 * Unified balance total computation (spec 040).
 *
 * Two pure-function exports:
 * - `computeUnifiedTotal` — walks per-currency buckets and produces a single
 *   total in the customer's chosen display currency. Fall-back-cleanly: any
 *   `null` from the rate adapter aborts the total (FR-007).
 * - `resolveDefaultDisplayCurrency` — picks a display currency when the
 *   customer hasn't (FR-006). Insertion-order based; unit-bias-free.
 *
 * Neither function reads settings, calls `Date.now()`, calls `Math.random()`,
 * or performs I/O. Both are deterministic and idempotent.
 *
 * See specs/040-unified-balance-display/contracts/wallet-balance-extensions.md
 * for the complete contract.
 */

import type {
  ExchangeRateAdapter,
  UnifiedTotalInput,
  UnifiedTotalOutput,
  VoucherBucket,
} from '../adapters/ExchangeRateAdapter';

export type {
  ExchangeRateAdapter,
  UnifiedTotalInput,
  UnifiedTotalOutput,
  VoucherBucket,
};

export function computeUnifiedTotal(input: UnifiedTotalInput): UnifiedTotalOutput {
  // Programmer-error guards (Constitution Principle VI — boundary validation).
  if (!input || typeof input !== 'object') {
    throw new TypeError('computeUnifiedTotal: input must be an object');
  }
  if (!Array.isArray(input.buckets)) {
    throw new TypeError('computeUnifiedTotal: input.buckets must be an array');
  }
  if (typeof input.displayCurrency !== 'string' || input.displayCurrency.length === 0) {
    throw new TypeError('computeUnifiedTotal: input.displayCurrency must be a non-empty string');
  }
  if (
    !input.rateLookup
    || typeof input.rateLookup.toDisplay !== 'function'
    || typeof input.rateLookup.supports !== 'function'
    || typeof input.rateLookup.supportedTargets !== 'function'
    || typeof input.rateLookup.refresh !== 'function'
  ) {
    throw new TypeError('computeUnifiedTotal: input.rateLookup must implement ExchangeRateAdapter');
  }

  const displayCurrency = input.displayCurrency.toLowerCase();
  const displayDecimals = input.displayDecimals;
  const unconvertible: string[] = [];
  let total = 0;
  let abort = false;

  for (const bucket of input.buckets) {
    const bucketCurrency = String(bucket.currency || '').toLowerCase();
    if (bucketCurrency === displayCurrency) {
      total += bucket.amount;
      continue;
    }
    const converted = input.rateLookup.toDisplay(
      bucket.amount,
      bucketCurrency,
      bucket.decimals,
      displayCurrency,
      displayDecimals,
    );
    if (converted === null) {
      abort = true;
      if (!unconvertible.includes(bucketCurrency)) {
        unconvertible.push(bucketCurrency);
      }
      continue;
    }
    total += converted;
  }

  return {
    displayCurrency,
    total: abort ? null : total,
    decimals: displayDecimals,
    unconvertible: abort ? unconvertible : [],
  };
}

export interface ResolveDefaultDisplayCurrencyOpts {
  localCurrencySetting?: string;
  buckets?: VoucherBucket[];
  supportedTargets: string[];
  fallbackCurrency: string;
}

export function resolveDefaultDisplayCurrency(
  opts: ResolveDefaultDisplayCurrencyOpts,
): string {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('resolveDefaultDisplayCurrency: opts must be an object');
  }
  if (!Array.isArray(opts.supportedTargets)) {
    throw new TypeError('resolveDefaultDisplayCurrency: opts.supportedTargets must be an array');
  }
  if (typeof opts.fallbackCurrency !== 'string' || opts.fallbackCurrency.length === 0) {
    throw new TypeError('resolveDefaultDisplayCurrency: opts.fallbackCurrency must be a non-empty string');
  }

  const supported = opts.supportedTargets.map((s) => String(s || '').toLowerCase());

  // 1. localCurrency setting, if supported as a display target.
  if (typeof opts.localCurrencySetting === 'string' && opts.localCurrencySetting.length > 0) {
    const lc = opts.localCurrencySetting.toLowerCase();
    if (supported.includes(lc)) {
      return lc;
    }
  }

  // 2. First supported held currency in insertion order. Deterministic +
  //    unit-bias-free (raw minor-units cannot be ranked across currencies;
  //    ranking by converted value would require the rate adapter, which is
  //    the very thing the resolver is picking the target for — circular).
  if (Array.isArray(opts.buckets) && opts.buckets.length > 0) {
    for (const bucket of opts.buckets) {
      const candidate = String(bucket.currency || '').toLowerCase();
      if (candidate && supported.includes(candidate)) {
        return candidate;
      }
    }
  }

  // 3. Mandatory final fallback.
  return opts.fallbackCurrency.toLowerCase();
}
